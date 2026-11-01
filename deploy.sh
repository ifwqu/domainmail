#!/usr/bin/env bash
# 域名邮箱一键部署脚本（Ubuntu / Debian）
set -euo pipefail

DOMAIN="${1:-}"
HOSTNAME_MAIL="${2:-mail.${DOMAIN}}"
INSTALL_DIR="/opt/domainmail"
NODE_MAJOR=22

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info() { echo -e "${BLUE}[*]${NC} $1"; }
ok()   { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; }

if [[ $EUID -ne 0 ]]; then
  err "请用 root 运行：sudo bash deploy.sh yourdomain.com mail.yourdomain.com"
  exit 1
fi

if [[ -z "$DOMAIN" ]]; then
  echo "用法：sudo bash deploy.sh <邮箱域名> [邮件主机名]"
  echo "示例：sudo bash deploy.sh example.com mail.example.com"
  exit 1
fi

echo ""
echo "================================================"
echo "  域名邮箱部署"
echo "  邮箱域名：  $DOMAIN"
echo "  邮件主机名：$HOSTNAME_MAIL"
echo "  安装目录：  $INSTALL_DIR"
echo "================================================"
echo ""

# ---------- 1. 系统依赖 ----------
info "更新软件包索引…"
apt-get update -qq

info "安装基础依赖…"
apt-get install -y -qq curl ca-certificates gnupg ufw openssl >/dev/null

# ---------- 2. Node.js ----------
if ! command -v node >/dev/null 2>&1 || [[ $(node -v | cut -d. -f1 | tr -d 'v') -lt $NODE_MAJOR ]]; then
  info "安装 Node.js ${NODE_MAJOR}.x…"
  curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null
fi
ok "Node.js $(node -v)"

# ---------- 3. 系统参数 ----------
info "调整系统参数…"
cat > /etc/sysctl.d/99-domainmail.conf <<'EOF'
# 邮件服务优化
net.core.somaxconn = 4096
net.ipv4.tcp_max_syn_backlog = 8192
net.ipv4.tcp_fin_timeout = 15
net.ipv4.tcp_keepalive_time = 300
fs.file-max = 200000
EOF
sysctl -p /etc/sysctl.d/99-domainmail.conf >/dev/null 2>&1 || true
ok "系统参数已优化"

# ---------- 4. 部署代码 ----------
info "部署到 ${INSTALL_DIR}…"
mkdir -p "$INSTALL_DIR"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_DIR/package.json" ]]; then
  cp -r "$SCRIPT_DIR"/. "$INSTALL_DIR"/
  ok "已复制项目文件"
else
  warn "未找到项目文件，请手动上传到 ${INSTALL_DIR}"
fi
cd "$INSTALL_DIR"
mkdir -p data/logs data/tls data/dkim data/spool data/messages data/attachments data/tmp

# ---------- 5. 防火墙 ----------
info "配置防火墙…"
ufw allow 22/tcp >/dev/null 2>&1 || true
ufw allow 25/tcp >/dev/null 2>&1 || true
ufw allow 587/tcp >/dev/null 2>&1 || true
ufw allow 143/tcp >/dev/null 2>&1 || true
ufw allow 993/tcp >/dev/null 2>&1 || true
ufw allow 80/tcp >/dev/null 2>&1 || true
ufw allow 443/tcp >/dev/null 2>&1 || true
ufw --force enable >/dev/null 2>&1 || true
ok "已放行 25 / 587 / 143 / 993 / 80 / 443"

