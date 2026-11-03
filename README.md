# DomainMail · 自建域名邮箱

一个**零第三方依赖**、可完整跑在自己 VPS 上的域名邮箱系统。
收信走本机 25 端口 SMTP，发信直连对方 MX（或走中继），数据落在本地 SQLite + 文件系统。

只需要 **Node.js 22.5+**，用内置的 `node:sqlite` 和 `node:crypto`，**不需要 npm install**。

```
20 个源文件 · 5788 行后端 · 53 个 REST 接口 · 113 项端到端测试
```

---

## 它是什么

不是「调用别人 API 的客户端」，是一台**真正自己跑协议**的邮件服务器：

- 别人给你发信 → 对方的 MTA 连你的 25 端口 → 你解析 MIME、验 SPF、算垃圾分、入库
- 你用 Foxmail / 手机 / 网页发信 → 587 提交 → 你签 DKIM → 你解析 MX → 你直连投递
- 你的客户端收信 → 连你的 IMAP → 你按 UID 返回信封和正文

没有 Cloudflare、没有 Mailgun、没有 Resend（除非你自己配中继）。域名、账号、别名、DKIM 私钥全在你自己机器上。

---

## 功能

### 收信

| 能力 | 说明 |
|---|---|
| SMTP 服务端 | 25 端口，多域名、多收件人、8BITMIME、PIPELINING、SMTPUTF8、ENHANCEDSTATUSCODES |
| STARTTLS | 服务端自动协商，证书可自签也可用 Let's Encrypt |
| 反垃圾 | SPF 求值、PTR 校验、关键词、可疑 TLD、全大写、空正文，加权评分后投 INBOX 或 Junk |
| 收件人展开 | 真实账号 / 别名一对多 / catch-all / 转发（可保留副本）/ 自动回复 |
| 限流 | 按 IP 每分钟连接数与消息数 |

### 发信

| 能力 | 说明 |
|---|---|
| 587 提交 | AUTH PLAIN / LOGIN + STARTTLS，发件人必须是本人地址或自己的别名，否则 553 |
| DKIM | 每个域名独立密钥，rsa-sha256 relaxed/relaxed，自动签名；支持在线轮换 |
| MX 直连 | 逐个 MX 尝试，A → AAAA 回退，跳过内网 IP 防 SSRF |
| IP 族选择 | `ipFamily: ipv4 / ipv6 / auto` —— 应对云厂商封锁 IPv4 出站 25 |
| 中继 | `type: smtp` 或 `type: resend`；`mode: always` 全走中继，`mode: fallback` 先探测目标 MX 有无 IPv6，没有才走中继 |
| 失败重试 | 指数退避，5xx 永久失败，4xx 与网络错误重试至上限 |

### IMAP

IMAP4rev1 子集，143（STARTTLS）与 993（隐式 TLS）双端口：

```
CAPABILITY  NOOP  LOGOUT  LOGIN  AUTHENTICATE(PLAIN/LOGIN)  STARTTLS
LIST  LSUB  SELECT  EXAMINE  STATUS  CREATE  DELETE  SUBSCRIBE  UNSUBSCRIBE
FETCH  STORE  SEARCH  COPY  MOVE  EXPUNGE  APPEND  IDLE  CLOSE  ID  NAMESPACE
```

支持 `UID` 子命令、`LITERAL+`、`SASL-IR`、`UIDPLUS`、`MOVE`，Foxmail / Outlook / iOS 邮件 / Thunderbird 均可直连。

### Webmail

- 收发信、HTML 沙箱渲染、附件上传下载、下载原文 `.eml`
- 文件夹：收件箱 / 星标 / 已发送 / 草稿箱 / 归档 / 垃圾邮件 / 回收站
- 筛选：全部 / 未读 / 星标 / 有附件
- 搜索、分页、批量选择、移动、删除、清空文件夹

### 无限邮箱

