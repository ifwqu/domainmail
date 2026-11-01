// 邮件存取层：用户解析、投递入库、文件夹/标记操作
import fs from 'node:fs';
import path from 'node:path';
import { parseMessage, buildMime, htmlToText } from './mime.js';
import { createLogger } from './logger.js';

const log = createLogger('store');

export const SYSTEM_FOLDERS = ['INBOX', 'Sent', 'Drafts', 'Trash', 'Junk'];

export class MailStore {
  constructor({ db, cfg, dkim }) {
    this.db = db;
    this.cfg = cfg;
    this.dkim = dkim;
  }

  // ---------- 地址解析 ----------
  resolveUser(email) {
    const addr = String(email || '').trim().toLowerCase();
    if (!addr.includes('@')) return null;
    const direct = this.db.get('SELECT * FROM users WHERE email = ? AND active = 1', addr);
    if (direct) return direct;

    const alias = this.db.get('SELECT * FROM aliases WHERE address = ? AND active = 1', addr);
    if (alias) {
      const target = JSON.parse(alias.targets)[0];
      if (target) {
        const u = this.db.get('SELECT * FROM users WHERE email = ? AND active = 1', target.toLowerCase());
        if (u) return u;
      }
    }

    const domain = addr.split('@')[1];
    const d = this.db.get('SELECT * FROM domains WHERE name = ? AND active = 1', domain);
    if (d && d.catch_all) {
      const u = this.db.get('SELECT * FROM users WHERE email = ? AND active = 1', d.catch_all.toLowerCase());
      if (u) return u;
    }
    return null;
  }

  expandRecipient(email) {
    // 返回 { user, deliveredAs } 或 null；支持别名多目标
    const addr = String(email || '').trim().toLowerCase();
    const direct = this.db.get('SELECT * FROM users WHERE email = ? AND active = 1', addr);
    if (direct) return [{ user: direct, deliveredAs: addr }];

    const alias = this.db.get('SELECT * FROM aliases WHERE address = ? AND active = 1', addr);
    if (alias) {
      const targets = JSON.parse(alias.targets);
      const out = [];
      for (const t of targets) {
        const u = this.db.get('SELECT * FROM users WHERE email = ? AND active = 1', String(t).toLowerCase());
        if (u) out.push({ user: u, deliveredAs: addr });
      }
      if (out.length) return out;
    }

    const domain = addr.split('@')[1];
    const d = this.db.get('SELECT * FROM domains WHERE name = ? AND active = 1', domain);
    if (d && d.catch_all) {
      const u = this.db.get('SELECT * FROM users WHERE email = ? AND active = 1', d.catch_all.toLowerCase());
      if (u) return [{ user: u, deliveredAs: addr }];
    }
    return null;
  }

  isLocalDomain(domain) {
    return !!this.db.get('SELECT id FROM domains WHERE name = ? AND active = 1', String(domain).toLowerCase());
  }

