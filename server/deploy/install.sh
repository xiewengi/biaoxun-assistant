#!/usr/bin/env bash
# =============================================================================
# 标讯助手 · 服务器端离线安装脚本（随发布包一起提供）
#
# 适用：无法从本地 SSH/rsync（例如只拿到腾讯云网页终端 + 文件上传）时，
#       把发布包上传到服务器，解压后 root 执行本脚本即可。
#
# 用法：
#   tar -xzf biaoxun-release-*.tar.gz -C /root/biaoxun-release
#   cd /root/biaoxun-release
#   sudo bash install.sh
#
# 常用选项：
#   --prefix DIR     安装目录，默认 /opt/biaoxun
#   --port PORT      应用端口，默认 8000（只监听 127.0.0.1）
#   --user NAME      运行用户，默认 biaoxun
#   --no-deps        跳过系统依赖安装（已装 python3-venv/pip 时）
#   --no-user        不创建系统用户（以当前用户运行；用于容器/本地测试）
#   --no-systemd     不安装 systemd 服务（只准备文件、venv、数据库）
#   --no-collector   不安装采集器依赖（/api/collect 将不可用）
#   --pip-index-url  指定 pip 镜像（也可用环境变量 PIP_INDEX_URL）
#
# 幂等：可重复执行；data/、web/ 之外的代码会覆盖更新，数据库与备份不删除。
# =============================================================================
set -euo pipefail
umask 022

APP_DIR="/opt/biaoxun"
APP_PORT="8000"
APP_USER="biaoxun"
DO_DEPS=1
DO_USER=1
DO_SYSTEMD=1
DO_COLLECTOR=1
PIP_INDEX_URL="${PIP_INDEX_URL:-}"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix) APP_DIR="${2:-}"; shift 2 ;;
    --prefix=*) APP_DIR="${1#*=}"; shift ;;
    --port) APP_PORT="${2:-}"; shift 2 ;;
    --port=*) APP_PORT="${1#*=}"; shift ;;
    --user) APP_USER="${2:-}"; shift 2 ;;
    --user=*) APP_USER="${1#*=}"; shift ;;
    --no-deps) DO_DEPS=0; shift ;;
    --no-user) DO_USER=0; shift ;;
    --no-systemd) DO_SYSTEMD=0; shift ;;
    --no-collector) DO_COLLECTOR=0; shift ;;
    --pip-index-url) PIP_INDEX_URL="${2:-}"; shift 2 ;;
    -h|--help) usage 0 ;;
    *) echo "未知参数：$1" >&2; usage 1 ;;
  esac
done

log()  { echo; echo "▶ $*"; }
ok()   { echo "✅ $*"; }
warn() { echo "⚠️  $*"; }
die()  { echo "❌ $*" >&2; exit 1; }

RUN_AS=()
if [[ "$DO_USER" == "1" || "$DO_SYSTEMD" == "1" ]]; then
  [[ "$(id -u)" -eq 0 ]] || die "需要 root 执行（或加 --no-user --no-systemd 做本地测试）"
fi
if [[ "$DO_USER" == "1" ]]; then
  RUN_AS=(runuser -u "$APP_USER" --)
