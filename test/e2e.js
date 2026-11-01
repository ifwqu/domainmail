// 端到端测试
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../src/main.js';
import { smtpClient, imapClient } from './client.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dmtest-'));
const CONFIG = path.join(TMP, 'config.json');

const cfg = {
  hostname: 'mail.test.local',
  dataDir: path.join(TMP, 'data'),
  log: { level: 'error', file: null },
  http: { port: 18080, admin: { email: 'admin@test.local', password: 'admin12345' }, allowSelfRegister: true, sessionSecret: 'test-secret' },
  smtp: { port: 12525, host: '127.0.0.1' },
  submission: { port: 12587, host: '127.0.0.1', requireTls: false },
  imap: { port: 12143, host: '127.0.0.1' },
  outbound: { enabled: false },
  tls: { certFile: path.join(TMP, 'data/tls/cert.pem'), keyFile: path.join(TMP, 'data/tls/key.pem') },
};
fs.writeFileSync(CONFIG, JSON.stringify(cfg));

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  [OK] ${name}`); }
  else { fail++; failures.push(name); console.log(`  [FAIL] ${name}  ${extra}`); }
}

async function http(method, p, body, cookie) {
  const res = await fetch(`http://127.0.0.1:${cfg.http.port}${p}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.getSetCookie?.() || [];
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, cookie: setCookie[0]?.split(';')[0] };
}

console.log('\n=== start ===');
const app = await createApp(CONFIG);
await app.start();
await new Promise((r) => setTimeout(r, 200));

console.log('\n=== 1. init / domain / dkim ===');
const domains = app.account.listDomains();
ok('domain test.local created', domains.some((d) => d.name === 'test.local'), JSON.stringify(domains));
const dkimRec = app.dkim.dnsRecordFor('test.local');
ok('dkim dns record', !!dkimRec && dkimRec.value.startsWith('v=DKIM1'), JSON.stringify(dkimRec));
ok('dkim pubkey length', (dkimRec?.value.length || 0) > 300, String(dkimRec?.value.length));
ok('tls selfsigned generated', fs.existsSync(cfg.tls.certFile) && fs.existsSync(cfg.tls.keyFile));

console.log('\n=== 2. accounts ===');
const u1 = app.account.createUser({ email: 'alice@test.local', password: 'alice123', displayName: 'Alice' });
const u2 = app.account.createUser({ email: 'bob@test.local', password: 'bob123', displayName: 'Bob' });
ok('alice created', u1.id > 0);
ok('bob created', u2.id > 0);
try { app.account.createUser({ email: 'alice@test.local', password: 'x123456' }); ok('dup rejected', false); }
catch { ok('dup rejected', true); }
try { app.account.createUser({ email: 'x@nodomain.test', password: 'x123456' }); ok('unknown domain rejected', false); }
catch { ok('unknown domain rejected', true); }
try { app.account.createUser({ email: 'bad@@test.local', password: 'x123456' }); ok('invalid addr rejected', false); }
catch { ok('invalid addr rejected', true); }

console.log('\n=== 3. smtp inbound ===');
const c1 = await smtpClient({ port: cfg.smtp.port });
const greet = await c1.readResponse();
ok('greeting 220', greet[0].startsWith('220'), JSON.stringify(greet));
const ehlo = await c1.cmd('EHLO testclient.local');
ok('EHLO 250', ehlo[ehlo.length - 1].startsWith('250'), JSON.stringify(ehlo));
ok('EHLO SIZE', ehlo.some((l) => l.includes('SIZE')), JSON.stringify(ehlo));
ok('EHLO 8BITMIME', ehlo.some((l) => l.includes('8BITMIME')), JSON.stringify(ehlo));
ok('EHLO STARTTLS', ehlo.some((l) => l.includes('STARTTLS')), JSON.stringify(ehlo));

ok('MAIL FROM 250', (await c1.cmd('MAIL FROM:<sender@external.test>'))[0].startsWith('250'));
ok('unknown rcpt 550', (await c1.cmd('RCPT TO:<nobody@test.local>'))[0].startsWith('550'));
ok('foreign domain 550', (await c1.cmd('RCPT TO:<x@other.test>'))[0].startsWith('550'));
ok('RCPT 250', (await c1.cmd('RCPT TO:<alice@test.local>'))[0].startsWith('250'));
ok('DATA 354', (await c1.cmd('DATA'))[0].startsWith('354'));

