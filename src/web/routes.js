// 路由定义：认证、邮件、设置、管理后台
import fs from 'node:fs';
import { DomainError, isValidEmail, normalizeEmail } from '../account.js';
import { HttpError, rawResponse } from './server.js';
import { buildMime } from '../mime.js';
import { SYSTEM_FOLDERS } from '../store.js';

export function registerRoutes(web, { cfg, db, store, dkim, account, outbox, tlsProvider }) {
  const adminPath = cfg.http.adminPath || '/admin';

  const wrap = (fn) => async (ctx) => {
    try {
      return await fn(ctx);
    } catch (e) {
      if (e instanceof DomainError) throw new HttpError(400, e.message);
      throw e;
    }
  };

  // ============ 认证 ============
  web.post('/api/auth/login', wrap(async (ctx) => {
    const { email, password } = ctx.body || {};
    if (!email || !password) throw new HttpError(400, '请输入邮箱和密码');
    const u = account.login(email, password, ctx.ip);
    web.setSession(ctx, { uid: u.id });
    return { ok: true, user: publicUser(u) };
  }));

  web.post('/api/auth/logout', async (ctx) => {
    web.clearSession(ctx);
    return { ok: true };
  });

  web.get('/api/auth/me', wrap(async (ctx) => {
    const u = web.requireUser(ctx);
    return { user: publicUser(u) };
  }));

  web.post('/api/auth/register', wrap(async (ctx) => {
    const { email, password, displayName } = ctx.body || {};
    const u = account.register(email, password, displayName);
    web.setSession(ctx, { uid: u.id });
    return { ok: true, user: publicUser(u) };
  }));

  web.get('/api/auth/register-config', async () => ({
    allowSelfRegister: !!cfg.http.allowSelfRegister,
    registerDomains: cfg.http.registerDomains || [],
    brand: cfg.brand,
  }));

  web.post('/api/auth/password', wrap(async (ctx) => {
    const u = web.requireUser(ctx);
    const { oldPassword, newPassword } = ctx.body || {};
    account.changePassword(u.id, oldPassword, newPassword);
    return { ok: true };
  }));

  // ============ 文件夹与邮件 ============
  web.get('/api/folders', wrap(async (ctx) => {
    const u = web.requireUser(ctx);
    const counts = store.folderCounts(u.id);
    return {
      folders: SYSTEM_FOLDERS.map((f) => ({ name: f, ...counts[f] })),
      total: Object.values(counts).reduce((a, b) => a + b.total, 0),
    };
  }));

  web.get('/api/messages', wrap(async (ctx) => {
    const u = web.requireUser(ctx);
    const folder = ctx.query.get('folder') || 'INBOX';
    const limit = Math.min(Number(ctx.query.get('limit')) || 30, 200);
    const offset = Number(ctx.query.get('offset')) || 0;
    const search = ctx.query.get('q') || '';
    const unreadOnly = ctx.query.get('unread') === '1';
    const rows = store.listMessages(u.id, folder, { limit, offset, search, unreadOnly });
    return {
      messages: rows.map((r) => ({
        id: r.id,
        uid: r.uid,
        folder: r.folder,
        subject: r.subject || '(无主题)',
        from: r.from_addr,
        fromName: r.from_name,
        to: r.to_addrs,
        date: r.date,
        size: r.size,
        snippet: r.snippet,
        hasAttachment: !!r.has_attachment,
        seen: r.flags.includes('\\Seen'),
        flagged: r.flags.includes('\\Flagged'),
        spamScore: r.spam_score,
      })),
      total: store.countFolder(u.id, folder).total,
    };
  }));

  web.get('/api/messages/:id', wrap(async (ctx) => {
    const u = web.requireUser(ctx);
    const msg = store.getMessage(u.id, Number(ctx.params.id));
    if (!msg) throw new HttpError(404, '邮件不存在');
    store.addFlags(u.id, msg.id, ['\\Seen']);
    const atts = store.attachmentsOf(msg.id).map((a) => ({
      id: a.id, filename: a.filename, mime: a.mime, size: a.size, inline: !!a.is_inline,
    }));
    return {
      id: msg.id,
      subject: msg.subject,
      from: msg.from_addr,
      fromName: msg.from_name,
      to: msg.to_addrs,
      cc: msg.cc_addrs,
      date: msg.date,
      size: msg.size,
      text: msg.body_text,
      html: msg.body_html,
      messageId: msg.message_id,
      folder: msg.folder,
      flags: msg.flags.split(' ').filter(Boolean),
      spamScore: msg.spam_score,
      spamReason: msg.spam_reason,
      attachments: atts,
    };
  }));

  web.get('/api/messages/:id/raw', wrap(async (ctx) => {
    const u = web.requireUser(ctx);
    const msg = store.getMessage(u.id, Number(ctx.params.id));
    if (!msg) throw new HttpError(404, '邮件不存在');
    const raw = store.readRaw(msg);
    return rawResponse(raw, 200, {
      'Content-Type': 'message/rfc822',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(msg.subject || 'message')}.eml"`,
    });
  }));

  web.get('/api/attachments/:id', wrap(async (ctx) => {
    const u = web.requireUser(ctx);
    const att = db.get('SELECT * FROM attachments WHERE id = ?', Number(ctx.params.id));
    if (!att) throw new HttpError(404, '附件不存在');
    const msg = store.getMessage(u.id, att.message_id);
    if (!msg) throw new HttpError(403, '无权访问');
    const full = store.rawFullPath(att.path);
    if (!fs.existsSync(full)) throw new HttpError(404, '文件已丢失');
    const body = fs.readFileSync(full);
    return rawResponse(body, 200, {
      'Content-Type': att.mime || 'application/octet-stream',
      'Content-Disposition': `${att.is_inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(att.filename)}`,
      'Content-Length': body.length,
    });
  }));

  web.post('/api/messages/:id/flags', wrap(async (ctx) => {
    const u = web.requireUser(ctx);
    const { add = [], remove = [] } = ctx.body || {};
    if (add.length) store.addFlags(u.id, Number(ctx.params.id), add);
    if (remove.length) store.removeFlags(u.id, Number(ctx.params.id), remove);
    return { ok: true };
  }));

  web.post('/api/messages/:id/move', wrap(async (ctx) => {
    const u = web.requireUser(ctx);
    const { folder } = ctx.body || {};
    store.moveMessage(u.id, Number(ctx.params.id), folder);
    return { ok: true };
  }));

  web.delete('/api/messages/:id', wrap(async (ctx) => {
    const u = web.requireUser(ctx);
    store.deleteMessage(u.id, Number(ctx.params.id));
    return { ok: true };
  }));

  web.post('/api/folders/:folder/empty', wrap(async (ctx) => {
    const u = web.requireUser(ctx);
    const n = store.emptyFolder(u.id, ctx.params.folder);
    return { ok: true, deleted: n };
  }));

  // ============ 发信 ============
  web.post('/api/send', wrap(async (ctx) => {
    const u = web.requireUser(ctx);
    const { to = '', cc = '', bcc = '', subject = '', text = '', html = '', attachments = [], inReplyTo = '', references = '', from } = ctx.body || {};

    const parseList = (s) => String(s).split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
    const toList = parseList(to).map((a) => ({ name: '', address: normalizeEmail(a) }));
    const ccList = parseList(cc).map((a) => ({ name: '', address: normalizeEmail(a) }));
    const bccList = parseList(bcc).map((a) => ({ name: '', address: normalizeEmail(a) }));

    if (!toList.length && !ccList.length && !bccList.length) throw new HttpError(400, '至少需要一个收件人');
    for (const a of [...toList, ...ccList, ...bccList]) {
      if (!isValidEmail(a.address)) throw new HttpError(400, `收件人地址无效：${a.address}`);
    }

    const senderAddr = normalizeEmail(from || u.email);
    if (senderAddr !== u.email) {
      const alias = db.get('SELECT * FROM aliases WHERE address = ? AND active = 1', senderAddr);
      if (!alias) throw new HttpError(403, '不能使用该发件人地址');
    }

    const atts = [];
    for (const a of attachments) {
      if (!a?.filename || !a?.content) continue;
      atts.push({
        filename: a.filename,
        mime: a.mime || 'application/octet-stream',
        content: Buffer.from(a.content, 'base64'),
        contentId: a.contentId || '',
        inline: !!a.inline,
      });
    }

    const { raw, messageId } = buildMime({
      from: { name: u.display_name || '', address: senderAddr },
      to: toList,
      cc: ccList,
      bcc: bccList,
      subject,
      text,
      html,
      attachments: atts,
      inReplyTo,
      references,
    });

    // DKIM
    let outRaw = raw;
    const domain = senderAddr.split('@')[1];
    if (dkim.forDomain(domain)) {
      try { outRaw = dkim.sign(raw, domain); } catch (e) { /* 签名失败不阻断 */ }
    }

    store.appendSent({ userId: u.id, mailbox: u.email, raw: outRaw });

    const allRcpt = [...toList, ...ccList, ...bccList].map((a) => a.address);
    let local = 0;
    let queued = 0;
    for (const r of allRcpt) {
      const dom = r.split('@')[1];
      if (store.isLocalDomain(dom) && store.expandRecipient(r)) {
        store.deliver({ raw: outRaw, to: [r], folder: 'INBOX' });
        local++;
      } else {
        outbox.add({ userId: u.id, mailFrom: senderAddr, rcptTo: r, raw: outRaw });
        queued++;
      }
    }

    db.run('INSERT INTO audit(at, actor, action, detail) VALUES(?,?,?,?)', Date.now(), u.email, 'send', `${subject} -> ${allRcpt.join(',')}`);
    return { ok: true, messageId, local, queued };
  }));

  // ============ 个人设置 ============
  web.get('/api/settings', wrap(async (ctx) => {
    const u = web.requireUser(ctx);
    const fwd = account.listForwards(u.id)[0] || null;
    const ar = account.getAutoresponder(u.email);
    return {
      user: publicUser(u),
      forward: fwd,
      autoresponder: ar,
      quotaMb: u.quota_mb,
      usedMb: Math.round((db.get('SELECT SUM(size) AS s FROM messages WHERE user_id = ?', u.id)?.s || 0) / 1048576),
      imap: { host: cfg.hostname, port: cfg.imap.port },
      smtp: { host: cfg.hostname, port: cfg.submission.port },
      apiKeys: account.listApiKeys(u.id),
    };
  }));

  web.post('/api/settings/forward', wrap(async (ctx) => {
    const u = web.requireUser(ctx);
    const { target, keepCopy } = ctx.body || {};
    if (!target) {
      account.deleteForward(u.email);
      return { ok: true, forward: null };
    }
    return { ok: true, forward: account.setForward(u.email, target, keepCopy ? 1 : 0) };
  }));

  web.post('/api/settings/autoresponder', wrap(async (ctx) => {
    const u = web.requireUser(ctx);
    const { subject, body, active } = ctx.body || {};
    if (active === false || (!subject && !body)) {
      account.deleteAutoresponder(u.email);
      return { ok: true, autoresponder: null };
    }
    return { ok: true, autoresponder: account.setAutoresponder(u.email, { subject, body, active: 1 }) };
  }));

  web.post('/api/settings/profile', wrap(async (ctx) => {
    const u = web.requireUser(ctx);
    const { displayName } = ctx.body || {};
    account.updateUser(u.id, { display_name: displayName || '' });
    return { ok: true };
  }));

  web.post('/api/settings/apikeys', wrap(async (ctx) => {
    const u = web.requireUser(ctx);
    const { name } = ctx.body || {};
    return account.createApiKey(u.id, name || '');
  }));

  web.delete('/api/settings/apikeys/:id', wrap(async (ctx) => {
    const u = web.requireUser(ctx);
    account.deleteApiKey(u.id, Number(ctx.params.id));
    return { ok: true };
  }));

  // ============ 管理后台 ============
  web.get('/api/admin/stats', wrap(async (ctx) => {
    web.requireAdmin(ctx);
    return account.stats();
  }));

  web.get('/api/admin/domains', wrap(async (ctx) => {
    web.requireAdmin(ctx);
    return { domains: account.listDomains() };
  }));

  web.post('/api/admin/domains', wrap(async (ctx) => {
    web.requireAdmin(ctx);
    const { name, catchAll } = ctx.body || {};
    const d = account.addDomain(name, { catchAll });
    return { ok: true, domain: d, dns: dnsGuide(d.name) };
  }));

  web.put('/api/admin/domains/:id', wrap(async (ctx) => {
    web.requireAdmin(ctx);
    const d = account.updateDomain(Number(ctx.params.id), ctx.body || {});
    return { ok: true, domain: d };
  }));

  web.delete('/api/admin/domains/:id', wrap(async (ctx) => {
    web.requireAdmin(ctx);
    account.deleteDomain(Number(ctx.params.id));
    return { ok: true };
  }));

  web.get('/api/admin/domains/:id/dns', wrap(async (ctx) => {
    web.requireAdmin(ctx);
    const d = db.get('SELECT * FROM domains WHERE id = ?', Number(ctx.params.id));
    if (!d) throw new HttpError(404, '域名不存在');
    const rec = dkim.dnsRecordFor(d.name);
    return { domain: d.name, records: dnsGuide(d.name), dkim: rec };
  }));

  web.post('/api/admin/domains/:id/dkim/rotate', wrap(async (ctx) => {
    web.requireAdmin(ctx);
    const d = db.get('SELECT * FROM domains WHERE id = ?', Number(ctx.params.id));
    if (!d) throw new HttpError(404, '域名不存在');
    const k = dkim.rotate(d.name, { selector: d.dkim_selector });
    return { ok: true, dkim: dkim.dnsRecordFor(d.name) };
  }));

  web.get('/api/admin/users', wrap(async (ctx) => {
    web.requireAdmin(ctx);
    return {
      users: account.listUsers({
        domain: ctx.query.get('domain') || null,
        q: ctx.query.get('q') || '',
      }),
    };
  }));

  web.post('/api/admin/users', wrap(async (ctx) => {
    web.requireAdmin(ctx);
    const { email, password, displayName, isAdmin, quotaMb } = ctx.body || {};
    const u = account.createUser({ email, password, displayName, isAdmin, quotaMb });
    return { ok: true, user: publicUser(u) };
  }));

  web.put('/api/admin/users/:id', wrap(async (ctx) => {
    web.requireAdmin(ctx);
    const u = account.updateUser(Number(ctx.params.id), ctx.body || {});
    return { ok: true, user: publicUser(u) };
  }));

  web.post('/api/admin/users/:id/password', wrap(async (ctx) => {
    web.requireAdmin(ctx);
    account.setPassword(Number(ctx.params.id), ctx.body?.password);
    return { ok: true };
  }));

  web.delete('/api/admin/users/:id', wrap(async (ctx) => {
    web.requireAdmin(ctx);
    account.deleteUser(Number(ctx.params.id));
    return { ok: true };
  }));

  web.get('/api/admin/aliases', wrap(async (ctx) => {
    web.requireAdmin(ctx);
    return { aliases: account.listAliases() };
  }));

  web.post('/api/admin/aliases', wrap(async (ctx) => {
    web.requireAdmin(ctx);
    const { address, targets } = ctx.body || {};
    return { ok: true, alias: account.createAlias(address, targets) };
  }));

  web.delete('/api/admin/aliases/:id', wrap(async (ctx) => {
    web.requireAdmin(ctx);
    account.deleteAlias(Number(ctx.params.id));
    return { ok: true };
  }));

  web.get('/api/admin/forwards', wrap(async (ctx) => {
    web.requireAdmin(ctx);
    return { forwards: account.listForwards() };
  }));

  web.post('/api/admin/forwards', wrap(async (ctx) => {
    web.requireAdmin(ctx);
    const { address, target, keepCopy } = ctx.body || {};
    return { ok: true, forward: account.setForward(address, target, keepCopy ? 1 : 0) };
  }));

  web.delete('/api/admin/forwards/:address', wrap(async (ctx) => {
    web.requireAdmin(ctx);
    account.deleteForward(ctx.params.address);
    return { ok: true };
  }));

  web.get('/api/admin/outbox', wrap(async (ctx) => {
    web.requireAdmin(ctx);
    const rows = db.all('SELECT * FROM outbox ORDER BY id DESC LIMIT 100');
    return { queue: rows, stats: outbox.stats() };
  }));

  web.post('/api/admin/outbox/:id/retry', wrap(async (ctx) => {
    web.requireAdmin(ctx);
    db.run("UPDATE outbox SET status = 'queued', next_try_at = 0, attempts = 0 WHERE id = ?", Number(ctx.params.id));
    return { ok: true };
  }));

  web.delete('/api/admin/outbox/:id', wrap(async (ctx) => {
    web.requireAdmin(ctx);
    const row = db.get('SELECT * FROM outbox WHERE id = ?', Number(ctx.params.id));
    if (row) {
      try { fs.unlinkSync(store.rawFullPath(row.raw_path)); } catch {}
      db.run('DELETE FROM outbox WHERE id = ?', row.id);
    }
    return { ok: true };
  }));

  web.get('/api/admin/audit', wrap(async (ctx) => {
    web.requireAdmin(ctx);
    return { audit: db.all('SELECT * FROM audit ORDER BY id DESC LIMIT 200') };
  }));

  web.get('/api/admin/config', wrap(async (ctx) => {
    web.requireAdmin(ctx);
    return {
      hostname: cfg.hostname,
      brand: cfg.brand,
      smtpPort: cfg.smtp.port,
      submissionPort: cfg.submission.port,
      imapPort: cfg.imap.port,
      httpPort: cfg.http.port,
      tls: {
        enabled: !!tlsProvider.get(),
        certFile: cfg.tls.certFile,
      },
      relay: {
        enabled: !!cfg.outbound.relay.enabled,
        type: cfg.outbound.relay.type,
        host: cfg.outbound.relay.host,
      },
      allowSelfRegister: !!cfg.http.allowSelfRegister,
      dkimSelector: cfg.dkim.selector,
    };
  }));

  // ============ 邮件客户端自动配置 ============
  web.get('/api/client-config', wrap(async (ctx) => {
    const u = web.requireUser(ctx);
    return {
      email: u.email,
      imap: { host: cfg.hostname, port: cfg.imap.port, security: 'STARTTLS' },
      smtp: { host: cfg.hostname, port: cfg.submission.port, security: 'STARTTLS', auth: true },
      webmail: `http://${cfg.hostname}:${cfg.http.port}/`,
    };
  }));
}

function publicUser(u) {
  return {
    id: u.id,
    email: u.email,
    displayName: u.display_name,
    isAdmin: !!u.is_admin,
    quotaMb: u.quota_mb,
    createdAt: u.created_at,
  };
}

function dnsGuide(domain) {
  const host = _hostname;
  return [
    { type: 'MX', name: domain, value: `10 ${host}`, note: '收信指向本服务器' },
    { type: 'A', name: host, value: 'VPS_IP', note: '邮件服务器主机名解析' },
    { type: 'TXT', name: domain, value: 'v=spf1 mx ~all', note: 'SPF 发信授权' },
    { type: 'TXT', name: `_dmarc.${domain}`, value: `v=DMARC1; p=quarantine; rua=mailto:postmaster@${domain}`, note: 'DMARC 策略' },
    { type: 'PTR', name: 'VPS_IP', value: host, note: '反向解析，需在 VPS 商家面板设置' },
  ];
}

let _hostname = 'mail.example.com';
export function setDnsHostname(h) { _hostname = h; }
