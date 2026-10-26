#!/usr/bin/env bash
# =============================================================================
# 标讯助手 · SQLite 备份脚本（服务器上以 biaoxun 用户运行）
#
# 用法：
#   /opt/biaoxun/server/deploy/backup.sh [备份目录]
#
# 默认备份到 /opt/biaoxun/backup，保留最近 14 天，自动删除更早的备份。
# crontab 示例（每天 03:15）：
#   15 3 * * * /opt/biaoxun/server/deploy/backup.sh >> /opt/biaoxun/data/backup.log 2>&1
# =============================================================================
set -euo pipefail
umask 077

APP_DIR="${BX_APP_DIR:-/opt/biaoxun}"
BACKUP_DIR="${1:-${BX_BACKUP_DIR:-$APP_DIR/backup}}"
SERVER_DIR="$APP_DIR/server"
PYTHON="$SERVER_DIR/.venv/bin/python"

if [[ ! -x "$PYTHON" ]]; then
  echo "❌ 未找到 venv Python：$PYTHON" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y-%m-%d-%H%M%S)"
DEST="$BACKUP_DIR/biaoxun-$STAMP.db"

# CLI 内部用 SQLite 在线备份 API，WAL 模式下也安全
cd "$SERVER_DIR"
BX_DATA_DIR="${BX_DATA_DIR:-$APP_DIR/data}" "$PYTHON" -m app.cli backup --dest "$DEST"

# 只清理本脚本生成的备份，避免误删目录里的其他文件
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'biaoxun-*.db' -mtime +14 -print -delete

echo "✅ 备份完成：$DEST"