- 每个账号可创建**任意数量**别名（`alias.maxPerUser: 0` = 无限）
- 单次批量创建上限 500 个（`alias.maxBatch`）
- 前缀回车即建，全部投递到主邮箱
- **邮箱切换器**：主邮箱与各别名一键切换，未读数、邮件列表、发信人身份全部跟随

### 账号与后台

| 模块 | 能力 |
|---|---|
| 账号 | 多域名、别名、catch-all、转发（保留副本开关）、自动回复（同地址 8 小时去重）、配额统计、API Key |
| 管理后台 | 概览 / 域名 / 账号 / 别名 / 队列 / 审计 六个标签页 |
| 域名管理 | 增删改、启停、DKIM 开关与轮换、**DNS 记录一键复制**（MX / A / SPF / DMARC / DKIM / PTR） |
| 投递队列 | 查看待发 / 已发 / 失败，单条重试、删除 |
| 审计 | 登录、建号、改密、删信等操作留痕 |

### 运维

- DKIM 密钥自动生成与在线轮换
- 纯 Node 手写 X.509，**无 openssl 也能生成自签证书**
- `src/dnscheck.js` 一键体检 MX / A / SPF / DKIM / DMARC / PTR / 25 端口
- systemd 单元、Dockerfile、docker-compose、`deploy.sh` 一键部署

---

## 界面

复刻成熟邮件客户端的排版（实测数值落地，非拍脑袋）：

```
顶栏 64px ─ 品牌 204px │ 搜索框 576×44 r=12 │ 头像 32 + 用户名 + 语言
─────────────────────────────────────────────────────────────
侧栏 15.3%          │ 主卡片 84.7%（14px 圆角 + 1px 边框 + 微阴影）
  ├ 身份卡 48px      │  ├ 工具栏 58px  标题 18/600 + 未读徽标 + 刷新
  ├ 写邮件 44px/10px │  ├ 筛选栏 48px  胶囊 72×28 r=7
  ├ 文件夹 36px/项   │  ├ 列表 36%   行 76px  grid(34px 1fr 8px 28px)
  ├ 标签             │  │             头像 32 圆 · 未读点 7px · 星标 28
  └ 容量 + 用户卡    │  └ 阅读 64%   工具栏 56 · 标题 20/600 · 正文 lh1.8
```

- 配色：`--blue #2563eb` / `--app-bg #f4f6f9` / `--side-bg #f7f9fc` / `--ink #202938`
- 分栏用百分比 flex，窗口缩放比例不变（1500 / 1366 / 1280 / 1100 / 1024 / 900 实测一致）
- 写信窗居中 1024×717，16px 圆角，`rgba(0,0,0,.8)` 遮罩
- 全部图标为内联 SVG（Lucide 风格 stroke-width 1.75），**无 emoji、无图标字体、无图片请求**
- 跟随系统暗色模式

### 手机适配

不是「压缩版桌面」，是独立的移动端布局。断点三档：**≤860 手机** / **861–1024 平板** / **>1024 桌面**。

| 区域 | 桌面 | 手机（≤860） |
|---|---|---|
| 顶栏 | 64px，品牌 204px + 搜索 576 + 用户胶囊 | **56px**，汉堡菜单 + logo + 搜索（隐藏用户名/语言/设置） |
| 侧栏 | 15.3% 常驻 | **82vw 抽屉**（≤320px），`translateX(-102%)` 滑出，`rgba(15,23,42,.42)` 遮罩，点遮罩关闭并锁 `body` 滚动 |
| 底栏 | 无 | **4 格**：邮件 / 写信 / 邮箱 / 设置，`env(safe-area-inset-bottom)` 适配 iPhone 手势条 |
| 列表 | 36%，行 76px，含勾选框 | **100%**，行 84px，隐藏勾选框，星标 36px，头像 36px |
| 阅读 | 右侧 64% | **全屏切换**：`.content.reading` 隐藏列表、阅读区占满，工具栏「返回」回列表 |
| 写信 | 居中 1024×717 圆角 16 | **全屏 100dvh**，圆角 0，安全区留白，底部按钮 44px |
| 设置 / 管理 | 左侧 label 80px + 右侧输入 | label 换行置顶、输入撑满、**16px 字号防 iOS 聚焦缩放**、表格内部横向滚动 |
| 横屏 | — | 顶栏压到 48px，隐藏底栏，争取纵向空间 |