const senderName = Buffer.from('外部发件人', 'utf8').toString('base64');
const subjectB64 = Buffer.from('测试邮件主题', 'utf8').toString('base64');
const body = [
  `From: =?UTF-8?B?${senderName}?= <sender@external.test>`,
  'To: alice@test.local',
  `Subject: =?UTF-8?B?${subjectB64}?=`,
  'Date: Mon, 01 Nov 2026 10:00:00 +0800',
  'Message-ID: <test-msg-1@external.test>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="BOUND1"',
  '',
  '--BOUND1',
  'Content-Type: multipart/alternative; boundary="BOUND2"',
  '',
  '--BOUND2',
  'Content-Type: text/plain; charset=UTF-8',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  'Hello Alice, =E8=BF=99=E6=98=AF=E6=AD=A3=E6=96=87=E3=80=82',
  '--BOUND2',
  'Content-Type: text/html; charset=UTF-8',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  '<p>Hello <b>Alice</b></p>',
  '--BOUND2--',
  '--BOUND1',
  'Content-Type: text/plain; name="note.txt"',
  'Content-Disposition: attachment; filename="note.txt"',
  'Content-Transfer-Encoding: base64',
  '',
  'SGVsbG8gYXR0YWNobWVudCE=',
  '--BOUND1--',
  '',
].join('\r\n');

c1.write(body + '\r\n.\r\n');
const afterData = await c1.readResponse();
ok('DATA done 250', afterData[0].startsWith('250'), JSON.stringify(afterData));
await c1.cmd('QUIT');
c1.close();
await new Promise((r) => setTimeout(r, 300));

console.log('\n=== 4. storage / mime ===');
const inbox = app.store.listMessages(u1.id, 'INBOX');
ok('inbox 1 msg', inbox.length === 1, `got ${inbox.length}`);
const msgRow = inbox[0];
ok('subject rfc2047', msgRow?.subject === '测试邮件主题', msgRow?.subject);
ok('from addr', msgRow?.from_addr === 'sender@external.test', msgRow?.from_addr);
ok('from name decoded', msgRow?.from_name === '外部发件人', msgRow?.from_name);
ok('attachment flag', msgRow?.has_attachment === 1);
const full = app.store.getMessage(u1.id, msgRow.id);
ok('qp+utf8 text', full.body_text.includes('这是正文'), full.body_text.slice(0, 100));
ok('html body', full.body_html.includes('<b>Alice</b>'), full.body_html.slice(0, 80));
const atts = app.store.attachmentsOf(msgRow.id);
ok('1 attachment', atts.length === 1, `got ${atts.length}`);
ok('attachment name', atts[0]?.filename === 'note.txt', atts[0]?.filename);
ok('attachment content', fs.readFileSync(app.store.rawFullPath(atts[0].path), 'utf8') === 'Hello attachment!');
ok('raw readable', app.store.readRaw(full).toString().includes('BOUND1'));

