// IMAP4rev1 服务端：CAPABILITY/LOGIN/AUTHENTICATE/LIST/SELECT/FETCH/STORE/SEARCH/APPEND/COPY/MOVE/EXPUNGE/IDLE
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import { createLogger } from './logger.js';
import { verifyPassword } from './crypto.js';
import { SYSTEM_FOLDERS } from './store.js';
import { parseMessage } from './mime.js';

const log = createLogger('imap');

const FLAG_ATTRS = {
  INBOX: ['\\HasNoChildren'],
  Sent: ['\\HasNoChildren', '\\Sent'],
  Drafts: ['\\HasNoChildren', '\\Drafts'],
  Trash: ['\\HasNoChildren', '\\Trash'],
  Junk: ['\\HasNoChildren', '\\Junk'],
};

function quote(s) {
  if (s === null || s === undefined) return '""';
  if (/[\r\n"\\]/.test(s) || /[\x00-\x1f\x80-\xff]/.test(s)) {
    return `"${String(s).replace(/(["\\])/g, '\\$1')}"`;
  }
  return `"${s}"`;
}

function nstring(s) {
  return s === null || s === undefined || s === '' ? 'NIL' : quote(s);
}

function imapDate(ts) {
  const d = new Date(ts);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}-${months[d.getUTCMonth()]}-${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}

function internalDate(ts) {
  const d = new Date(ts);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}-${months[d.getUTCMonth()]}-${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}

function envelope(msg) {
  const addr = (a, name) => `(${nstring(name || '')} NIL ${nstring((a || '').split('@')[0])} ${nstring((a || '').split('@')[1] || '')})`;
  const list = (str) => {
    if (!str) return 'NIL';
    const arr = str.split(',').map((s) => s.trim()).filter(Boolean);
    if (!arr.length) return 'NIL';
    return `(${arr.map((a) => addr(a, '')).join(' ')})`;
  };
  return `(${internalDate(msg.date)} ${nstring(msg.subject)} ${addr(msg.from_addr, msg.from_name)} ${addr(msg.from_addr, msg.from_name)} ${addr(msg.from_addr, msg.from_name)} ${list(msg.to_addrs)} ${list(msg.cc_addrs)} NIL NIL ${nstring(msg.message_id ? `<${msg.message_id}>` : '')})`;
}

function flagsOf(msg) {
  const f = msg.flags.split(' ').filter(Boolean);
  if (!f.length) return '';
  return `FLAGS (${f.join(' ')})`;
}

function parseFetchItems(spec) {
  // 处理 (FLAGS BODY.PEEK[]) 或 FLAGS BODY[] 之类
  const s = spec.trim().replace(/^\(/, '').replace(/\)$/, '');
  const items = [];
  let cur = '';
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ' ' && depth === 0) {
      if (cur) items.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur) items.push(cur);
  return items;
}

class ImapSession {
  constructor(server, socket) {
    this.server = server;
    this.store = server.store;
    this.db = server.db;
    this.socket = socket;
    this.buf = '';
    this.user = null;
    this.selected = null; // { folder, readOnly }
    this.secured = false;
    this.remoteIp = (socket.remoteAddress || '').replace(/^::ffff:/, '');
    this.literal = null; // { size, cb, rest }
    this.idling = false;
    this.authenticating = null;
  }

  write(s) {
    if (!this.socket.destroyed) this.socket.write(s + '\r\n');
  }

  rawWrite(s) {
    if (!this.socket.destroyed) this.socket.write(s);
  }

  onConnect() {
    this.write(`* OK [CAPABILITY IMAP4rev1 LITERAL+ SASL-IR AUTH=PLAIN AUTH=LOGIN IDLE MOVE UIDPLUS] ${this.server.cfg.hostname} DomainMail IMAP4rev1 ready`);
  }

  onData(chunk) {
    this.buf += chunk.toString('latin1');
    this.pump();
  }

