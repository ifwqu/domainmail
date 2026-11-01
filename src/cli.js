#!/usr/bin/env node
// CLI：初始化、建域、建号、DNS 导出、发信测试
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, ensureDirs } from './config.js';
import { openDb } from './db.js';
import { MailStore } from './store.js';
import { DkimManager } from './dkim-manager.js';
import { AccountService } from './account.js';
import { TlsProvider } from './tls-provider.js';
import { OutboxQueue } from './outbound.js';
import { projectRoot } from './config.js';

function ctx(configPath) {
  const cfg = loadConfig(configPath);
  ensureDirs(cfg);
  const db = openDb(cfg.dataDir);
  const tlsProvider = new TlsProvider({ cfg });
  const dkim = new DkimManager({ cfg, db });
  const store = new MailStore({ db, cfg, dkim });
  const outbox = new OutboxQueue({ cfg, db, dkim, tlsProvider });
  const account = new AccountService({ cfg, db, store, dkim, outbox });
  return { cfg, db, store, dkim, account, outbox };
}

function usage() {
  console.log(`DomainMail CLI

  node src/cli.js init [--config config.json]
  node src/cli.js domain add <domain> [--catch-all addr]
  node src/cli.js domain list
  node src/cli.js domain dns <domain>
  node src/cli.js user add <email> <password> [--admin] [--name 显示名]
  node src/cli.js user list
  node src/cli.js user passwd <email> <password>
  node src/cli.js alias add <address> <target,target2>
  node src/cli.js dkim rotate <domain>
  node src/cli.js check`);
}

const argv = process.argv.slice(2);
const cmd = argv[0];
const configIdx = argv.indexOf('--config');
const configPath = configIdx !== -1 ? argv[configIdx + 1] : undefined;
const args = argv.filter((a, i) => !a.startsWith('--') && !(configIdx !== -1 && i === configIdx + 1));

function flag(name) {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const c = ctx(configPath);

if (cmd === 'init') {
  const adminEmail = flag('--admin') || 'admin@example.com';
  const adminPass = flag('--password') || 'admin12345';
  const domain = adminEmail.split('@')[1];
  if (!c.db.get('SELECT id FROM domains WHERE name = ?', domain)) {
    c.account.addDomain(domain);
    console.log(`✓ 已添加域名 ${domain}`);
  }
  if (!c.db.get('SELECT id FROM users WHERE email = ?', adminEmail)) {
    c.account.createUser({ email: adminEmail, password: adminPass, displayName: '管理员', isAdmin: 1, domainCheck: false });
    console.log(`✓ 已创建管理员 ${adminEmail} / ${adminPass}`);
  }
  const dkim = c.dkim.ensure(domain);
  const rec = c.dkim.dnsRecordFor(domain);
  console.log('\n请到 DNS 服务商添加以下记录：');
  console.log(`  MX    ${domain}                 -> 10 ${c.cfg.hostname}`);
  console.log(`  A     ${c.cfg.hostname.split('.').slice(1).join('.')}    -> 你的 VPS IP`);
  console.log(`  TXT   ${domain}                 -> v=spf1 mx ~all`);
  console.log(`  TXT   _dmarc.${domain}          -> v=DMARC1; p=quarantine; rua=mailto:postmaster@${domain}`);
  console.log(`  TXT   ${rec.name}  -> ${rec.value}`);
  console.log('\n完成后再运行 node src/main.js 启动服务。');
  process.exit(0);
}

if (cmd === 'domain') {
  const sub = args[1];
  if (sub === 'add') {
    const d = c.account.addDomain(args[2], { catchAll: flag('--catch-all') || '' });
    console.log(`✓ 已添加域名 ${d.name}`);
    const rec = c.dkim.dnsRecordFor(d.name);
    console.log(`DKIM 记录：${rec.name} TXT "${rec.value}"`);
  } else if (sub === 'list') {
    for (const d of c.account.listDomains()) {
      console.log(`${d.active ? '●' : '○'} ${d.name}\tcatch-all=${d.catch_all || '-'}\tdkim=${d.dkim_enabled ? 'on' : 'off'}`);
    }
  } else if (sub === 'dns') {
    const d = args[2];
    const rec = c.dkim.dnsRecordFor(d);
    console.log(`MX      ${d}  -> 10 ${c.cfg.hostname}`);
    console.log(`TXT     ${d}  -> v=spf1 mx ~all`);
    console.log(`TXT     _dmarc.${d}  -> v=DMARC1; p=quarantine; rua=mailto:postmaster@${d}`);
    if (rec) console.log(`TXT     ${rec.name}  -> ${rec.value}`);
  }
  process.exit(0);
}

if (cmd === 'user') {
  const sub = args[1];
  if (sub === 'add') {
    const u = c.account.createUser({
      email: args[2], password: args[3],
      displayName: flag('--name') || '', isAdmin: !!flag('--admin'),
    });
    console.log(`✓ 已创建账号 ${u.email}`);
  } else if (sub === 'list') {
    for (const u of c.account.listUsers()) {
      console.log(`${u.active ? '●' : '○'} ${u.email}\t${u.is_admin ? 'ADMIN' : 'user'}\t${u.display_name || ''}`);
    }
  } else if (sub === 'passwd') {
    const u = c.db.get('SELECT * FROM users WHERE email = ?', String(args[2]).toLowerCase());
    if (!u) { console.error('用户不存在'); process.exit(1); }
    c.account.setPassword(u.id, args[3]);
    console.log(`✓ 已重置 ${u.email} 的密码`);
  }
  process.exit(0);
}

if (cmd === 'alias') {
  if (args[1] === 'add') {
    const a = c.account.createAlias(args[2], args[3]);
    console.log(`✓ 别名 ${a.address} -> ${a.targets}`);
  }
  process.exit(0);
}

if (cmd === 'dkim') {
  if (args[1] === 'rotate') {
    c.dkim.rotate(args[2]);
    const rec = c.dkim.dnsRecordFor(args[2]);
    console.log(`✓ 已轮换密钥，请更新 DNS：\n  ${rec.name} TXT "${rec.value}"`);
  }
  process.exit(0);
}

if (cmd === 'check') {
  const { checkSpf, resolveMx } = await import('./policy.js');
  const domains = c.account.listDomains();
  for (const d of domains) {
    const mx = await resolveMx(d.name);
    const spf = await checkSpf({ ip: '1.1.1.1', domain: d.name, mailFrom: `test@${d.name}` });
    console.log(`${d.name}: MX=${mx ? mx.map((m) => `${m.priority} ${m.exchange}`).join(',') : '未配置'} SPF=${spf.result}`);
  }
  process.exit(0);
}

usage();
