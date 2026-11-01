// HTTP 服务器：路由、会话、静态资源
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../logger.js';
import { createSessionToken, verifySessionToken } from '../crypto.js';

const log = createLogger('http');
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export class WebServer {
  constructor({ cfg, db, store, dkim, outbox, services }) {
    this.cfg = cfg;
    this.db = db;
    this.store = store;
    this.dkim = dkim;
    this.outbox = outbox;
    this.services = services;
    this.secret = cfg.__sessionSecret;
    this.routes = [];
    this.server = null;
  }

  // ---------- 路由注册 ----------
  route(method, pattern, handler, opts = {}) {
    const keys = [];
    const regex = new RegExp(
      '^' + pattern.replace(/:[A-Za-z0-9_]+/g, (m) => {
        keys.push(m.slice(1));
        return '([^/]+)';
      }).replace(/\*/g, '.*') + '$'
    );
    this.routes.push({ method, regex, keys, handler, ...opts });
  }

  get(p, h, o) { this.route('GET', p, h, o); }
  post(p, h, o) { this.route('POST', p, h, o); }
  put(p, h, o) { this.route('PUT', p, h, o); }
  patch(p, h, o) { this.route('PATCH', p, h, o); }
  del(p, h, o) { this.route('DELETE', p, h, o); }
  delete(p, h, o) { this.route('DELETE', p, h, o); }

  // ---------- 请求上下文 ----------
  context(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies.dm_session;
    const session = token ? verifySessionToken(this.secret, token) : null;
    const ip = this.cfg.http.trustProxy
      ? (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress
      : req.socket.remoteAddress;
    return {
      req,
      res,
      url,
      query: url.searchParams,
      cookies,
      session,
      ip: (ip || '').replace(/^::ffff:/, ''),
      params: {},
      body: null,
    };
  }

  async readBody(req, limit = 30 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) {
          reject(new HttpError(413, '请求体过大'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  async readJson(ctx) {
    const buf = await this.readBody(ctx.req);
    if (!buf.length) return {};
    try {
      return JSON.parse(buf.toString('utf8'));
    } catch {
      throw new HttpError(400, 'JSON 格式错误');
    }
  }

  // ---------- 响应 ----------
  json(ctx, status, data) {
    const body = JSON.stringify(data);
    ctx.res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
    });
    ctx.res.end(body);
  }

  setSession(ctx, payload) {
    const ttl = this.cfg.http.sessionTtlSeconds;
    const token = createSessionToken(this.secret, payload, ttl);
    const secure = this.cfg.http.trustProxy && ctx.req.headers['x-forwarded-proto'] === 'https';
    ctx.res.setHeader(
      'Set-Cookie',
      `dm_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${ttl}${secure ? '; Secure' : ''}`
    );
  }

  clearSession(ctx) {
    ctx.res.setHeader('Set-Cookie', 'dm_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  }

  requireUser(ctx) {
    if (!ctx.session?.uid) throw new HttpError(401, '请先登录');
    const u = this.db.get('SELECT * FROM users WHERE id = ? AND active = 1', ctx.session.uid);
    if (!u) throw new HttpError(401, '账号不可用');
    return u;
  }

  requireAdmin(ctx) {
    const u = this.requireUser(ctx);
    if (!u.is_admin) throw new HttpError(403, '需要管理员权限');
    return u;
  }

  // ---------- 静态文件 ----------
  serveStatic(ctx) {
    let rel = decodeURIComponent(ctx.url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const full = path.join(PUBLIC_DIR, rel.replace(/^\/+/, ''));
    if (!full.startsWith(PUBLIC_DIR)) return false;
    if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) return false;
    const ext = path.extname(full).toLowerCase();
    const body = fs.readFileSync(full);
    ctx.res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    // HEAD 只返回头
    ctx.res.end(ctx.req.method === 'HEAD' ? undefined : body);
    return true;
  }

  // ---------- 主循环 ----------
  async handle(req, res) {
    const ctx = this.context(req, res);
    try {
      // HEAD 按 GET 处理（路由 + 静态资源），仅省略响应体
      const effective = req.method === 'HEAD' ? 'GET' : req.method;
      for (const r of this.routes) {
        if (r.method !== effective) continue;
        const m = r.regex.exec(ctx.url.pathname);
        if (!m) continue;
        r.keys.forEach((k, i) => (ctx.params[k] = decodeURIComponent(m[i + 1])));
        if (r.json !== false && (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH')) {
          const ct = req.headers['content-type'] || '';
          if (ct.includes('application/json')) ctx.body = await this.readJson(ctx);
        }
        const out = await r.handler(ctx);
        if (out !== undefined && !res.writableEnded) {
          if (typeof out === 'object' && out !== null && out.__raw !== undefined) {
            res.writeHead(out.status || 200, out.headers || {});
            res.end(req.method === 'HEAD' ? undefined : out.__raw);
          } else if (req.method !== 'HEAD') {
            this.json(ctx, 200, out);
          } else {
            const body = JSON.stringify(out);
            res.writeHead(200, {
              'Content-Type': 'application/json; charset=utf-8',
              'Content-Length': Buffer.byteLength(body),
            });
            res.end();
          }
        }
        return;
      }

      if (effective === 'GET' && this.serveStatic(ctx)) return;

      // SPA 兜底
      if (effective === 'GET' && !ctx.url.pathname.startsWith('/api/')) {
        const index = path.join(PUBLIC_DIR, 'index.html');
        if (fs.existsSync(index)) {
          const body = fs.readFileSync(index);
          res.writeHead(200, { 'Content-Type': MIME['.html'], 'Content-Length': body.length });
          res.end(req.method === 'HEAD' ? undefined : body);
          return;
        }
      }
      this.json(ctx, 404, { error: '未找到' });
    } catch (e) {
      if (e instanceof HttpError) {
        this.json(ctx, e.status, { error: e.message });
        return;
      }
      log.error('请求处理异常', e);
      if (!res.writableEnded) this.json(ctx, 500, { error: '服务器内部错误' });
    }
  }

  listen() {
    return new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => this.handle(req, res));
      srv.on('error', reject);
      srv.listen(this.cfg.http.port, this.cfg.http.host, () => {
        log.info(`Web 服务监听 http://${this.cfg.http.host}:${this.cfg.http.port}`);
        resolve(srv);
      });
      this.server = srv;
    });
  }

  close() {
    return new Promise((r) => (this.server ? this.server.close(() => r()) : r()));
  }
}

export function rawResponse(body, status = 200, headers = {}) {
  return { __raw: body, status, headers };
}
