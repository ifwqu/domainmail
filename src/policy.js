// DNS 查询 + SPF 校验 + PTR + 反垃圾评分
import dns from 'node:dns/promises';
import net from 'node:net';
import fs from 'node:fs';
import { createLogger } from './logger.js';

const log = createLogger('policy');
const cache = new Map();

function cached(key, ttl, fn) {
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.val;
  const p = fn().then((val) => {
    cache.set(key, { val, exp: Date.now() + ttl });
    return val;
  }).catch((e) => {
    cache.set(key, { val: null, exp: Date.now() + Math.min(ttl, 60000) });
    return null;
  });
  return p;
}

export async function resolveTxt(name) {
  return cached(`txt:${name}`, 300000, async () => {
    try {
      const recs = await dns.resolveTxt(name);
      return recs.map((r) => r.join(''));
    } catch {
      return null;
    }
  });
}

export async function resolveMx(name) {
  return cached(`mx:${name}`, 300000, async () => {
    try {
      const recs = await dns.resolveMx(name);
      return recs.sort((a, b) => a.priority - b.priority);
    } catch {
      return null;
    }
  });
}

export async function resolvePtr(ip) {
  return cached(`ptr:${ip}`, 600000, async () => {
    try {
      return await dns.reverse(ip);
    } catch {
      return null;
    }
  });
}

export async function resolveA(name) {
  return cached(`a:${name}`, 300000, async () => {
    try {
      return await dns.resolve4(name);
    } catch {
      return null;
    }
  });
}