console.log('\n=== 5. imap ===');
const im = await imapClient({ port: cfg.imap.port });
const imGreet = await im.greeting();
ok('imap greeting', imGreet.startsWith('* OK'), imGreet);
ok('CAPABILITY', (await im.cmd('a1', 'a1 CAPABILITY')).some((l) => String(l).includes('IMAP4rev1')));
ok('bad password NO', (await im.cmd('a2', 'a2 LOGIN alice@test.local wrong')).some((l) => String(l).includes('NO')));
ok('login OK', (await im.cmd('a3', 'a3 LOGIN alice@test.local alice123')).some((l) => /^a3 OK/.test(String(l))));
const list = await im.cmd('a4', 'a4 LIST "" "*"');
ok('LIST INBOX', list.some((l) => String(l).includes('INBOX')));
ok('LIST Sent', list.some((l) => String(l).includes('Sent')));
const sel = await im.cmd('a5', 'a5 SELECT INBOX');
ok('SELECT 1 EXISTS', sel.some((l) => String(l).includes('1 EXISTS')), JSON.stringify(sel));
ok('SELECT UIDNEXT', sel.some((l) => String(l).includes('UIDNEXT')));
const fenv = await im.cmd('a6', 'a6 FETCH 1 (UID FLAGS RFC822.SIZE ENVELOPE)');
ok('FETCH UID', fenv.some((l) => String(l).includes('UID 1')), JSON.stringify(fenv).slice(0, 300));
ok('FETCH ENVELOPE', fenv.some((l) => String(l).includes('ENVELOPE')));
const fbody = await im.cmd('a7', 'a7 FETCH 1 (BODY.PEEK[])');
ok('FETCH BODY[] literal', fbody.some((x) => typeof x === 'object' && x.literal && x.literal.includes('BOUND1')), JSON.stringify(fbody).slice(0, 200));
ok('SEARCH ALL hit', (await im.cmd('a8', 'a8 SEARCH ALL')).some((l) => String(l).includes('* SEARCH 1')));
ok('STORE flag', (await im.cmd('a9', 'a9 STORE 1 +FLAGS (\\Flagged)')).some((l) => String(l).includes('OK')));
ok('FLAGS contains Flagged', (await im.cmd('a10', 'a10 FETCH 1 (FLAGS)')).some((l) => String(l).includes('\\Flagged')));
ok('STATUS MESSAGES', (await im.cmd('a11', 'a11 STATUS INBOX (MESSAGES UNSEEN)')).some((l) => String(l).includes('MESSAGES 1')));
await im.cmd('a12', 'a12 LOGOUT');
im.close();

console.log('\n=== 6. web api ===');
const lr = await http('POST', '/api/auth/login', { email: 'alice@test.local', password: 'alice123' });
ok('web login', lr.status === 200 && lr.json?.ok, JSON.stringify(lr.json));
const cookie = lr.cookie;
ok('session cookie', !!cookie);
ok('me endpoint', (await http('GET', '/api/auth/me', null, cookie)).json?.user?.email === 'alice@test.local');
const fr = await http('GET', '/api/folders', null, cookie);
ok('5 folders', fr.json?.folders?.length === 5, JSON.stringify(fr.json));
ok('INBOX count 1', fr.json?.folders?.find((f) => f.name === 'INBOX')?.total === 1);
const mr = await http('GET', '/api/messages?folder=INBOX', null, cookie);
ok('message list 1', mr.json?.messages?.length === 1);
const dr = await http('GET', `/api/messages/${mr.json.messages[0].id}`, null, cookie);
ok('detail subject', dr.json?.subject === '测试邮件主题', dr.json?.subject);
ok('detail attachments', dr.json?.attachments?.length === 1);
const attRes = await fetch(`http://127.0.0.1:${cfg.http.port}/api/attachments/${dr.json.attachments[0].id}`, { headers: { Cookie: cookie } });
ok('attachment download', (await attRes.text()) === 'Hello attachment!');
const rawRes = await fetch(`http://127.0.0.1:${cfg.http.port}/api/messages/${mr.json.messages[0].id}/raw`, { headers: { Cookie: cookie } });
const rawText = await rawRes.text();
ok('raw download', rawText.includes('BOUND1') && rawText.includes('Message-ID'));
ok('unauth 401', (await http('GET', '/api/messages')).status === 401);

console.log('\n=== 7. web send ===');
const sr = await http('POST', '/api/send', {
  to: 'bob@test.local', subject: '来自 Alice 的测试',
  text: '你好 Bob，这是一封测试邮件。',
  html: '<p>你好 <b>Bob</b>，这是一封测试邮件。</p>',
}, cookie);
ok('send ok', sr.json?.ok === true, JSON.stringify(sr.json));
ok('local delivered 1', sr.json?.local === 1, JSON.stringify(sr.json));
await new Promise((r) => setTimeout(r, 200));
const bobInbox = app.store.listMessages(u2.id, 'INBOX');
ok('bob received', bobInbox.length === 1, `got ${bobInbox.length}`);
ok('bob subject', bobInbox[0]?.subject === '来自 Alice 的测试', bobInbox[0]?.subject);
const bobMsg = app.store.getMessage(u2.id, bobInbox[0].id);
ok('bob body', bobMsg.body_text.includes('这是一封测试邮件'), bobMsg.body_text.slice(0, 80));
const aliceSent = app.store.listMessages(u1.id, 'Sent');
ok('sent 1 msg', aliceSent.length === 1);
const sentRaw = app.store.readRaw(app.store.getMessage(u1.id, aliceSent[0].id)).toString();
ok('sent has DKIM', sentRaw.includes('DKIM-Signature:'), sentRaw.slice(0, 150));

