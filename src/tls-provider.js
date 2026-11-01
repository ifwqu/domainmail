// TLS 证书：读取真实证书（Let's Encrypt 等），缺失时用纯 Node 生成自签证书
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createLogger } from './logger.js';
import { generateSelfSignedCert } from './selfsign.js';

const log = createLogger('tls');

export class TlsProvider {
  constructor({ cfg }) {
    this.cfg = cfg;
    this.current = null;
    this.mtime = 0;
  }

  load() {
    const { certFile, keyFile } = this.cfg.tls;
    try {
      if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
        const st = fs.statSync(certFile);
        if (this.current && st.mtimeMs === this.mtime) return this.current;
        const cert = fs.readFileSync(certFile);
        const key = fs.readFileSync(keyFile);
        // 校验证书能被 Node 解析
        try {
          new crypto.X509Certificate(cert);
        } catch (e) {
          log.warn(`证书文件无效：${e.message}`);
          return this.current;
        }
        this.current = { cert, key };
        this.mtime = st.mtimeMs;
        return this.current;
      }
    } catch (e) {
      log.warn('读取证书失败', e.message);
    }
    return this.current;
  }

  get() {
    return this.load();
  }

  hasRealCert() {
    return fs.existsSync(this.cfg.tls.certFile) && fs.existsSync(this.cfg.tls.keyFile);
  }

  selfSign(names) {
    const { certFile, keyFile } = this.cfg.tls;
    const list = (names && names.length ? names : [this.cfg.hostname, 'localhost', '127.0.0.1']).filter(Boolean);
    fs.mkdirSync(path.dirname(certFile), { recursive: true });
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    try {
      const { cert, key } = generateSelfSignedCert({ names: list, commonName: list[0], days: 3650 });
      fs.writeFileSync(certFile, cert);
      fs.writeFileSync(keyFile, key, { mode: 0o600 });
      log.info(`已生成自签证书：${list.join(', ')}（有效期 10 年）`);
      this.current = null;
      this.load();
      return true;
    } catch (e) {
      log.error('生成自签证书失败', e.message);
      return false;
    }
  }

  // 检测证书是否包含指定域名
  coversName(name) {
    const c = this.get();
    if (!c) return false;
    try {
      const x = new crypto.X509Certificate(c.cert);
      return x.checkHost(name) !== undefined;
    } catch {
      return false;
    }
  }
}