  // ---------- 入库 ----------
  saveRaw(raw) {
    const dir = path.join(this.cfg.dataDir, 'messages');
    const name = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}.eml`;
    const full = path.join(dir, name);
    fs.writeFileSync(full, raw);
    return path.relative(this.cfg.dataDir, full).split(path.sep).join('/');
  }

  rawFullPath(rel) {
    return path.join(this.cfg.dataDir, rel);
  }

  deliver({ raw, to, folder = 'INBOX', flags = [], spam = { score: 0, reason: '' }, remoteIp = '', userId = null, mailboxEmail = null }) {
    const parsed = parseMessage(raw);
    const targets = [];
    if (userId) {
      const u = this.db.get('SELECT * FROM users WHERE id = ?', userId);
      if (u) targets.push({ user: u, deliveredAs: mailboxEmail || u.email });
    } else {
      for (const t of to) {
        const expanded = this.expandRecipient(t);
        if (expanded) targets.push(...expanded);
      }
    }
    if (!targets.length) return [];

    const relPath = this.saveRaw(raw);
    const saved = [];

    for (const { user, deliveredAs } of targets) {
      const uid = this.db.nextUid(user.id, folder);
      const now = Date.now();
      const snippet = (parsed.text || htmlToText(parsed.html) || '').slice(0, 300);
      const info = this.db.run(
        `INSERT INTO messages
         (user_id, mailbox, uid, folder, message_id, subject, from_addr, from_name, to_addrs, cc_addrs,
          reply_to, date, size, snippet, body_text, body_html, raw_path, has_attachment, flags,
          spam_score, spam_reason, remote_ip, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        user.id,
        deliveredAs,
        uid,
        folder,
        parsed.messageId,
        parsed.subject,
        parsed.from.address,
        parsed.from.name,
        parsed.to.map((a) => a.address).join(', '),
        parsed.cc.map((a) => a.address).join(', '),
        parsed.replyTo?.address || '',
        parsed.date,
        parsed.size,
        snippet,
        parsed.text,
        parsed.html,
        relPath,
        parsed.attachments.length ? 1 : 0,
        flags.join(' '),
        spam.score || 0,
        spam.reason || '',
        remoteIp,
        now
      );
      const msgId = Number(info.lastInsertRowid);