console.log('\n=== 8. dkim verify ===');
const { verifyMessage } = await import('../src/dkim.js');
const k = app.dkim.ensure('test.local');
const v = verifyMessage(sentRaw, k.publicKey);
ok('DKIM verify pass', v.ok, JSON.stringify(v));

console.log('\n=== 9. submission 587 ===');
const c2 = await smtpClient({ port: cfg.submission.port });
await c2.readResponse();
const se = await c2.cmd('EHLO testclient.local');
ok('587 AUTH advertised', se.some((l) => l.includes('AUTH')), JSON.stringify(se));
ok('no auth 530', (await c2.cmd('MAIL FROM:<alice@test.local>'))[0].startsWith('530'));
const auth = Buffer.from('\0alice@test.local\0alice123').toString('base64');
ok('AUTH PLAIN 235', (await c2.cmd(`AUTH PLAIN ${auth}`))[0].startsWith('235'));
ok('spoof sender 553', (await c2.cmd('MAIL FROM:<admin@test.local>'))[0].startsWith('553'));
ok('legit sender 250', (await c2.cmd('MAIL FROM:<alice@test.local>'))[0].startsWith('250'));
await c2.cmd('RCPT TO:<bob@test.local>');
await c2.cmd('DATA');
c2.write([
  'From: alice@test.local', 'To: bob@test.local', 'Subject: 通过 587 提交',
  'Message-ID: <sub-1@test.local>', '', '这是通过提交端口发送的邮件。', '',
].join('\r\n') + '\r\n.\r\n');
ok('587 submit 250', (await c2.readResponse())[0].startsWith('250'));
await c2.cmd('QUIT');
c2.close();
await new Promise((r) => setTimeout(r, 300));
ok('bob received 2', app.store.listMessages(u2.id, 'INBOX').length === 2, String(app.store.listMessages(u2.id, 'INBOX').length));

console.log('\n=== 10. alias / forward ===');
app.account.createAlias('sales@test.local', ['alice@test.local', 'bob@test.local']);
const c3 = await smtpClient({ port: cfg.smtp.port });
await c3.readResponse();
await c3.cmd('EHLO t.local');
await c3.cmd('MAIL FROM:<lead@external.test>');
ok('alias rcpt 250', (await c3.cmd('RCPT TO:<sales@test.local>'))[0].startsWith('250'));
await c3.cmd('DATA');
c3.write('From: lead@external.test\r\nTo: sales@test.local\r\nSubject: alias test\r\n\r\nbody\r\n.\r\n');
ok('alias deliver 250', (await c3.readResponse())[0].startsWith('250'));
await c3.cmd('QUIT');
c3.close();
await new Promise((r) => setTimeout(r, 300));
ok('alice got alias (2)', app.store.listMessages(u1.id, 'INBOX').length === 2, String(app.store.listMessages(u1.id, 'INBOX').length));
ok('bob got alias (3)', app.store.listMessages(u2.id, 'INBOX').length === 3, String(app.store.listMessages(u2.id, 'INBOX').length));

