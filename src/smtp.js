// SMTP 服务端：25 收信 / 587 提交，支持 EHLO、STARTTLS、AUTH PLAIN/LOGIN、8BITMIME、SIZE、PIPELINING
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from './logger.js';
import { verifyPassword } from './crypto.js';
import { checkSpf, scoreSpam, resolvePtr, resolveMx } from './policy.js';
import { parseMessage, buildMime } from './mime.js';

const log = createLogger('smtp');

const MAX_LINE = 8192;

class SmtpSession {
  constructor(server, socket) {
    this.server = server;
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.state = 'greeting'; // greeting | ready | mail | rcpt | data
    this.mailFrom = null;
    this.rcpts = [];
    this.user = null;
    this.helo = '';
    this.secured = false;
    this.dataMode = null;
    this.remoteIp = (socket.remoteAddress || '').replace(/^::ffff:/, '');
    this.msgCount = 0;
  }

  send(line) {
    if (!this.socket.destroyed) this.socket.write(line + '\r\n');
  }

  multiline(code, lines) {
    const arr = Array.isArray(lines) ? lines : [lines];
    arr.forEach((l, i) => {
      const sep = i === arr.length - 1 ? ' ' : '-';
      this.send(`${code}${sep}${l}`);
    });
  }

  onConnect() {
    this.multiline(220, [
      `${this.server.cfg.hostname} ESMTP DomainMail`,
      `服务就绪 ${new Date().toISOString()}`,
    ]);
    this.state = 'ready';
  }

  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    if (this.dataMode) return this.consumeData();

