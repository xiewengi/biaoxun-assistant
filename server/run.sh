#!/usr/bin/env bash
# =============================================================================
# 标讯助手 · 通用启动脚本（本地 macOS / 服务器 Linux 通用）
#
# 用法：
#   ./server/run.sh                       # 默认 127.0.0.1:8000，2 个 worker
#   BX_HOST=0.0.0.0 ./server/run.sh       # 监听所有网卡（仅内网/测试用）
#   BX_PORT=8080 ./server/run.sh          # 换端口
#   BX_WORKERS=1 ./server/run.sh          # 单 worker（调试更方便）
#
# 说明：
#   - 自动 cd 到 server/ 并激活同目录的 .venv
#   - 生产环境请用 systemd（见 server/deploy/biaoxun.service），
#     不要用本脚本 nohup 挂后台，否则崩溃不会自动拉起。
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# 1) 检查虚拟环境
if [[ ! -f ".venv/bin/activate" ]]; then
  echo "❌ 未找到虚拟环境：${SCRIPT_DIR}/.venv" >&2
  echo "   请先创建并安装依赖：" >&2
  echo "   cd ${SCRIPT_DIR}" >&2
  echo "   python3 -m venv .venv" >&2
  echo "   .venv/bin/pip install -r requirements.txt" >&2
  exit 1
fi

# 2) 激活虚拟环境
# shellcheck disable=SC1091
source .venv/bin/activate

if ! command -v uvicorn >/dev/null 2>&1; then
  echo "❌ 虚拟环境中没有 uvicorn，请执行：.venv/bin/pip install -r requirements.txt" >&2
  exit 1
fi

# 3) 读取环境变量并启动
BX_HOST="${BX_HOST:-127.0.0.1}"
BX_PORT="${BX_PORT:-8000}"
BX_WORKERS="${BX_WORKERS:-2}"

echo "▶ 启动标讯助手：http://${BX_HOST}:${BX_PORT}（workers=${BX_WORKERS}）"
exec uvicorn app.main:app \
  --host "${BX_HOST}" \
  --port "${BX_PORT}" \
  --workers "${BX_WORKERS}"
