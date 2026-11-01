// 账号/域名/别名/转发/自动回复的业务逻辑
import fs from 'node:fs';
import path from 'node:path';
import { hashPassword, verifyPassword, randomToken, sha256Hex } from './crypto.js';
import { SYSTEM_FOLDERS } from './store.js';

export class DomainError extends Error {}

const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;

export function normalizeEmail(s) {
  return String(s || '').trim().toLowerCase();
}

export function isValidEmail(s) {
  return EMAIL_RE.test(normalizeEmail(s));
}

export class AccountService {
  constructor({ cfg, db, store, dkim, outbox }) {
    this.cfg = cfg;
    this.db = db;
    this.store = store;
    this.dkim = dkim;
    this.outbox = outbox;
  }

  // ---------- 域名 ----------
  listDomains() {
    return this.db.all('SELECT id, name, active, catch_all, dkim_selector, dkim_enabled, created_at FROM domains ORDER BY name');
  }

  addDomain(name, { catchAll = '', active = 1 } = {}) {
    const d = String(name).toLowerCase().trim();
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d)) {
      throw new DomainError('域名格式不正确');
    }
    const exists = this.db.get('SELECT id FROM domains WHERE name = ?', d);
    if (exists) throw new DomainError('域名已存在');
    const now = Date.now();
    this.db.run(
      'INSERT INTO domains(name, active, catch_all, dkim_selector, dkim_enabled, created_at) VALUES(?,?,?,?,1,?)',
      d, active ? 1 : 0, catchAll || '', this.cfg.dkim.selector, now
    );
    const row = this.db.get('SELECT * FROM domains WHERE name = ?', d);
    if (this.cfg.dkim.autoGenerate) {
      try { this.dkim.ensure(d); } catch (e) { /* 密钥生成失败不影响建域 */ }
    }
    return row;
  }

  updateDomain(id, patch) {
    const row = this.db.get('SELECT * FROM domains WHERE id = ?', id);
    if (!row) throw new DomainError('域名不存在');
    const fields = [];
    const params = [];
    if (patch.active !== undefined) { fields.push('active = ?'); params.push(patch.active ? 1 : 0); }
    if (patch.catch_all !== undefined) { fields.push('catch_all = ?'); params.push(normalizeEmail(patch.catch_all)); }
    if (patch.dkim_enabled !== undefined) { fields.push('dkim_enabled = ?'); params.push(patch.dkim_enabled ? 1 : 0); }
    if (patch.dkim_selector !== undefined) { fields.push('dkim_selector = ?'); params.push(String(patch.dkim_selector)); }
    if (!fields.length) return row;
    params.push(id);
    this.db.run(`UPDATE domains SET ${fields.join(', ')} WHERE id = ?`, ...params);
    return this.db.get('SELECT * FROM domains WHERE id = ?', id);
  }

  deleteDomain(id) {
    const row = this.db.get('SELECT * FROM domains WHERE id = ?', id);
    if (!row) throw new DomainError('域名不存在');
    const users = this.db.all('SELECT email FROM users WHERE email LIKE ?', `%@${row.name}`);
    if (users.length) throw new DomainError(`该域下还有 ${users.length} 个账号，请先删除`);
    this.db.run('DELETE FROM domains WHERE id = ?', id);
    return true;
  }

  // ---------- 用户 ----------
  listUsers({ domain = null, q = '' } = {}) {
    let sql = 'SELECT id, email, display_name, is_admin, active, quota_mb, last_login_at, created_at FROM users';
    const where = [];
    const params = [];
    if (domain) { where.push('email LIKE ?'); params.push(`%@${domain}`); }
    if (q) { where.push('(email LIKE ? OR display_name LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY email';
    return this.db.all(sql, ...params);
  }

  getUser(id) {
    return this.db.get('SELECT * FROM users WHERE id = ?', id);
  }

  createUser({ email, password, displayName = '', isAdmin = 0, quotaMb = 1024, domainCheck = true }) {
    const addr = normalizeEmail(email);
    if (!isValidEmail(addr)) throw new DomainError('邮箱地址格式不正确');
    if (!password || String(password).length < 6) throw new DomainError('密码至少 6 位');
    const domain = addr.split('@')[1];
    if (domainCheck) {
      const d = this.db.get('SELECT * FROM domains WHERE name = ?', domain);
      if (!d) throw new DomainError('该域名未添加，请先在域名管理中配置');
      if (!d.active) throw new DomainError('该域名已停用');
    }
    if (this.db.get('SELECT id FROM users WHERE email = ?', addr)) throw new DomainError('该邮箱已被注册');
    if (this.db.get('SELECT id FROM aliases WHERE address = ?', addr)) throw new DomainError('该地址已被别名占用');

    const info = this.db.run(
      'INSERT INTO users(email, password_hash, display_name, is_admin, active, quota_mb, created_at) VALUES(?,?,?,?,1,?,?)',
      addr, hashPassword(password), displayName, isAdmin ? 1 : 0, quotaMb, Date.now()
    );
    return this.getUser(Number(info.lastInsertRowid));
  }

  updateUser(id, patch) {
    const u = this.getUser(id);
    if (!u) throw new DomainError('用户不存在');
    const fields = [];
    const params = [];
    if (patch.display_name !== undefined) { fields.push('display_name = ?'); params.push(String(patch.display_name)); }
    if (patch.is_admin !== undefined) { fields.push('is_admin = ?'); params.push(patch.is_admin ? 1 : 0); }
    if (patch.active !== undefined) { fields.push('active = ?'); params.push(patch.active ? 1 : 0); }
    if (patch.quota_mb !== undefined) { fields.push('quota_mb = ?'); params.push(Number(patch.quota_mb) || 0); }
    if (!fields.length) return u;
    params.push(id);
    this.db.run(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, ...params);
    return this.getUser(id);
  }

  setPassword(id, password) {
    if (!password || String(password).length < 6) throw new DomainError('密码至少 6 位');
    this.db.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(password), id);
    return true;
  }

  changePassword(id, oldPassword, newPassword) {
    const u = this.getUser(id);
    if (!u) throw new DomainError('用户不存在');
    if (!verifyPassword(oldPassword, u.password_hash)) throw new DomainError('原密码错误');
    return this.setPassword(id, newPassword);
  }

  deleteUser(id) {
    const msgs = this.db.all('SELECT id FROM messages WHERE user_id = ?', id);
    for (const m of msgs) this.store.deleteMessage(id, m.id);
    this.db.run('DELETE FROM apikeys WHERE user_id = ?', id);
    this.db.run('DELETE FROM users WHERE id = ?', id);
    return true;
  }

  login(email, password, ip = '') {
    const addr = normalizeEmail(email);
    const u = this.db.get('SELECT * FROM users WHERE email = ?', addr);
    if (!u || !verifyPassword(password, u.password_hash)) {
      throw new DomainError('邮箱或密码错误');
    }
    if (!u.active) throw new DomainError('账号已停用');
    this.db.run('UPDATE users SET last_login_at = ? WHERE id = ?', Date.now(), u.id);
    this.db.run('INSERT INTO audit(at, actor, action, detail) VALUES(?,?,?,?)', Date.now(), addr, 'login', ip);
    return u;
  }

  register(email, password, displayName = '') {
    if (!this.cfg.http.allowSelfRegister) throw new DomainError('本站未开放注册，请联系管理员');
    const addr = normalizeEmail(email);
    const domain = addr.split('@')[1];
    const allow = this.cfg.http.registerDomains || [];
    if (allow.length && !allow.includes(domain)) throw new DomainError('该域名不允许自助注册');
    return this.createUser({ email: addr, password, displayName });
  }

  // ---------- 别名 ----------
  listAliases() {
    return this.db.all('SELECT * FROM aliases ORDER BY address');
  }

  createAlias(address, targets) {
    const addr = normalizeEmail(address);
    const list = (Array.isArray(targets) ? targets : String(targets).split(/[,;\s]+/))
      .map(normalizeEmail).filter(Boolean);
    if (!isValidEmail(addr)) throw new DomainError('别名地址格式不正确');
    if (!list.length) throw new DomainError('至少需要一个目标地址');
    if (this.db.get('SELECT id FROM users WHERE email = ?', addr)) throw new DomainError('该地址已是真实账号');
    if (this.db.get('SELECT id FROM aliases WHERE address = ?', addr)) throw new DomainError('别名已存在');
    this.db.run(
      'INSERT INTO aliases(address, targets, active, created_at) VALUES(?,?,1,?)',
      addr, JSON.stringify(list), Date.now()
    );
    return this.db.get('SELECT * FROM aliases WHERE address = ?', addr);
  }

  updateAlias(id, patch) {
    const row = this.db.get('SELECT * FROM aliases WHERE id = ?', id);
    if (!row) throw new DomainError('别名不存在');
    if (patch.targets !== undefined) {
      const list = (Array.isArray(patch.targets) ? patch.targets : String(patch.targets).split(/[,;\s]+/))
        .map(normalizeEmail).filter(Boolean);
      this.db.run('UPDATE aliases SET targets = ? WHERE id = ?', JSON.stringify(list), id);
    }
    if (patch.active !== undefined) this.db.run('UPDATE aliases SET active = ? WHERE id = ?', patch.active ? 1 : 0, id);
    return this.db.get('SELECT * FROM aliases WHERE id = ?', id);
  }

  deleteAlias(id) {
    this.db.run('DELETE FROM aliases WHERE id = ?', id);
    return true;
  }

  // ---------- 转发 ----------
  listForwards(userId = null) {
    if (userId) {
      const u = this.getUser(userId);
      return this.db.all('SELECT * FROM forwards WHERE address = ?', u.email);
    }
    return this.db.all('SELECT * FROM forwards ORDER BY address');
  }

  setForward(address, target, keepCopy = 1) {
    const addr = normalizeEmail(address);
    if (!isValidEmail(addr)) throw new DomainError('地址格式不正确');
    if (!isValidEmail(target)) throw new DomainError('目标地址格式不正确');
    this.db.run(
      `INSERT INTO forwards(address, target, keep_copy, active, created_at) VALUES(?,?,?,1,?)
       ON CONFLICT(address) DO UPDATE SET target = excluded.target, keep_copy = excluded.keep_copy, active = 1`,
      addr, normalizeEmail(target), keepCopy ? 1 : 0, Date.now()
    );
    return this.db.get('SELECT * FROM forwards WHERE address = ?', addr);
  }

  deleteForward(address) {
    this.db.run('DELETE FROM forwards WHERE address = ?', normalizeEmail(address));
    return true;
  }

  // ---------- 自动回复 ----------
  getAutoresponder(address) {
    return this.db.get('SELECT * FROM autoresponders WHERE address = ?', normalizeEmail(address));
  }

  setAutoresponder(address, { subject, body, active = 1 }) {
    const addr = normalizeEmail(address);
    this.db.run(
      `INSERT INTO autoresponders(address, subject, body, active, created_at) VALUES(?,?,?,?,?)
       ON CONFLICT(address) DO UPDATE SET subject = excluded.subject, body = excluded.body, active = excluded.active`,
      addr, subject || '自动回复', body || '', active ? 1 : 0, Date.now()
    );
    return this.getAutoresponder(addr);
  }

  deleteAutoresponder(address) {
    this.db.run('DELETE FROM autoresponders WHERE address = ?', normalizeEmail(address));
    return true;
  }

  // ---------- API Key ----------
  listApiKeys(userId) {
    return this.db.all('SELECT id, name, key_hint, created_at, last_used FROM apikeys WHERE user_id = ?', userId);
  }

  createApiKey(userId, name = '') {
    const key = `dm_${randomToken(32)}`;
    const hash = sha256Hex(key);
    this.db.run(
      'INSERT INTO apikeys(user_id, name, key_hash, key_hint, created_at) VALUES(?,?,?,?,?)',
      userId, name, hash, key.slice(0, 10), Date.now()
    );
    return { key };
  }

  deleteApiKey(userId, id) {
    this.db.run('DELETE FROM apikeys WHERE id = ? AND user_id = ?', id, userId);
    return true;
  }

  userByApiKey(key) {
    const hash = sha256Hex(String(key));
    const row = this.db.get('SELECT * FROM apikeys WHERE key_hash = ?', hash);
    if (!row) return null;
    this.db.run('UPDATE apikeys SET last_used = ? WHERE id = ?', Date.now(), row.id);
    return this.db.get('SELECT * FROM users WHERE id = ? AND active = 1', row.user_id);
  }

  // ---------- 统计 ----------
  stats() {
    const users = this.db.get('SELECT COUNT(*) AS c FROM users');
    const domains = this.db.get('SELECT COUNT(*) AS c FROM domains');
    const messages = this.db.get('SELECT COUNT(*) AS c FROM messages');
    const size = this.db.get('SELECT SUM(size) AS s FROM messages');
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayMsgs = this.db.get('SELECT COUNT(*) AS c FROM messages WHERE created_at >= ?', today.getTime());
    return {
      users: Number(users?.c || 0),
      domains: Number(domains?.c || 0),
      messages: Number(messages?.c || 0),
      storageMb: Math.round(Number(size?.s || 0) / 1024 / 1024),
      todayMessages: Number(todayMsgs?.c || 0),
      outbox: this.outbox?.stats() || {},
    };
  }
}

export { SYSTEM_FOLDERS };
