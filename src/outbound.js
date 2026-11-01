// 出站投递队列：MX 解析 → 直连投递（25）或走中继（587），失败指数退避重试
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import { createLogger } from './logger.js';
import { resolveMx } from './policy.js';

const log = createLogger('outbound');

function isPrivateIp(ip) {
  const v4 = ip.replace(/^::ffff:/, '');
  if (net.isIPv4(v4)) {
    const [a, b] = v4.split('.').map(Number);
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (net.isIPv6(v4)) {
    const l = v4.toLowerCase();
    return l === '::1' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80');
  }
  return false;
}

class SmtpClient {
  constructor({ host, port, secure = false, timeoutMs = 20000 }) {
    this.host = host;
    this.port = port;
    this.secure = secure;
    this.timeoutMs = timeoutMs;
    this.socket = null;
    this.buf = '';
    this.waiters = [];
    this.capabilities = [];
    this.secured = secure;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const opts = { host: this.host, port: this.port, servername: net.isIP(this.host) ? undefined : this.host };
      const sock = this.secure
        ? tls.connect({ ...opts, rejectUnauthorized: false })
        : net.connect(opts);
      this.socket = sock;
      sock.setTimeout(this.timeoutMs, () => {
        sock.destroy(new Error('timeout'));
      });
      sock.on('error', (e) => {
        this.fail(e);
        reject(e);
      });
      sock.on('close', () => this.fail(new Error('connection closed')));
      sock.on('data', (c) => this.onData(c));
      const onReady = async () => {
        try {
          const greet = await this.read();
          if (greet.code !== 220) throw new Error(`greeting ${greet.code} ${greet.text}`);
          resolve(this);
        } catch (e) {
          reject(e);
        }
      };
      if (this.secure) sock.once('secureConnect', onReady);
      else sock.once('connect', onReady);
    });
  }

  fail(err) {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w.reject(err);
  }

  onData(chunk) {
    this.buf += chunk.toString('latin1');
    while (true) {
      const lines = this.buf.split('\r\n');
      if (lines.length < 2) break;
      // 收集完整的多行响应
      let consumed = 0;
      let code = 0;
      let texts = [];
      let done = false;
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i];
        if (!/^\d{3}/.test(line)) { consumed += line.length + 2; continue; }
        code = Number(line.slice(0, 3));
        const sep = line[3];
        texts.push(line.slice(4));
        consumed += line.length + 2;
        if (sep !== '-') { done = true; break; }
      }
      if (!done) break;
      this.buf = this.buf.slice(consumed);
      const resp = { code, text: texts.join('\n') };
      const w = this.waiters.shift();
      if (w) w.resolve(resp);
    }
  }

  read() {
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  async cmd(line, expect) {
    this.socket.write(line + '\r\n');
    const r = await this.read();
    if (expect && !expect.includes(r.code)) {
      const err = new Error(`SMTP ${r.code}: ${r.text}`);
      err.code = r.code;
      err.smtp = r;
      throw err;
    }
    return r;
  }

  async ehlo(name) {
    let r;
    try {
      r = await this.cmd(`EHLO ${name}`);
    } catch {
      r = await this.cmd(`HELO ${name}`, [250]);
    }
    this.capabilities = r.text.split('\n').map((s) => s.trim()).filter(Boolean);
    return this.capabilities;
  }

  hasCap(name) {
    const n = name.toUpperCase();
    return this.capabilities.some((c) => c.toUpperCase().startsWith(n));
  }

  async startTls(servername) {
    return new Promise((resolve, reject) => {
      const sock = tls.connect({
        socket: this.socket,
        servername,
        rejectUnauthorized: false,
      }, () => {
        this.socket = sock;
        this.secured = true;
        this.buf = '';
        sock.on('data', (c) => this.onData(c));
        sock.on('error', (e) => this.fail(e));
        sock.on('close', () => this.fail(new Error('connection closed')));
        resolve();
      });
      sock.once('error', reject);
    });
  }

  async authLogin(user, pass) {
    await this.cmd('AUTH LOGIN', [334]);
    await this.cmd(Buffer.from(user).toString('base64'), [334]);
    await this.cmd(Buffer.from(pass).toString('base64'), [235]);
  }

  async authPlain(user, pass) {
    const token = Buffer.from(`\0${user}\0${pass}`).toString('base64');
    await this.cmd(`AUTH PLAIN ${token}`, [235]);
  }

  async quit() {
    try {
      await this.cmd('QUIT', [221]);
    } catch {}
    try { this.socket.end(); } catch {}
  }

  destroy() {
    try { this.socket.destroy(); } catch {}
  }
}

