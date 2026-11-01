// 主入口：装配所有服务
import { loadConfig, ensureDirs, loadOrCreateSecret } from './config.js';
import { initLogger, createLogger } from './logger.js';
import { openDb } from './db.js';
import { MailStore } from './store.js';
import { DkimManager } from './dkim-manager.js';
import { TlsProvider } from './tls-provider.js';
import { SmtpServer } from './smtp.js';
import { ImapServer } from './imap.js';
import { OutboxQueue } from './outbound.js';
import { AccountService } from './account.js';
import { WebServer } from './web/server.js';
import { registerRoutes, setDnsHostname } from './web/routes.js';
import { hashPassword } from './crypto.js';

const log = createLogger('main');

export async function createApp(configPath) {
  const cfg = loadConfig(configPath);
  initLogger({ level: cfg.log.level, file: cfg.log.file });
  ensureDirs(cfg);

  const db = openDb(cfg.dataDir);
  const tlsProvider = new TlsProvider({ cfg });
  tlsProvider.load();
  if (!tlsProvider.get()) {
    const names = cfg.tls.selfSignedNames.length ? cfg.tls.selfSignedNames : [cfg.hostname];
    tlsProvider.selfSign(names);
  }

  const dkim = new DkimManager({ cfg, db });
  const store = new MailStore({ db, cfg, dkim });
  const outbox = new OutboxQueue({ cfg, db, dkim, tlsProvider });
  const account = new AccountService({ cfg, db, store, dkim, outbox });

  setDnsHostname(cfg.hostname);

  // 初始化管理员
  const userCount = db.get('SELECT COUNT(*) AS c FROM users');
  if (Number(userCount?.c || 0) === 0 && cfg.http.admin?.email) {
    const email = cfg.http.admin.email;
    const pass = cfg.http.admin.password || 'admin12345';
    const domain = email.split('@')[1];
    if (!db.get('SELECT id FROM domains WHERE name = ?', domain)) {
      account.addDomain(domain);
    }
    account.createUser({ email, password: pass, displayName: '管理员', isAdmin: 1, domainCheck: false });
    log.info(`已创建管理员 ${email}（密码 ${cfg.http.admin.password ? '来自配置' : 'admin12345'}）`);
  }

  const web = new WebServer({
    cfg: { ...cfg, __sessionSecret: loadOrCreateSecret(cfg) },
    db, store, dkim, outbox, services: {},
  });
  registerRoutes(web, { cfg, db, store, dkim, account, outbox, tlsProvider });

  const smtpIn = new SmtpServer({ cfg, db, store, dkim, tlsProvider, mode: 'inbound' });
  const smtpSub = new SmtpServer({ cfg, db, store, dkim, tlsProvider, mode: 'submission' });
  const imap = new ImapServer({ cfg, db, store, tlsProvider });

  const app = { cfg, db, store, dkim, outbox, account, web, smtpIn, smtpSub, imap, tlsProvider };

  app.start = async () => {
    if (cfg.http.enabled) await web.listen();
    if (cfg.smtp.enabled) await smtpIn.listen();
    if (cfg.submission.enabled) await smtpSub.listen();
    if (cfg.imap.enabled) await imap.listen();
    outbox.start();
  };

  app.stop = async () => {
    await outbox.stop();
    await Promise.all([web.close(), smtpIn.close(), smtpSub.close(), imap.close()]);
    db.close();
  };

  return app;
}

if (process.argv[1] && process.argv[1].endsWith('main.js')) {
  const app = await createApp(process.argv[2]);
  await app.start();
  const shutdown = async (sig) => {
    log.info(`收到 ${sig}，正在关闭`);
    await app.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (e) => log.error('未处理的 Promise 拒绝', e));
}
