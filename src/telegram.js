// Telegram 推送：把新邮件以 HTML 消息推到 Bot 对话
// 零依赖，只用内置 fetch；串行队列 + 最小间隔，避免触发 Bot API 限流
import { createLogger } from './logger.js';

const log = createLogger('telegram');

const TG_MAX_TEXT = 4096;

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function fmtBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let x = v;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i++;
  }
  return `${i === 0 || x >= 10 ? Math.round(x) : x.toFixed(1)} ${units[i]}`;
}

function fmtTime(ts, offsetMinutes) {
  const t = Number(ts) || Date.now();
  const d = new Date(t + (Number(offsetMinutes) || 0) * 60 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

export function maskToken(token) {
  const s = String(token || '');
  if (!s) return '';
  const i = s.indexOf(':');
  if (i < 0) return `${s.slice(0, 4)}****`;
  return `${s.slice(0, i)}:****${s.slice(-4)}`;
}

export class TelegramNotifier {
  constructor({ cfg }) {
    this.cfg = cfg || {};
    this.tg = this.cfg.telegram || {};
    this.queue = [];
    this.draining = false;
    this.stats = { sent: 0, failed: 0, skipped: 0, lastError: '', lastSentAt: 0 };
  }

  get enabled() {
    return !!(this.tg.enabled && this.tg.botToken && String(this.tg.chatId || '').trim());
  }

  status() {
    return {
      enabled: this.enabled,
      chatId: this.tg.chatId || '',
      botToken: maskToken(this.tg.botToken),
      events: this.tg.events || {},
      skipJunk: !!this.tg.skipJunk,
      pending: this.queue.length,
      ...this.stats,
    };
  }

  /** 渲染邮件为 Telegram HTML 文本 */
  render({ parsed, rcpts = [], folder = 'INBOX' }) {
    const max = Math.max(400, Number(this.tg.maxLength) || 3500);
    const p = parsed || {};
    const fromName = p.from?.name ? `${esc(p.from.name)} ` : '';
    const fromAddr = esc(p.from?.address || '(未知)');
    const subject = esc(p.subject || '(无主题)');
    const when = fmtTime(p.date, this.tg.timezoneOffsetMinutes ?? 480);

    const head = [
      `<b>📬 新邮件</b>${folder === 'Junk' ? ' · <i>垃圾箱</i>' : ''}`,
      `<b>发件人</b>：${fromName}&lt;${fromAddr}&gt;`,
      `<b>收件人</b>：${esc(rcpts.join(', ') || '-')}`,
      `<b>主题</b>：${subject}`,
      `<b>时间</b>：${when} · ${fmtBytes(p.size)}`,
    ].join('\n');

    let body = String(p.text || '').trim();
    if (!body) body = '(无正文)';
    body = body.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n');

    const room = Math.max(200, max - head.length - 120);
    const full = body.length;
    let truncated = false;
    if (body.length > room) {
      body = body.slice(0, room);
      truncated = true;
    }

    const out = [head, '────────────', esc(body)];
    if (truncated) out.push(`<i>…正文已截断（原文 ${full} 字）</i>`);

    const atts = p.attachments || [];
    if (atts.length) {
      out.push(`<b>📎 附件 ${atts.length} 个</b>`);
      for (const a of atts.slice(0, 8)) {
        out.push(`· ${esc(a.filename || '未命名')} (${fmtBytes(a.size)})`);
      }
      if (atts.length > 8) out.push(`· …另有 ${atts.length - 8} 个`);
    }

    return out.join('\n').slice(0, TG_MAX_TEXT);
  }

  /** 入队推送；不阻塞调用方 */
  notify(event) {
    if (!this.enabled) {
      this.stats.skipped++;
      return { ok: false, reason: 'disabled' };
    }
    const events = this.tg.events || {};
    const dir = event.direction || 'inbound';
    if (dir === 'inbound' && events.inbound === false) {
      this.stats.skipped++;
      return { ok: false, reason: 'inbound-off' };
    }
    if (dir === 'outbound' && !events.outbound) {
      this.stats.skipped++;
      return { ok: false, reason: 'outbound-off' };
    }
    if (event.folder === 'Junk' && this.tg.skipJunk) {
      this.stats.skipped++;
      return { ok: false, reason: 'junk-skip' };
    }

    const text = this.render(event);
    this.queue.push({
      method: 'sendMessage',
      payload: {
        chat_id: String(this.tg.chatId),
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      },
    });
    this.drain();
    return { ok: true, queued: true, length: text.length };
  }

  /** 直接发送一条测试消息（不进队列，立即返回结果） */
  async sendTest(text) {
    const body = text || '<b>✅ 连接测试</b>\n域名邮箱与 Telegram 推送通道正常。';
    const r = await this.call('sendMessage', {
      chat_id: String(this.tg.chatId),
      text: body,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
    this.stats.sent++;
    this.stats.lastSentAt = Date.now();
    return r;
  }

  async getMe() {
    return this.call('getMe', undefined);
  }

  drain() {
    if (this.draining || !this.queue.length) return;
    this.draining = true;
    this.loop()
      .catch((e) => log.warn(`推送队列异常：${e.message}`))
      .finally(() => {
        this.draining = false;
        if (this.queue.length) this.drain();
      });
  }

  async loop() {
    while (this.queue.length) {
      const job = this.queue.shift();
      const gap = Math.max(0, Number(this.tg.minIntervalMs) || 1100);
      const wait = this.stats.lastSentAt + gap - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      try {
        await this.call(job.method, job.payload);
        this.stats.sent++;
        this.stats.lastSentAt = Date.now();
        this.stats.lastError = '';
      } catch (e) {
        this.stats.failed++;
        this.stats.lastError = e.message;
        log.warn(`TG 推送失败：${e.message}`);
      }
    }
  }

  async call(method, payload) {
    if (!this.tg.botToken) throw new Error('未配置 botToken');
    const base = String(this.tg.apiBase || 'https://api.telegram.org').replace(/\/+$/, '');
    const url = `${base}/bot${this.tg.botToken}/${method}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload === undefined ? '{}' : JSON.stringify(payload),
      signal: AbortSignal.timeout(Math.max(3000, Number(this.tg.timeoutMs) || 15000)),
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) {
      const err = new Error(data.description || `Telegram HTTP ${res.status}`);
      err.code = data.error_code;
      err.retryAfter = data.parameters?.retry_after;
      throw err;
    }
    return data.result;
  }
}