export class OutboxQueue {
  constructor({ cfg, db, dkim, tlsProvider }) {
    this.cfg = cfg;
    this.db = db;
    this.dkim = dkim;
    this.tlsProvider = tlsProvider;
    this.timer = null;
    this.running = false;
    this.active = 0;
    this.stopped = false;
    this.heloName = cfg.hostname;
  }

  add({ userId = null, mailFrom, rcptTo, raw }) {
    const dir = this.cfg.dataDir;
    const p = path.join(dir, 'spool', `${Date.now()}-${Math.random().toString(36).slice(2, 10)}.eml`);
    fs.writeFileSync(p, raw);
    const rel = path.relative(dir, p).split(path.sep).join('/');
    const now = Date.now();
    return this.db.run(
      'INSERT INTO outbox(user_id, mail_from, rcpt_to, raw_path, status, attempts, next_try_at, created_at, updated_at) VALUES(?,?,?,?,?,0,?,?,?)',
      userId, mailFrom, rcptTo, rel, 'queued', now, now, now
    );
  }

  start() {
    if (!this.cfg.outbound.enabled) {
      log.info('出站投递已禁用');
      return;
    }
    this.stopped = false;
    const tick = async () => {
      if (this.stopped) return;
      try {
        await this.processBatch();
      } catch (e) {
        log.error('队列处理异常', e.message);
      }
      this.timer = setTimeout(tick, this.cfg.outbound.pollIntervalMs);
    };
    this.timer = setTimeout(tick, 300);
    log.info(`出站队列已启动，轮询 ${this.cfg.outbound.pollIntervalMs}ms`);
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    while (this.active > 0) await new Promise((r) => setTimeout(r, 50));
  }

  async processBatch() {
    if (this.active >= this.cfg.outbound.concurrency) return;
    const now = Date.now();
    const rows = this.db.all(
      "SELECT * FROM outbox WHERE status = 'queued' AND next_try_at <= ? ORDER BY id LIMIT ?",
      now, this.cfg.outbound.concurrency - this.active
    );
    const jobs = rows.map((row) => this.processOne(row).catch((e) => log.error('投递异常', e.message)));
    await Promise.all(jobs);
  }

  async processOne(row) {
    this.active++;
    this.db.run("UPDATE outbox SET status = 'sending', updated_at = ? WHERE id = ?", Date.now(), row.id);
    try {
      const raw = fs.readFileSync(path.join(this.cfg.dataDir, row.raw_path));
      await this.deliver({ mailFrom: row.mail_from, rcptTo: row.rcpt_to, raw });
      this.db.run("UPDATE outbox SET status = 'sent', updated_at = ?, last_error = '' WHERE id = ?", Date.now(), row.id);
      log.info(`投递成功 ${row.mail_from} -> ${row.rcpt_to} (id=${row.id})`);
    } catch (e) {
      const attempts = row.attempts + 1;
      const permanent = e.code >= 500 && e.code < 600;
      const exhausted = attempts >= this.cfg.outbound.maxAttempts;
      if (permanent || exhausted) {
        this.db.run(
          "UPDATE outbox SET status = 'failed', attempts = ?, updated_at = ?, last_error = ? WHERE id = ?",
          attempts, Date.now(), String(e.message).slice(0, 500), row.id
        );
        log.warn(`投递失败（终止）${row.mail_from} -> ${row.rcpt_to}: ${e.message}`);
      } else {
        const backoff = Math.min(
          this.cfg.outbound.retryBaseSeconds * 2 ** (attempts - 1),
          this.cfg.outbound.maxBackoffSeconds
        );
        this.db.run(
          "UPDATE outbox SET status = 'queued', attempts = ?, next_try_at = ?, updated_at = ?, last_error = ? WHERE id = ?",
          attempts, Date.now() + backoff * 1000, Date.now(), String(e.message).slice(0, 500), row.id
        );
        log.info(`投递重试 ${row.rcpt_to} 第 ${attempts} 次，${backoff}s 后重试：${e.message}`);
      }
    } finally {
      this.active--;
    }
  }

  async deliver({ mailFrom, rcptTo, raw }) {
    const relay = this.cfg.outbound.relay;
    if (relay.enabled) {
      if (relay.type === 'resend') return this.deliverViaResend({ mailFrom, rcptTo, raw });
      return this.deliverViaRelay({ mailFrom, rcptTo, raw });
    }
    return this.deliverDirect({ mailFrom, rcptTo, raw });
  }

