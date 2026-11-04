#!/usr/bin/env bash
# =============================================================================
# 标讯助手 · 打离线发布包（本地执行）
#
# 产物：dist/biaoxun-release-<日期-时间>.tar.gz 与同名 .sha256
# 包内：server/ web/ collector/ install.sh VERSION
#
# 用法：
#   ./server/deploy/package.sh
#   ./server/deploy/package.sh --out /tmp/dist
#
# 后续（无 SSH 场景）：
#   1. 把 tar.gz 上传到服务器（腾讯云网页终端支持文件上传 / 或任意传输工具）
#   2. tar -xzf biaoxun-release-*.tar.gz -C /root/biaoxun-release
#   3. cd /root/biaoxun-release && sudo bash install.sh
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUT_DIR="$REPO_DIR/dist"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) OUT_DIR="${2:-}"; shift 2 ;;
    --out=*) OUT_DIR="${1#*=}"; shift ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 1 ;;
  esac
done

STAMP="$(date +%Y%m%d-%H%M)"
NAME="biaoxun-release-$STAMP"
STAGE="$(mktemp -d /tmp/biaoxun-package.XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT

echo "▶ 打包 $NAME"
mkdir -p "$OUT_DIR"

# server：排除运行产物
rsync -a \
  --exclude '.venv/' --exclude '__pycache__/' --exclude 'data/' \
  --exclude '.pytest_cache/' --exclude '*.pyc' \
  "$REPO_DIR/server/" "$STAGE/server/"

# web（前端源码 + 种子数据）
rsync -a --exclude '.DS_Store' "$REPO_DIR/web/" "$STAGE/web/"

# collector（采集脚本与数据源注册表）
rsync -a --exclude '__pycache__/' --exclude 'logs/' --exclude '_ocr/' \
  "$REPO_DIR/collector/" "$STAGE/collector/"

# 安装脚本 + 版本信息
install -m 755 "$SCRIPT_DIR/install.sh" "$STAGE/install.sh"
cat > "$STAGE/VERSION" <<EOF
name=$NAME
built_at=$(date '+%Y-%m-%d %H:%M:%S %Z')
git_branch=$(git -C "$REPO_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)
git_commit=$(git -C "$REPO_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)
EOF

TARBALL="$OUT_DIR/$NAME.tar.gz"
tar -czf "$TARBALL" -C "$STAGE" .
( cd "$OUT_DIR" && shasum -a 256 "$NAME.tar.gz" > "$NAME.tar.gz.sha256" 2>/dev/null \
  || sha256sum "$NAME.tar.gz" > "$NAME.tar.gz.sha256" )

echo "✅ 已生成：${TARBALL}（$(du -h "$TARBALL" | cut -f1)）"
echo "   SHA256：$(cut -d' ' -f1 "$TARBALL.sha256")"
echo
echo "服务器端安装："
echo "  tar -xzf $NAME.tar.gz -C /root/biaoxun-release"
echo "  cd /root/biaoxun-release && sudo bash install.sh"
echo "  # 或者指定国内镜像：sudo bash install.sh --pip-index-url https://pypi.tuna.tsinghua.edu.cn/simple"