      // 附件落盘
      const attDir = path.join(this.cfg.dataDir, 'attachments', String(msgId));
      for (const a of parsed.attachments) {
        fs.mkdirSync(attDir, { recursive: true });
        const safe = (a.filename || 'file').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
        const fname = `${Math.random().toString(36).slice(2, 8)}-${safe}`;
        const full = path.join(attDir, fname);
        fs.writeFileSync(full, a.content);
        this.db.run(
          'INSERT INTO attachments(message_id, filename, mime, size, content_id, is_inline, path) VALUES(?,?,?,?,?,?,?)',
          msgId,
          a.filename || 'file',
          a.mime,
          a.content.length,
          a.contentId || '',
          a.inline ? 1 : 0,
          path.relative(this.cfg.dataDir, full).split(path.sep).join('/')
        );
      }
      saved.push({ userId: user.id, messageId: msgId, uid, folder, mailbox: deliveredAs });
      log.info(`投递 user=${user.email} as=${deliveredAs} folder=${folder} uid=${uid} size=${parsed.size}`);
    }
    return saved;
  }

  // ---------- 读取 ----------
  listMessages(userId, folder, { limit = 50, offset = 0, search = '', unreadOnly = false, mailbox = null } = {}) {
    const where = ['user_id = ?', 'folder = ?'];
    const params = [userId, folder];
    if (mailbox) { where.push('mailbox = ?'); params.push(mailbox); }
    if (unreadOnly) where.push("instr(flags, '\\Seen') = 0");
    if (search) {
      where.push('(subject LIKE ? OR from_addr LIKE ? OR body_text LIKE ?)');
      const q = `%${search}%`;
      params.push(q, q, q);
    }
    const sql = `SELECT id, uid, folder, mailbox, subject, from_addr, from_name, to_addrs, date, size,
                        snippet, has_attachment, flags, spam_score, message_id
                 FROM messages WHERE ${where.join(' AND ')}
                 ORDER BY date DESC, id DESC LIMIT ? OFFSET ?`;
    return this.db.all(sql, ...params, limit, offset);
  }

  countFolder(userId, folder, mailbox = null) {
    const params = [userId, folder];
    let sql = 'SELECT COUNT(*) AS c, SUM(CASE WHEN instr(flags, \'\\Seen\') = 0 THEN 1 ELSE 0 END) AS u FROM messages WHERE user_id = ? AND folder = ?';
    if (mailbox) { sql += ' AND mailbox = ?'; params.push(mailbox); }
    const r = this.db.get(sql, ...params);
    return { total: Number(r?.c || 0), unread: Number(r?.u || 0) };
  }

  folderCounts(userId) {
    const rows = this.db.all(
      `SELECT folder, COUNT(*) AS c,
              SUM(CASE WHEN instr(flags, '\\Seen') = 0 THEN 1 ELSE 0 END) AS u
       FROM messages WHERE user_id = ? GROUP BY folder`,
      userId
    );
    const out = {};
    for (const f of SYSTEM_FOLDERS) out[f] = { total: 0, unread: 0 };
    for (const r of rows) out[r.folder] = { total: Number(r.c), unread: Number(r.u || 0) };
    return out;
  }

  getMessage(userId, id) {
    return this.db.get('SELECT * FROM messages WHERE id = ? AND user_id = ?', id, userId);
  }

  getMessageByUid(userId, folder, uid) {
    return this.db.get('SELECT * FROM messages WHERE user_id = ? AND folder = ? AND uid = ?', userId, folder, uid);
  }

  attachmentsOf(messageId) {
    return this.db.all('SELECT * FROM attachments WHERE message_id = ?', messageId);
  }

  readRaw(msg) {
    try {
      return fs.readFileSync(this.rawFullPath(msg.raw_path));
    } catch {
      // 兜底：从数据库字段重建
      const { raw } = buildMime({
        from: { name: msg.from_name, address: msg.from_addr },
        to: [{ name: '', address: msg.mailbox }],
        subject: msg.subject,
        text: msg.body_text,
        html: msg.body_html,
        date: new Date(msg.date),
        messageId: msg.message_id,
      });
      return Buffer.from(raw);
    }
  }

  // ---------- 修改 ----------
  addFlags(userId, id, flags) {
    const msg = this.getMessage(userId, id);
    if (!msg) return false;
    const set = new Set(msg.flags.split(' ').filter(Boolean));
    for (const f of flags) set.add(f);
    this.db.run('UPDATE messages SET flags = ? WHERE id = ?', [...set].join(' '), id);
    return true;
  }

  removeFlags(userId, id, flags) {
    const msg = this.getMessage(userId, id);
    if (!msg) return false;
    const set = new Set(msg.flags.split(' ').filter(Boolean));
    for (const f of flags) set.delete(f);
    this.db.run('UPDATE messages SET flags = ? WHERE id = ?', [...set].join(' '), id);
    return true;
  }

  setFlagsByUid(userId, folder, uid, flags, mode = 'set') {
    const msg = this.getMessageByUid(userId, folder, uid);
    if (!msg) return false;
    let set = new Set(msg.flags.split(' ').filter(Boolean));
    if (mode === 'set') set = new Set(flags);
    else for (const f of flags) set.add(f);
    this.db.run('UPDATE messages SET flags = ? WHERE id = ?', [...set].join(' '), msg.id);
    return true;
  }

  moveMessage(userId, id, folder) {
    const msg = this.getMessage(userId, id);
    if (!msg) return false;
    if (msg.folder === folder) return true;
    const uid = this.db.nextUid(userId, folder);
    this.db.run('UPDATE messages SET folder = ?, uid = ? WHERE id = ?', folder, uid, id);
    return true;
  }

  deleteMessage(userId, id) {
    const msg = this.getMessage(userId, id);
    if (!msg) return false;
    const atts = this.attachmentsOf(id);
    for (const a of atts) {
      try { fs.unlinkSync(this.rawFullPath(a.path)); } catch {}
    }
    try { fs.unlinkSync(this.rawFullPath(msg.raw_path)); } catch {}
    this.db.run('DELETE FROM messages WHERE id = ?', id);
    return true;
  }

  emptyFolder(userId, folder) {
    const rows = this.db.all('SELECT id FROM messages WHERE user_id = ? AND folder = ?', userId, folder);
    for (const r of rows) this.deleteMessage(userId, r.id);
    return rows.length;
  }

  // ---------- 保存草稿 / 发件 ----------
  appendSent({ userId, mailbox, raw }) {
    return this.deliver({ raw, to: [], folder: 'Sent', userId, mailboxEmail: mailbox, flags: ['\\Seen'] });
  }
}

export function parseJsonList(s, fallback = []) {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : fallback;
  } catch {
    return fallback;
  }
}