  pump() {
    while (true) {
      if (this.literal) {
        const { size, cb } = this.literal;
        if (Buffer.byteLength(this.buf, 'latin1') < size) return;
        const data = Buffer.from(this.buf, 'latin1').subarray(0, size);
        this.buf = Buffer.from(this.buf, 'latin1').subarray(size).toString('latin1');
        const l = this.literal;
        this.literal = null;
        const cont = cb(data);
        if (cont === 'stop') return;
        continue;
      }
      const idx = this.buf.indexOf('\r\n');
      if (idx === -1) return;
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 2);
      if (this.idling) {
        if (/^DONE$/i.test(line.trim())) {
          this.idling = false;
          this.write(`${this.idleTag} OK IDLE terminated`);
        }
        continue;
      }
      this.handleLine(line);
      if (this.socket.destroyed) return;
    }
  }

  // 读取字面量：cb 返回 'stop' 时停止处理后续命令
  readLiteral(size, cb) {
    this.literal = { size, cb };
    this.rawWrite('+ Ready for literal data\r\n');
  }

  handleLine(line) {
    const m = /^(\S+)\s+(\S+)(?:\s+([\s\S]*))?$/.exec(line);
    if (!m) {
      this.write('* BAD 无法解析的命令');
      return;
    }
    const [, tag, verbRaw, restRaw] = m;
    const verb = verbRaw.toUpperCase();
    const rest = restRaw || '';

    if (this.authenticating) return this.handleAuthContinuation(tag, rest);

    switch (verb) {
      case 'CAPABILITY':
        return this.cmdCapability(tag);
      case 'NOOP':
        return this.write(`${tag} OK NOOP completed`);
      case 'LOGOUT':
        this.write('* BYE 正在断开连接');
        this.write(`${tag} OK LOGOUT completed`);
        return this.socket.end();
      case 'LOGIN':
        return this.cmdLogin(tag, rest);
      case 'AUTHENTICATE':
        return this.cmdAuthenticate(tag, rest);
      case 'STARTTLS':
        return this.cmdStartTls(tag);
      case 'LIST':
      case 'LSUB':
        return this.cmdList(tag, rest);
      case 'SELECT':
      case 'EXAMINE':
        return this.cmdSelect(tag, rest, verb === 'EXAMINE');
      case 'STATUS':
        return this.cmdStatus(tag, rest);
      case 'FETCH':
        return this.cmdFetch(tag, rest, false);
      case 'UID':
        return this.cmdUid(tag, rest);
      case 'STORE':
        return this.cmdStore(tag, rest, false);
      case 'SEARCH':
        return this.cmdSearch(tag, rest, false);
      case 'COPY':
        return this.cmdCopy(tag, rest, false);
      case 'MOVE':
        return this.cmdMove(tag, rest, false);
      case 'EXPUNGE':
        return this.cmdExpunge(tag);
      case 'APPEND':
        return this.cmdAppend(tag, rest);
      case 'IDLE':
        return this.cmdIdle(tag);
      case 'CLOSE':
        return this.cmdClose(tag);
      case 'CREATE':
        return this.write(`${tag} OK CREATE completed`);
      case 'DELETE':
        return this.write(`${tag} OK DELETE completed`);
      case 'SUBSCRIBE':
      case 'UNSUBSCRIBE':
        return this.write(`${tag} OK ${verb} completed`);
      case 'ID':
        return this.cmdId(tag);
      case 'NAMESPACE':
        this.write('* NAMESPACE (("" "/")) NIL NIL');
        return this.write(`${tag} OK NAMESPACE completed`);
      case 'CHECK':
        return this.write(`${tag} OK CHECK completed`);
      default:
        return this.write(`${tag} BAD 不支持的命令 ${verb}`);
    }
  }

  cmdCapability(tag) {
    this.write('* CAPABILITY IMAP4rev1 LITERAL+ SASL-IR AUTH=PLAIN AUTH=LOGIN IDLE MOVE UIDPLUS');
    this.write(`${tag} OK CAPABILITY completed`);
  }

  cmdId(tag) {
    this.write('* ID ("name" "DomainMail" "version" "1.0.0")');
    this.write(`${tag} OK ID completed`);
  }

  cmdStartTls(tag) {
    if (this.secured) return this.write(`${tag} BAD 已加密`);
    const opts = this.server.tlsOptions();
    if (!opts.cert) return this.write(`${tag} NO TLS 不可用`);
    this.write(`${tag} OK 开始 TLS 协商`);
    const secure = new tls.TLSSocket(this.socket, { isServer: true, ...opts });
    secure.once('secure', () => {
      this.socket = secure;
      this.secured = true;
      this.server.trackSocket(secure);
      secure.on('data', (c) => this.onData(c));
      secure.on('error', () => {});
      this.buf = '';
    });
    secure.once('error', (e) => {
      log.warn('IMAP TLS 握手失败', e.message);
      this.socket.destroy();
    });
  }

  cmdLogin(tag, rest) {
    const m = /^(?:"((?:[^"\\]|\\.)*)"|(\S+))\s+(?:"((?:[^"\\]|\\.)*)"|(\S+))/.exec(rest);
    if (!m) return this.write(`${tag} BAD LOGIN 参数错误`);
    const user = (m[1] ?? m[2] ?? '').replace(/\\(.)/g, '$1');
    const pass = (m[3] ?? m[4] ?? '').replace(/\\(.)/g, '$1');
    return this.tryLogin(tag, user, pass);
  }

  cmdAuthenticate(tag, rest) {
    const mech = rest.split(/\s+/)[0].toUpperCase();
    const initial = rest.split(/\s+/)[1];
    if (mech === 'PLAIN') {
      if (initial) {
        const raw = Buffer.from(initial, 'base64').toString('utf8');
        const parts = raw.split('\0');
        return this.tryLogin(tag, parts[1] || parts[0], parts[2] || parts[1]);
      }
      this.authenticating = { tag, mech };
      this.rawWrite('+ \r\n');
      return;
    }
    if (mech === 'LOGIN') {
      this.authenticating = { tag, mech, step: 'user' };
      this.rawWrite('+ VXNlcm5hbWU6\r\n');
      return;
    }
    return this.write(`${tag} NO 不支持的认证机制`);
  }

  handleAuthContinuation(tag, data) {
    const a = this.authenticating;
    if (a.mech === 'PLAIN') {
      this.authenticating = null;
      const raw = Buffer.from(data.trim(), 'base64').toString('utf8');
      const parts = raw.split('\0');
      return this.tryLogin(a.tag, parts[1] || parts[0], parts[2] || parts[1]);
    }
    if (a.mech === 'LOGIN') {
      if (a.step === 'user') {
        a.user = Buffer.from(data.trim(), 'base64').toString('utf8');
        a.step = 'pass';
        this.rawWrite('+ UGFzc3dvcmQ6\r\n');
        return;
      }
      this.authenticating = null;
      return this.tryLogin(a.tag, a.user, Buffer.from(data.trim(), 'base64').toString('utf8'));
    }
  }

  tryLogin(tag, email, password) {
    const u = this.db.get('SELECT * FROM users WHERE email = ? AND active = 1', String(email).toLowerCase());
    if (!u || !verifyPassword(password, u.password_hash)) {
      log.warn(`IMAP 登录失败 ${email} from ${this.remoteIp}`);
      return this.write(`${tag} NO [AUTHENTICATIONFAILED] 用户名或密码错误`);
    }
    this.user = u;
    this.db.run('UPDATE users SET last_login_at = ? WHERE id = ?', Date.now(), u.id);
    log.info(`IMAP 登录成功 ${u.email} from ${this.remoteIp}`);
    this.write(`${tag} OK [CAPABILITY IMAP4rev1 LITERAL+ IDLE MOVE UIDPLUS] 登录成功`);
  }

  requireAuth(tag) {
    if (!this.user) {
      this.write(`${tag} NO 请先登录`);
      return false;
    }
    return true;
  }

  folderName(rest) {
    const m = /^(?:"((?:[^"\\]|\\.)*)"|(\S+))/.exec(rest.trim());
    if (!m) return null;
    let name = (m[1] ?? m[2] ?? '').replace(/\\(.)/g, '$1');
    if (name.toUpperCase() === 'INBOX') return 'INBOX';
    return name;
  }

  cmdList(tag, rest) {
    if (!this.requireAuth(tag)) return;
    const ref = /^(?:"([^"]*)"|(\S+))\s+(?:"([^"]*)"|(\S+))/.exec(rest.trim());
    const pattern = ref ? (ref[3] ?? ref[4] ?? '*') : '*';
    this.write('* LIST (\\Noselect) "/" ""');
    for (const f of SYSTEM_FOLDERS) {
      if (pattern !== '*' && pattern !== '%' && !f.toLowerCase().startsWith(pattern.replace(/[*%]/g, '').toLowerCase())) continue;
      const attrs = FLAG_ATTRS[f] || ['\\HasNoChildren'];
      this.write(`* LIST (${attrs.join(' ')}) "/" ${quote(f)}`);
    }
    this.write(`${tag} OK LIST completed`);
  }

  cmdSelect(tag, rest, readOnly) {
    if (!this.requireAuth(tag)) return;
    const folder = this.folderName(rest);
    if (!folder) return this.write(`${tag} BAD SELECT 参数错误`);
    this.selected = { folder, readOnly };
    const counts = this.store.countFolder(this.user.id, folder);
    const rows = this.db.all('SELECT uid FROM messages WHERE user_id = ? AND folder = ? ORDER BY uid', this.user.id, folder);
    this.write(`* ${rows.length} EXISTS`);
    this.write(`* ${counts.unread} RECENT`);
    this.write(`* FLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft \\Recent)`);
    this.write('* OK [PERMANENTFLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft \\*)] 可写');
    const uidNext = rows.length ? Math.max(...rows.map((r) => Number(r.uid))) + 1 : 1;
    this.write(`* OK [UIDVALIDITY 1] UID 有效性`);
    this.write(`* OK [UIDNEXT ${uidNext}] 下一个 UID`);
    this.write(`${tag} OK [${readOnly ? 'READ-ONLY' : 'READ-WRITE'}] SELECT 完成`);
  }

  cmdStatus(tag, rest) {
    if (!this.requireAuth(tag)) return;
    const m = /^(?:"([^"]*)"|(\S+))\s+\(([^)]*)\)/.exec(rest.trim());
    if (!m) return this.write(`${tag} BAD STATUS 参数错误`);
    const folder = (m[1] ?? m[2]).toUpperCase() === 'INBOX' ? 'INBOX' : (m[1] ?? m[2]);
    const items = m[3].toUpperCase().split(/\s+/);
    const counts = this.store.countFolder(this.user.id, folder);
    const rows = this.db.all('SELECT uid FROM messages WHERE user_id = ? AND folder = ? ORDER BY uid DESC LIMIT 1', this.user.id, folder);
    const parts = [];
    for (const it of items) {
      if (it === 'MESSAGES') parts.push(`MESSAGES ${counts.total}`);
      if (it === 'RECENT') parts.push(`RECENT ${counts.unread}`);
      if (it === 'UIDNEXT') parts.push(`UIDNEXT ${rows.length ? Number(rows[0].uid) + 1 : 1}`);
      if (it === 'UIDVALIDITY') parts.push('UIDVALIDITY 1');
      if (it === 'UNSEEN') parts.push(`UNSEEN ${counts.unread}`);
    }
    this.write(`* STATUS ${quote(folder)} (${parts.join(' ')})`);
    this.write(`${tag} OK STATUS completed`);
  }

  resolveSeqs(spec, byUid) {
    const rows = this.db.all(
      'SELECT id, uid, flags FROM messages WHERE user_id = ? AND folder = ? ORDER BY uid',
      this.user.id, this.selected.folder
    );
    if (!rows.length) return [];
    const nums = rows.map((r) => Number(byUid ? r.uid : 0));
    const maxSeq = rows.length;

    const keyOf = (row, idx) => (byUid ? Number(row.uid) : idx + 1);
    const allKeys = rows.map((r, i) => keyOf(r, i));
    const maxKey = Math.max(...allKeys);

    const result = new Set();
    for (const part of String(spec).split(',')) {
      const p = part.trim();
      if (!p) continue;
      if (p === '*') { result.add(maxKey); continue; }
      const range = /^(\d+|\*):(\d+|\*)$/.exec(p);
      if (range) {
        let a = range[1] === '*' ? maxKey : Number(range[1]);
        let b = range[2] === '*' ? maxKey : Number(range[2]);
        if (a > b) [a, b] = [b, a];
        for (const k of allKeys) if (k >= a && k <= b) result.add(k);
        continue;
      }
      if (/^\d+$/.test(p)) {
        const n = Number(p);
        if (allKeys.includes(n)) result.add(n);
      }
    }
    return rows.filter((r, i) => result.has(keyOf(r, i)));
  }

  cmdFetch(tag, rest, byUid) {
    if (!this.requireAuth(tag)) return;
    if (!this.selected) return this.write(`${tag} BAD 未选择邮箱`);
    const m = /^(\S+)\s+([\s\S]+)$/.exec(rest.trim());
    if (!m) return this.write(`${tag} BAD FETCH 参数错误`);
    const [, seqSpec, itemSpec] = m;
    const rows = this.resolveSeqs(seqSpec, byUid);
    const items = parseFetchItems(itemSpec);

    for (const row of rows) {
      const msg = this.db.get('SELECT * FROM messages WHERE id = ?', row.id);
      if (!msg) continue;
      const parts = [];
      let needRaw = false;
      let markSeen = false;

      for (const raw of items) {
        const it = raw.toUpperCase();
        if (it === 'UID') parts.push(`UID ${msg.uid}`);
        else if (it === 'FLAGS') parts.push(`FLAGS (${msg.flags.split(' ').filter(Boolean).join(' ')})`);
        else if (it === 'INTERNALDATE') parts.push(`INTERNALDATE "${internalDate(msg.date)}"`);
        else if (it === 'RFC822.SIZE') parts.push(`RFC822.SIZE ${msg.size}`);
        else if (it === 'ENVELOPE') parts.push(`ENVELOPE ${envelope(msg)}`);
        else if (it.startsWith('BODY.PEEK')) {
          needRaw = true;
          parts.push('BODY[]');
        } else if (it.startsWith('BODY[') || it.startsWith('RFC822')) {
          needRaw = true;
          markSeen = true;
          parts.push(it.startsWith('RFC822.HEADER') ? 'RFC822.HEADER' : it.startsWith('RFC822.TEXT') ? 'RFC822.TEXT' : 'RFC822');
        } else if (it.startsWith('BODYSTRUCTURE') || it === 'BODY') {
          parts.push('BODY ("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 0 0)');
        }
      }

      if (needRaw) {
        const raw = this.store.readRaw(msg);
        const label = parts.findIndex((p) => p === 'BODY[]' || p === 'RFC822');
        const bodyStr = raw.toString('latin1');
        const seq = byUid ? this.seqOfUid(msg.uid) : this.seqOfUid(msg.uid);
        this.rawWrite(`* ${seq} FETCH (`);
        const out = [];
        for (const p of parts) {
          if (p === 'BODY[]') out.push(`BODY[] {${raw.length}}\r\n${bodyStr}`);
          else if (p === 'RFC822') out.push(`RFC822 {${raw.length}}\r\n${bodyStr}`);
          else if (p === 'RFC822.HEADER') {
            const hdr = bodyStr.split('\r\n\r\n')[0] + '\r\n\r\n';
            out.push(`RFC822.HEADER {${hdr.length}}\r\n${hdr}`);
          } else out.push(p);
        }
        this.rawWrite(out.join('\r\n'));
        this.rawWrite(')\r\n');
      } else {
        const seq = this.seqOfUid(msg.uid);
        this.write(`* ${seq} FETCH (${parts.join(' ')})`);
      }

      if (markSeen && !this.selected.readOnly && !msg.flags.includes('\\Seen')) {
        this.store.addFlags(this.user.id, msg.id, ['\\Seen']);
      }
    }
    this.write(`${tag} OK FETCH completed`);
  }

  seqOfUid(uid) {
    const row = this.db.get(
      'SELECT COUNT(*) AS c FROM messages WHERE user_id = ? AND folder = ? AND uid <= ?',
      this.user.id, this.selected.folder, uid
    );
    return Number(row?.c || 1);
  }

  cmdUid(tag, rest) {
    const m = /^(\S+)\s+([\s\S]*)$/.exec(rest.trim());
    if (!m) return this.write(`${tag} BAD UID 参数错误`);
    const cmd = m[1].toUpperCase();
    const args = m[2];
    if (cmd === 'FETCH') return this.cmdFetch(tag, args, true);
    if (cmd === 'STORE') return this.cmdStore(tag, args, true);
    if (cmd === 'SEARCH') return this.cmdSearch(tag, args, true);
    if (cmd === 'COPY') return this.cmdCopy(tag, args, true);
    if (cmd === 'MOVE') return this.cmdMove(tag, args, true);
    if (cmd === 'EXPUNGE') return this.cmdExpunge(tag);
    return this.write(`${tag} BAD 不支持的 UID 命令`);
  }

  cmdStore(tag, rest, byUid) {
    if (!this.requireAuth(tag)) return;
    if (!this.selected) return this.write(`${tag} BAD 未选择邮箱`);
    if (this.selected.readOnly) return this.write(`${tag} NO 只读模式`);
    const m = /^(\S+)\s+([+-]?FLAGS(?:\.SILENT)?)\s+\(([^)]*)\)/i.exec(rest.trim());
    if (!m) return this.write(`${tag} BAD STORE 参数错误`);
    const [, seqSpec, opRaw, flagStr] = m;
    const op = opRaw.toUpperCase();
    const flags = flagStr.split(/\s+/).filter(Boolean);
    const rows = this.resolveSeqs(seqSpec, byUid);
    for (const row of rows) {
      const msg = this.db.get('SELECT * FROM messages WHERE id = ?', row.id);
      if (!msg) continue;
      let set = new Set(msg.flags.split(' ').filter(Boolean));
      if (op.startsWith('+')) for (const f of flags) set.add(f);
      else if (op.startsWith('-')) for (const f of flags) set.delete(f);
      else set = new Set(flags);
      this.db.run('UPDATE messages SET flags = ? WHERE id = ?', [...set].join(' '), msg.id);
      if (!op.includes('SILENT')) {
        this.write(`* ${this.seqOfUid(msg.uid)} FETCH (FLAGS (${[...set].join(' ')}))`);
      }
    }
    this.write(`${tag} OK STORE completed`);
  }

  cmdSearch(tag, rest, byUid) {
    if (!this.requireAuth(tag)) return;
    if (!this.selected) return this.write(`${tag} BAD 未选择邮箱`);
    const tokens = rest.trim().match(/(?:"[^"]*"|\([^)]*\)|\S+)/g) || [];
    const rows = this.db.all(
      'SELECT * FROM messages WHERE user_id = ? AND folder = ? ORDER BY uid',
      this.user.id, this.selected.folder
    );
    const hits = [];
    let criteria = { all: true };

    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i].toUpperCase();
      const next = tokens[i + 1];
      const unq = (s) => String(s || '').replace(/^"|"$/g, '');
      if (t === 'ALL') continue;
      if (t === 'UNSEEN') criteria.unseen = true;
      else if (t === 'SEEN') criteria.seen = true;
      else if (t === 'FLAGGED') criteria.flagged = true;
      else if (t === 'UNFLAGGED') criteria.unflagged = true;
      else if (t === 'DELETED') criteria.deleted = true;
      else if (t === 'UNDELETED') criteria.undeleted = true;
      else if (t === 'FROM') { criteria.from = unq(next).toLowerCase(); i++; }
      else if (t === 'TO') { criteria.to = unq(next).toLowerCase(); i++; }
      else if (t === 'SUBJECT') { criteria.subject = unq(next).toLowerCase(); i++; }
      else if (t === 'BODY') { criteria.body = unq(next).toLowerCase(); i++; }
      else if (t === 'TEXT') { criteria.text = unq(next).toLowerCase(); i++; }
      else if (t === 'SINCE') { criteria.since = Date.parse(unq(next)); i++; }
      else if (t === 'BEFORE') { criteria.before = Date.parse(unq(next)); i++; }
      else if (t === 'UID') { criteria.uidSpec = next; i++; }
      else if (/^\d+$/.test(t)) { criteria.uidSpec = next ? `${t}:${next}` : t; if (next && /^\d+$/.test(next)) i++; }
    }

    for (const msg of rows) {
      const f = msg.flags;
      if (criteria.unseen && f.includes('\\Seen')) continue;
      if (criteria.seen && !f.includes('\\Seen')) continue;
      if (criteria.flagged && !f.includes('\\Flagged')) continue;
      if (criteria.unflagged && f.includes('\\Flagged')) continue;
      if (criteria.deleted && !f.includes('\\Deleted')) continue;
      if (criteria.undeleted && f.includes('\\Deleted')) continue;
      if (criteria.from && !msg.from_addr.toLowerCase().includes(criteria.from)) continue;
      if (criteria.to && !msg.to_addrs.toLowerCase().includes(criteria.to)) continue;
      if (criteria.subject && !msg.subject.toLowerCase().includes(criteria.subject)) continue;
      if (criteria.body && !msg.body_text.toLowerCase().includes(criteria.body)) continue;
      if (criteria.text && !(msg.body_text + msg.subject).toLowerCase().includes(criteria.text)) continue;
      if (criteria.since && msg.date < criteria.since) continue;
      if (criteria.before && msg.date >= criteria.before) continue;
      hits.push(byUid ? msg.uid : this.seqOfUid(msg.uid));
    }

    if (!hits.length) this.write('* SEARCH');
    else this.write(`* SEARCH ${hits.join(' ')}`);
    this.write(`${tag} OK SEARCH completed`);
  }

  cmdCopy(tag, rest, byUid) {
    if (!this.requireAuth(tag)) return;
    if (!this.selected) return this.write(`${tag} BAD 未选择邮箱`);
    const m = /^(\S+)\s+(?:"([^"]*)"|(\S+))/.exec(rest.trim());
    if (!m) return this.write(`${tag} BAD COPY 参数错误`);
    const seqSpec = m[1];
    const dest = m[2] ?? m[3];
    const rows = this.resolveSeqs(seqSpec, byUid);
    const newUids = [];
    for (const row of rows) {
      const msg = this.db.get('SELECT * FROM messages WHERE id = ?', row.id);
      if (!msg) continue;
      const raw = this.store.readRaw(msg);
      const saved = this.store.deliver({
        raw, to: [], folder: dest, userId: this.user.id, mailboxEmail: this.user.email,
        flags: msg.flags.split(' ').filter(Boolean),
      });
      if (saved[0]) newUids.push(saved[0].uid);
    }
    this.write(`${tag} OK [COPYUID 1 ${rows.map((r) => r.uid).join(',')} ${newUids.join(',')}] COPY completed`);
  }

  cmdMove(tag, rest, byUid) {
    if (!this.requireAuth(tag)) return;
    if (!this.selected) return this.write(`${tag} BAD 未选择邮箱`);
    const m = /^(\S+)\s+(?:"([^"]*)"|(\S+))/.exec(rest.trim());
    if (!m) return this.write(`${tag} BAD MOVE 参数错误`);
    const rows = this.resolveSeqs(m[1], byUid);
    const dest = m[2] ?? m[3];
    for (const row of rows) {
      this.store.moveMessage(this.user.id, row.id, dest);
    }
    for (const row of rows) this.write(`* OK [UIDNEXT] 移动完成`);
    this.write(`${tag} OK MOVE completed`);
  }

  cmdExpunge(tag) {
    if (!this.requireAuth(tag)) return;
    if (!this.selected) return this.write(`${tag} BAD 未选择邮箱`);
    const rows = this.db.all(
      "SELECT id, uid FROM messages WHERE user_id = ? AND folder = ? AND instr(flags, '\\Deleted') > 0 ORDER BY uid",
      this.user.id, this.selected.folder
    );
    for (const r of rows) {
      this.write(`* ${this.seqOfUid(r.uid)} EXPUNGE`);
      this.store.deleteMessage(this.user.id, r.id);
    }
    this.write(`${tag} OK EXPUNGE completed`);
  }

  cmdClose(tag) {
    if (!this.selected) return this.write(`${tag} BAD 未选择邮箱`);
    const rows = this.db.all(
      "SELECT id FROM messages WHERE user_id = ? AND folder = ? AND instr(flags, '\\Deleted') > 0",
      this.user.id, this.selected.folder
    );
    for (const r of rows) this.store.deleteMessage(this.user.id, r.id);
    this.selected = null;
    this.write(`${tag} OK CLOSE completed`);
  }

  cmdAppend(tag, rest) {
    if (!this.requireAuth(tag)) return;
    // APPEND "folder" (\Flag) "date" {size}
    const m = /^(?:"([^"]*)"|(\S+))\s+(?:\(([^)]*)\)\s+)?(?:"([^"]*)"\s+)?\{(\d+)(\+)?\}$/.exec(rest.trim());
    if (!m) return this.write(`${tag} BAD APPEND 参数错误`);
    const folder = (m[1] ?? m[2]);
    const flags = (m[3] || '').split(/\s+/).filter(Boolean);
    const size = Number(m[5]);
    const nonSync = !!m[6];
    if (nonSync) {
      // LITERAL+ 客户端会立即发送内容
      this.readLiteral(size, (data) => {
        this.finishAppend(tag, folder, flags, data);
      });
      // 需要立即读取缓冲区
      if (this.buf.length >= size) this.pump();
      return;
    }
    this.readLiteral(size, (data) => {
      this.finishAppend(tag, folder, flags, data);
    });
  }

  finishAppend(tag, folder, flags, data) {
    const target = folder.toUpperCase() === 'INBOX' ? 'INBOX' : folder;
    const saved = this.store.deliver({
      raw: data, to: [], folder: target, userId: this.user.id,
      mailboxEmail: this.user.email, flags,
    });
    if (saved[0]) {
      this.write(`${tag} OK [APPENDUID 1 ${saved[0].uid}] APPEND completed`);
      if (this.selected && this.selected.folder === target) {
        const counts = this.store.countFolder(this.user.id, target);
        this.write(`* ${counts.total} EXISTS`);
      }
    } else {
      this.write(`${tag} NO APPEND 失败`);
    }
  }

  cmdIdle(tag) {
    if (!this.requireAuth(tag)) return;
    this.idling = true;
    this.idleTag = tag;
    this.rawWrite('+ idling\r\n');
  }

  onClose() {
    this.server.untrackSocket(this.socket);
  }
}

