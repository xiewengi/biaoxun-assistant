#!/usr/bin/env bash
# =============================================================================
# 标讯助手 · 一键部署脚本（本地 macOS / Linux 均可执行）
#
# 作用：
#   1. 本地校验 SSH、用 rsync 增量同步代码（自动排除虚拟环境/数据库/缓存）
#   2. 远程安装系统依赖、创建 biaoxun 系统用户、建 venv 装依赖
#   3. 发布前端到 /opt/biaoxun/web，安装 systemd 服务并重启
#   4. 若服务器已装 nginx，自动安装站点配置并 reload；未装则提示安装命令
#   5. 最后执行 /api/health 健康检查
#
# 用法：
#   ./server/deploy/deploy.sh --host 1.2.3.4
#   ./server/deploy/deploy.sh --host biaoxun.example.com --user ubuntu
#   ./server/deploy/deploy.sh --host 1.2.3.4 --identity ~/.ssh/biaoxun_deploy
#   ./server/deploy/deploy.sh --host 1.2.3.4 --port 2222 --app-port 8080
#   ./server/deploy/deploy.sh --host 1.2.3.4 --remote-dir /srv/biaoxun
#   ./server/deploy/deploy.sh 1.2.3.4        # 第一个位置参数等价于 --host
#
# 参数：
#   --host HOST         必填，服务器公网 IP 或域名（暂不支持 IPv6 字面量）
#   --user USER         SSH 登录用户，默认 root（内部变量名 SSH_USER）
#   --port PORT         SSH 端口，默认 22
#   --identity FILE    SSH 私钥文件（默认使用 ssh 的默认密钥）
#   --remote-dir DIR    远程安装目录，默认 /opt/biaoxun
#   --app-port PORT     应用监听端口，默认 8000（systemd 与 nginx 会同步）
#   -h, --help          显示帮助
#
# 说明：
#   - USER 用 --user 传入，是为了避免和本机环境变量 $USER 冲突（$USER 永远有值）。
#   - 推荐 SSH 密钥登录；首次可执行：
#       ssh-copy-id -p 22 root@<服务器IP>
#     若暂时只能用密码，脚本会提示并允许你交互输入密码，后续 rsync/ssh
#     会复用同一条 SSH 连接（ControlMaster），不必反复输入。
#   - 非 root 用户部署需要“免密 sudo”（NOPASSWD），因为 rsync 要以 root 写入
#     /opt/biaoxun；腾讯云 Ubuntu 镜像的 ubuntu 用户通常已满足。
#   - 本脚本不写入任何密码/密钥；数据库、日志、.venv 不会被覆盖。
#   - 幂等：可反复执行，用于首次部署和日常更新。
# =============================================================================

set -euo pipefail
umask 022

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SERVER_DIR="${PROJECT_ROOT}/server"
DEMO_DIR="${PROJECT_ROOT}/demo"

HOST=""
SSH_USER="root"
PORT="22"
IDENTITY=""
REMOTE_DIR="/opt/biaoxun"
APP_PORT="8000"

usage() {
  cat <<'USAGE'
标讯助手一键部署脚本

用法：
  ./server/deploy/deploy.sh --host <IP或域名> [选项]
  ./server/deploy/deploy.sh <IP或域名> [选项]

选项：
  --host HOST         必填，服务器公网 IP 或域名
  --user USER         SSH 登录用户，默认 root
  --port PORT         SSH 端口，默认 22
  --identity FILE     SSH 私钥文件，默认用 ssh 默认密钥（例：~/.ssh/biaoxun_deploy）
  --remote-dir DIR    远程安装目录，默认 /opt/biaoxun
  --app-port PORT     应用监听端口，默认 8000
  -h, --help          显示本帮助

示例：
  ./server/deploy/deploy.sh --host 1.2.3.4
  ./server/deploy/deploy.sh --host biaoxun.example.com --user ubuntu
  ./server/deploy/deploy.sh --host 1.2.3.4 --identity ~/.ssh/biaoxun_deploy
  ./server/deploy/deploy.sh --host 1.2.3.4 --port 2222 --app-port 8080
  ./server/deploy/deploy.sh --host 1.2.3.4 --remote-dir /srv/biaoxun

部署后：
  curl http://127.0.0.1:8000/api/health        # 在服务器上执行
  journalctl -u biaoxun -f                    # 查看服务日志
USAGE
}

info() { echo; echo "▶ $*"; }
ok()   { echo "✅ $*"; }
warn() { echo "⚠️  $*"; }
die()  { echo "❌ $*" >&2; exit 1; }

is_uint() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

# ---------------------------------------------------------------------------
# 1. 解析参数
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --host)
      [[ $# -ge 2 ]] || die "--host 需要一个参数"
      HOST="$2"; shift 2 ;;
    --host=*)
      HOST="${1#*=}"; shift ;;
    --user)
      [[ $# -ge 2 ]] || die "--user 需要一个参数"
      SSH_USER="$2"; shift 2 ;;
    --user=*)
      SSH_USER="${1#*=}"; shift ;;
    --port)
      [[ $# -ge 2 ]] || die "--port 需要一个参数"
      PORT="$2"; shift 2 ;;
    --port=*)
      PORT="${1#*=}"; shift ;;
    --identity)
      [[ $# -ge 2 ]] || die "--identity 需要一个参数"
      IDENTITY="$2"; shift 2 ;;
    --identity=*)
      IDENTITY="${1#*=}"; shift ;;
    --remote-dir)
      [[ $# -ge 2 ]] || die "--remote-dir 需要一个参数"
      REMOTE_DIR="$2"; shift 2 ;;
    --remote-dir=*)
      REMOTE_DIR="${1#*=}"; shift ;;
    --app-port)
      [[ $# -ge 2 ]] || die "--app-port 需要一个参数"
      APP_PORT="$2"; shift 2 ;;
    --app-port=*)
      APP_PORT="${1#*=}"; shift ;;
    -h|--help)
      usage; exit 0 ;;
    --*)
      die "未知参数：$1（用 --help 查看用法）" ;;
    *)
      if [[ -z "$HOST" ]]; then
        HOST="$1"; shift
      else
        die "多余的参数：$1（用 --help 查看用法）"
      fi
      ;;
  esac