# ---------- 6. 配置文件 ----------
if [[ ! -f config.json ]]; then
  info "生成配置文件…"
  ADMIN_PASS=$(openssl rand -base64 12 | tr -d '/+=' | head -c 16)
  cat > config.json <<EOF
{
  "hostname": "${HOSTNAME_MAIL}",
  "brand": "域名邮箱",
  "dataDir": "./data",
  "log": { "level": "info", "file": "./data/logs/mail.log" },
  "http": {
    "enabled": true,
    "host": "0.0.0.0",
    "port": 8080,
    "allowSelfRegister": false,
    "admin": { "email": "admin@${DOMAIN}", "password": "${ADMIN_PASS}" }
  },
  "smtp": { "enabled": true, "host": "0.0.0.0", "port": 25 },
  "submission": { "enabled": true, "host": "0.0.0.0", "port": 587 },
  "imap": { "enabled": true, "host": "0.0.0.0", "port": 143 },
  "outbound": {
    "enabled": true,
    "allowPrivateRelay": false,
    "relay": { "enabled": false }
  },
  "tls": {
    "certFile": "./data/tls/cert.pem",
    "keyFile": "./data/tls/key.pem",
    "selfSignedNames": ["${HOSTNAME_MAIL}"]
  }
}
EOF
  ok "配置已生成"
else
  warn "config.json 已存在，跳过"
fi

# ---------- 7. 初始化 ----------
info "初始化数据库与管理员…"
node src/cli.js init --admin "admin@${DOMAIN}" --password "$(node -e "const c=require('./config.json');console.log(c.http.admin.password)")" 2>&1 | grep -v '^$' || true
ok "初始化完成"

# ---------- 8. systemd ----------
info "创建 systemd 服务…"
cat > /etc/systemd/system/domainmail.service <<EOF
[Unit]
Description=Domain Mail Server
Documentation=https://github.com/maillab/cloud-mail
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=${INSTALL_DIR}
ExecStart=$(command -v node) src/main.js
Restart=always
RestartSec=5
StandardOutput=append:${INSTALL_DIR}/data/logs/stdout.log
StandardError=append:${INSTALL_DIR}/data/logs/stderr.log

# 安全加固
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=false
ReadWritePaths=${INSTALL_DIR}/data

# 资源限制
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable domainmail >/dev/null 2>&1
systemctl restart domainmail
sleep 2

if systemctl is-active --quiet domainmail; then
  ok "服务已启动"
else
  err "服务启动失败，查看日志：journalctl -u domainmail -n 50"
  exit 1
fi

# ---------- 9. 完成 ----------
ADMIN_PASS_SHOW=$(node -e "const c=require('./config.json');console.log(c.http.admin.password)" 2>/dev/null || echo "见 config.json")

echo ""
echo "================================================"
echo -e "${GREEN}部署完成${NC}"
echo "================================================"
echo ""
echo "访问地址：  http://$(curl -s -4 ifconfig.me 2>/dev/null || echo '你的VPS_IP'):8080"
echo "管理员账号：admin@${DOMAIN}"
echo "管理员密码：${ADMIN_PASS_SHOW}"
echo ""
echo -e "${YELLOW}下一步：配置 DNS 解析${NC}"
echo ""
echo "  1. A     ${HOSTNAME_MAIL}              → $(curl -s -4 ifconfig.me 2>/dev/null || echo 'VPS_IP')"
echo "  2. MX    ${DOMAIN}                     → 10 ${HOSTNAME_MAIL}"
echo "  3. TXT   ${DOMAIN}                     → v=spf1 mx ~all"
echo "  4. TXT   _dmarc.${DOMAIN}              → v=DMARC1; p=quarantine; rua=mailto:postmaster@${DOMAIN}"
echo "  5. PTR   $(curl -s -4 ifconfig.me 2>/dev/null || echo 'VPS_IP')                 → ${HOSTNAME_MAIL}  （在VPS商家面板设置）"
echo ""
echo "  6. DKIM 记录请在后台「域名 → DNS 记录」中复制"
echo ""
echo -e "${YELLOW}验证 DNS：${NC} node src/dnscheck.js"
echo -e "${YELLOW}查看日志：${NC} journalctl -u domainmail -f"
echo -e "${YELLOW}重启服务：${NC} systemctl restart domainmail"
echo ""
echo -e "${YELLOW}申请免费 HTTPS 证书（可选，推荐）：${NC}"
echo "  apt install -y certbot"
echo "  certbot certonly --standalone -d ${HOSTNAME_MAIL}"
echo "  然后把证书路径填入 config.json 的 tls.certFile / tls.keyFile"
echo "  并重启：systemctl restart domainmail"
echo ""
