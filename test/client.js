// 测试用 SMTP / IMAP 客户端：基于字节缓冲的精确读取
import net from 'node:net';

class Reader {
  constructor(sock) {
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    this.waiter = null;
    this.closed = false;
    sock.on('data', (c) => {
      this.buf = Buffer.concat([this.buf, c]);
      this.notify();
    });
    sock.on('close', () => {
      this.closed = true;
      this.notify();
    });
  }

  notify() {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w();
    }
  }

  async waitFor(pred) {
    while (!pred()) {
      if (this.closed) throw new Error('连接已关闭');
      await new Promise((res) => {
        this.waiter = res;
        setTimeout(res, 5000);
      });
    }
  }

  async readLine() {
    await this.waitFor(() => {
      const i = this.buf.indexOf('\r\n');
      return i !== -1;
    });
    const i = this.buf.indexOf('\r\n');
    const line = this.buf.subarray(0, i).toString('utf8');
    this.buf = this.buf.subarray(i + 2);
    return line;
  }

  async readBytes(n) {
    await this.waitFor(() => this.buf.length >= n);
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }
}

export function smtpClient({ port, host = '127.0.0.1' }) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, host);
    const r = new Reader(sock);
    sock.on('error', reject);

    const readResponse = async () => {
      const first = await r.readLine();
      const out = [first];
      if (first.length > 3 && first[3] === '-') {
        const code = first.slice(0, 3);
        while (true) {
          const l = await r.readLine();
          out.push(l);
          if (l.startsWith(code + ' ')) break;
        }
      }
      return out;
    };

    const cmd = async (line) => {
      sock.write(line + '\r\n');
      return readResponse();
    };

    sock.once('connect', () => {
      resolve({
        sock,
        readResponse,
        cmd,
        write: (s) => sock.write(s),
        close: () => sock.end(),
      });
    });
  });
}

export function imapClient({ port, host = '127.0.0.1' }) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, host);
    const r = new Reader(sock);
    sock.on('error', reject);

    const greeting = async () => r.readLine();

    const cmd = async (tag, line) => {
      sock.write(line + '\r\n');
      const out = [];
      while (true) {
        const l = await r.readLine();
        const m = /\{(\d+)\}$/.exec(l);
        if (m) {
          out.push(l);
          const n = Number(m[1]);
          const data = await r.readBytes(n);
          out.push({ literal: data.toString('utf8'), size: n });
          continue;
        }
        out.push(l);
        if (l.startsWith('+')) continue;
        if (new RegExp(`^${tag} (OK|NO|BAD)`, 'i').test(l)) break;
        if (l.startsWith('* BYE')) break;
      }
      return out;
    };

    sock.once('connect', () => {
      resolve({
        sock,
        greeting,
        cmd,
        write: (s) => sock.write(s),
        close: () => sock.end(),
      });
    });
  });
}