    while (true) {
      const idx = this.buf.indexOf('\r\n');
      const idx2 = idx === -1 ? this.buf.indexOf('\n') : -1;
      const cut = idx !== -1 ? idx : idx2;
      if (cut === -1) {
        if (this.buf.length > MAX_LINE) {
          this.send('500 Line too long');
          this.socket.end();
        }
        return;
      }
      const line = this.buf.subarray(0, cut).toString('utf8');
      this.buf = this.buf.subarray(cut + (idx !== -1 ? 2 : 1));
      if (line.length > MAX_LINE) {
        this.send('500 Line too long');
        continue;
      }
      this.handleCommand(line);
      if (this.socket.destroyed) return;
    }
  }

  consumeData() {
    const marker = Buffer.from('\r\n.\r\n');
    const altMarker = Buffer.from('\n.\n');
    let end = this.buf.indexOf(marker);
    let endLen = 5;
    if (end === -1) {
      const e2 = this.buf.indexOf(altMarker);
      if (e2 !== -1) { end = e2; endLen = 3; }
    }
    if (end === -1) {
      if (this.buf.length > this.server.maxBytes) {
        this.dataMode = null;
        this.state = 'ready';
        this.send('552 Message size exceeds limit');
        this.buf = Buffer.alloc(0);
      }
      return;
    }
    const chunk = this.buf.subarray(0, end);
    this.buf = this.buf.subarray(end + endLen);
    const d = this.dataMode;
    this.dataMode = null;
    d.chunks.push(chunk);
    this.finishData(Buffer.concat(d.chunks));
  }

  async handleCommand(line) {
    const sp = line.indexOf(' ');
    const verb = (sp === -1 ? line : line.slice(0, sp)).toUpperCase();
    const arg = sp === -1 ? '' : line.slice(sp + 1).trim();

    if (this.state === 'greeting') {
      this.send('503 请先打招呼');
      return;
    }

    switch (verb) {
      case 'EHLO':
        return this.cmdEhlo(arg, true);
      case 'HELO':
        return this.cmdEhlo(arg, false);
      case 'STARTTLS':
        return this.cmdStartTls();
      case 'AUTH':
        return this.cmdAuth(arg);
      case 'MAIL':
        return this.cmdMail(arg);
      case 'RCPT':
        return this.cmdRcpt(arg);
      case 'DATA':
        return this.cmdData();
      case 'RSET':
        this.mailFrom = null;
        this.rcpts = [];
        this.state = 'ready';
        return this.send('250 2.0.0 已重置');
      case 'NOOP':
        return this.send('250 2.0.0 OK');
      case 'VRFY':
        return this.send('252 2.5.2 无法验证用户');
      case 'HELP':
        return this.multiline(214, ['EHLO HELO STARTTLS AUTH MAIL RCPT DATA RSET NOOP QUIT']);
      case 'QUIT':
        this.send('221 2.0.0 再见');
        return this.socket.end();
      default:
        return this.send('500 5.5.2 无法识别的命令');
    }
  }

  cmdEhlo(arg, extended) {
    if (!arg) return this.send('501 5.5.4 需要域名参数');
    this.helo = arg;
    this.state = 'ready';
    if (!extended) return this.send(`250 ${this.server.cfg.hostname}`);

    const lines = [
      this.server.cfg.hostname,
      `SIZE ${this.server.maxBytes}`,
      '8BITMIME',
      'PIPELINING',
      'SMTPUTF8',
      'ENHANCEDSTATUSCODES',
    ];
    if (this.server.tlsAvailable() && !this.secured) lines.push('STARTTLS');
    if (this.server.mode === 'submission') lines.push('AUTH PLAIN LOGIN');
    this.multiline(250, lines);
  }

  cmdStartTls() {
    if (this.secured) return this.send('503 5.5.1 已加密');
    if (!this.server.tlsAvailable()) return this.send('454 4.7.0 TLS 不可用');
    this.send('220 2.0.0 准备 TLS');
    const opts = this.server.tlsOptions();
    const secure = new tls.TLSSocket(this.socket, { isServer: true, ...opts });
    secure.on('secure', () => {
      this.socket = secure;
      this.secured = true;
      this.server.trackSocket(secure);
      secure.on('data', (c) => this.onData(c));
      secure.on('error', () => {});
      secure.on('close', () => this.onClose());
      this.state = 'ready';
      this.buf = Buffer.alloc(0);
    });
    secure.on('error', (e) => {
      log.warn('TLS 握手失败', e.message);
      this.socket.destroy();
    });
  }

  cmdAuth(arg) {
    if (this.server.mode !== 'submission') return this.send('503 5.5.1 该端口不支持认证');
    if (this.server.cfg.submission.requireTls && !this.secured) {
      return this.send('538 5.7.11 需要先 STARTTLS');
    }
    if (this.user) return this.send('503 5.5.1 已认证');
    const [mechRaw, initial] = arg.split(/\s+/);
    const mech = (mechRaw || '').toUpperCase();
    if (mech === 'PLAIN') {
      if (initial) return this.doPlainAuth(initial);
      this.send('334 ');
      return this.expectAuth('PLAIN');
    }
    if (mech === 'LOGIN') {
      this.send('334 VXNlcm5hbWU6');
      return this.expectAuth('LOGIN-USER');
    }
    return this.send('504 5.5.4 不支持的认证方式');
  }

  expectAuth(mode) {
    this.authMode = mode;
    const origHandler = this.handleCommand.bind(this);
    this.handleCommand = (line) => {
      if (this.authMode === 'PLAIN') {
        this.authMode = null;
        this.handleCommand = origHandler;
        return this.doPlainAuth(line.trim());
      }
      if (this.authMode === 'LOGIN-USER') {
        this.pendingUser = Buffer.from(line.trim(), 'base64').toString('utf8');
        this.authMode = 'LOGIN-PASS';
        this.send('334 UGFzc3dvcmQ6');
        return;
      }
      if (this.authMode === 'LOGIN-PASS') {
        const pass = Buffer.from(line.trim(), 'base64').toString('utf8');
        this.authMode = null;
        this.handleCommand = origHandler;
        return this.tryLogin(this.pendingUser, pass);
      }
    };
  }

  doPlainAuth(b64) {
    const raw = Buffer.from(b64, 'base64').toString('utf8');
    const parts = raw.split('\0');
    const user = parts.length >= 3 ? parts[1] : parts[0];
    const pass = parts.length >= 3 ? parts[2] : parts[1];
    return this.tryLogin(user, pass);
  }

  tryLogin(email, password) {
    const u = this.server.db.get('SELECT * FROM users WHERE email = ? AND active = 1', String(email).toLowerCase());
    if (!u || !verifyPassword(password, u.password_hash)) {
      log.warn(`认证失败 ${email} from ${this.remoteIp}`);
      return this.send('535 5.7.8 认证失败');
    }
    this.user = u;
    this.server.db.run('UPDATE users SET last_login_at = ? WHERE id = ?', Date.now(), u.id);
    log.info(`认证成功 ${u.email} from ${this.remoteIp}`);
    this.send('235 2.7.0 认证成功');
  }

  async cmdMail(arg) {
    if (this.server.mode === 'submission' && this.server.cfg.submission.requireTls && !this.secured) {
      return this.send('530 5.7.0 需要加密连接');
    }
    if (this.mailFrom) return this.send('503 5.5.1 已有进行中的事务');
    const m = /^FROM:\s*<([^>]*)>/i.exec(arg);
    if (!m) return this.send('501 5.5.4 语法错误：MAIL FROM:<addr>');
    const from = m[1].trim();

    if (this.server.mode === 'submission') {
      if (!this.user) return this.send('530 5.7.0 需要先认证');
      if (from && !this.server.canSendAs(this.user, from)) {
        return this.send('553 5.7.1 不允许使用该发件人地址');
      }
    }

    // SIZE 参数
    const sizeMatch = /SIZE=(\d+)/i.exec(arg);
    if (sizeMatch && Number(sizeMatch[1]) > this.server.maxBytes) {
      return this.send('552 5.3.4 邮件过大');
    }

    if (this.server.mode === 'inbound' && from) {
      const dom = from.split('@')[1];
      if (this.server.cfg.smtp.rejectUnknownSenderDomain && dom) {
        const mx = await resolveMx(dom);
        if (!mx || !mx.length) return this.send('550 5.1.8 发件域不存在');
      }
    }

    this.mailFrom = from;
    this.state = 'mail';
    this.send('250 2.1.0 发件人已接受');
  }

  cmdRcpt(arg) {
    if (!this.mailFrom) return this.send('503 5.5.1 需要先 MAIL FROM');
    const m = /^TO:\s*<([^>]*)>/i.exec(arg);
    if (!m) return this.send('501 5.5.4 语法错误：RCPT TO:<addr>');
    const to = m[1].trim().toLowerCase();
    if (!to.includes('@')) return this.send('501 5.1.3 地址格式错误');
    if (this.rcpts.length >= this.server.cfg.smtp.maxRecipients) {
      return this.send('452 4.5.3 收件人过多');
    }

    if (this.server.mode === 'inbound') {
      const dom = to.split('@')[1];
      const allowed = this.server.cfg.smtp.domains;
      const isAllowed = allowed.length ? allowed.includes(dom) : this.server.store.isLocalDomain(dom);
      if (!isAllowed) return this.send('550 5.1.2 不接收该域名邮件');
      if (!this.server.store.expandRecipient(to)) {
        return this.send('550 5.1.1 用户不存在');
      }
    }

    this.rcpts.push(to);
    this.state = 'rcpt';
    this.send('250 2.1.5 收件人已接受');
  }

  cmdData() {
    if (!this.rcpts.length) return this.send('503 5.5.1 需要先 RCPT TO');
    this.send('354 开始输入邮件内容，以 <CRLF>.<CRLF> 结束');
    this.dataMode = { chunks: [] };
    this.buf = Buffer.alloc(0);
  }

  async finishData(raw) {
    // 解除 dot-stuffing
    const text = raw.toString('latin1');
    const unstuffed = text.replace(/\r\n\.\./g, '\r\n.').replace(/^\.\./, '.');
    let body = Buffer.from(unstuffed, 'latin1');
    if (body.length > this.server.maxBytes) {
      this.reset();
      return this.send('552 5.3.4 邮件过大');
    }

    const from = this.mailFrom;
    const rcpts = [...this.rcpts];
    this.reset();

    try {
      if (this.server.mode === 'submission') {
        await this.server.handleSubmission({ session: this, raw: body, from, rcpts });
      } else {
        await this.server.handleInbound({ session: this, raw: body, from, rcpts });
      }
    } catch (e) {
      log.error('处理邮件失败', e);
      return this.send('451 4.3.0 服务器处理失败，请稍后重试');
    }
  }

  reset() {
    this.mailFrom = null;
    this.rcpts = [];
    this.state = 'ready';
    this.msgCount++;
  }

  onClose() {
    this.server.untrackSocket(this.socket);
  }
}