  async deliverDirect({ mailFrom, rcptTo, raw }) {
    const domain = rcptTo.split('@')[1];
    if (!domain) throw new Error('收件人域名无效');
    const mxs = await resolveMx(domain);
    if (!mxs || !mxs.length) {
      const err = new Error(`域名 ${domain} 无 MX 记录`);
      err.code = 550;
      throw err;
    }

    let lastErr = null;
    for (const mx of mxs) {
      try {
        let addrs;
        try {
          addrs = await dns.resolve4(mx.exchange);
        } catch {
          addrs = await dns.resolve6(mx.exchange).catch(() => []);
        }
        if (!addrs || !addrs.length) throw new Error(`MX ${mx.exchange} 无法解析`);

        for (const ip of addrs) {
          if (!this.cfg.outbound.allowPrivateRelay && isPrivateIp(ip)) {
            throw new Error(`拒绝投递到内网地址 ${ip}`);
          }
          const client = new SmtpClient({
            host: ip,
            port: 25,
            timeoutMs: this.cfg.outbound.connectTimeoutMs,
          });
          try {
            await client.connect();
            await client.ehlo(this.heloName);
            if (client.hasCap('STARTTLS')) {
              await client.cmd('STARTTLS', [220]);
              await client.startTls(mx.exchange);
              await client.ehlo(this.heloName);
            }
            await client.cmd(`MAIL FROM:<${mailFrom}>`, [250]);
            await client.cmd(`RCPT TO:<${rcptTo}>`, [250, 251]);
            await client.cmd('DATA', [354]);
            const stuffed = raw.toString('latin1').replace(/\r\n\./g, '\r\n..').replace(/^\./, '..');
            client.socket.write(stuffed);
            if (!stuffed.endsWith('\r\n')) client.socket.write('\r\n');
            client.socket.write('.\r\n');
            const r = await client.read();
            if (r.code !== 250) {
              const err = new Error(`DATA 被拒 ${r.code}: ${r.text}`);
              err.code = r.code;
              throw err;
            }
            await client.quit();
            return true;
          } catch (e) {
            lastErr = e;
            client.destroy();
            if (e.code >= 500 && e.code < 600) throw e;
          }
        }
      } catch (e) {
        lastErr = e;
        if (e.code >= 500 && e.code < 600) throw e;
      }
    }
    throw lastErr || new Error('所有 MX 投递失败');
  }

  async deliverViaRelay({ mailFrom, rcptTo, raw }) {
    const r = this.cfg.outbound.relay;
    const client = new SmtpClient({
      host: r.host,
      port: r.port,
      secure: !!r.secure,
      timeoutMs: this.cfg.outbound.connectTimeoutMs,
    });
    await client.connect();
    await client.ehlo(this.heloName);
    if (!client.secured && client.hasCap('STARTTLS')) {
      await client.cmd('STARTTLS', [220]);
      await client.startTls(r.host);
      await client.ehlo(this.heloName);
    }
    if (r.user) {
      if (client.hasCap('AUTH')) {
        try { await client.authPlain(r.user, r.pass); }
        catch { await client.authLogin(r.user, r.pass); }
      }
    }
    await client.cmd(`MAIL FROM:<${mailFrom}>`, [250]);
    await client.cmd(`RCPT TO:<${rcptTo}>`, [250, 251]);
    await client.cmd('DATA', [354]);
    const stuffed = raw.toString('latin1').replace(/\r\n\./g, '\r\n..').replace(/^\./, '..');
    client.socket.write(stuffed);
    if (!stuffed.endsWith('\r\n')) client.socket.write('\r\n');
    client.socket.write('.\r\n');
    const resp = await client.read();
    if (resp.code !== 250) {
      const err = new Error(`中继拒收 ${resp.code}: ${resp.text}`);
      err.code = resp.code;
      throw err;
    }
    await client.quit();
    return true;
  }

  async deliverViaResend({ mailFrom, rcptTo, raw }) {
    const r = this.cfg.outbound.relay;
    const { parseMessage } = await import('./mime.js');
    const parsed = parseMessage(raw);
    const body = {
      from: mailFrom,
      to: [rcptTo],
      subject: parsed.subject || '(无主题)',
      text: parsed.text || '',
      html: parsed.html || undefined,
      attachments: parsed.attachments.map((a) => ({
        filename: a.filename,
        content: a.content.toString('base64'),
      })),
      headers: parsed.messageId ? { 'Message-ID': `<${parsed.messageId}>` } : {},
    };
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${r.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      const err = new Error(`Resend ${res.status}: ${text.slice(0, 300)}`);
      err.code = res.status >= 400 && res.status < 500 ? 550 : 450;
      throw err;
    }
    return true;
  }

  stats() {
    const rows = this.db.all('SELECT status, COUNT(*) AS c FROM outbox GROUP BY status');
    const out = { queued: 0, sending: 0, sent: 0, failed: 0 };
    for (const r of rows) out[r.status] = Number(r.c);
    return out;
  }
}