// ---------- SPF ----------
function ipInCidr(ip, cidr) {
  const [range, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  const fam = net.isIPv6(ip) ? 6 : 4;
  const rangeFam = net.isIPv6(range) ? 6 : 4;
  if (fam !== rangeFam) return false;
  const size = fam === 4 ? 4 : 16;
  const toBuf = (addr) => {
    if (fam === 4) {
      const p = addr.split('.').map(Number);
      return Buffer.from(p);
    }
    // 简化 IPv6 展开
    const [head, tail = ''] = addr.split('::');
    const hp = head ? head.split(':') : [];
    const tp = tail ? tail.split(':') : [];
    const missing = 8 - hp.length - tp.length;
    const groups = [...hp, ...Array(Math.max(0, missing)).fill('0'), ...tp];
    const buf = Buffer.alloc(16);
    groups.forEach((g, i) => buf.writeUInt16BE(parseInt(g || '0', 16), i * 2));
    return buf;
  };
  try {
    const a = toBuf(ip);
    const b = toBuf(range);
    const fullBytes = Math.floor(bits / 8);
    const rem = bits % 8;
    for (let i = 0; i < fullBytes; i++) if (a[i] !== b[i]) return false;
    if (rem) {
      const mask = 0xff << (8 - rem) & 0xff;
      if ((a[fullBytes] & mask) !== (b[fullBytes] & mask)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function ipMatches(ip, token) {
  if (token.includes('/')) return ipInCidr(ip, token);
  return ip === token;
}

export async function checkSpf({ ip, domain, helo, mailFrom }) {
  const senderDomain = (mailFrom || '').split('@')[1] || domain || helo;
  if (!senderDomain) return { result: 'none', reason: 'no-domain' };

  const txt = await resolveTxt(senderDomain);
  if (!txt) return { result: 'none', reason: 'no-dns' };
  const spf = txt.find((t) => /^v=spf1\b/i.test(t.trim()));
  if (!spf) return { result: 'none', reason: 'no-record' };

  const terms = spf.replace(/^v=spf1\s*/i, '').split(/\s+/).filter(Boolean);
  let lookups = 0;

  const evalTerm = async (term) => {
    if (lookups > 10) return { result: 'permerror' };
    const lower = term.toLowerCase();
    if (lower === 'all') return { result: 'pass' };
    if (lower === '-all') return { result: 'fail' };
    if (lower === '~all') return { result: 'softfail' };
    if (lower === '?all') return { result: 'neutral' };

    const m = /^([+\-~?]?)([a-z0-9]+)([::]?)(.*)$/.exec(lower);
    if (!m) return null;
    const [, qual, mech, sep, argRaw] = m;
    const arg = sep === ':' ? argRaw : argRaw.replace(/^\//, '');
    const q = qual || '+';

    let matched = false;
    if (mech === 'ip4' || mech === 'ip6') {
      matched = ipMatches(ip, arg);
    } else if (mech === 'a') {
      lookups++;
      const target = arg ? arg.split('/')[0] : senderDomain;
      const addrs = await resolveA(target);
      matched = !!addrs && addrs.includes(ip);
    } else if (mech === 'mx') {
      lookups++;
      const target = arg ? arg.split('/')[0] : senderDomain;
      const mxs = await resolveMx(target);
      if (mxs) {
        for (const mx of mxs) {
          const addrs = await resolveA(mx.exchange);
          if (addrs && addrs.includes(ip)) { matched = true; break; }
        }
      }
    } else if (mech === 'include') {
      lookups++;
      const sub = await checkSpf({ ip, domain: arg, mailFrom: `x@${arg}` });
      if (sub.result === 'pass') matched = true;
      else if (sub.result === 'permerror') return { result: 'permerror' };
    } else if (mech === 'exists') {
      lookups++;
      const addrs = await resolveA(arg);
      matched = !!addrs;
    } else if (mech === 'ptr') {
      // 已废弃，忽略
      matched = false;
    } else if (mech === 'redirect') {
      lookups++;
      const sub = await checkSpf({ ip, domain: arg, mailFrom: `x@${arg}` });
      return sub;
    } else if (mech === 'exp') {
      return null;
    } else {
      return null;
    }

    if (matched) {
      const map = { '+': 'pass', '-': 'fail', '~': 'softfail', '?': 'neutral' };
      return { result: map[q] || 'neutral' };
    }
    return null;
  };

  for (const term of terms) {
    const r = await evalTerm(term);
    if (r) return { result: r.result, record: spf };
  }
  return { result: 'neutral', record: spf };
}

// ---------- 反垃圾 ----------
export function loadBlacklist(cfg) {
  const f = cfg.antispam.blacklistFile;
  if (!f || !fs.existsSync(f)) return new Set();
  try {
    return new Set(
      fs.readFileSync(f, 'utf8')
        .split(/\r?\n/)
        .map((l) => l.trim().toLowerCase())
        .filter((l) => l && !l.startsWith('#'))
    );
  } catch {
    return new Set();
  }
}

export async function scoreSpam({ cfg, parsed, remoteIp, helo, mailFrom, spfResult }) {
  const a = cfg.antispam;
  if (!a.enabled) return { score: 0, reason: '', reject: false };
  let score = 0;
  const reasons = [];

  const text = `${parsed.subject}\n${parsed.text}`.toLowerCase();
  for (const kw of a.keywords || []) {
    if (text.includes(String(kw).toLowerCase())) {
      score += a.keywordScore;
      reasons.push(`kw:${kw}`);
    }
  }

  const fromDomain = (parsed.from.address.split('@')[1] || '').toLowerCase();
  for (const tld of a.suspiciousTlds || []) {
    if (fromDomain.endsWith(tld)) {
      score += a.suspiciousTldScore;
      reasons.push(`tld:${tld}`);
      break;
    }
  }

  const blacklist = loadBlacklist(cfg);
  if (blacklist.size) {
    if (remoteIp && blacklist.has(remoteIp)) { score += 100; reasons.push('ip-blacklist'); }
    if (fromDomain && blacklist.has(fromDomain)) { score += 100; reasons.push('domain-blacklist'); }
    for (const a2 of [...parsed.to, ...parsed.cc]) {
      if (blacklist.has(a2.address)) { score += 100; reasons.push('rcpt-blacklist'); break; }
    }
  }

  if (parsed.subject) {
    const letters = parsed.subject.replace(/[^A-Za-z]/g, '');
    const upper = parsed.subject.replace(/[^A-Z]/g, '');
    if (letters.length > 8 && upper.length / letters.length > 0.7) {
      score += a.shoutScore;
      reasons.push('shouty-subject');
    }
    if ((parsed.subject.match(/[!！]/g) || []).length >= 5) {
      score += a.shoutScore;
      reasons.push('excess-exclaim');
    }
  }

  if (!parsed.text.trim() && !parsed.html.trim()) {
    score += a.emptyBodyScore;
    reasons.push('empty-body');
  }

  if (spfResult === 'fail') { score += 3; reasons.push('spf-fail'); }
  if (spfResult === 'softfail') { score += 1; reasons.push('spf-softfail'); }

  return {
    score,
    reason: reasons.join(','),
    reject: score >= a.rejectScore,
    spam: score >= a.spamThreshold,
  };
}
