import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function deepMerge(base, over) {
  if (over === undefined) return base;
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export const DEFAULT_CONFIG = {
  hostname: 'mail.example.com',
  brand: 'Domain Mail',
  dataDir: './data',
  log: { level: 'info', file: './data/logs/mail.log' },

  http: {
    enabled: true,
    host: '0.0.0.0',
    port: 8080,
    adminPath: '/admin',
    sessionSecret: '',
    sessionTtlSeconds: 7 * 24 * 3600,
    trustProxy: true,
    allowSelfRegister: true,
    registerDomains: [],
    // 注册时是否需要邮箱验证码（需出站投递可用）
    requireEmailVerify: false,
    // 新用户默认配额 MB；0 = 无限
    defaultQuotaMb: 0,
    admin: { email: 'admin@example.com', password: '' },
  },

  // 无限邮箱：每个账号可创建任意多个别名地址
  alias: {
    // 每个账号最多可创建的别名数量；0 = 无限
    maxPerUser: 0,
    // 是否允许用户自助创建别名
    allowSelfCreate: true,
    // 单次批量创建上限
    maxBatch: 500,
  },

  smtp: {
    enabled: true,
    host: '0.0.0.0',
    port: 25,
    maxMessageBytes: 25 * 1024 * 1024,
    maxRecipients: 100,
    banner: '',
    checkHelo: true,
    checkPtr: 'none',
    checkSpf: 'none',
    rejectUnknownSenderDomain: false,
    rateLimitPerIpPerMinute: 600,
    domains: [],
  },

  submission: {
    enabled: true,
    host: '0.0.0.0',
    port: 587,
    requireTls: false,
    maxMessageBytes: 25 * 1024 * 1024,
    rateLimitPerUserPerMinute: 120,
  },

  imap: {
    enabled: true,
    host: '0.0.0.0',
    port: 143,
    // IMAPS 隐式 TLS 端口；设为 0 关闭
    tlsPort: 993,
    requireTls: false,
    idleTimeoutMs: 30 * 60 * 1000,
    maxConnectionsPerIp: 60,
  },

  outbound: {
    enabled: true,
    pollIntervalMs: 5000,
    maxAttempts: 8,
    retryBaseSeconds: 60,
    maxBackoffSeconds: 6 * 3600,
    connectTimeoutMs: 15000,
    socketTimeoutMs: 60000,
    concurrency: 4,
    allowPrivateRelay: false,
    // 出站 IP 协议族优先级：auto / ipv6 / ipv4
    // Oracle/AWS 等云厂商常封锁 IPv4 出站 25，但 IPv6 可用 → 设为 ipv6
    ipFamily: 'auto',
    relay: {
      enabled: false,
      // always = 全部走中继；fallback = 直连失败才走中继
      mode: 'fallback',
      type: 'smtp',
      host: '',
      port: 587,
      secure: false,
      user: '',
      pass: '',
      apiKey: '',
    },
  },

  storage: {
    driver: 'local',
    s3: {
      endpoint: '',
      region: 'auto',
      bucket: '',
      accessKeyId: '',
      secretAccessKey: '',
      forcePathStyle: true,
    },
  },

  tls: {
    certFile: './data/tls/cert.pem',
    keyFile: './data/tls/key.pem',
    selfSignedNames: [],
    minVersion: 'TLSv1.2',
  },

  dkim: {
    autoGenerate: true,
    keyBits: 2048,
    selector: 'mail',
    headers: [
      'from', 'to', 'cc', 'subject', 'date', 'message-id',
      'mime-version', 'content-type', 'content-transfer-encoding',
      'reply-to', 'in-reply-to', 'references',
    ],
    canonicalization: 'relaxed/relaxed',
    algorithm: 'rsa-sha256',
  },

  antispam: {
    enabled: true,
    spamThreshold: 5,
    keywords: ['viagra', 'casino', '代开发票', '博彩', '刷单', '兼职日结', '贷款秒批', 'usdt洗'],
    keywordScore: 2,
    suspiciousTlds: ['.top', '.xyz', '.click', '.loan', '.work', '.buzz', '.icu'],
    suspiciousTldScore: 1,
    shoutScore: 1,
    emptyBodyScore: 1,
    rejectScore: 100,
    blacklistFile: './data/blacklist.txt',
  },
};

export function loadConfig(configPath) {
  const file = path.resolve(configPath || path.join(projectRoot, 'config.json'));
  let user = {};
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (raw) user = JSON.parse(raw);
  }
  const cfg = deepMerge(DEFAULT_CONFIG, user);
  cfg.__root = projectRoot;
  cfg.__configPath = file;
  cfg.dataDir = path.resolve(projectRoot, expandHome(cfg.dataDir));
  cfg.log.file = cfg.log.file ? path.resolve(projectRoot, expandHome(cfg.log.file)) : null;
  cfg.tls.certFile = path.resolve(projectRoot, expandHome(cfg.tls.certFile));
  cfg.tls.keyFile = path.resolve(projectRoot, expandHome(cfg.tls.keyFile));
  cfg.antispam.blacklistFile = cfg.antispam.blacklistFile
    ? path.resolve(projectRoot, expandHome(cfg.antispam.blacklistFile))
    : null;
  if (!cfg.smtp.banner) cfg.smtp.banner = `220 ${cfg.hostname} ESMTP DomainMail ready`;
  return cfg;
}

export function ensureDirs(cfg) {
  const dirs = [
    cfg.dataDir,
    path.join(cfg.dataDir, 'logs'),
    path.join(cfg.dataDir, 'tls'),
    path.join(cfg.dataDir, 'dkim'),
    path.join(cfg.dataDir, 'spool'),
    path.join(cfg.dataDir, 'messages'),
    path.join(cfg.dataDir, 'tmp'),
    path.join(cfg.dataDir, 'attachments'),
  ];
  for (const d of dirs) fs.mkdirSync(d, { recursive: true });
}

export function loadOrCreateSecret(cfg) {
  if (cfg.http.sessionSecret) return cfg.http.sessionSecret;
  const f = path.join(cfg.dataDir, 'secret');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  const s = crypto.randomBytes(48).toString('base64url');
  fs.writeFileSync(f, s, { mode: 0o600 });
  return s;
}
