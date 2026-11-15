#!/usr/bin/env bash
# 域名邮箱备份脚本
# 备份内容：数据库（一致性快照）+ DKIM 私钥 + 配置文件 + 邮件原文 + 附件 + 出站暂存
# 用法：bash scripts/backup.sh [保留份数]
set -euo pipefail

INSTALL_DIR="${DM_INSTALL_DIR:-/opt/domainmail}"
BACKUP_DIR="${DM_BACKUP_DIR:-$INSTALL_DIR/backups}"
KEEP="${1:-${DM_KEEP:-14}}"
TS="$(date -u +%Y%m%d-%H%M%S)"
NAME="dm-$TS"
OUT="$BACKUP_DIR/$NAME.tar.gz"

mkdir -p "$BACKUP_DIR"
STAGE="$(mktemp -d)"
cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT

cd "$INSTALL_DIR"
mkdir -p "$STAGE/data"

echo "[*] 数据库一致性快照…"
node -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1]);
db.exec(`VACUUM INTO '"'"'${process.argv[2]}'"'"'`);
db.close();
' "$INSTALL_DIR/data/mail.db" "$STAGE/data/mail.db" 2>/dev/null

if [[ ! -s "$STAGE/data/mail.db" ]]; then
  echo "[!] VACUUM INTO 失败，回退为文件拷贝"
  cp "$INSTALL_DIR/data/mail.db" "$STAGE/data/mail.db"
fi

echo "[*] DKIM 私钥…"
[[ -d "$INSTALL_DIR/data/dkim" ]] && cp -a "$INSTALL_DIR/data/dkim" "$STAGE/data/dkim"

echo "[*] 邮件原文与附件…"
[[ -d "$INSTALL_DIR/data/messages" ]] && cp -a "$INSTALL_DIR/data/messages" "$STAGE/data/messages"
[[ -d "$INSTALL_DIR/data/attachments" ]] && cp -a "$INSTALL_DIR/data/attachments" "$STAGE/data/attachments"
[[ -d "$INSTALL_DIR/data/spool" ]] && cp -a "$INSTALL_DIR/data/spool" "$STAGE/data/spool"

echo "[*] 配置文件…"
[[ -f "$INSTALL_DIR/config.json" ]] && cp -a "$INSTALL_DIR/config.json" "$STAGE/config.json"

echo "[*] 生成清单…"
node -e '
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const stage = process.argv[1];
const dbPath = path.join(stage, "data", "mail.db");
const out = { createdAt: new Date().toISOString(), counts: {}, node: process.version };
try {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  for (const [k, sql] of Object.entries({
    domains: "SELECT COUNT(*) c FROM domains",
    users: "SELECT COUNT(*) c FROM users",
    aliases: "SELECT COUNT(*) c FROM aliases",
    forwards: "SELECT COUNT(*) c FROM forwards",
    messages: "SELECT COUNT(*) c FROM messages",
    outbox: "SELECT COUNT(*) c FROM outbox",
  })) {
    try { out.counts[k] = Number(db.prepare(sql).get().c); } catch { out.counts[k] = null; }
  }
  try { out.emails = db.prepare("SELECT email FROM users ORDER BY id").all().map((r) => r.email); } catch {}
  db.close();
} catch (e) { out.error = String(e.message); }
for (const d of ["messages", "attachments", "dkim"]) {
  const p = path.join(stage, "data", d);
  try { out[d + "Files"] = fs.readdirSync(p, { recursive: true }).filter((f) => fs.statSync(path.join(p, f)).isFile()).length; }
  catch { out[d + "Files"] = 0; }
}
fs.writeFileSync(path.join(stage, "manifest.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out.counts));
' "$STAGE"

echo "[*] 打包…"
tar -czf "$OUT" -C "$STAGE" .
sha256sum "$OUT" | awk '{print $1}' > "$OUT.sha256"
chmod 600 "$OUT" "$OUT.sha256"
SIZE="$(du -h "$OUT" | awk '{print $1}')"
echo "[✓] 备份完成：$OUT（$SIZE）"

echo "[*] 清理旧备份（保留 $KEEP 份）…"
ls -1t "$BACKUP_DIR"/dm-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
  rm -f "$old" "$old.sha256"
  echo "    已删除 $(basename "$old")"
done

echo "[✓] 当前备份："
ls -lht "$BACKUP_DIR"/dm-*.tar.gz 2>/dev/null | awk '{print "    " $9 "  " $5}'