export class SmtpServer {
  constructor({ cfg, db, store, dkim, tlsProvider, mode = 'inbound', port }) {
    this.cfg = cfg;
    this.db = db;
    this.store = store;
    this.dkim = dkim;
    this.tlsProvider = tlsProvider;
    this.mode = mode;
    this.port = port ?? (mode === 'submission' ? cfg.submission.port : cfg.smtp.port);
    this.host = mode === 'submission' ? cfg.submission.host : cfg.smtp.host;
    this.maxBytes = mode === 'submission' ? cfg.submission.maxMessageBytes : cfg.smtp.maxMessageBytes;
    this.sockets = new Set();
    this.server = null;
    this.ipBuckets = new Map();
    this.userBuckets = new Map();
  }

  tlsAvailable() {
    return !!this.tlsProvider?.get();
  }

  tlsOptions() {
    const c = this.tlsProvider?.get();
    if (!c) return {};
    return { cert: c.cert, key: c.key, minVersion: this.cfg.tls.minVersion };
  }

  canSendAs(user, from) {
    const addr = String(from).toLowerCase();
    if (!addr) return true;
    if (addr === user.email.toLowerCase()) return true;
    const alias = this.db.get('SELECT * FROM aliases WHERE address = ? AND active = 1', addr);
    if (alias) {
      const targets = JSON.parse(alias.targets).map((t) => String(t).toLowerCase());
      if (targets.includes(user.email.toLowerCase())) return true;
    }
    return false;
  }

