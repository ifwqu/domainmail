// Telegram 推送单元测试：渲染、转义、截断、限流、事件开关、失败统计
import assert from 'node:assert';
import { TelegramNotifier, maskToken } from '../src/telegram.js';

let passed = 0;
let failed = 0;
const t = (name, fn) => {
  try {
    const r = fn();
    if (r instanceof Promise) throw new Error('用 at() 跑异步用例');
    passed++;
    console.log(`  [OK] ${name}`);
  } catch (e) {
    failed++;
    console.log(`  [FAIL] ${name} — ${e.message}`);
  }
};
const at = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log(`  [OK] ${name}`);
  } catch (e) {
    failed++;
    console.log(`  [FAIL] ${name} — ${e.message}`);
  }
};

const baseCfg = () => ({
  telegram: {
    enabled: true,
    botToken: '123456:AAFakeTokenABCD',
    chatId: '123456789',
    events: { inbound: true, outbound: false },
    maxLength: 3500,
    minIntervalMs: 0,
    skipJunk: true,
    timezoneOffsetMinutes: 480,
    apiBase: 'https://api.telegram.org',
    timeoutMs: 5000,
  },
});

const sampleParsed = (over = {}) => ({
  from: { name: '张三', address: 'zhang@example.org' },
  to: [{ name: '', address: 'obs@example.com' }],
  subject: '季度报告 & <重要>',
  date: Date.UTC(2026, 10, 15, 11, 0, 0),
  text: '正文第一行\n\n\n\n正文第二行',
  attachments: [],
  size: 4700,
  ...over,
});

console.log('\n=== 1. token 掩码 ===');
t('掩码保留前后片段', () => {
  assert.strictEqual(maskToken('123456789:AAHsecretTokenTail'), '123456789:****Tail');
});
t('空 token 返回空串', () => {
  assert.strictEqual(maskToken(''), '');
});

console.log('\n=== 2. 渲染 ===');
t('包含发件人、主题、收件人', () => {
  const n = new TelegramNotifier({ cfg: baseCfg() });
  const s = n.render({ parsed: sampleParsed(), rcpts: ['obs@example.com'], folder: 'INBOX' });
  assert.ok(s.includes('张三'), '缺发件人名');
  assert.ok(s.includes('zhang@example.org'), '缺发件地址');
  assert.ok(s.includes('obs@example.com'), '缺收件人');
  assert.ok(s.includes('季度报告'), '缺主题');
});

t('HTML 特殊字符被转义', () => {
  const n = new TelegramNotifier({ cfg: baseCfg() });
  const s = n.render({ parsed: sampleParsed(), rcpts: ['obs@example.com'] });
  assert.ok(s.includes('&lt;重要&gt;'), '尖括号未转义');
  assert.ok(s.includes('&amp;'), '& 未转义');
  assert.ok(!s.includes('<重要>'), '存在未转义标签');
});

t('连续空行被压缩', () => {
  const n = new TelegramNotifier({ cfg: baseCfg() });
  const s = n.render({ parsed: sampleParsed(), rcpts: ['x@y.z'] });
  assert.ok(!s.includes('\n\n\n'), '仍有 3 连换行');
});

t('垃圾箱有标记', () => {
  const n = new TelegramNotifier({ cfg: baseCfg() });
  const s = n.render({ parsed: sampleParsed(), rcpts: ['x@y.z'], folder: 'Junk' });
  assert.ok(s.includes('垃圾箱'));
});

t('超长正文被截断并提示', () => {
  const cfg = baseCfg();
  cfg.telegram.maxLength = 600;
  const n = new TelegramNotifier({ cfg });
  const s = n.render({ parsed: sampleParsed({ text: '啊'.repeat(5000) }), rcpts: ['x@y.z'] });
  assert.ok(s.length <= 4096, `超长: ${s.length}`);
  assert.ok(s.includes('已截断'), '缺截断提示');
});

t('消息不超过 Telegram 4096 上限', () => {
  const cfg = baseCfg();
  cfg.telegram.maxLength = 9000;
  const n = new TelegramNotifier({ cfg });
  const s = n.render({ parsed: sampleParsed({ text: 'x'.repeat(20000) }), rcpts: ['x@y.z'] });
  assert.ok(s.length <= 4096, `长度 ${s.length}`);
});

t('附件清单被列出', () => {
  const n = new TelegramNotifier({ cfg: baseCfg() });
  const s = n.render({
    parsed: sampleParsed({ attachments: [{ filename: '报告.pdf', size: 102400 }, { filename: 'a.zip', size: 2048 }] }),
    rcpts: ['x@y.z'],
  });
  assert.ok(s.includes('报告.pdf'), '缺附件名');
  assert.ok(s.includes('100 KB'), '缺附件大小');
});

