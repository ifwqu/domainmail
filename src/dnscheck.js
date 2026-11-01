#!/usr/bin/env node
// DNS 自检：检查 MX / SPF / DKIM / DMARC / PTR / 25端口连通性
import dns from 'node:dns/promises';
import net from 'node:net';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { DkimManager } from './dkim-manager.js';
import { resolveTxt, resolveMx, resolvePtr } from './policy.js';

const argv = process.argv.slice(2);
const configIdx = argv.indexOf('--config');
const configPath = configIdx !== -1 ? argv[configIdx + 1] : undefined;
const domainArg = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--config');

const cfg = loadConfig(configPath);
const db = openDb(cfg.dataDir);
const dkim = new DkimManager({ cfg, db });

const C = {
  ok: '\x1b[32m', err: '\x1b[31m', warn: '\x1b[33m', dim: '\x1b[2m', b: '\x1b[1m', r: '\x1b[0m',
};
const pass = (s) => `${C.ok}✓${C.r} ${s}`;
const fail = (s) => `${C.err}✗${C.r} ${s}`;
const warn = (s) => `${C.warn}!${C.r} ${s}`;
const info = (s) => `${C.dim}·${C.r} ${s}`;

let problems = 0;
let warnings = 0;

async function checkPort(host, port, timeout = 6000) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const t = setTimeout(() => { s.destroy(); resolve(false); }, timeout);
    s.once('connect', () => { clearTimeout(t); s.destroy(); resolve(true); });
    s.once('error', () => { clearTimeout(t); resolve(false); });
  });
}

async function getPublicIp() {
  for (const url of ['https://api.ipify.org', 'https://ifconfig.me/ip', 'https://icanhazip.com']) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
      const t = (await r.text()).trim();
      if (/^\d+\.\d+\.\d+\.\d+$/.test(t)) return t;
    } catch {}
  }
  return null;
}

async function checkDomain(domain) {
  console.log(`\n${C.b}━━━ ${domain} ━━━${C.r}`);

  // MX
  const mx = await resolveMx(domain);
  if (!mx || !mx.length) {
    console.log(fail(`MX 记录：未找到。请在 DNS 添加 MX → 10 ${cfg.hostname}`));
    problems++;
  } else {
    const target = mx.map((m) => m.exchange.replace(/\.$/, ''));
    const hasSelf = target.some((t) => t.toLowerCase() === cfg.hostname.toLowerCase());
    console.log(hasSelf
      ? pass(`MX 记录：${mx.map((m) => `${m.priority} ${m.exchange}`).join(', ')}`)
      : warn(`MX 记录：${mx.map((m) => `${m.priority} ${m.exchange}`).join(', ')}（未指向 ${cfg.hostname}）`));
    if (!hasSelf) warnings++;
  }

  // A 记录（邮件主机名）
  try {
    const a = await dns.resolve4(cfg.hostname);
    console.log(pass(`主机名 ${cfg.hostname} → ${a.join(', ')}`));
  } catch {
    console.log(fail(`主机名 ${cfg.hostname} 无 A 记录。请添加 A 记录指向 VPS IP`));
    problems++;
  }

  // SPF
  const txts = await resolveTxt(domain);
  const spf = (txts || []).find((t) => t.trim().toLowerCase().startsWith('v=spf1'));
  if (!spf) {
    console.log(fail(`SPF：未找到。请添加 TXT "${domain}" → v=spf1 mx ~all`));
    problems++;
  } else if (/\?all|\+all/.test(spf)) {
    console.log(warn(`SPF：${spf}（+all/?all 过于宽松，建议改为 ~all 或 -all）`));
    warnings++;
  } else {
    console.log(pass(`SPF：${spf}`));
  }

  // DKIM
  const rec = dkim.dnsRecordFor(domain);
  const sel = rec ? rec.name.split('._domainkey')[0] : cfg.dkim.selector;
  const dkimName = `${sel}._domainkey.${domain}`;
  const dkimTxt = await resolveTxt(dkimName);
  if (!dkimTxt || !dkimTxt.length) {
    console.log(fail(`DKIM：${dkimName} 无记录。请在后台“域名 → DNS 记录”复制并添加`));
    problems++;
  } else {
    const val = dkimTxt.join('');
    if (!/v=DKIM1/.test(val)) {
      console.log(fail(`DKIM：记录格式不正确，应包含 v=DKIM1`));
      problems++;
    } else if (rec && !val.includes(rec.value.replace(/^v=DKIM1;\s*k=rsa;\s*p=/, '').slice(0, 40))) {
      console.log(warn(`DKIM：记录存在但公钥与本地密钥不匹配（可能刚轮换过密钥）`));
      warnings++;
    } else {
      console.log(pass(`DKIM：${dkimName} 已配置`));
    }
  }

  // DMARC
  const dmarcTxt = await resolveTxt(`_dmarc.${domain}`);
  const dmarc = (dmarcTxt || []).find((t) => t.toLowerCase().startsWith('v=dmarc1'));
  if (!dmarc) {
    console.log(warn(`DMARC：未配置。建议添加 TXT "_dmarc.${domain}" → v=DMARC1; p=quarantine; rua=mailto:postmaster@${domain}`));
    warnings++;
  } else {
    console.log(pass(`DMARC：${dmarc}`));
  }
}

async function main() {
  console.log(`${C.b}域名邮箱 DNS 自检${C.r}`);
  console.log(`${C.dim}主机名：${cfg.hostname}${C.r}`);

  const ip = await getPublicIp();
  if (ip) {
    console.log(info(`公网 IP：${ip}`));
    const ptr = await resolvePtr(ip);
    if (!ptr || !ptr.length) {
      console.log(fail(`PTR：${ip} 无反向解析。多数收件方（Gmail/Outlook）会因此拒收或判垃圾，需在 VPS 商家面板设置 rDNS → ${cfg.hostname}`));
      problems++;
    } else if (!ptr.some((p) => p.toLowerCase().replace(/\.$/, '') === cfg.hostname.toLowerCase())) {
      console.log(warn(`PTR：${ip} → ${ptr.join(', ')}（与主机名 ${cfg.hostname} 不一致，建议改为一致）`));
      warnings++;
    } else {
      console.log(pass(`PTR：${ip} → ${ptr.join(', ')}`));
    }

    const port25 = await checkPort(ip, 25);
    console.log(port25
      ? pass(`25 端口：可连通`)
      : warn(`25 端口：从本机访问 ${ip}:25 失败。若 VPS 商家封锁 25 出站，需申请解封或改用中继（config.json → outbound.relay）`));
    if (!port25) warnings++;
  } else {
    console.log(warn('无法获取公网 IP，跳过 PTR / 端口检查'));
    warnings++;
  }

  const domains = domainArg
    ? [{ name: domainArg }]
    : db.all('SELECT name FROM domains WHERE active = 1');

  if (!domains.length) {
    console.log(warn('数据库中没有启用的域名'));
    return;
  }

  for (const d of domains) await checkDomain(d.name);

  console.log(`\n${C.b}结论${C.r}`);
  if (problems === 0 && warnings === 0) {
    console.log(`${C.ok}全部通过，可以正常收发邮件。${C.r}`);
  } else {
    if (problems) console.log(`${C.err}${problems} 项必须修复${C.r}（否则无法收信或会被判垃圾）`);
    if (warnings) console.log(`${C.warn}${warnings} 项建议优化${C.r}`);
  }
  console.log('');
  process.exit(problems > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('自检失败：', e.message);
  process.exit(2);
});