  rateLimit(key, limit) {
    const now = Date.now();
    const bucket = this.ipBuckets.get(key) || [];
    const recent = bucket.filter((t) => now - t < 60000);
    if (recent.length >= limit) return false;
    recent.push(now);
    this.ipBuckets.set(key, recent);
    return true;
  }

  trackSocket(s) {
    this.sockets.add(s);
    s.on('close', () => this.sockets.delete(s));
  }

  untrackSocket(s) {
    this.sockets.delete(s);
  }

  async handleInbound({ session, raw, from, rcpts }) {
    const ip = session.remoteIp;
    const limit = this.cfg.smtp.rateLimitPerIpPerMinute;
    if (limit > 0 && !this.rateLimit(`ip:${ip}`, limit)) {
      session.send('452 4.7.0 请求过于频繁');
      return;
    }

    const parsed = parseMessage(raw);

    // PTR 校验
    if (this.cfg.smtp.checkPtr !== 'none') {
      const ptrs = await resolvePtr(ip);
      if (!ptrs || !ptrs.length) {
        if (this.cfg.smtp.checkPtr === 'reject') {
          session.send('550 5.7.25 发信 IP 无反向解析');
          return;
        }
        log.warn(`无 PTR: ${ip}`);
      }
    }

    // SPF
    let spfResult = 'none';
    if (this.cfg.smtp.checkSpf !== 'none') {
      const r = await checkSpf({ ip, domain: session.helo, mailFrom: from });
      spfResult = r.result;
      if (spfResult === 'fail' && this.cfg.smtp.checkSpf === 'reject') {
        session.send('550 5.7.23 SPF 校验失败');
        return;
      }
    }

    const spam = await scoreSpam({ cfg: this.cfg, parsed, remoteIp: ip, helo: session.helo, mailFrom: from, spfResult });
    if (spam.reject) {
      log.warn(`拒收（评分 ${spam.score}）：${spam.reason} from ${ip}`);
      session.send('550 5.7.1 邮件被判定为垃圾邮件');
      return;
    }

    const folder = spam.spam ? 'Junk' : 'INBOX';
    const flags = spam.spam ? ['\\Seen'] : [];
    const saved = this.store.deliver({
      raw,
      to: rcpts,
      folder,
      flags,
      spam,
      remoteIp: ip,
    });

    if (!saved.length) {
      session.send('550 5.1.1 收件人不存在');
      return;
    }

    session.send(`250 2.0.0 已接收，队列 ID ${saved.map((s) => s.messageId).join(',')}`);
    log.info(`收信 from=<${from}> to=${rcpts.join(',')} ip=${ip} size=${raw.length} spam=${spam.score}`);

    // 自动回复 / 转发
    await this.postProcess({ parsed, raw, saved, from, rcpts });
  }

  async postProcess({ parsed, raw, saved, from, rcpts }) {
    for (const addr of rcpts) {
      const fwd = this.db.get('SELECT * FROM forwards WHERE address = ? AND active = 1', addr);
      if (fwd) {
        this.enqueue({ mailFrom: addr, rcptTo: fwd.target, raw });
        log.info(`转发 ${addr} -> ${fwd.target}`);
        if (!fwd.keep_copy) {
          for (const s of saved.filter((x) => x.mailbox === addr)) this.store.deleteMessage(s.userId, s.messageId);
        }
      }

      const ar = this.db.get('SELECT * FROM autoresponders WHERE address = ? AND active = 1', addr);
      if (ar && parsed.from.address && parsed.from.address !== addr) {
        const key = `ar:${addr}:${parsed.from.address}`;
        const last = Number(this.db.getSetting(key, '0'));
        if (Date.now() - last > 8 * 3600 * 1000) {
          this.db.setSetting(key, Date.now());
          const domain = addr.split('@')[1];
          const { raw: autoRaw } = buildMime({
            from: { name: this.cfg.brand, address: addr },
            to: [parsed.from],
            subject: ar.subject || `自动回复：${parsed.subject || ''}`,
            text: ar.body || '我暂时无法及时回复，稍后与您联系。',
            inReplyTo: parsed.messageId,
            extraHeaders: { 'Auto-Submitted': 'auto-replied' },
          });
          this.enqueue({ mailFrom: addr, rcptTo: parsed.from.address, raw: Buffer.from(autoRaw) });
          log.info(`自动回复 ${addr} -> ${parsed.from.address}`);
        }
      }
    }
  }