t('无正文时给占位', () => {
  const n = new TelegramNotifier({ cfg: baseCfg() });
  const s = n.render({ parsed: sampleParsed({ text: '' }), rcpts: ['x@y.z'] });
  assert.ok(s.includes('(无正文)'));
});

t('时间按 +8 时区显示', () => {
  const n = new TelegramNotifier({ cfg: baseCfg() });
  const s = n.render({ parsed: sampleParsed(), rcpts: ['x@y.z'] });
  assert.ok(s.includes('2026-11-15 19:00'), `时间不对: ${s.split('\n').find((l) => l.includes('时间'))}`);
});

console.log('\n=== 3. 开关与跳过 ===');
t('未启用时 notify 直接跳过', () => {
  const cfg = baseCfg();
  cfg.telegram.enabled = false;
  const n = new TelegramNotifier({ cfg });
  assert.strictEqual(n.enabled, false);
  const r = n.notify({ parsed: sampleParsed(), rcpts: ['x@y.z'] });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'disabled');
});

t('缺 chatId 视为未启用', () => {
  const cfg = baseCfg();
  cfg.telegram.chatId = '';
  assert.strictEqual(new TelegramNotifier({ cfg }).enabled, false);
});

t('垃圾箱被 skipJunk 拦截', () => {
  const n = new TelegramNotifier({ cfg: baseCfg() });
  const r = n.notify({ parsed: sampleParsed(), rcpts: ['x@y.z'], folder: 'Junk' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'junk-skip');
});

t('outbound 事件默认关闭', () => {
  const n = new TelegramNotifier({ cfg: baseCfg() });
  const r = n.notify({ direction: 'outbound', parsed: sampleParsed(), rcpts: ['x@y.z'] });
  assert.strictEqual(r.reason, 'outbound-off');
});

await at('inbound 事件默认开启', async () => {
  const n = new TelegramNotifier({ cfg: baseCfg() });
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 200, json: async () => ({ ok: true, result: {} }) });
  let r;
  try {
    r = n.notify({ direction: 'inbound', parsed: sampleParsed(), rcpts: ['x@y.z'] });
    await new Promise((res) => setTimeout(res, 10));
  } finally {
    globalThis.fetch = orig;
  }
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.queued, true);
  assert.strictEqual(n.stats.sent, 1);
});

console.log('\n=== 4. 请求体与失败处理 ===');
await at('POST 到正确 URL 且带 HTML 参数', async () => {
  const cfg = baseCfg();
  const n = new TelegramNotifier({ cfg });
  let captured = null;
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    captured = { url, body: JSON.parse(opts.body) };
    return { status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
  try {
    await n.sendTest('hello');
  } finally {
    globalThis.fetch = orig;
  }
  assert.ok(captured.url.includes('/bot' + cfg.telegram.botToken + '/sendMessage'), captured.url);
  assert.strictEqual(captured.body.chat_id, '123456789');
  assert.strictEqual(captured.body.parse_mode, 'HTML');
  assert.strictEqual(captured.body.text, 'hello');
});

await at('API 返回 ok:false 时抛错并计入 failed', async () => {
  const n = new TelegramNotifier({ cfg: baseCfg() });
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 400, json: async () => ({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }) });
  try {
    n.queue.push({ method: 'sendMessage', payload: { chat_id: '1', text: 'x' } });
    await n.loop();
  } finally {
    globalThis.fetch = orig;
  }
  assert.strictEqual(n.stats.failed, 1);
  assert.strictEqual(n.stats.sent, 0);
  assert.ok(n.stats.lastError.includes('chat not found'), n.stats.lastError);
});

await at('成功后统计 +1 且清空错误', async () => {
  const n = new TelegramNotifier({ cfg: baseCfg() });
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 200, json: async () => ({ ok: true, result: {} }) });
  try {
    n.stats.lastError = '旧错误';
    n.queue.push({ method: 'sendMessage', payload: { chat_id: '1', text: 'x' } });
    await n.loop();
  } finally {
    globalThis.fetch = orig;
  }
  assert.strictEqual(n.stats.sent, 1);
  assert.strictEqual(n.stats.lastError, '');
});

await at('status() 不泄露完整 token', async () => {
  const n = new TelegramNotifier({ cfg: baseCfg() });
  const s = n.status();
  assert.ok(!s.botToken.includes('AAFakeTokenABCD'), '完整 token 泄露');
  assert.ok(s.botToken.includes('****'));
});

console.log('\n==================================================');
console.log(`RESULT: ${passed} passed, ${failed} failed`);
console.log('==================================================\n');
process.exit(failed ? 1 : 0);
