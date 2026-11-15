// 转发功能专项测试：本地临时实例，不对外发信（outbound 关闭，只看队列）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../src/main.js';
import { smtpClient } from './client.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dmfwd-'));
const CONFIG = path.join(TMP, 'config.json');
const cfg = {
  hostname: 'mail.test.local',
  dataDir: path.join(TMP, 'data'),
  log: { level: 'error', file: null },
  http: { port: 18090, host: '127.0.0.1', admin: { email: 'obs@test.local', password: 'TestPass123' }, allowSelfRegister: false, sessionSecret: 'fwd-secret' },
  smtp: { port: 12526, host: '127.0.0.1', checkPtr: 'none', checkSpf: 'none' },
  submission: { port: 12588, host: '127.0.0.1', requireTls: false },
  imap: { port: 12144, host: '127.0.0.1', tlsPort: 0 },
  outbound: { enabled: false },
  antispam: { enabled: false },
  dkim: { autoGenerate: false },
  tls: { certFile: path.join(TMP, 'data/tls/cert.pem'), keyFile: path.join(TMP, 'data/tls/key.pem') },
};
fs.writeFileSync(CONFIG, JSON.stringify(cfg));

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  [OK]   ${name}`); }
  else { fail++; fails.push(name); console.log(`  [FAIL] ${name}  ${extra}`); }
}

async function http(method, p, body, cookie) {
  const res = await fetch(`http://127.0.0.1:${cfg.http.port}${p}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.getSetCookie?.() || [];
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, cookie: setCookie[0]?.split(';')[0] };
}

async function sendMail(to, subject, from = 'sender@external.test') {
  const c = await smtpClient({ port: cfg.smtp.port });
  await c.readResponse();
  await c.cmd('EHLO testclient.local');
  const r1 = await c.cmd(`MAIL FROM:<${from}>`);
  const r2 = await c.cmd(`RCPT TO:<${to}>`);
  await c.cmd('DATA');
  c.write(`From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\nMessage-ID: <${Date.now()}-${Math.random().toString(36).slice(2)}@external.test>\r\nDate: ${new Date().toUTCString()}\r\n\r\n转发测试正文 ${subject}\r\n.\r\n`);
  const r3 = await c.readResponse();
  await c.cmd('QUIT');
  c.close();
  await new Promise((r) => setTimeout(r, 350));
  return { mail: r1[0], rcpt: r2[0], data: r3[0] };
}

console.log('\n=== 启动 ===');
const app = await createApp(CONFIG);
await app.start();
await new Promise((r) => setTimeout(r, 200));
const obsId = app.account.getUser(1).id;

const login = await http('POST', '/api/auth/login', { email: 'obs@test.local', password: 'TestPass123' });
ok('管理员登录', login.status === 200 && login.json?.ok === true, JSON.stringify(login.json));
const ck = login.cookie;
const bob = await http('POST', '/api/admin/users', { email: 'bob@test.local', password: 'BobPass123' }, ck);
ok('创建 bob 账号', bob.status === 200 && bob.json?.ok === true, JSON.stringify(bob.json));
const bobId = bob.json?.user?.id;

const outboxRows = () => app.db.all('SELECT * FROM outbox ORDER BY id');
const inbox = (uid) => app.store.listMessages(uid, 'INBOX');

console.log('\n=== 1. 读取/设置转发（用户自助接口）===');
const s0 = await http('GET', '/api/settings', null, ck);
ok('初始无转发', s0.json?.forward === null, JSON.stringify(s0.json?.forward));
const setF = await http('POST', '/api/settings/forward', { target: 'ext@target.test', keepCopy: true }, ck);
ok('设置转发成功', setF.status === 200 && setF.json?.forward?.target === 'ext@target.test', JSON.stringify(setF.json));
ok('转发 keep_copy=1', Number(setF.json?.forward?.keep_copy) === 1, JSON.stringify(setF.json?.forward));
ok('转发 active=1', Number(setF.json?.forward?.active) === 1);
const s1 = await http('GET', '/api/settings', null, ck);
ok('回读转发规则', s1.json?.forward?.target === 'ext@target.test', JSON.stringify(s1.json?.forward));

console.log('\n=== 2. 收到邮件 → 入本地 + 进转发队列（keepCopy=1）===');
const before = inbox(obsId).length;
const m1 = await sendMail('obs@test.local', '转发测试-保留副本');
ok('SMTP 250 接收', /^250/.test(m1.data), JSON.stringify(m1));
const after1 = inbox(obsId).length;
ok('本地副本保留 +1', after1 === before + 1, `${before} -> ${after1}`);
const q1 = outboxRows();
ok('转发进入出站队列', q1.length === 1, `rows=${q1.length}`);
ok('队列信封发件人=原地址', q1[0]?.mail_from === 'obs@test.local', q1[0]?.mail_from);
ok('队列收件人=转发目标', q1[0]?.rcpt_to === 'ext@target.test', q1[0]?.rcpt_to);
ok('队列状态 queued', q1[0]?.status === 'queued', q1[0]?.status);
const raw1 = fs.readFileSync(app.store.rawFullPath(q1[0].raw_path), 'utf8');
ok('转发的原始内容含主题', raw1.includes('转发测试-保留副本'), raw1.slice(0, 80));
ok('转发内容含正文', raw1.includes('转发测试正文'));