console.log('\n=== 11. admin ===');
const al = await http('POST', '/api/auth/login', { email: 'admin@test.local', password: 'admin12345' });
ok('admin login', al.status === 200, JSON.stringify(al.json));
const ac = al.cookie;
ok('stats endpoint', (await http('GET', '/api/admin/stats', null, ac)).json?.users >= 3);
ok('normal user 403', (await http('GET', '/api/admin/stats', null, cookie)).status === 403);
const ad = await http('POST', '/api/admin/domains', { name: 'company.test' }, ac);
ok('add domain', ad.json?.ok === true, JSON.stringify(ad.json));
ok('dns guide returned', ad.json?.dns?.length >= 4);
ok('domain list', (await http('GET', '/api/admin/domains', null, ac)).json?.domains?.some((d) => d.name === 'company.test'));
const nu = await http('POST', '/api/admin/users', { email: 'carol@company.test', password: 'carol123', displayName: 'Carol' }, ac);
ok('admin create user', nu.json?.ok === true, JSON.stringify(nu.json));
const dnsr = await http('GET', `/api/admin/domains/${ad.json.domain.id}/dns`, null, ac);
ok('dns endpoint', dnsr.json?.dkim?.name?.includes('_domainkey'), JSON.stringify(dnsr.json?.dkim));

console.log('\n=== 12. unlimited mailboxes (aliases) ===');
const aliasList0 = await http('GET', '/api/aliases', null, cookie);
ok('aliases endpoint', aliasList0.status === 200, JSON.stringify(aliasList0.json));
ok('unlimited by default', aliasList0.json?.unlimited === true, JSON.stringify(aliasList0.json));
ok('self create allowed', aliasList0.json?.allowSelfCreate === true);
ok('domains listed', aliasList0.json?.domains?.includes('test.local'), JSON.stringify(aliasList0.json?.domains));

// 批量生成 20 个随机地址
const batch = await http('POST', '/api/aliases/batch', { count: 20, domain: 'test.local' }, cookie);
ok('batch create 20', batch.json?.count === 20, JSON.stringify(batch.json)?.slice(0, 200));
ok('batch addresses valid', batch.json?.created?.every((a) => /^[a-z0-9]+@test\.local$/.test(a)), JSON.stringify(batch.json?.created?.slice(0, 3)));

// 带前缀
const batch2 = await http('POST', '/api/aliases/batch', { count: 3, prefix: 'shop', domain: 'test.local' }, cookie);
ok('batch with prefix', batch2.json?.created?.includes('shop-1@test.local'), JSON.stringify(batch2.json?.created));

// 手动创建
const manual = await http('POST', '/api/aliases', { address: 'contact@test.local' }, cookie);
ok('manual alias create', manual.json?.ok === true, JSON.stringify(manual.json));
ok('manual alias targets owner', manual.json?.alias?.targets?.includes('alice@test.local'), JSON.stringify(manual.json?.alias?.targets));

// 重复拒绝
const dup = await http('POST', '/api/aliases', { address: 'contact@test.local' }, cookie);
ok('duplicate alias rejected', dup.status === 400, String(dup.status));

// 无效域名拒绝
const badDom = await http('POST', '/api/aliases', { address: 'x@notexist.test' }, cookie);
ok('unknown domain rejected', badDom.status === 400, String(badDom.status));

// 只填前缀即可创建（无需输入完整地址）
const prefixOnly = await http('POST', '/api/aliases', { prefix: 'hello', domain: 'test.local' }, cookie);
ok('prefix-only create', prefixOnly.json?.alias?.address === 'hello@test.local', JSON.stringify(prefixOnly.json));

// 只给 prefix、不给 domain，自动用默认域名（第一个启用的域名）
const autoDom = await http('POST', '/api/aliases', { prefix: 'auto' }, cookie);
ok('prefix without domain', /^auto@.+/.test(autoDom.json?.alias?.address || ''), JSON.stringify(autoDom.json));

// 非法前缀拒绝
const badPrefix = await http('POST', '/api/aliases', { prefix: 'bad prefix!' }, cookie);
ok('invalid prefix rejected', badPrefix.status === 400, String(badPrefix.status));

// 空前缀拒绝
const emptyPrefix = await http('POST', '/api/aliases', {}, cookie);
ok('empty prefix rejected', emptyPrefix.status === 400, String(emptyPrefix.status));

// 完整地址写法仍然支持
const fullAddr = await http('POST', '/api/aliases', { address: 'legacy@test.local' }, cookie);
ok('full address still works', fullAddr.json?.alias?.address === 'legacy@test.local', JSON.stringify(fullAddr.json));

