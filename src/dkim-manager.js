// DKIM 密钥管理：按域名生成/读取/签名，输出 DNS 记录
import fs from 'node:fs';
import path from 'node:path';
import { generateKeyPair, dnsRecord, signMessage } from './dkim.js';
import { createLogger } from './logger.js';

const log = createLogger('dkimmgr');

export class DkimManager {
  constructor({ cfg, db }) {
    this.cfg = cfg;
    this.db = db;
    this.cache = new Map();
  }

  keyDir(domain) {
    return path.join(this.cfg.dataDir, 'dkim', domain);
  }

  ensure(domain, { selector, bits } = {}) {
    const d = String(domain).toLowerCase();
    const row = this.db.get('SELECT * FROM domains WHERE name = ?', d);
    const sel = selector || row?.dkim_selector || this.cfg.dkim.selector;
    const dir = this.keyDir(d);
    const privPath = path.join(dir, `${sel}.key.pem`);
    const pubPath = path.join(dir, `${sel}.pub.pem`);

    if (fs.existsSync(privPath) && fs.existsSync(pubPath)) {
      const privateKey = fs.readFileSync(privPath, 'utf8');
      const publicKey = fs.readFileSync(pubPath, 'utf8');
      const dnsValue = publicKey
        .replace(/-----BEGIN PUBLIC KEY-----/, '')
        .replace(/-----END PUBLIC KEY-----/, '')
        .replace(/\s+/g, '');
      return { domain: d, selector: sel, privateKey, publicKey, dnsValue };
    }

    const kp = generateKeyPair(bits || this.cfg.dkim.keyBits);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(privPath, kp.privateKey, { mode: 0o600 });
    fs.writeFileSync(pubPath, kp.publicKey);
    if (row) {
      this.db.run(
        'UPDATE domains SET dkim_selector = ?, dkim_private = ?, dkim_public = ? WHERE id = ?',
        sel, kp.privateKey, kp.dnsValue, row.id
      );
    }
    log.info(`已生成 DKIM 密钥 ${d} selector=${sel}`);
    return { domain: d, selector: sel, privateKey: kp.privateKey, publicKey: kp.publicKey, dnsValue: kp.dnsValue };
  }

  rotate(domain, { selector, bits } = {}) {
    const d = String(domain).toLowerCase();
    const dir = this.keyDir(d);
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        try { fs.unlinkSync(path.join(dir, f)); } catch {}
      }
    }
    this.cache.delete(d);
    return this.ensure(d, { selector, bits });
  }

  forDomain(domain) {
    if (!domain) return null;
    const d = String(domain).toLowerCase();
    const row = this.db.get('SELECT * FROM domains WHERE name = ?', d);
    if (row && !row.dkim_enabled) return null;
    const cached = this.cache.get(d);
    if (cached) return cached;

    const dir = this.keyDir(d);
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.key.pem'));
      if (files.length) {
        const sel = files[0].replace('.key.pem', '');
        const privateKey = fs.readFileSync(path.join(dir, files[0]), 'utf8');
        const out = { domain: d, selector: sel, privateKey, ...this.cfg.dkim };
        this.cache.set(d, out);
        return out;
      }
    }
    if (!this.cfg.dkim.autoGenerate) return null;
    if (!row) return null;
    const k = this.ensure(d);
    const out = { domain: d, selector: k.selector, privateKey: k.privateKey, ...this.cfg.dkim };
    this.cache.set(d, out);
    return out;
  }

  sign(raw, domain) {
    const k = this.forDomain(domain);
    if (!k) return raw;
    return signMessage(raw, {
      domain: k.domain,
      selector: k.selector,
      privateKey: k.privateKey,
      headers: this.cfg.dkim.headers,
      algorithm: this.cfg.dkim.algorithm,
    });
  }

  dnsRecordFor(domain, selector) {
    const d = String(domain).toLowerCase();
    const row = this.db.get('SELECT * FROM domains WHERE name = ?', d);
    let sel = selector || row?.dkim_selector || this.cfg.dkim.selector;
    let value = row?.dkim_public || '';
    if (!value) {
      const dir = this.keyDir(d);
      if (fs.existsSync(dir)) {
        const pub = fs.readdirSync(dir).find((f) => f.endsWith('.pub.pem'));
        if (pub) {
          sel = pub.replace('.pub.pem', '');
          value = fs.readFileSync(path.join(dir, pub), 'utf8')
            .replace(/-----BEGIN PUBLIC KEY-----/, '')
            .replace(/-----END PUBLIC KEY-----/, '')
            .replace(/\s+/g, '');
        }
      }
    }
    if (!value) return null;
    return {
      name: `${sel}._domainkey.${d}`,
      type: 'TXT',
      value: `v=DKIM1; k=rsa; p=${value}`,
      formatted: dnsRecord(sel, value),
    };
  }
}