fi
run_as() {
  if [[ ${#RUN_AS[@]} -gt 0 ]]; then
    "${RUN_AS[@]}" "$@"
  else
    "$@"
  fi
}

[[ -d "$SOURCE_DIR/server/app" ]] || die "发布包不完整：缺少 server/app"
[[ -d "$SOURCE_DIR/web" ]] || die "发布包不完整：缺少 web/"
[[ -f "$SOURCE_DIR/server/requirements.txt" ]] || die "发布包不完整：缺少 requirements.txt"

log "1/7 检查系统与 Python"
if command -v python3 >/dev/null 2>&1; then
  python3 -V
else
  die "未找到 python3"
fi
PYTHON_BIN="$(command -v python3)"

if [[ "$DO_DEPS" == "1" ]]; then
  log "2/7 安装系统依赖（python3-venv / python3-pip）"
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq || warn "apt-get update 失败，继续尝试安装"
    apt-get install -y -qq python3-venv python3-pip || die "系统依赖安装失败，可加 --no-deps 跳过"
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y python3-pip python3-virtualenv 2>/dev/null \
      || dnf install -y python3-pip || die "系统依赖安装失败，可加 --no-deps 跳过"
  elif command -v yum >/dev/null 2>&1; then
    yum install -y python3-pip || die "系统依赖安装失败，可加 --no-deps 跳过"
  else
    warn "未识别包管理器，跳过系统依赖安装"
  fi
  ok "系统依赖就绪"
else
  log "2/7 跳过系统依赖安装（--no-deps）"
fi

if [[ "$DO_USER" == "1" ]]; then
  log "3/7 创建运行用户"
  if getent group "$APP_USER" >/dev/null 2>&1; then
    ok "用户组 $APP_USER 已存在"
  else
    groupadd -r "$APP_USER"
    ok "创建用户组 $APP_USER"
  fi
  if id -u "$APP_USER" >/dev/null 2>&1; then
    ok "用户 $APP_USER 已存在"
  else
    NOLOGIN=/usr/sbin/nologin
    [[ -x "$NOLOGIN" ]] || NOLOGIN=/sbin/nologin
    [[ -x "$NOLOGIN" ]] || NOLOGIN=/bin/false
    useradd -r -g "$APP_USER" -d "$APP_DIR" -s "$NOLOGIN" "$APP_USER"
    ok "创建用户 $APP_USER"
  fi
else
  log "3/7 跳过用户创建（--no-user），以 $(id -un) 运行"
fi

log "4/7 安装代码到 $APP_DIR"
mkdir -p "$APP_DIR" "$APP_DIR/data"
# 代码覆盖更新；data / backup 不在复制源里，天然保留
rsync -a --delete --exclude '.venv/' --exclude '__pycache__/' --exclude 'data/' \
  "$SOURCE_DIR/server/" "$APP_DIR/server/"
if [[ -d "$SOURCE_DIR/web" ]]; then
  rsync -a --delete --exclude '.DS_Store' "$SOURCE_DIR/web/" "$APP_DIR/web/"
fi
if [[ -d "$SOURCE_DIR/collector" ]]; then
  rsync -a --delete --exclude '__pycache__/' --exclude 'logs/' --exclude '_ocr/' \
    "$SOURCE_DIR/collector/" "$APP_DIR/collector/"
fi
[[ -f "$APP_DIR/web/index.html" ]] || die "前端安装失败：缺少 $APP_DIR/web/index.html"
ok "代码与前端已就位（web/ 为前端唯一目录）"

log "5/7 创建/复用 venv 并安装 Python 依赖"
VENV="$APP_DIR/server/.venv"
PIP_ARGS=(--disable-pip-version-check)
if [[ -n "$PIP_INDEX_URL" ]]; then
  PIP_ARGS+=(--index-url "$PIP_INDEX_URL")
fi
if [[ -x "$VENV/bin/python" ]]; then
  ok "venv 已存在，复用"
else
  run_as env HOME="$APP_DIR/data" "$PYTHON_BIN" -m venv "$VENV" || die "创建 venv 失败"
  ok "venv 创建完成"
fi
run_as env HOME="$APP_DIR/data" PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 \
  "$VENV/bin/python" -m pip install "${PIP_ARGS[@]}" -r "$APP_DIR/server/requirements.txt" \
  || die "服务端依赖安装失败（可设置 --pip-index-url 使用国内镜像）"
ok "服务端依赖安装完成"

if [[ "$DO_COLLECTOR" == "1" && -f "$APP_DIR/collector/requirements.txt" ]]; then
  log "5.1 安装采集器依赖（可选）"
  if run_as env HOME="$APP_DIR/data" PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 \
       "$VENV/bin/python" -m pip install "${PIP_ARGS[@]}" -r "$APP_DIR/collector/requirements.txt"; then
    ok "采集器依赖安装完成"
  else
    warn "采集器依赖安装失败，仅影响「刷新抓取」按钮"
  fi
fi

log "6/7 初始化数据库（仅首次）"
if [[ ! -s "$APP_DIR/data/biaoxun.db" ]]; then
  run_as env HOME="$APP_DIR/data" BX_DATA_DIR="$APP_DIR/data" BX_STATIC_DIR="$APP_DIR/web" \
    bash -c "cd '$APP_DIR/server' && '$VENV/bin/python' -c 'from app import seed; print(seed.run_seed())'" \
    || die "数据库初始化失败"
  ok "数据库与种子数据已初始化"
else
  ok "数据库已存在，跳过初始化"
fi

if [[ "$DO_USER" == "1" ]]; then
  chown -R "$APP_USER:$APP_USER" "$APP_DIR/server" "$APP_DIR/web" "$APP_DIR/collector" 2>/dev/null || true
  chown -R "$APP_USER:$APP_USER" "$APP_DIR/data"
fi

if [[ "$DO_SYSTEMD" == "1" ]]; then
  log "7/7 安装并启动 systemd 服务"
  UNIT_SRC="$APP_DIR/server/deploy/biaoxun.service"
  [[ -f "$UNIT_SRC" ]] || die "缺少 $UNIT_SRC"
  TMP_UNIT="$(mktemp /tmp/biaoxun.service.XXXXXX)"
  sed -e "s#/opt/biaoxun#${APP_DIR}#g" \
      -e "s#127.0.0.1:8000#127.0.0.1:${APP_PORT}#g" \
      "$UNIT_SRC" > "$TMP_UNIT"
  install -m 644 "$TMP_UNIT" /etc/systemd/system/biaoxun.service
  rm -f "$TMP_UNIT"
  systemctl daemon-reload
  systemctl enable biaoxun >/dev/null 2>&1 || warn "systemctl enable 失败"
  systemctl restart biaoxun
  for _ in $(seq 1 15); do
    systemctl is-active --quiet biaoxun && break
    sleep 1
  done
  systemctl is-active --quiet biaoxun || die "biaoxun 服务未启动，查看：journalctl -u biaoxun -n 80"
  ok "biaoxun 服务已启动"

  # 定时采集 timer（每 2 小时）
  if [[ -f "$APP_DIR/server/deploy/biaoxun-collect.service" && -f "$APP_DIR/server/deploy/biaoxun-collect.timer" ]]; then
    TMP_CS="$(mktemp /tmp/biaoxun-collect.service.XXXXXX)"
    sed -e "s#/opt/biaoxun#${APP_DIR}#g" \
      "$APP_DIR/server/deploy/biaoxun-collect.service" > "$TMP_CS"
    install -m 644 "$TMP_CS" /etc/systemd/system/biaoxun-collect.service
    install -m 644 "$APP_DIR/server/deploy/biaoxun-collect.timer" /etc/systemd/system/biaoxun-collect.timer
    rm -f "$TMP_CS"
    systemctl daemon-reload
    systemctl enable --now biaoxun-collect.timer >/dev/null 2>&1 || warn "启用定时采集失败"
    ok "定时采集已启用（每 2 小时）"
  fi
else
  log "7/7 跳过 systemd（--no-systemd），用下面命令启动："
  echo "  cd $APP_DIR/server && BX_DATA_DIR=$APP_DIR/data BX_STATIC_DIR=$APP_DIR/web \\"
  echo "    .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port $APP_PORT"
fi

log "健康检查"
for _ in $(seq 1 15); do
  if curl -fsS --max-time 3 "http://127.0.0.1:${APP_PORT}/api/health" >/dev/null 2>&1; then
    ok "http://127.0.0.1:${APP_PORT}/api/health 正常"
    break
  fi
  sleep 1
done

if command -v caddy >/dev/null 2>&1; then
  log "检测到 Caddy：如需公网访问，请把 /biaoxun 路由加到 Caddyfile"
  echo "  参考：$APP_DIR/server/deploy/caddy-biaoxun.conf"
  echo "  或执行：python3 $APP_DIR/server/deploy/apply-caddy-subpath.py --reload"
fi

echo
echo "🎉 安装完成：$APP_DIR"
echo "   启动命令（--no-systemd 时）：cd $APP_DIR/server && BX_DATA_DIR=$APP_DIR/data BX_STATIC_DIR=$APP_DIR/web .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port $APP_PORT"
echo "   验收命令（本地）：./server/deploy/verify_deploy.sh --base http://<服务器IP>:$APP_PORT"