实现要点：

- `height: 100dvh` 解决 iOS Safari 地址栏导致的 100vh 溢出
- `viewport-fit=cover` + `env(safe-area-inset-*)` 适配刘海与手势条
- 输入框全部 16px —— 小于 16px 时 iOS 会在聚焦瞬间强制放大页面
- `@media (hover: none) and (pointer: coarse)` 清掉 hover 残留，改为 `:active` 反馈
- `touch-action: manipulation` 消除 300ms 点击延迟与双击缩放
- 触控目标统一 ≥32px（底栏 48px、按钮 36–44px）
- 超小屏（≤380）与横屏手机各有单独一档收紧规则

覆盖设备实测：375×667 / 390×844 / 412×915 / 768×1024 / 1024×768 / 1440×900，**80 项断言全通过，无横向溢出**。

---

## 快速部署

### 一键脚本（Ubuntu / Debian）

```bash
scp -r mailserver root@your-vps:/opt/domainmail
ssh root@your-vps
cd /opt/domainmail

bash deploy.sh example.com mail.example.com
```

自动完成：装 Node、配 ufw、建 systemd 服务、生成 `config.json`、初始化数据库与管理员、生成 DKIM 密钥。
结束时打印**管理员密码**和**需要添加的 DNS 记录**。

### 手动

```bash
cd /opt/domainmail
mkdir -p data/{logs,tls,dkim,spool,messages,attachments,tmp}
cp config.example.json config.json        # 编辑 hostname 与 admin
node src/cli.js init --admin admin@example.com --password '你的强密码'
node src/main.js
```

### Docker

```bash
cp config.example.json config.json
docker compose up -d
docker compose logs -f
```

---

## DNS 配置

不配就收不到信。在域名服务商处添加：

| 类型 | 主机记录 | 值 | 说明 |
|---|---|---|---|
| A | `mail` | `你的VPS_IP` | 邮件服务器主机名 |
| AAAA | `mail` | `你的VPS_IPv6` | 可选，但强烈建议（见下） |
| MX | `@` | `10 mail.example.com` | 收信指向本机 |
| TXT | `@` | `v=spf1 mx ~all` | 授权本机发信 |
| TXT | `_dmarc` | `v=DMARC1; p=quarantine; rua=mailto:postmaster@example.com` | DMARC 策略 |
| TXT | `mail._domainkey` | `v=DKIM1; k=rsa; p=MIIBIjAN...` | DKIM 公钥，后台可直接复制 |

**PTR（反向解析）必须设置**，否则 Gmail / Outlook 大概率拒收或判垃圾：
在 VPS 商家控制面板把 `你的VPS_IP` 的 rDNS 设为 `mail.example.com`。

### 自检

```bash
node src/dnscheck.js
```

逐项检查 MX / A / SPF / DKIM / DMARC / PTR / 25 端口连通性，并给出修复建议。

---

## 端口

| 端口 | 用途 | 必须公网可达 |
|---|---|---|
| 25 | SMTP 收信 | **是** |
| 587 | SMTP 提交 | 是 |
| 143 | IMAP + STARTTLS | 是 |
| 993 | IMAPS 隐式 TLS | 可选 |
| 8080 | Webmail / 管理后台 | 建议挂 Nginx + HTTPS |

---

## 客户端配置

```
收信 IMAP：mail.example.com   143   STARTTLS
发信 SMTP：mail.example.com   587   STARTTLS   需要认证
账号：you@example.com
密码：邮箱登录密码
```

---

## 25 端口被封怎么办