export class ImapServer {
  constructor({ cfg, db, store, tlsProvider }) {
    this.cfg = cfg;
    this.db = db;
    this.store = store;
    this.tlsProvider = tlsProvider;
    this.sockets = new Set();
    this.server = null;
    this.ipCount = new Map();
  }

  tlsOptions() {
    const c = this.tlsProvider?.get();
    if (!c) return {};
    return { cert: c.cert, key: c.key, minVersion: this.cfg.tls.minVersion };
  }

  trackSocket(s) {
    this.sockets.add(s);
    s.on('close', () => this.sockets.delete(s));
  }

  untrackSocket(s) {
    this.sockets.delete(s);
  }

  listen() {
    return new Promise((resolve, reject) => {
      const handler = (socket, secured = false) => {
        const ip = (socket.remoteAddress || '').replace(/^::ffff:/, '');
        const n = (this.ipCount.get(ip) || 0) + 1;
        this.ipCount.set(ip, n);
        if (n > this.cfg.imap.maxConnectionsPerIp) {
          socket.write('* BYE 连接数超限\r\n');
          socket.destroy();
          return;
        }
        socket.on('close', () => {
          const c = (this.ipCount.get(ip) || 1) - 1;
          if (c <= 0) this.ipCount.delete(ip);
          else this.ipCount.set(ip, c);
        });
        socket.on('error', () => {});
        const sess = new ImapSession(this, socket);
        if (secured) {
          sess.secured = true;
          // 隐式 TLS 连接首行欢迎语去掉 STARTTLS 能力
          sess.onConnect = function () {
            this.write(`* OK [CAPABILITY IMAP4rev1 LITERAL+ SASL-IR AUTH=PLAIN AUTH=LOGIN IDLE MOVE UIDPLUS] ${this.server.cfg.hostname} DomainMail IMAP4rev1 ready`);
          };
        }
        this.trackSocket(socket);
        socket.on('data', (c) => sess.onData(c));
        socket.on('close', () => sess.onClose());
        sess.onConnect();
      };

      const srv = net.createServer((socket) => handler(socket, false));
      srv.on('error', reject);
      srv.listen(this.cfg.imap.port, this.cfg.imap.host, () => {
        log.info(`IMAP 服务监听 ${this.cfg.imap.host}:${this.cfg.imap.port}`);
        resolve(srv);
      });
      this.server = srv;

      // IMAPS 993（隐式 TLS）
      if (this.cfg.imap.tlsPort && this.tlsProvider.get()) {
        const tlsSrv = tls.createServer(this.tlsOptions(), (socket) => handler(socket, true));
        tlsSrv.on('error', (e) => log.warn('IMAPS 监听失败', e.message));
        tlsSrv.listen(this.cfg.imap.tlsPort, this.cfg.imap.host, () => {
          log.info(`IMAPS 服务监听 ${this.cfg.imap.host}:${this.cfg.imap.tlsPort}`);
        });
        this.tlsServer = tlsSrv;
      }
    });
  }

  close() {
    for (const s of this.sockets) {
      try { s.destroy(); } catch {}
    }
    this.sockets.clear();
    const closeAll = [];
    if (this.server) closeAll.push(new Promise((r) => this.server.close(() => r())));
    if (this.tlsServer) closeAll.push(new Promise((r) => this.tlsServer.close(() => r())));
    return Promise.all(closeAll).then(() => {});
  }
}