done

[[ -n "$HOST" ]] || { usage; die "缺少 --host（服务器 IP 或域名）"; }

if [[ -n "$IDENTITY" ]]; then
  IDENTITY="${IDENTITY/#\~/$HOME}"
  [[ -f "$IDENTITY" ]] || die "私钥文件不存在：$IDENTITY"
  [[ -r "$IDENTITY" ]] || die "私钥文件不可读：$IDENTITY"
fi

# 只允许常规主机名/IP 字符，避免拼接 SSH/rsync 目标时注入
[[ "$HOST" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] \
  || die "HOST 格式不合法：${HOST}（示例：1.2.3.4 或 biaoxun.example.com；暂不支持 IPv6）"
[[ "$SSH_USER" =~ ^[A-Za-z_][A-Za-z0-9_.-]*$ ]] \
  || die "USER 格式不合法：$SSH_USER"
is_uint "$PORT" || die "PORT 必须是数字：$PORT"
PORT=$((10#$PORT))
(( PORT >= 1 && PORT <= 65535 )) || die "PORT 必须在 1-65535 之间：$PORT"
is_uint "$APP_PORT" || die "APP_PORT 必须是数字：$APP_PORT"
APP_PORT=$((10#$APP_PORT))
(( APP_PORT >= 1 && APP_PORT <= 65535 )) || die "APP_PORT 必须在 1-65535 之间：$APP_PORT"

case "$REMOTE_DIR" in
  /) die "REMOTE_DIR 不能是根目录 /" ;;
  /*) ;;
  *) die "REMOTE_DIR 必须是绝对路径：$REMOTE_DIR" ;;
esac
case "$REMOTE_DIR" in
  *..*) die "REMOTE_DIR 不能包含 ..：$REMOTE_DIR" ;;
  *[!A-Za-z0-9._/-]*) die "REMOTE_DIR 只能包含字母、数字、点、下划线、斜杠和短横线：$REMOTE_DIR" ;;
esac
REMOTE_DIR="${REMOTE_DIR%/}"

TARGET="${SSH_USER}@${HOST}"

# ---------------------------------------------------------------------------
# 2. 本地环境检查
# ---------------------------------------------------------------------------
info "1/6 检查本地环境"
command -v ssh   >/dev/null 2>&1 || die "本地缺少 ssh 命令"
command -v rsync >/dev/null 2>&1 || die "本地缺少 rsync 命令（macOS 自带）"
[[ -f "${SERVER_DIR}/app/main.py" ]]      || die "未找到 ${SERVER_DIR}/app/main.py，请在项目根目录内运行"
[[ -f "${SERVER_DIR}/requirements.txt" ]] || die "未找到 ${SERVER_DIR}/requirements.txt"
[[ -f "${DEMO_DIR}/index.html" ]]         || die "未找到 ${DEMO_DIR}/index.html"
[[ -f "${SERVER_DIR}/deploy/biaoxun.service" ]]   || die "未找到 server/deploy/biaoxun.service"
[[ -f "${SERVER_DIR}/deploy/nginx-biaoxun.conf" ]] || die "未找到 server/deploy/nginx-biaoxun.conf"
ok "本地文件齐全，项目根目录：${PROJECT_ROOT}"

TMP_DIR="$(mktemp -d /tmp/biaoxun-deploy.XXXXXX)"
CTRL_SOCK="/tmp/bx-deploy-$$.sock"

cleanup() {
  # 结束 SSH 复用连接并清理临时文件（BatchMode 避免退出时误弹密码提示）
  ssh -O exit -o BatchMode=yes -o ConnectTimeout=3 -o ControlPath="$CTRL_SOCK" "$TARGET" >/dev/null 2>&1 || true
  rm -rf "$TMP_DIR"
  rm -f "$CTRL_SOCK"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# ---------------------------------------------------------------------------
# 3. SSH 连通性（密钥优先；密码登录走交互，并用 ControlMaster 复用连接）
# ---------------------------------------------------------------------------
info "2/6 检查 SSH 连通性：${TARGET}（端口 ${PORT}）"
SSH_OPTS=(
  -p "$PORT"
  ${IDENTITY:+-i "$IDENTITY"}
  -o ConnectTimeout=10
  -o ServerAliveInterval=30
  -o ControlMaster=auto
  -o ControlPath="$CTRL_SOCK"
  -o ControlPersist=600
)

if ssh "${SSH_OPTS[@]}" -o BatchMode=yes "$TARGET" "true" 2>/dev/null; then
  ok "SSH 免密连接正常"
else
  warn "免密登录未配置或失败，改为交互式登录"
  echo "   建议先执行：ssh-copy-id -p ${PORT} ${TARGET}"
  echo "   若继续，请按提示输入 SSH 密码（之后 rsync/ssh 会复用这条连接）"
  ssh "${SSH_OPTS[@]}" "$TARGET" "true" \
    || die "SSH 连接失败：请检查 IP、端口、用户名、密码/密钥、安全组是否放行 ${PORT}"
  ok "SSH 连接成功"
fi

if ! REMOTE_UID="$(ssh "${SSH_OPTS[@]}" "$TARGET" 'id -u')"; then
  die "无法获取远程用户信息，请确认 SSH 权限"
fi

REMOTE_IS_ROOT=0
SUDO_CMD=""
if [[ "$REMOTE_UID" == "0" ]]; then
  REMOTE_IS_ROOT=1
  ok "远程以 root 身份部署"
else
  if ! ssh "${SSH_OPTS[@]}" "$TARGET" "sudo -n true" >/dev/null 2>&1; then
    die "远程用户 ${SSH_USER} 不是 root，且没有免密 sudo。请改用 root，或为该用户配置 NOPASSWD 后重试：
    echo '${SSH_USER} ALL=(ALL) NOPASSWD:ALL' | sudo tee /etc/sudoers.d/biaoxun-deploy
    sudo chmod 440 /etc/sudoers.d/biaoxun-deploy"
  fi
  SUDO_CMD="sudo -n "
  ok "远程用户 ${SSH_USER} 具备免密 sudo，将以 root 权限安装"
fi

# ---------------------------------------------------------------------------
# 4. 远程预检：rsync（后面同步代码、发布前端都要用）
# ---------------------------------------------------------------------------
info "3/6 远程预检依赖（rsync）"
cat > "${TMP_DIR}/bootstrap.sh" <<'BOOTSTRAP'
set -euo pipefail
umask 022

if command -v rsync >/dev/null 2>&1; then
  echo "✅ rsync 已安装：$(command -v rsync)"
  exit 0
fi

echo "▶ 远程缺少 rsync，尝试通过包管理器安装"
if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y rsync
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y rsync
elif command -v yum >/dev/null 2>&1; then
  yum install -y rsync
else
  echo "❌ 未识别包管理器（需要 apt-get / dnf / yum），请手动安装 rsync 后重试" >&2
  exit 1
fi

command -v rsync >/dev/null 2>&1 || { echo "❌ rsync 安装失败" >&2; exit 1; }
echo "✅ rsync 安装完成"
BOOTSTRAP

if [[ "$REMOTE_IS_ROOT" == "1" ]]; then
  ssh "${SSH_OPTS[@]}" "$TARGET" "bash -s" < "${TMP_DIR}/bootstrap.sh" \
    || die "远程 rsync 预检失败，请检查服务器网络/软件源后重试"
else
  ssh "${SSH_OPTS[@]}" "$TARGET" "sudo -n bash -s" < "${TMP_DIR}/bootstrap.sh" \
    || die "远程 rsync 预检失败，请检查服务器网络/软件源后重试"
fi

# ---------------------------------------------------------------------------
# 5. 本地打包 + rsync 同步
#    说明：这里用 rsync 的 --exclude 完成“打包过滤”，避免额外 tar 中间文件；
#          --delete 保证服务器代码与本地一致，但 data/、web/、.venv/ 被排除，
#          不会被删除。
# ---------------------------------------------------------------------------
# 3.5 前端版本号 +0.1（每次 deploy 自动递增，体现迭代节奏）
# ---------------------------------------------------------------------------
info "3.5/6 自动递增前端版本号"
APP_JS="${PROJECT_ROOT}/demo/js/app.js"
if [[ -f "$APP_JS" ]]; then
  # 匹配 ">v数字.数字<"，例如 >v1.0< → >v1.1<，>v1.9< → >v2.0<
  OLD_VER=$(grep -oE '>v[0-9]+\.[0-9]+<' "$APP_JS" | head -1 | sed 's/^>//;s/<$//')
  if [[ -n "$OLD_VER" ]]; then
    NEW_VER=$(awk -v v="${OLD_VER#v}" 'BEGIN{n=split(v,a,"."); printf "v%d.%d", a[1], a[2]+1}')
    sed -i '' "s/>${OLD_VER}</>${NEW_VER}</" "$APP_JS" 2>/dev/null \
      || sed -i "s/>${OLD_VER}</>${NEW_VER}</" "$APP_JS"
    echo "  ${OLD_VER} → ${NEW_VER}"
  else
    echo "  ⚠ 未找到页脚版本号（格式应为 >vN.N<），跳过"
  fi
else
  echo "  ⚠ ${APP_JS} 不存在，跳过"
fi

info "4/6 同步代码到 ${TARGET}:${REMOTE_DIR}"

if ! ssh "${SSH_OPTS[@]}" "$TARGET" "${SUDO_CMD}mkdir -p '${REMOTE_DIR}'"; then
  die "远程创建目录失败：${REMOTE_DIR}（请检查权限/磁盘空间）"
fi

RSYNC_EXCLUDES=(
  --exclude '.git/'
  --exclude '.venv/'
  --exclude 'venv/'
  --exclude '__pycache__/'
  --exclude '*.pyc'
  --exclude '.pytest_cache/'
  --exclude 'node_modules/'
  --exclude '.pw-browsers/'
  --exclude '.DS_Store'
  --exclude '.memory'
  --exclude 'collector/_ocr/'
  --exclude 'pylibs/'
  --exclude '/server/data/'
  --exclude '/data/'
  --exclude '/web/'
  --exclude '/backup/'
  --exclude '/backup.sh'
  --exclude '*.db'
  --exclude '*.db-shm'
  --exclude '*.db-wal'
  --exclude '*.log'
  # 只同步运行所需目录，避免把本地文档/截图/发布包/单文件 Demo 搬到服务器
  --exclude '/docs/'
  --exclude '/scripts/'
  --exclude '/screenshots/'
  --exclude '/dist/'
  --exclude '/相关文档/'
  --exclude '/标讯助手demo.html'
  --exclude '/announcements.json'
  --exclude '/package.json'
  --exclude '/package-lock.json'
  --exclude '/.gitignore'
)

RSYNC_SSH="ssh -p ${PORT} -o ConnectTimeout=10 -o ControlMaster=auto -o ControlPath=${CTRL_SOCK} -o ControlPersist=600${IDENTITY:+ -i ${IDENTITY}}"
RSYNC_CMD=(rsync -azh --delete "${RSYNC_EXCLUDES[@]}" -e "$RSYNC_SSH")
if [[ "$REMOTE_IS_ROOT" != "1" ]]; then
  RSYNC_CMD+=(--rsync-path="sudo -n rsync")
fi
RSYNC_CMD+=("${PROJECT_ROOT}/" "${TARGET}:${REMOTE_DIR}/")

if ! "${RSYNC_CMD[@]}"; then
  die "rsync 同步失败：请检查远程磁盘空间、${REMOTE_DIR} 权限、SELinux 是否拦截"
fi
ok "代码已同步（已排除 .venv / __pycache__ / data / .git / node_modules / .pw-browsers / *.db）"

# ---------------------------------------------------------------------------
# 6. 生成远程安装脚本（通过 stdin 交给远端 bash 执行，不在磁盘留脚本）
# ---------------------------------------------------------------------------
{
  printf '# 由 deploy.sh 生成，请勿手工修改\n'
  printf 'REMOTE_DIR=%q\n' "$REMOTE_DIR"
  printf 'APP_PORT=%q\n' "$APP_PORT"
  printf 'APP_USER=%q\n' "biaoxun"
  if [[ -n "${PIP_INDEX_URL:-}" ]]; then
    printf 'PIP_INDEX_URL=%q\n' "$PIP_INDEX_URL"
  fi
  cat <<'REMOTE_SCRIPT'
set -euo pipefail
umask 022

log()  { echo; echo "▶ $*"; }
ok()   { echo "✅ $*"; }
warn() { echo "⚠️  $*"; }
die()  { echo "❌ $*" >&2; exit 1; }
trap 'echo "❌ 远程脚本执行失败（第 ${LINENO} 行）：${BASH_COMMAND}" >&2' ERR

# 可选 pip 镜像（本地执行时：PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple ./deploy.sh ...）
PIP_ARGS=()
if [[ -n "${PIP_INDEX_URL:-}" ]]; then
  PIP_ARGS=(--index-url "$PIP_INDEX_URL")
fi

[[ "$(id -u)" == "0" ]] || die "远程脚本必须以 root 运行"
command -v systemctl >/dev/null 2>&1 || die "未检测到 systemd，本脚本只支持 systemd 系统"

# ---------------------------------------------------------------------------
# 6.1 检测包管理器
# ---------------------------------------------------------------------------
if command -v apt-get >/dev/null 2>&1; then
  PKG="apt"
elif command -v dnf >/dev/null 2>&1; then
  PKG="dnf"
elif command -v yum >/dev/null 2>&1; then
  PKG="yum"
else
  die "未识别的包管理器（需要 apt-get / dnf / yum），请手动安装 Python3.9+ 后重试"
fi

case "$PKG" in
  apt)   DISTRO_HINT="Ubuntu/Debian" ;;
  dnf|yum) DISTRO_HINT="CentOS/RHEL 系" ;;
esac
log "系统：${DISTRO_HINT}，包管理器：${PKG}"

# ---------------------------------------------------------------------------
# 6.2 确保 python3 存在且版本 >= 3.9
# ---------------------------------------------------------------------------
if ! command -v python3 >/dev/null 2>&1; then
  log "安装 python3"
  case "$PKG" in
    apt)
      export DEBIAN_FRONTEND=noninteractive
      apt-get update
      apt-get install -y python3
      ;;
    dnf|yum)
      "$PKG" install -y python3
      ;;
  esac
fi
command -v python3 >/dev/null 2>&1 || die "python3 安装失败，请手动安装 Python 3.9+"

PYTHON_BIN="$(command -v python3)"
if ! "$PYTHON_BIN" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' >/dev/null 2>&1; then
  die "远程 Python 版本过低：$("$PYTHON_BIN" --version 2>&1)（需要 >= 3.9）。
    CentOS 7 自带 Python 3.6，请升级到 Ubuntu 22.04 / CentOS Stream 9，或单独安装 Python 3.9+ 后调整 systemd 的 ExecStart。"
fi
ok "Python：$("$PYTHON_BIN" --version 2>&1)"

# ---------------------------------------------------------------------------
# 6.3 安装 python3-venv / python3-pip / rsync（已有则跳过）
# ---------------------------------------------------------------------------
NEED_VENV=0
NEED_PIP=0
NEED_RSYNC=0
"$PYTHON_BIN" -c 'import venv, ensurepip' >/dev/null 2>&1 || NEED_VENV=1
"$PYTHON_BIN" -m pip --version >/dev/null 2>&1 || NEED_PIP=1
command -v rsync >/dev/null 2>&1 || NEED_RSYNC=1

if (( NEED_VENV + NEED_PIP + NEED_RSYNC > 0 )); then
  log "安装系统依赖（venv=${NEED_VENV} pip=${NEED_PIP} rsync=${NEED_RSYNC}）"
  if [[ "$PKG" == "apt" ]]; then
    export DEBIAN_FRONTEND=noninteractive
    PKGS=""
    if (( NEED_VENV ));  then PKGS="$PKGS python3-venv"; fi
    if (( NEED_PIP ));   then PKGS="$PKGS python3-pip";  fi
    if (( NEED_RSYNC )); then PKGS="$PKGS rsync";        fi
    apt-get update
    # shellcheck disable=SC2086
    apt-get install -y $PKGS
  else
    PKGS=""
    if (( NEED_VENV ));  then PKGS="$PKGS python3";     fi
    if (( NEED_PIP ));   then PKGS="$PKGS python3-pip"; fi
    if (( NEED_RSYNC )); then PKGS="$PKGS rsync";       fi
    if [[ -n "$PKGS" ]]; then
      # shellcheck disable=SC2086
      "$PKG" install -y $PKGS
    fi
    if (( NEED_VENV )); then
      warn "RHEL/CentOS 的 venv 通常随 python3 提供；若下面校验失败，请安装完整的 python3 包"
    fi
  fi
else
  ok "python3-venv / python3-pip / rsync 已齐全，跳过安装"
fi

"$PYTHON_BIN" -c 'import venv, ensurepip' >/dev/null 2>&1 \
  || die "Python 缺少 venv/ensurepip。Ubuntu/Debian 请装 python3-venv；CentOS/RHEL 请装完整 python3 包"
"$PYTHON_BIN" -m pip --version >/dev/null 2>&1 \
  || die "pip 不可用，请安装 python3-pip 后重试"
command -v rsync >/dev/null 2>&1 || die "rsync 不可用，请手动安装后重试"

# ---------------------------------------------------------------------------
# 6.4 创建 biaoxun 系统用户（存在则跳过）
# ---------------------------------------------------------------------------
group_exists() {
  getent group "$1" >/dev/null 2>&1 || grep -q "^$1:" /etc/group 2>/dev/null
}

if group_exists "$APP_USER"; then
  ok "用户组 ${APP_USER} 已存在，跳过创建"
else
  log "创建用户组 ${APP_USER}"
  groupadd -r "$APP_USER"
fi

if id -u "$APP_USER" >/dev/null 2>&1; then
  ok "系统用户 ${APP_USER} 已存在，跳过创建"
else
  log "创建系统用户 ${APP_USER}"
  NOLOGIN=/bin/false
  if [[ -x /usr/sbin/nologin ]]; then
    NOLOGIN=/usr/sbin/nologin
  elif [[ -x /sbin/nologin ]]; then
    NOLOGIN=/sbin/nologin
  fi
  useradd -r -g "$APP_USER" -d "$REMOTE_DIR" -s "$NOLOGIN" "$APP_USER"
fi

as_app() {
  if command -v runuser >/dev/null 2>&1; then
    runuser -u "$APP_USER" -- "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo -u "$APP_USER" -- "$@"
  else
    die "缺少 runuser/sudo，无法以 ${APP_USER} 身份执行命令"
  fi
}

# ---------------------------------------------------------------------------
# 6.5 目录准备 + 权限
# ---------------------------------------------------------------------------
log "准备目录与权限"
[[ -d "$REMOTE_DIR/server" ]] || die "未找到 $REMOTE_DIR/server，代码同步可能失败"
install -d -m 755 "$REMOTE_DIR"
install -d -m 750 -o "$APP_USER" -g "$APP_USER" "$REMOTE_DIR/data"
chown -R "$APP_USER:$APP_USER" "$REMOTE_DIR/server"
[[ -d "$REMOTE_DIR/demo" ]] && chown -R "$APP_USER:$APP_USER" "$REMOTE_DIR/demo"
# rsync 会保留本地 uid，collector 也必须归 biaoxun，否则采集器依赖安装/运行失败
[[ -d "$REMOTE_DIR/collector" ]] && chown -R "$APP_USER:$APP_USER" "$REMOTE_DIR/collector"
ok "目录就绪：$REMOTE_DIR / data / server"

# ---------------------------------------------------------------------------
# 6.6 创建/复用 venv，安装 requirements.txt
# ---------------------------------------------------------------------------
VENV="$REMOTE_DIR/server/.venv"
log "准备 Python 虚拟环境：$VENV"
if [[ -x "$VENV/bin/python" ]] && "$VENV/bin/python" -c 'import sys' >/dev/null 2>&1; then
  ok "虚拟环境已存在，复用"
else
  if [[ -e "$VENV" ]]; then
    warn "检测到损坏的虚拟环境，重新创建"
    rm -rf "$VENV"
  fi
  as_app env HOME="$REMOTE_DIR/data" PIP_NO_CACHE_DIR=1 \
    "$PYTHON_BIN" -m venv "$VENV" \
    || die "创建 venv 失败：请确认 python3-venv 已安装、$REMOTE_DIR 磁盘可写"
  ok "虚拟环境创建完成"
fi
chown -R "$APP_USER:$APP_USER" "$VENV"

log "安装 Python 依赖（requirements.txt）"
as_app env HOME="$REMOTE_DIR/data" PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 \
  "$VENV/bin/python" -m pip install "${PIP_ARGS[@]}" -r "$REMOTE_DIR/server/requirements.txt" \
  || die "pip 安装失败：请检查服务器到 PyPI 的网络；国内可用清华源（见 deploy/README.md）"
ok "Python 依赖安装完成"

# 6.6b 采集器依赖（可选）：/api/collect 用同一个 venv 跑 collector/collect.py。
# 失败不阻断主站，只影响「刷新抓取」按钮。
if [[ -f "$REMOTE_DIR/collector/requirements.txt" ]]; then
  log "安装采集器依赖（collector/requirements.txt，可选）"
  if as_app env HOME="$REMOTE_DIR/data" PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 \
       "$VENV/bin/python" -m pip install "${PIP_ARGS[@]}" -r "$REMOTE_DIR/collector/requirements.txt" \
       >/tmp/biaoxun-pip-collector.log 2>&1; then
    ok "采集器依赖安装完成"
  else
    warn "采集器依赖安装失败（不影响主站，/api/collect 可能不可用）：tail -n 30 /tmp/biaoxun-pip-collector.log"
  fi
fi

# ---------------------------------------------------------------------------
# 6.7 发布前端：demo/ -> web/
# ---------------------------------------------------------------------------
log "发布前端：$REMOTE_DIR/demo/ -> $REMOTE_DIR/web/"
[[ -d "$REMOTE_DIR/demo" ]] || die "未找到 $REMOTE_DIR/demo，无法发布前端"
install -d -m 755 "$REMOTE_DIR/web"
rsync -a --delete --exclude '.DS_Store' "$REMOTE_DIR/demo/" "$REMOTE_DIR/web/" \
  || die "复制前端失败（demo -> web）"
[[ -f "$REMOTE_DIR/web/index.html" ]] || die "发布后未找到 $REMOTE_DIR/web/index.html"
chown -R "$APP_USER:$APP_USER" "$REMOTE_DIR/web"
ok "前端已发布到 $REMOTE_DIR/web"

# seed 需要 demo/data 与 collector/sources.json，缺失时只提示，不阻断
if [[ ! -f "$REMOTE_DIR/demo/data/announcements.json" ]]; then
  warn "缺少 demo/data/announcements.json，首次启动将没有种子公告"
fi
if [[ ! -f "$REMOTE_DIR/collector/sources.json" ]]; then
  warn "缺少 collector/sources.json，首次启动将没有种子数据源"
fi

# 先以 biaoxun 身份做一次导入检查；全新环境再预初始化数据库，
# 避免多个 uvicorn worker 在首次启动时同时建表/灌种子产生 SQLite 竞争。
log "预检查应用导入"
if ! (
  cd "$REMOTE_DIR/server"
  as_app env HOME="$REMOTE_DIR/data" BX_DATA_DIR="$REMOTE_DIR/data" BX_STATIC_DIR="$REMOTE_DIR/web" \
    "$VENV/bin/python" -c 'import app.main; print("应用导入正常")'
); then
  die "应用导入失败：请检查 Python 依赖、app/ 代码是否完整（日志见上）"
fi

if [[ ! -s "$REMOTE_DIR/data/biaoxun.db" ]]; then
  log "首次部署：预初始化数据库与种子数据"
  if ! (
    cd "$REMOTE_DIR/server"
    as_app env HOME="$REMOTE_DIR/data" BX_DATA_DIR="$REMOTE_DIR/data" BX_STATIC_DIR="$REMOTE_DIR/web" \
      "$VENV/bin/python" -c 'from app import seed; print("种子数据：", seed.run_seed())'
  ); then
    die "数据库初始化失败：请检查 $REMOTE_DIR/data 权限和 demo/collector 种子文件"
  fi
  chown -R "$APP_USER:$APP_USER" "$REMOTE_DIR/data"
fi

# ---------------------------------------------------------------------------
# 6.8 安装 systemd 单元
# ---------------------------------------------------------------------------
log "安装 systemd 服务：biaoxun.service"
UNIT_SRC="$REMOTE_DIR/server/deploy/biaoxun.service"
[[ -f "$UNIT_SRC" ]] || die "未找到 $UNIT_SRC"
if [[ -f /etc/systemd/system/biaoxun.service ]]; then
  cp -a /etc/systemd/system/biaoxun.service /etc/systemd/system/biaoxun.service.bak
  ok "旧单元已备份到 /etc/systemd/system/biaoxun.service.bak"
fi
TMP_UNIT="$(mktemp /tmp/biaoxun.service.XXXXXX)"
sed -e "s#/opt/biaoxun#${REMOTE_DIR}#g" \
    -e "s#127.0.0.1:8000#127.0.0.1:${APP_PORT}#g" \
    "$UNIT_SRC" > "$TMP_UNIT"
grep -q "ExecStart=${REMOTE_DIR}/server/.venv/bin/uvicorn" "$TMP_UNIT" \
  || die "systemd 单元路径替换失败，请检查 biaoxun.service 模板"
install -m 644 "$TMP_UNIT" /etc/systemd/system/biaoxun.service
rm -f "$TMP_UNIT"

systemctl daemon-reload
systemctl enable biaoxun >/dev/null 2>&1 || warn "systemctl enable biaoxun 失败，请检查 systemd 状态"
systemctl restart biaoxun

for _ in $(seq 1 10); do
  if systemctl is-active --quiet biaoxun; then
    break
  fi
  sleep 1
done
if ! systemctl is-active --quiet biaoxun; then
  warn "biaoxun 服务未处于 active，最近日志："
  journalctl -u biaoxun -n 60 --no-pager || true
  die "服务启动失败，请根据上面的日志修复后重试"
fi
ok "biaoxun 服务已启动"

# 6.8b 定时采集（systemd timer，每 2 小时）
COLLECT_SVC_SRC="$REMOTE_DIR/server/deploy/biaoxun-collect.service"
COLLECT_TIMER_SRC="$REMOTE_DIR/server/deploy/biaoxun-collect.timer"
if [[ -f "$COLLECT_SVC_SRC" && -f "$COLLECT_TIMER_SRC" ]]; then
  log "安装定时采集任务"
  TMP_CS="$(mktemp /tmp/biaoxun-collect.service.XXXXXX)"
  TMP_CT="$(mktemp /tmp/biaoxun-collect.timer.XXXXXX)"
  sed -e "s#/opt/biaoxun#${REMOTE_DIR}#g" "$COLLECT_SVC_SRC" > "$TMP_CS"
  cp "$COLLECT_TIMER_SRC" "$TMP_CT"
  install -m 644 "$TMP_CS" /etc/systemd/system/biaoxun-collect.service
  install -m 644 "$TMP_CT" /etc/systemd/system/biaoxun-collect.timer
  rm -f "$TMP_CS" "$TMP_CT"
  systemctl daemon-reload
  systemctl enable --now biaoxun-collect.timer >/dev/null 2>&1 \
    || warn "启用 biaoxun-collect.timer 失败，请检查 systemd"
  ok "定时采集已启用（每 2 小时，systemctl list-timers 可查看）"
else
  warn "未找到定时采集单元文件，跳过（手动：python -m app.cli collect）"
fi

# ---------------------------------------------------------------------------
# 6.9 配置 nginx（存在才配置；不存在只给安装命令）
# ---------------------------------------------------------------------------
if command -v nginx >/dev/null 2>&1; then
  log "配置 nginx 反向代理"

  if [[ -d /etc/nginx/conf.d ]]; then
    NGINX_DEST=/etc/nginx/conf.d/biaoxun.conf
  elif [[ -d /etc/nginx/sites-available ]]; then
    NGINX_DEST=/etc/nginx/sites-available/biaoxun.conf
  else
    mkdir -p /etc/nginx/conf.d
    NGINX_DEST=/etc/nginx/conf.d/biaoxun.conf
  fi

  # 发行版默认站点会抢占 80 端口的默认 server，先禁用
  if [[ -e /etc/nginx/sites-enabled/default ]]; then
    rm -f /etc/nginx/sites-enabled/default
    ok "已禁用 Ubuntu/Debian 默认站点（sites-enabled/default）"
  fi
  if [[ -f /etc/nginx/conf.d/default.conf ]]; then
    mv /etc/nginx/conf.d/default.conf /etc/nginx/conf.d/default.conf.disabled
    ok "已禁用 CentOS/RHEL 默认站点（重命名为 default.conf.disabled）"
  fi

  # certbot --nginx 会改写这个文件；检测到托管标记就跳过，避免覆盖 HTTPS 配置
  NGINX_INSTALLED=0
  if [[ -f "$NGINX_DEST" ]] && grep -q "managed by Certbot" "$NGINX_DEST" 2>/dev/null; then
    warn "检测到 Certbot 管理的 nginx 配置，跳过覆盖以保护 HTTPS；如需更新模板请手动合并"
  else
    if [[ -f "$NGINX_DEST" ]]; then
      cp -a "$NGINX_DEST" "${NGINX_DEST}.bak"
      ok "旧 nginx 配置已备份到 ${NGINX_DEST}.bak"
    fi
    TMP_NGINX="$(mktemp /tmp/biaoxun.nginx.XXXXXX)"
    sed -e "s#127.0.0.1:8000#127.0.0.1:${APP_PORT}#g" \
      "$REMOTE_DIR/server/deploy/nginx-biaoxun.conf" > "$TMP_NGINX"
    install -m 644 "$TMP_NGINX" "$NGINX_DEST"
    rm -f "$TMP_NGINX"
    NGINX_INSTALLED=1

    if [[ "$NGINX_DEST" == /etc/nginx/sites-available/* ]]; then
      ln -sf "$NGINX_DEST" /etc/nginx/sites-enabled/biaoxun.conf
    fi
    ok "nginx 站点配置已安装：$NGINX_DEST"
  fi

  if ! nginx -t; then
    if [[ "$NGINX_INSTALLED" == "1" ]]; then
      if [[ -f "${NGINX_DEST}.bak" ]]; then
        mv "${NGINX_DEST}.bak" "$NGINX_DEST"
        warn "nginx 配置校验失败，已恢复备份 ${NGINX_DEST}.bak"
      else
        rm -f "$NGINX_DEST"
        warn "nginx 配置校验失败，已移除新配置 $NGINX_DEST"
      fi
    fi
    die "请根据上面的 nginx 报错修复（常见：80 端口被占用、server_name 冲突）"
  fi

  if systemctl is-active --quiet nginx 2>/dev/null; then
    systemctl reload nginx || die "nginx reload 失败，请执行 nginx -t 和 systemctl status nginx 排查"
  else
    systemctl enable nginx >/dev/null 2>&1 || true
    systemctl start nginx || die "nginx 启动失败，请执行 journalctl -u nginx -n 100 排查"
  fi
  ok "nginx 已加载配置并运行"
else
  if command -v caddy >/dev/null 2>&1; then
    warn "未安装 nginx，但检测到 Caddy：跳过 nginx，避免与 Caddy 抢 80/443"
    echo "   标讯助手仍监听 127.0.0.1:${APP_PORT}，请在 Caddyfile 中加 /biaoxun 子路径（见 6.9b 提示）"
  else
    warn "未检测到 nginx，已跳过反向代理配置（应用仍监听 127.0.0.1:${APP_PORT}）"
    echo "   安装 nginx 后重新执行本脚本即可自动配置："
    echo "   Ubuntu/Debian：sudo apt-get update && sudo apt-get install -y nginx"
    echo "   CentOS/RHEL：  sudo dnf install -y nginx   # 老系统用 yum"
  fi
fi

# ---------------------------------------------------------------------------
# 6.9b 检测 Caddy（若 80/443 已被 Caddy 占用，nginx 通常没装，需要子路径路由）
if command -v caddy >/dev/null 2>&1; then
  log "检测到 Caddy（80/443 可能由它托管）"
  CADDYFILE=""
  for candidate in /etc/caddy/Caddyfile /usr/local/etc/caddy/Caddyfile; do
    [[ -f "$candidate" ]] && CADDYFILE="$candidate" && break
  done
  if [[ -n "$CADDYFILE" ]]; then
    if grep -q "/biaoxun" "$CADDYFILE" 2>/dev/null; then
      ok "Caddyfile 已包含 /biaoxun 路由"
    else
      warn "Caddyfile 尚未配置 /biaoxun 子路径，标讯助手暂不会对外可访问"
      echo "   参考片段：$REMOTE_DIR/server/deploy/caddy-biaoxun.conf"
      echo "   操作建议：备份 $CADDYFILE 后把 handle_path 段插入现有 site 块，再执行："
      echo "     caddy validate --config $CADDYFILE && systemctl reload caddy"
    fi
  else
    warn "找到 caddy 命令但没找到 Caddyfile，请手工确认 80/443 由谁监听"
  fi
fi

# 6.10 SELinux / firewalld 提示
# ---------------------------------------------------------------------------
if command -v getenforce >/dev/null 2>&1 && [[ "$(getenforce)" == "Enforcing" ]]; then
  log "检测到 SELinux Enforcing，放行 nginx 访问本机后端"
  if command -v setsebool >/dev/null 2>&1; then
    setsebool -P httpd_can_network_connect 1 || warn "setsebool 执行失败，请手动执行：setsebool -P httpd_can_network_connect 1"
    ok "已设置 httpd_can_network_connect=1"
  else
    warn "缺少 setsebool，请安装 policycoreutils-python-utils 后执行：setsebool -P httpd_can_network_connect 1"
  fi
fi

if command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld 2>/dev/null; then
  warn "firewalld 正在运行；如需公网访问 80/443，请执行："
  echo "   firewall-cmd --permanent --add-service=http"
  echo "   firewall-cmd --permanent --add-service=https"
  echo "   firewall-cmd --reload"
fi

# ---------------------------------------------------------------------------
# 6.11 健康检查
# ---------------------------------------------------------------------------
log "健康检查"
echo "   curl http://127.0.0.1:${APP_PORT}/api/health"
HEALTH_OK=0
if command -v curl >/dev/null 2>&1; then
  for (( i = 1; i <= 20; i++ )); do
    if BODY="$(curl -fsS --max-time 2 "http://127.0.0.1:${APP_PORT}/api/health" 2>/dev/null)"; then
      echo "   ${BODY}"
      HEALTH_OK=1
      break
    fi
    sleep 1
  done
else
  for (( i = 1; i <= 20; i++ )); do
    if "$VENV/bin/python" -c "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:${APP_PORT}/api/health', timeout=3).read().decode())"; then
      HEALTH_OK=1
      break
    fi
    sleep 1
  done
fi

if [[ "$HEALTH_OK" != "1" ]]; then
  warn "健康检查未通过，最近日志："
  journalctl -u biaoxun -n 80 --no-pager || true
  die "服务未响应 /api/health，请根据日志排查（端口占用、依赖、数据库权限等）"
fi

if [[ -f "$REMOTE_DIR/data/biaoxun.db" ]]; then
  ok "数据库已就绪：$REMOTE_DIR/data/biaoxun.db"
else
  warn "暂未发现 $REMOTE_DIR/data/biaoxun.db，首次请求/启动完成后应自动创建"
fi

echo
echo "✅ 远程部署完成"
echo "   服务状态：systemctl status biaoxun"
echo "   实时日志：journalctl -u biaoxun -f"
echo "   健康检查：curl http://127.0.0.1:${APP_PORT}/api/health"
echo "   数据文件：${REMOTE_DIR}/data/biaoxun.db"
REMOTE_SCRIPT
} > "${TMP_DIR}/remote.sh"

# ---------------------------------------------------------------------------
# 7. 执行远程安装脚本
# ---------------------------------------------------------------------------
info "5/6 远程安装依赖、配置服务与 nginx（可能需要几分钟）"
if [[ "$REMOTE_IS_ROOT" == "1" ]]; then
  if ! ssh "${SSH_OPTS[@]}" "$TARGET" "bash -s" < "${TMP_DIR}/remote.sh"; then
    die "远程部署失败，请根据上面的日志修复后重跑本脚本（脚本幂等）"
  fi
else
  if ! ssh "${SSH_OPTS[@]}" "$TARGET" "sudo -n bash -s" < "${TMP_DIR}/remote.sh"; then
    die "远程部署失败，请根据上面的日志修复后重跑本脚本（脚本幂等）"
  fi
fi

# ---------------------------------------------------------------------------
# 8. 本地汇总
# ---------------------------------------------------------------------------
info "6/6 完成"
cat <<EOF

============================================================
✅ 标讯助手部署流程完成
   服务器    ：${TARGET}
   安装目录  ：${REMOTE_DIR}
   应用端口  ：${APP_PORT}（仅监听 127.0.0.1，通常由 nginx 对外）
   健康检查  ：curl http://127.0.0.1:${APP_PORT}/api/health
   服务日志  ：ssh -p ${PORT} ${TARGET} 'journalctl -u biaoxun -f'
   数据文件  ：${REMOTE_DIR}/data/biaoxun.db
============================================================

下一步：
  1) 若刚才提示未装 nginx：按提示安装后重新执行本脚本。
  2) 腾讯云安全组放行 22/80/443；用域名访问前先完成 ICP 备案。
  3) 浏览器打开 http://<服务器公网IP>/ 验证（无 nginx 时见 README 的测试方案）。
  4) 详细部署/备份/回滚/排障见 server/deploy/README.md。
EOF