多数云厂商（阿里云、腾讯云、AWS、Oracle）默认封 **出站** 25。三条路：

**1. 申请解封** —— 提工单说明用途，多数商家可解。

**2. 走中继** —— 编辑 `config.json`：

```json
"outbound": {
  "ipFamily": "ipv6",
  "relay": {
    "enabled": true,
    "type": "smtp",
    "mode": "fallback",
    "host": "smtp.yourprovider.com",
    "port": 465,
    "secure": true,
    "user": "your-user",
    "pass": "your-pass"
  }
}
```

- `mode: always` —— 全部走中继
- `mode: fallback` —— 先探测目标 MX 有没有 IPv6，有就直连，没有才走中继（**IPv4 被封但 IPv6 可用时，这是最优解**：耗时从 110 秒降到 2 秒内）
- 也可用 `"type": "resend"` + `"apiKey"` 走 Resend HTTP API

**3. 换 VPS** —— 选明确允许 25 端口的商家。

注意：中继只影响**出站发信**，25 端口**入站收信**仍需商家放行。

---

## HTTPS

```bash
apt install -y certbot
certbot certonly --standalone -d mail.example.com
```

```json
"tls": {
  "certFile": "/etc/letsencrypt/live/mail.example.com/fullchain.pem",
  "keyFile": "/etc/letsencrypt/live/mail.example.com/privkey.pem"
}
```

```bash
systemctl restart domainmail
```

SMTP / IMAP / Web 共用这一份证书。Web 建议再挂 Nginx 反代 8080。
证书续期后需要重启服务，可在 `/etc/letsencrypt/renewal-hooks/deploy/` 放一个脚本：

```bash
#!/bin/sh
nginx -s reload
systemctl restart domainmail
```

---

## 常用命令

```bash
systemctl status domainmail          # 状态
systemctl restart domainmail         # 重启
journalctl -u domainmail -f          # 实时日志
tail -f data/logs/mail.log           # 邮件日志

node src/cli.js domain list                      # 域名列表
node src/cli.js domain add example.com           # 加域名
node src/cli.js domain dns example.com           # 打印 DNS 记录
node src/cli.js user list                        # 账号列表
node src/cli.js user add bob@example.com 密码     # 建账号
node src/cli.js user passwd bob@example.com 新密码
node src/cli.js alias add sales@example.com a@example.com b@example.com
node src/cli.js dkim rotate example.com          # 轮换 DKIM
node src/dnscheck.js                             # DNS 体检
```

---

## REST API

53 个接口，全部走 `dm_session` Cookie 会话。分组：

```
POST   /api/auth/login | logout | register | password
GET    /api/auth/me | register-config
GET    /api/folders
GET    /api/messages                     ?folder&limit&offset&q&unread
GET    /api/messages/:id | :id/raw
POST   /api/messages/:id/flags | move
DELETE /api/messages/:id
POST   /api/folders/:folder/empty
POST   /api/send
GET    /api/attachments/:id
GET    /api/mailboxes                    # 邮箱切换器数据
GET    /api/aliases  POST /api/aliases  POST /api/aliases/batch
PUT    /api/aliases/:id  DELETE /api/aliases/:id
GET    /api/settings  POST /api/settings/{forward,autoresponder,profile,apikeys}
DELETE /api/settings/apikeys/:id
GET    /api/admin/{stats,domains,users,aliases,forwards,outbox,audit,config}
POST   /api/admin/domains  PUT/DELETE /api/admin/domains/:id
GET    /api/admin/domains/:id/dns
POST   /api/admin/domains/:id/dkim/rotate
POST   /api/admin/users  PUT/DELETE /api/admin/users/:id
POST   /api/admin/users/:id/password
POST   /api/admin/outbox/:id/retry  DELETE /api/admin/outbox/:id
GET    /api/client-config
```

---

## 架构