console.log('\n=== 3. keepCopy=false → 本地不留副本 ===');
const setF2 = await http('POST', '/api/settings/forward', { target: 'ext@target.test', keepCopy: false }, ck);
ok('改为不保留副本', Number(setF2.json?.forward?.keep_copy) === 0, JSON.stringify(setF2.json?.forward));
const before2 = inbox(obsId).length;
const m2 = await sendMail('obs@test.local', '转发测试-不留副本');
ok('SMTP 250 接收', /^250/.test(m2.data), JSON.stringify(m2));
const after2 = inbox(obsId).length;
ok('本地副本被删除（数量不变）', after2 === before2, `${before2} -> ${after2}`);
const q2 = outboxRows();
ok('第二条转发进入队列', q2.length === 2, `rows=${q2.length}`);
ok('第二条收件人正确', q2[1]?.rcpt_to === 'ext@target.test', q2[1]?.rcpt_to);
const raw2 = fs.readFileSync(app.store.rawFullPath(q2[1].raw_path), 'utf8');
ok('第二条转发内容正确', raw2.includes('转发测试-不留副本'));

console.log('\n=== 4. 关闭转发 → 不再进队列 ===');
const delF = await http('POST', '/api/settings/forward', { target: '' }, ck);
ok('清除转发规则', delF.status === 200 && delF.json?.forward === null, JSON.stringify(delF.json));
const before3 = inbox(obsId).length;
const m3 = await sendMail('obs@test.local', '转发测试-已关闭');
const after3 = inbox(obsId).length;
ok('关闭后本地正常收信 +1', after3 === before3 + 1, `${before3} -> ${after3}`);
ok('关闭后不进队列', outboxRows().length === 2, `rows=${outboxRows().length}`);

console.log('\n=== 5. 别名地址转发（管理接口）===');
const al = await http('POST', '/api/aliases', { address: 'sub@test.local', targets: ['bob@test.local'] }, ck);
ok('创建别名 sub@', al.status === 200 && al.json?.ok === true, JSON.stringify(al.json));
const af = await http('POST', '/api/admin/forwards', { address: 'sub@test.local', target: 'ext2@target.test', keepCopy: true }, ck);
ok('给别名设置转发', af.status === 200 && af.json?.forward?.target === 'ext2@target.test', JSON.stringify(af.json));
const fList = await http('GET', '/api/admin/forwards', null, ck);
ok('转发列表含别名规则', fList.json?.forwards?.some((f) => f.address === 'sub@test.local'), JSON.stringify(fList.json?.forwards));
const bobBefore = inbox(bobId).length;
const m4 = await sendMail('sub@test.local', '转发测试-别名');
ok('别名收信 250', /^250/.test(m4.data), JSON.stringify(m4));
ok('别名投递到 bob', inbox(bobId).length === bobBefore + 1, `${bobBefore} -> ${inbox(bobId).length}`);
const q4 = outboxRows();
ok('别名转发进队列', q4.length === 3, `rows=${q4.length}`);
ok('别名转发收件人正确', q4[2]?.rcpt_to === 'ext2@target.test', q4[2]?.rcpt_to);
ok('别名转发信封发件人=别名', q4[2]?.mail_from === 'sub@test.local', q4[2]?.mail_from);
const delA = await http('DELETE', '/api/admin/forwards/sub@test.local', null, ck);
ok('删除别名转发规则', delA.status === 200 && delA.json?.ok === true, JSON.stringify(delA.json));

console.log('\n=== 6. 参数校验 ===');
const bad1 = await http('POST', '/api/settings/forward', { target: 'not-an-email' }, ck);
ok('非法目标地址被拒', bad1.status >= 400, `status=${bad1.status} body=${bad1.text}`);
const bad2 = await http('POST', '/api/admin/forwards', { address: 'no-at-sign', target: 'x@y.test' }, ck);
ok('非法源地址被拒', bad2.status >= 400, `status=${bad2.status} body=${bad2.text}`);
const dup = await http('POST', '/api/settings/forward', { target: 'a@b.test', keepCopy: true }, ck);
const dup2 = await http('POST', '/api/settings/forward', { target: 'c@d.test', keepCopy: true }, ck);
const fRows = app.db.all("SELECT * FROM forwards WHERE address = 'obs@test.local'");
ok('同地址重复设置=覆盖不新增', fRows.length === 1 && fRows[0].target === 'c@d.test', JSON.stringify(fRows));

console.log('\n=== 7. 收信后队列可被管理端看到 ===');
const ob = await http('GET', '/api/admin/outbox', null, ck);
ok('队列接口返回记录', Array.isArray(ob.json?.queue) && ob.json.queue.length >= 3, `len=${ob.json?.queue?.length}`);
ok('队列统计含 queued', Number(ob.json?.stats?.queued) >= 3, JSON.stringify(ob.json?.stats));

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
if (fail) console.log('FAILED: ' + fails.join(' | '));
await app.stop();
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
