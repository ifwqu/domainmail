# 域名邮箱系统（VPS 自建版）

一个不依赖任何第三方邮件服务、可以完整跑在自己 VPS 上的**域名邮箱**系统。
参考 [maillab/cloud-mail](https://github.com/maillab/cloud-mail) 的功能形态（多域名、多账号、Webmail、附件、转发、管理后台、API），但**不依赖 Cloudflare**：收信走本机 25 端口 SMTP，发信直连对方 MX，数据落在本地 SQLite + 文件系统。

零 npm 依赖 —— 只需要 Node.js 22+，用内置的 `node:sqlite` 和 `node:crypto`。

---

## 功能

| 模块 | 能力 |
|---|---|
| **收信** | 25 端口 SMTP 服务端，多域名、多收件人、8BITMIME、PIPELINING、STARTTLS、SPF 校验、PTR 校验、反垃圾评分 |
| **发信** | 587 提交（AUTH PLAIN/LOGIN + STARTTLS）、DKIM rsa-sha256 自动签名、MX 直连投递、失败指数退避重试、可选 SMTP/Resend 中继 |
| **IMAP** | IMAP4rev1 子集：CAPABILITY / LOGIN / AUTHENTICATE / LIST / SELECT / STATUS / FETCH / UID / STORE / SEARCH / COPY / MOVE / APPEND / EXPUNGE / IDLE / STARTTLS，143 与 993 双端口 |
| **Webmail** | 收发信、HTML 沙箱渲染、附件上传下载、文件夹、搜索、星标、移动、删除、下载原文 |
| **账号** | 多域名、别名（一对多）、catch-all、转发（保留副本开关）、自动回复（8 小时去重）、配额统计、API Key |
| **管理后台** | 域名管理 + DNS 记录一键复制、账号管理、别名管理、投递队列监控与重试、审计日志 |
| **运维** | DKIM 密钥生成/轮换、自签证书自动生成、DNS 自检脚本、systemd、Docker |

---

## 界面预览

Gmail 风格 Webmail：胶囊搜索框、单行邮件列表、彩色头像、暗色模式。
侧边栏支持**邮箱切换**（主邮箱/别名一键切换，收发与列表跟随当前身份），
以及**无限邮箱**：输入前缀回车即创建别名地址，全部投递到主邮箱。

## 快速部署（Ubuntu / Debian）

```bash
# 1. 上传项目到 VPS
scp -r mailserver root@your-vps:/opt/domainmail
ssh root@your-vps
cd /opt/domainmail

# 2. 一键部署（自动装 Node、配防火墙、建 systemd 服务、生成配置和 DKIM）
bash deploy.sh example.com mail.example.com
```

脚本结束会打印**管理员账号密码**和**需要添加的 DNS 记录**。

### 手动部署

```bash
cd /opt/domainmail
mkdir -p data/{logs,tls,dkim,spool,messages,attachments,tmp}
cp config.example.json config.json   # 然后编辑
node src/cli.js init --admin admin@example.com --password 你的密码
node src/main.js
```

---

## DNS 配置（关键，不配就收不到信）

在域名服务商处添加：

| 类型 | 主机记录 | 值 | 说明 |
|---|---|---|---|
| A | `mail` | `你的VPS_IP` | 邮件服务器主机名 |
| MX | `@` | `10 mail.example.com` | 收信指向本机 |
| TXT | `@` | `v=spf1 mx ~all` | 授权本机发信 |
| TXT | `_dmarc` | `v=DMARC1; p=quarantine; rua=mailto:postmaster@example.com` | DMARC 策略 |
| TXT | `mail._domainkey` | `v=DKIM1; k=rsa; p=MIIBIjAN...` | DKIM 公钥（后台复制） |

**PTR（反向解析）必须设置**，否则 Gmail / Outlook 会直接拒收或判垃圾：
在 VPS 商家控制面板把 `你的VPS_IP` 的 rDNS 设为 `mail.example.com`。

### 自检

```bash
node src/dnscheck.js
```

会逐项检查 MX / A / SPF / DKIM / DMARC / PTR / 25 端口连通性，并给出修复建议。

---

## 端口

| 端口 | 用途 | 是否必须公网可达 |
|---|---|---|
| 25 | SMTP 收信 | **必须** |
| 587 | SMTP 提交（客户端发信） | 必须 |
| 143 | IMAP（STARTTLS） | 必须 |
| 993 | IMAPS（隐式 TLS） | 可选 |
| 8080 | Webmail / 管理后台 | 建议（建议前面挂 Nginx + HTTPS） |

---

## 客户端配置（Foxmail / Outlook / 手机）

```
收信 IMAP：mail.example.com   端口 143   加密 STARTTLS
发信 SMTP：mail.example.com   端口 587   加密 STARTTLS   需要认证
账号：you@example.com
密码：邮箱登录密码
```

---

## 25 端口被封怎么办

多数云厂商（阿里云、腾讯云、AWS、Oracle）默认封 25 端口出站。三种方案：

1. **申请解封** —— 提交工单说明用途，多数商家可解。
2. **走中继** —— 编辑 `config.json`：
   ```json
   "outbound": {
     "relay": {
       "enabled": true,
       "type": "smtp",
       "host": "smtp.yourprovider.com",
       "port": 587,
       "secure": false,
       "user": "your-user",
       "pass": "your-pass"
     }
   }
   ```
   也可用 `"type": "resend"` + `"apiKey"` 走 Resend HTTP API。
3. **换 VPS** —— 选明确允许 25 端口的商家（如 Hetzner、Vultr 部分机房、Contabo）。

注意：中继只影响**出站发信**，25 端口**入站收信**仍需商家放行。

---

## HTTPS（推荐）

```bash
apt install -y certbot
certbot certonly --standalone -d mail.example.com

# 编辑 config.json
"tls": {
  "certFile": "/etc/letsencrypt/live/mail.example.com/fullchain.pem",
  "keyFile": "/etc/letsencrypt/live/mail.example.com/privkey.pem"
}

systemctl restart domainmail
```

之后 Web 也可用 Nginx 反代 8080 加 HTTPS。注意 SMTP/IMAP 用的是同一份证书。

---

## 常用命令

```bash
systemctl status domainmail        # 状态
systemctl restart domainmail       # 重启
journalctl -u domainmail -f        # 实时日志
tail -f data/logs/mail.log         # 邮件日志

node src/cli.js domain list                    # 域名列表
node src/cli.js user list                      # 账号列表
node src/cli.js user add bob@example.com 密码   # 建账号
node src/cli.js user passwd bob@example.com 新密码
node src/cli.js domain dns example.com         # 打印 DNS 记录
node src/cli.js dkim rotate example.com        # 轮换 DKIM 密钥
node src/dnscheck.js                           # DNS 自检
```

---

## Docker 部署

```bash
cp config.example.json config.json    # 编辑 hostname 等
docker compose up -d
docker compose logs -f
```

---

## 架构

```
                    ┌──────────────────────────────────────┐
   外部 MTA ──25──▶ │ SMTP 入站                             │
                    │  ├ SPF / PTR 校验                     │
                    │  ├ 反垃圾评分 → INBOX / Junk          │
                    │  └ 别名展开 / catch-all / 转发 / 自动回复│
                    └───────────────┬──────────────────────┘
                                    ▼
                    ┌──────────────────────────────────────┐
                    │ MIME 解析（RFC2047/2231/QP/Base64）    │
                    │ SQLite 元数据 + 文件系统 .eml 原文     │
                    └───────────────┬──────────────────────┘
                                    ▼
        ┌──────────────┬────────────┴────────────┬──────────────┐
        ▼              ▼                         ▼              ▼
    Webmail        IMAP 143/993           管理后台        出站队列
   (REST API)    (Foxmail/手机)                          ├ DKIM 签名
                                                          ├ MX 解析
                                                          ├ 直连投递
                                                          └ 失败重试
```

---

## 目录结构

```
mailserver/
├── src/
│   ├── main.js           装配入口
│   ├── config.js         配置加载与默认值
│   ├── db.js             SQLite schema 与访问层
│   ├── store.js          邮件存取、投递入库
│   ├── mime.js           MIME 解析/生成、RFC2047/2231
│   ├── dkim.js           DKIM 签名与验签
│   ├── dkim-manager.js   DKIM 密钥生命周期
│   ├── smtp.js           SMTP 服务端（25/587）
│   ├── imap.js           IMAP 服务端（143/993）
│   ├── outbound.js       出站投递队列
│   ├── policy.js         SPF / PTR / 反垃圾
│   ├── account.js        账号、域名、别名、转发业务
│   ├── selfsign.js       纯 Node 自签证书生成
│   ├── tls-provider.js   证书加载
│   ├── dnscheck.js       DNS 自检
│   ├── cli.js            命令行工具
│   └── web/              HTTP 服务与路由
├── public/               Webmail 前端（无框架）
├── test/e2e.js           端到端测试（87 项）
├── deploy.sh             一键部署
├── Dockerfile
└── docker-compose.yml
```

---

## 测试

```bash
node test/e2e.js
```

覆盖：建域建号、SMTP 收信、MIME 解码（中文/RFC2047/QP/Base64/附件）、IMAP 全流程、Web API、发信与本地投递、DKIM 签名验签、587 提交与伪造拦截、别名、管理后台、反垃圾、重启持久化。

---

## 安全建议

- 管理后台首次登录后立即改密码
- 生产环境把 `allowSelfRegister` 设为 `false`
- `outbound.allowPrivateRelay` 保持 `false`（防止 SSRF 式内网投递）
- 用 Nginx + HTTPS 反代 8080，或只在内网访问
- 定期 `node src/dnscheck.js` 检查 DNS 健康度
- 备份 `data/` 目录（数据库 + 邮件原文 + DKIM 私钥）

---

## 许可证

MIT