```
   外部 MTA ──25──▶ ┌────────────────────────────────────────┐
                    │ SMTP 入站                              │
                    │  ├ SPF / PTR 校验                      │
                    │  ├ 反垃圾评分 → INBOX / Junk           │
                    │  └ 别名展开 / catch-all / 转发 / 自动回复 │
                    └───────────────┬────────────────────────┘
                                    ▼
                    ┌────────────────────────────────────────┐
                    │ MIME 解析（RFC2047 / 2231 / QP / Base64）│
                    │ SQLite 元数据 + 文件系统 .eml 原文       │
                    └───────────────┬────────────────────────┘
                                    ▼
      ┌──────────────┬──────────────┴──────────────┬──────────────┐
      ▼              ▼                             ▼              ▼
  Webmail        IMAP 143/993                管理后台        出站队列
 (53 个 REST)  (Foxmail / 手机)                           ├ DKIM 签名
                                                          ├ MX 解析（A→AAAA）
                                                          ├ ipFamily 选择
                                                          ├ 直连 / 中继
                                                          └ 指数退避重试
```

---

## 目录结构

```
mailserver/
├── src/
│   ├── main.js           装配入口（createApp / start / stop）
│   ├── config.js         配置加载、默认值、deepMerge、ensureDirs
│   ├── db.js             SQLite schema、迁移、nextUid
│   ├── store.js          MailStore：投递入库、列表、计数、标记、移动
│   ├── mime.js           MIME 解析与生成、RFC2047 / 2231
│   ├── dkim.js           DKIM 签名与验签
│   ├── dkim-manager.js   每域密钥、轮换、DNS 记录
│   ├── smtp.js           SMTP 服务端（25 入站 / 587 提交）
│   ├── imap.js           IMAP 服务端（143 / 993）
│   ├── outbound.js       出站队列、SmtpClient、中继
│   ├── policy.js         SPF 求值、PTR、反垃圾评分
│   ├── account.js        域名 / 账号 / 别名 / 转发 / 自动回复 / APIKey
│   ├── crypto.js         scrypt 口令哈希、会话 token
│   ├── selfsign.js       纯 Node X.509 自签证书生成
│   ├── tls-provider.js   证书加载与热更新
│   ├── dnscheck.js       DNS 体检 CLI
│   ├── logger.js         分级日志
│   ├── cli.js            命令行工具
│   └── web/
│       ├── server.js     零依赖 HTTP、静态文件、ETag、会话
│       └── routes.js     全部 REST 路由
├── public/               Webmail 前端（无框架、无构建、无 npm）
│   ├── index.html
│   ├── app.js            1345 行，手写渲染
│   └── style.css         1574 行，设计令牌 + 暗色模式
├── test/
│   ├── e2e.js            端到端测试（113 项断言）
│   └── client.js         SMTP / IMAP 测试客户端
├── deploy.sh             一键部署
├── Dockerfile
├── docker-compose.yml
└── config.example.json
```

---

## 测试

```bash
node test/e2e.js
```

```
RESULT: 113 passed, 0 failed
```

覆盖 13 个环节：自动建域与 DKIM 记录、建号与重复校验、SMTP 收信全流程（含中文主题 RFC2047、QP 正文、Base64 附件）、MIME 落库校验、IMAP 全命令、Web API 与附件下载、本地投递与 DKIM 签名、签名验签、587 提交与伪造发件人拦截、别名一对多、管理后台与权限、反垃圾评分、重启后数据持久化。

---

## 安全建议

- 首次登录后立即改管理员密码
- 生产环境保持 `allowSelfRegister: false`
- `outbound.allowPrivateRelay` 保持 `false`（防 SSRF 式内网投递）
- Web 挂 Nginx + HTTPS 反代 8080，或只监听内网
- 定期 `node src/dnscheck.js` 检查 DNS 健康度
- 备份 `data/` 目录（数据库 + 邮件原文 + DKIM 私钥）
- `config.json` 与 `data/` 已在 `.gitignore` 中，不要提交

---

## 许可证

MIT
