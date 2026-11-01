// DKIM (RFC 6376)：rsa-sha256，relaxed/relaxed 签名与验证
import crypto from 'node:crypto';

const CRLF = '\r\n';

function splitRaw(raw) {
  const s = Buffer.isBuffer(raw) ? raw.toString('latin1') : String(raw);
  let i = s.indexOf('\r\n\r\n');
  if (i !== -1) return { head: s.slice(0, i + 2), body: s.slice(i + 4) };
  i = s.indexOf('\n\n');
  if (i !== -1) return { head: s.slice(0, i + 1), body: s.slice(i + 2) };
  return { head: s, body: '' };
}

function parseHead(head) {
  const out = [];
  for (const line of head.split(/\r?\n/)) {
    if (!line) continue;
    if (/^[ \t]/.test(line) && out.length) {
      out[out.length - 1].value += CRLF + line;
      continue;
    }
    const i = line.indexOf(':');
    if (i < 0) continue;
    out.push({ name: line.slice(0, i).trim(), value: line.slice(i + 1) });
  }
  return out;
}

function canonHeaderRelaxed(name, value) {
  const n = name.toLowerCase().trim();
  const v = String(value)
    .replace(/\r?\n/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
  return `${n}:${v}`;
}

function canonBodyRelaxed(body) {
  let b = String(body).replace(/\r?\n/g, '\n');
  const lines = b.split('\n').map((l) => l.replace(/[ \t]+$/, '').replace(/[ \t]+/g, ' '));
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (!lines.length) return '';
  return lines.join(CRLF) + CRLF;
}

export function bodyHash(body, algorithm = 'sha256') {
  const canon = canonBodyRelaxed(body);
  return crypto.createHash(algorithm).update(canon, 'latin1').digest('base64');
}

function foldHeader(name, value, maxLen = 78) {
  const tokens = value.split(/(?=;\s)/);
  let out = `${name}:`;
  let lineLen = out.length;
  const pieces = [];
  let cur = '';
  for (const ch of value) cur += ch;
  // 按 ";" 分割为可折叠片段
  const segs = cur.split(';').map((s, i, arr) => (i < arr.length - 1 ? `${s};` : s));
  for (const seg of segs) {
    const piece = seg.trim();
    if (!piece) continue;
    if (lineLen + 1 + piece.length > maxLen) {
      pieces.push(CRLF + ' ' + piece);
      lineLen = 1 + piece.length;
    } else {
      pieces.push(' ' + piece);
      lineLen += 1 + piece.length;
    }
  }
  return out + pieces.join('');
}

export function signMessage(rawMessage, { domain, selector, privateKey, headers, algorithm = 'rsa-sha256' }) {
  const { head, body } = splitRaw(rawMessage);
  const parsed = parseHead(head);
  const bh = bodyHash(body, algorithm.replace('rsa-', ''));
  const t = Math.floor(Date.now() / 1000);
  const signHeaders = (headers || []).map((h) => h.toLowerCase());

  // 找出实际存在且未被重复的头部（From 必须有）
  const present = [];
  const seen = new Set();
  for (const h of signHeaders) {
    const found = parsed.filter((p) => p.name.toLowerCase() === h);
    if (!found.length) continue;
    if (h === 'from' || !seen.has(h)) {
      present.push({ name: h, value: found[found.length - 1].value });
      seen.add(h);
    }
  }
  if (!seen.has('from')) throw new Error('DKIM: 邮件缺少 From 头');

  const hList = present.map((p) => p.name).join(':');
  const baseValue =
    `v=1; a=${algorithm}; c=relaxed/relaxed; d=${domain}; s=${selector}; t=${t}; ` +
    `h=${hList}; bh=${bh}; b=`;

  const headerToHash = foldHeader('DKIM-Signature', baseValue);
  const canon = [];
  for (const p of present) canon.push(canonHeaderRelaxed(p.name, p.value));
  canon.push(canonHeaderRelaxed('DKIM-Signature', headerToHash.slice('DKIM-Signature:'.length)));

  const data = canon.join(CRLF) + CRLF;
  const sig = crypto.sign('sha256', Buffer.from(data, 'latin1'), privateKey).toString('base64');
  const folded = foldHeader('DKIM-Signature', `${baseValue}${sig}`);
  return folded + CRLF + rawMessage;
}

// ---- 校验（自测/收信验签用）----
export function verifyMessage(rawMessage, publicKeyPem) {
  const { head, body } = splitRaw(rawMessage);
  const parsed = parseHead(head);
  const sigHeader = parsed.find((p) => p.name.toLowerCase() === 'dkim-signature');
  if (!sigHeader) return { ok: false, reason: 'no-signature' };
  const flat = sigHeader.value.replace(/\r?\n[ \t]+/g, ' ');
  const tags = {};
  for (const part of flat.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    tags[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  if (tags.v !== '1') return { ok: false, reason: 'bad-version' };
  const algo = (tags.a || 'rsa-sha256').replace('rsa-', '');
  const bh = bodyHash(body, algo);
  if (bh !== tags.bh) return { ok: false, reason: 'body-hash-mismatch', bh, expected: tags.bh };

  const hList = (tags.h || '').split(':').map((s) => s.trim().toLowerCase());
  const bValue = tags.b;
  // 重建签名头（b= 置空，去掉末尾 CRLF）
  const rebuilt = sigHeader.value.replace(/b=[^;]*$/, 'b=').replace(/\r?\n[ \t]+/g, ' ');
  const canon = [];
  for (const h of hList) {
    const found = parsed.filter((p) => p.name.toLowerCase() === h);
    if (!found.length) return { ok: false, reason: `missing-header:${h}` };
    canon.push(canonHeaderRelaxed(h, found[found.length - 1].value));
  }
  canon.push(canonHeaderRelaxed('dkim-signature', rebuilt.replace(/^dkim-signature:/i, '')));
  const data = canon.join(CRLF) + CRLF;
  const ok = crypto.verify('sha256', Buffer.from(data, 'latin1'), publicKeyPem, Buffer.from(bValue, 'base64'));
  return { ok, reason: ok ? 'ok' : 'bad-signature', domain: tags.d, selector: tags.s };
}

export function generateKeyPair(bits = 2048) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: bits,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const b64 = publicKey
    .replace(/-----BEGIN PUBLIC KEY-----/, '')
    .replace(/-----END PUBLIC KEY-----/, '')
    .replace(/\s+/g, '');
  return { privateKey, publicKey, dnsValue: b64 };
}

export function dnsRecord(selector, dnsValue) {
  const chunks = dnsValue.match(/.{1,200}/g) || [];
  return `${selector}._domainkey IN TXT ( ${chunks.map((c) => `"${c}"`).join(' ')} )`;
}