// 向别名投递
const c4 = await smtpClient({ port: cfg.smtp.port });
await c4.readResponse();
await c4.cmd('EHLO t.local');
await c4.cmd('MAIL FROM:<news@external.test>');
const aliasRcpt2 = await c4.cmd('RCPT TO:<contact@test.local>');
ok('alias accepts mail', aliasRcpt2[0].startsWith('250'), aliasRcpt2[0]);
await c4.cmd('DATA');
c4.write('From: news@external.test\r\nTo: contact@test.local\r\nSubject: unlimited alias test\r\n\r\nbody\r\n.\r\n');
ok('alias delivery ok', (await c4.readResponse())[0].startsWith('250'));
await c4.cmd('QUIT');
c4.close();
await new Promise((r) => setTimeout(r, 300));
const aliceInbox = app.store.listMessages(u1.id, 'INBOX');
ok('alias mail lands in main inbox', aliceInbox.some((m) => m.subject === 'unlimited alias test'), String(aliceInbox.length));

// 列表包含全部
const aliasList1 = await http('GET', '/api/aliases', null, cookie);
ok('aliases total 28', aliasList1.json?.total === 28, String(aliasList1.json?.total));

// 停用 / 删除
const firstAlias = aliasList1.json.aliases[0];
const toggle = await http('PUT', `/api/aliases/${firstAlias.id}`, { active: false }, cookie);
ok('alias disable', toggle.json?.alias?.active === false, JSON.stringify(toggle.json));

const delAlias = await http('DELETE', `/api/aliases/${firstAlias.id}`, null, cookie);
ok('alias delete', delAlias.json?.ok === true);
const aliasList2 = await http('GET', '/api/aliases', null, cookie);
ok('aliases total 27 after delete', aliasList2.json?.total === 27, String(aliasList2.json?.total));

// 用户不能删别人的别名
const bobCookie = (await http('POST', '/api/auth/login', { email: 'bob@test.local', password: 'bob123' })).cookie;
const bobAliases = await http('GET', '/api/aliases', null, bobCookie);
ok('bob sees only shared alias', bobAliases.json?.total === 1, String(bobAliases.json?.total));
const bobDel = await http('DELETE', `/api/aliases/${aliasList2.json.aliases[0].id}`, null, bobCookie);
ok('bob cannot delete alice alias', bobDel.status === 403, String(bobDel.status));

// 批量上限
const tooMany = await http('POST', '/api/aliases/batch', { count: 9999, domain: 'test.local' }, cookie);
ok('batch over limit rejected', tooMany.status === 400, String(tooMany.status));

console.log('\n=== 13. antispam ===');
const { scoreSpam } = await import('../src/policy.js');
const sp = await scoreSpam({
  cfg: app.cfg,
  parsed: { subject: 'CHEAP VIAGRA NOW!!!!!', text: 'casino bonus 代开发票 博彩 刷单', html: '', from: { address: 'x@bad.top' }, to: [{ address: 'alice@test.local' }], cc: [] },
  remoteIp: '1.2.3.4', spfResult: 'fail',
});
ok('spam score above threshold', sp.score >= app.cfg.antispam.spamThreshold, JSON.stringify(sp));

console.log('\n=== 14. restart persistence ===');
const before = app.db.get('SELECT COUNT(*) AS c FROM messages').c;
await app.stop();
const app2 = await createApp(CONFIG);
await app2.start();
await new Promise((r) => setTimeout(r, 200));
ok('restart msg count', before === app2.db.get('SELECT COUNT(*) AS c FROM messages').c, `${before} vs ${app2.db.get('SELECT COUNT(*) AS c FROM messages').c}`);
ok('restart login', (await http('POST', '/api/auth/login', { email: 'alice@test.local', password: 'alice123' })).status === 200);
await app2.stop();

console.log(`\n${'='.repeat(50)}`);
console.log(`RESULT: ${pass} passed, ${fail} failed`);
if (failures.length) console.log(`FAILED: ${failures.join(' | ')}`);
console.log(`${'='.repeat(50)}\n`);

fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail > 0 ? 1 : 0);