  enqueue({ mailFrom, rcptTo, raw, userId = null }) {
    return this.enqueueOut({ userId, mailFrom, rcptTo, raw });
  }

  async handleSubmission({ session, raw, from, rcpts }) {
    const user = session.user;
    const limit = this.cfg.submission.rateLimitPerUserPerMinute;
    if (limit > 0 && !this.rateLimit(`user:${user.id}`, limit)) {
      session.send('452 4.7.0 发送过于频繁');
      return;
    }

    const parsed = parseMessage(raw);

    // DKIM 签名
    let outRaw = raw;
    const senderDomain = (from || user.email).split('@')[1];
    const dkimCfg = this.dkim?.forDomain(senderDomain);
    if (dkimCfg) {
      try {
        outRaw = Buffer.from(this.dkim.sign(raw, dkimCfg));
      } catch (e) {
        log.warn('DKIM 签名失败', e.message);
      }
    }

    // 存到已发送
    const localRcpts = [];
    const remoteRcpts = [];
    for (const r of rcpts) {
      const dom = r.split('@')[1];
      if (this.store.isLocalDomain(dom) && this.store.expandRecipient(r)) localRcpts.push(r);
      else remoteRcpts.push(r);
    }

    this.store.appendSent({ userId: user.id, mailbox: user.email, raw: outRaw });

    for (const r of localRcpts) {
      const saved = this.store.deliver({ raw: outRaw, to: [r], folder: 'INBOX', remoteIp: session.remoteIp });
      log.info(`本地投递 ${user.email} -> ${r} (${saved.length})`);
    }

    for (const r of remoteRcpts) {
      const p = this.enqueueOut({ userId: user.id, mailFrom: from || user.email, rcptTo: r, raw: outRaw });
      log.info(`加入发信队列 ${from || user.email} -> ${r} id=${p?.lastInsertRowid ?? '-'}`);
    }

    session.send(`250 2.0.0 已接收，本地 ${localRcpts.length} 封，待投递 ${remoteRcpts.length} 封`);
    log.info(`提交 from=<${from || user.email}> to=${rcpts.join(',')} size=${raw.length} user=${user.email}`);
  }

  enqueueOut({ userId, mailFrom, rcptTo, raw }) {
    const dir = this.cfg.dataDir;
    const p = path.join(dir, 'spool', `${Date.now()}-${Math.random().toString(36).slice(2, 10)}.eml`);
    fs.writeFileSync(p, raw);
    const now = Date.now();
    const rel = path.relative(dir, p).split(path.sep).join('/');
    return this.db.run(
      'INSERT INTO outbox(user_id, mail_from, rcpt_to, raw_path, status, attempts, next_try_at, created_at, updated_at) VALUES(?,?,?,?,?,0,?,?,?)',
      userId, mailFrom, rcptTo, rel, 'queued', now, now, now
    );
  }

  listen() {
    return new Promise((resolve, reject) => {
      const srv = net.createServer((socket) => {
        socket.setTimeout(0);
        socket.on('error', () => {});
        const sess = new SmtpSession(this, socket);
        this.trackSocket(socket);
        socket.on('data', (c) => sess.onData(c));
        socket.on('close', () => sess.onClose());
        sess.onConnect();
      });
      srv.on('error', reject);
      srv.listen(this.port, this.host, () => {
        log.info(`${this.mode === 'submission' ? '提交' : '收信'}服务监听 ${this.host}:${this.port}`);
        resolve(srv);
      });
      this.server = srv;
    });
  }

  close() {
    for (const s of this.sockets) {
      try { s.destroy(); } catch {}
    }
    this.sockets.clear();
    return new Promise((r) => (this.server ? this.server.close(() => r()) : r()));
  }
}
