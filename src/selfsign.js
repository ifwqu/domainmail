// 纯 Node 实现的 X.509 v3 自签证书生成（不依赖 openssl）
// 支持 RSA 2048，SAN 包含 DNS 与 IP
import crypto from 'node:crypto';

// ---- DER 编码工具 ----
function len(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag, content) {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return Buffer.concat([Buffer.from([tag]), len(body.length), body]);
}

const seq = (...items) => tlv(0x30, Buffer.concat(items));
const set = (...items) => tlv(0x31, Buffer.concat(items));
const int = (buf) => {
  let b = Buffer.isBuffer(buf) ? buf : Buffer.from([buf]);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
};
const bitStr = (buf, unused = 0) => tlv(0x03, Buffer.concat([Buffer.from([unused]), buf]));
const octet = (buf) => tlv(0x04, buf);
const nul = () => Buffer.from([0x05, 0x00]);
const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
const printable = (s) => tlv(0x13, Buffer.from(s, 'ascii'));
const ia5 = (s) => tlv(0x16, Buffer.from(s, 'ascii'));
const bool = (v) => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));
const explicit = (n, content) => tlv(0xa0 + n, content);
const ctx = (n, content, constructed = false) => tlv((constructed ? 0xa0 : 0x80) + n, content);

function oid(str) {
  const parts = str.split('.').map(Number);
  const bytes = [40 * parts[0] + parts[1]];
  for (let i = 2; i < parts.length; i++) {
    let v = parts[i];
    const stack = [v & 0x7f];
    v >>= 7;
    while (v > 0) {
      stack.unshift((v & 0x7f) | 0x80);
      v >>= 7;
    }
    bytes.push(...stack);
  }
  return tlv(0x06, Buffer.from(bytes));
}

function time(d) {
  // UTCTime (YYMMDDHHMMSSZ) 用于 1950-2049
  const p = (n) => String(n).padStart(2, '0');
  const s = `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return tlv(0x17, Buffer.from(s, 'ascii'));
}

function name(cn) {
  return seq(
    set(seq(oid('2.5.4.3'), utf8(cn))),
    set(seq(oid('2.5.4.10'), utf8('DomainMail')))
  );
}

function sanExtension(names) {
  const entries = names.map((n) => (/^\d+\.\d+\.\d+\.\d+$/.test(n) ? ctx(7, Buffer.from(n.split('.').map(Number)), false) : ctx(2, Buffer.from(n, 'ascii'), false)));
  const value = octet(seq(...entries));
  return seq(oid('2.5.29.17'), value);
}

function keyUsageExtension() {
  // digitalSignature | keyEncipherment | keyCertSign
  const bits = Buffer.from([0x07, 0xa0]);
  return seq(oid('2.5.29.15'), bool(true), octet(bitStr(bits, 5)));
}

function basicConstraintsExtension() {
  return seq(oid('2.5.29.19'), bool(true), octet(seq(bool(true))));
}

function extKeyUsageExtension() {
  // serverAuth 1.3.6.1.5.5.7.3.1
  return seq(oid('2.5.29.37'), octet(seq(oid('1.3.6.1.5.5.7.3.1'))));
}

function serialNumber() {
  const b = crypto.randomBytes(16);
  b[0] = b[0] & 0x7f || 0x01;
  return b;
}

// 生成自签证书
export function generateSelfSignedCert({ names = [], commonName = 'localhost', days = 3650, bits = 2048 } = {}) {
  const list = names.length ? names : [commonName];
  const cn = commonName || list[0];

  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: bits,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const now = new Date();
  const notBefore = new Date(now.getTime() - 24 * 3600 * 1000);
  const notAfter = new Date(now.getTime() + days * 24 * 3600 * 1000);

  const sigAlg = seq(oid('1.2.840.113549.1.1.11'), nul()); // sha256WithRSAEncryption
  const issuer = name(cn);
  const subject = name(cn);
  const serial = int(serialNumber());

  const extensions = seq(
    sanExtension(list),
    keyUsageExtension(),
    basicConstraintsExtension(),
    extKeyUsageExtension()
  );

  const tbs = seq(
    explicit(0, int(2)),        // version v3
    serial,
    sigAlg,
    issuer,
    seq(time(notBefore), time(notAfter)),
    subject,
    publicKey,                  // SubjectPublicKeyInfo (DER)
    explicit(3, extensions)
  );

  const signer = crypto.createPrivateKey(privateKey);
  const signature = crypto.sign('sha256', tbs, signer);
  const cert = seq(tbs, sigAlg, bitStr(signature));

  const toPem = (der, label) => {
    const b64 = der.toString('base64').replace(/(.{64})/g, '$1\n').trim();
    return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
  };

  return {
    cert: toPem(cert, 'CERTIFICATE'),
    key: privateKey,
    names: list,
  };
}
