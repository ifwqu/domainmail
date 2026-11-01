import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 8000;

CREATE TABLE IF NOT EXISTS domains (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  active        INTEGER NOT NULL DEFAULT 1,
  catch_all     TEXT NOT NULL DEFAULT '',
  dkim_selector TEXT NOT NULL DEFAULT 'mail',
  dkim_private  TEXT NOT NULL DEFAULT '',
  dkim_public   TEXT NOT NULL DEFAULT '',
  dkim_enabled  INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  display_name  TEXT NOT NULL DEFAULT '',
  is_admin      INTEGER NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 1,
  quota_mb      INTEGER NOT NULL DEFAULT 1024,
  last_login_at INTEGER,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS aliases (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  address    TEXT NOT NULL UNIQUE COLLATE NOCASE,
  targets    TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS forwards (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  address    TEXT NOT NULL UNIQUE COLLATE NOCASE,
  target     TEXT NOT NULL,
  keep_copy  INTEGER NOT NULL DEFAULT 1,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS autoresponders (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  address    TEXT NOT NULL UNIQUE COLLATE NOCASE,
  subject    TEXT NOT NULL,
  body       TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          INTEGER NOT NULL,
  mailbox          TEXT NOT NULL,
  uid              INTEGER NOT NULL,
  folder           TEXT NOT NULL,
  message_id       TEXT NOT NULL DEFAULT '',
  subject          TEXT NOT NULL DEFAULT '',
  from_addr        TEXT NOT NULL DEFAULT '',
  from_name        TEXT NOT NULL DEFAULT '',
  to_addrs         TEXT NOT NULL DEFAULT '',
  cc_addrs         TEXT NOT NULL DEFAULT '',
  reply_to         TEXT NOT NULL DEFAULT '',
  date             INTEGER NOT NULL,
  size             INTEGER NOT NULL DEFAULT 0,
  snippet          TEXT NOT NULL DEFAULT '',
  body_text        TEXT NOT NULL DEFAULT '',
  body_html        TEXT NOT NULL DEFAULT '',
  raw_path         TEXT NOT NULL DEFAULT '',
  has_attachment   INTEGER NOT NULL DEFAULT 0,
  flags            TEXT NOT NULL DEFAULT '',
  spam_score       REAL NOT NULL DEFAULT 0,
  spam_reason      TEXT NOT NULL DEFAULT '',
  remote_ip        TEXT NOT NULL DEFAULT '',
  created_at       INTEGER NOT NULL,
  UNIQUE (user_id, folder, uid)
);
CREATE INDEX IF NOT EXISTS idx_messages_user_folder ON messages(user_id, folder, date DESC);
CREATE INDEX IF NOT EXISTS idx_messages_message_id ON messages(message_id);
CREATE INDEX IF NOT EXISTS idx_messages_uid ON messages(user_id, folder, uid);

CREATE TABLE IF NOT EXISTS attachments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL,
  filename   TEXT NOT NULL DEFAULT '',
  mime       TEXT NOT NULL DEFAULT 'application/octet-stream',
  size       INTEGER NOT NULL DEFAULT 0,
  content_id TEXT NOT NULL DEFAULT '',
  is_inline  INTEGER NOT NULL DEFAULT 0,
  path       TEXT NOT NULL,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_attachments_msg ON attachments(message_id);

CREATE TABLE IF NOT EXISTS outbox (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER,
  mail_from    TEXT NOT NULL,
  rcpt_to      TEXT NOT NULL,
  raw_path     TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'queued',
  attempts     INTEGER NOT NULL DEFAULT 0,
  next_try_at  INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox(status, next_try_at);

CREATE TABLE IF NOT EXISTS apikeys (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  name       TEXT NOT NULL DEFAULT '',
  key_hash   TEXT NOT NULL UNIQUE,
  key_hint   TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_used  INTEGER
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      INTEGER NOT NULL,
  actor   TEXT NOT NULL DEFAULT '',
  action  TEXT NOT NULL DEFAULT '',
  detail  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit(at DESC);
`;

export class DB {
  constructor(file) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(SCHEMA);
    this.stmts = new Map();
  }

  prepare(sql) {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  get(sql, ...params) {
    return this.prepare(sql).get(...params) ?? null;
  }

  all(sql, ...params) {
    return this.prepare(sql).all(...params);
  }

  run(sql, ...params) {
    return this.prepare(sql).run(...params);
  }

  exec(sql) {
    this.db.exec(sql);
  }

  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw e;
    }
  }

  getSetting(key, fallback = null) {
    const row = this.get('SELECT value FROM settings WHERE key = ?', key);
    return row ? row.value : fallback;
  }

  setSetting(key, value) {
    this.run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, String(value));
  }

  nextUid(userId, folder) {
    return this.tx(() => {
      const key = `uid:${userId}:${folder}`;
      const cur = Number(this.getSetting(key, '0')) || 0;
      const maxRow = this.get('SELECT MAX(uid) AS m FROM messages WHERE user_id = ? AND folder = ?', userId, folder);
      const next = Math.max(cur, Number(maxRow?.m || 0)) + 1;
      this.setSetting(key, next);
      return next;
    });
  }

  close() {
    try { this.db.close(); } catch {}
  }
}

export function openDb(dataDir) {
  return new DB(path.join(dataDir, 'mail.db'));
}
