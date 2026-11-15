#!/usr/bin/env bash
# 域名邮箱恢复脚本
# 用法：bash scripts/restore.sh /path/to/dm-YYYYMMDD-HHMMSS.tar.gz
# 会先备份当前数据，再覆盖恢复，然后重启服务
set -euo pipefail

ARCHIVE="${1:-}"
INSTALL_DIR="${DM_INSTALL_DIR:-/opt/domainmail}"

if [[ -z "$ARCHIVE" || ! -f "$ARCHIVE" ]]; then
  echo "用法：bash scripts/restore.sh /path/to/dm-YYYYMMDD-HHMMSS.tar.gz"
  echo
  echo "可用备份："
  ls -lht "$INSTALL_DIR"/backups/dm-*.tar.gz 2>/dev/null | awk '{print "  " $9 "  " $5}' || echo "  （无）"
  exit 1
fi

echo "[*] 校验归档完整性…"
if [[ -f "$ARCHIVE.sha256" ]]; then
  EXPECT="$(cat "$ARCHIVE.sha256")"
  ACTUAL="$(sha256sum "$ARCHIVE" | awk '{print $1}')"
  if [[ "$EXPECT" != "$ACTUAL" ]]; then
    echo "[!] SHA256 不匹配，归档可能损坏"
    echo "    期望 $EXPECT"
    echo "    实际 $ACTUAL"
    exit 1
  fi
  echo "    SHA256 校验通过"
else
  echo "    （无 .sha256 文件，跳过校验）"
fi

echo "[*] 预检归档内容…"
LIST="$(tar -tzf "$ARCHIVE")"
echo "$LIST" | sed -n '1,20p' | sed 's/^/    /'
if ! grep -qxE '\./?data/mail\.db' <<<"$LIST"; then
  echo "[!] 归档里没有 data/mail.db，可能不是有效备份"
  exit 1
fi

TS="$(date -u +%Y%m%d-%H%M%S)"
SAFE="$INSTALL_DIR/backups/pre-restore-$TS.tar.gz"
mkdir -p "$INSTALL_DIR/backups"

echo "[*] 先把当前状态备份到 $SAFE …"
if [[ -d "$INSTALL_DIR/data" ]]; then
  tar -czf "$SAFE" -C "$INSTALL_DIR" data config.json 2>/dev/null || \
  tar -czf "$SAFE" -C "$INSTALL_DIR" data 2>/dev/null || true
  [[ -f "$SAFE" ]] && chmod 600 "$SAFE" && echo "    已保存"
fi

echo "[*] 停止服务…"
systemctl stop domainmail 2>/dev/null || true

echo "[*] 解包恢复…"
STAGE="$(mktemp -d)"
tar -xzf "$ARCHIVE" -C "$STAGE"
MANIFEST="$STAGE/manifest.json"
if [[ ! -f "$MANIFEST" ]]; then
  MANIFEST="$(mktemp)"
  echo '{}' > "$MANIFEST"
fi
MANIFEST_COPY="$(mktemp)"
cp "$MANIFEST" "$MANIFEST_COPY"
MANIFEST="$MANIFEST_COPY"

mkdir -p "$INSTALL_DIR/data"
# 保留目录本身，逐个覆盖内容
for item in mail.db dkim messages attachments spool; do
  if [[ -e "$STAGE/data/$item" ]]; then
    rm -rf "${INSTALL_DIR:?}/data/$item"
    cp -a "$STAGE/data/$item" "$INSTALL_DIR/data/$item"
    echo "    恢复 data/$item"
  fi
done

# 清理可能残留的 WAL/SHM，避免与新库不匹配
rm -f "$INSTALL_DIR/data/mail.db-wal" "$INSTALL_DIR/data/mail.db-shm"

if [[ -f "$STAGE/config.json" ]]; then
  if [[ -f "$INSTALL_DIR/config.json" ]]; then
    cp -a "$INSTALL_DIR/config.json" "$INSTALL_DIR/config.json.bak-$TS"
    echo "    原 config.json 已备份为 config.json.bak-$TS"
  fi
  cp -a "$STAGE/config.json" "$INSTALL_DIR/config.json"
  echo "    恢复 config.json"
fi

chown -R root:root "$INSTALL_DIR/data" 2>/dev/null || true
echo "[*] 启动服务…"
systemctl start domainmail
sleep 2

echo "[*] 校验…"
if systemctl is-active --quiet domainmail; then
  echo "    服务 active"
else
  echo "[!] 服务未启动，查看日志：journalctl -u domainmail -n 50"
  exit 1
fi

node -e '
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const db = new DatabaseSync(process.argv[1], { readOnly: true });
const actual = {};
for (const t of ["domains","users","aliases","forwards","messages","outbox"]) {
  try { actual[t] = Number(db.prepare("SELECT COUNT(*) c FROM " + t).get().c); } catch { actual[t] = null; }
}
try { actual.emails = db.prepare("SELECT email FROM users ORDER BY id").all().map(r=>r.email); } catch {}
db.close();
console.log("    实际: " + JSON.stringify(actual));
let expect = null;
try { expect = JSON.parse(fs.readFileSync(process.argv[2], "utf8")); } catch {}
if (expect) {
  console.log("    期望: " + JSON.stringify(expect.counts));
  let bad = 0;
  for (const [k, v] of Object.entries(expect.counts || {})) {
    if (v === null || v === undefined) continue;
    if (actual[k] !== v) { console.log("    [!] " + k + " 不一致：实际 " + actual[k] + " / 期望 " + v); bad++; }
  }
  console.log(bad ? "    [!] 有 " + bad + " 项与清单不一致" : "    [✓] 所有表计数与清单一致");
  if (JSON.stringify(actual.emails) !== JSON.stringify(expect.emails)) console.log("    [!] 账号列表与清单不一致");
}
' "$INSTALL_DIR/data/mail.db" "$MANIFEST"

echo "[✓] 恢复完成"
echo "    归档：$ARCHIVE"
echo "    恢复前快照：${SAFE:-（无）}"
