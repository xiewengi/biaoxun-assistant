#!/usr/bin/env bash
# =============================================================================
# 标讯助手 · 部署前置检查（在腾讯云服务器上执行，只读，不改任何东西）
#
# 用法：
#   bash server/deploy/preflight.sh
#   # 或把本文件单独 scp 到服务器执行
#
# 输出：系统版本、Python 版本、systemd/nginx 状态、端口占用、磁盘、内存、
#       当前用户与 sudo 权限、时区、防火墙。把输出发给部署人员即可。
# =============================================================================
set -uo pipefail

line() { printf '\n===== %s =====\n' "$1"; }

line "系统"
uname -a 2>/dev/null || true
if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  echo "发行版：${PRETTY_NAME:-$NAME $VERSION_ID}"
fi
echo "主机名：$(hostname 2>/dev/null || echo '?')"
echo "时区：$(date '+%Y-%m-%d %H:%M:%S %Z (%z)')"

line "登录用户与权限"
echo "当前用户：$(id -un)（uid=$(id -u)）"
if [[ "$(id -u)" -eq 0 ]]; then
  echo "身份：root"
elif sudo -n true 2>/dev/null; then
  echo "身份：非 root，但已配置免密 sudo ✅"
else
  echo "身份：非 root，且没有免密 sudo ❌（部署脚本需要 root 或 NOPASSWD sudo）"
fi

line "Python"
if command -v python3 >/dev/null 2>&1; then
  echo "python3：$(command -v python3)"
  python3 -V
  python3 - <<'PY' 2>/dev/null || true
import sys
ok = sys.version_info >= (3, 9)
print("版本要求 >=3.9：", "✅" if ok else "❌ 请升级")
PY
else
  echo "❌ 未安装 python3"
fi
command -v python3.11 >/dev/null 2>&1 && echo "python3.11：$(python3.11 -V 2>&1)"
command -v python3.12 >/dev/null 2>&1 && echo "python3.12：$(python3.12 -V 2>&1)"

line "systemd / nginx / rsync"
if command -v systemctl >/dev/null 2>&1; then
  echo "systemctl：$(command -v systemctl)（$(ps -p 1 -o comm= 2>/dev/null || echo '?')）"
else
  echo "❌ 没有 systemctl（容器环境？部署脚本的 systemd 部分会失败）"
fi
if command -v nginx >/dev/null 2>&1; then
  echo "nginx：$(command -v nginx)（$(nginx -v 2>&1)）"
  (systemctl is-active nginx 2>/dev/null && echo "nginx 状态：active") || true
else
  echo "nginx：未安装（部署脚本会给出安装命令，不会擅自装）"
fi
command -v rsync >/dev/null 2>&1 && echo "rsync：$(command -v rsync)" || echo "rsync：未安装（部署脚本会自动装）"

line "端口占用（22 / 80 / 443 / 8000）"
if command -v ss >/dev/null 2>&1; then
  ss -lntp 2>/dev/null | awk 'NR==1 || $4 ~ /:(22|80|443|8000)$/'
elif command -v netstat >/dev/null 2>&1; then
  netstat -lntp 2>/dev/null | awk 'NR<=2 || $4 ~ /:(22|80|443|8000)$/'
else
  echo "没有 ss/netstat，跳过"
fi

line "磁盘与内存"
df -h / 2>/dev/null | tail -2 || true
df -h /opt 2>/dev/null | tail -1 || true
free -h 2>/dev/null || vm_stat 2>/dev/null | head -5 || true

line "防火墙"
if command -v firewall-cmd >/dev/null 2>&1; then
  echo "firewalld：$(systemctl is-active firewalld 2>/dev/null || echo unknown)"
  firewall-cmd --list-ports 2>/dev/null || true
elif command -v ufw >/dev/null 2>&1; then
  ufw status 2>/dev/null | head -10 || true
else
  echo "未检测到 firewalld / ufw"
fi
echo "（腾讯云安全组在控制台查看，本脚本看不到）"

line "已有的 /opt/biaoxun"
if [[ -d /opt/biaoxun ]]; then
  ls -la /opt/biaoxun 2>/dev/null | head -15
  if [[ -f /opt/biaoxun/data/biaoxun.db ]]; then
    echo "已存在数据库：$(du -h /opt/biaoxun/data/biaoxun.db | cut -f1)"
  fi
  systemctl status biaoxun --no-pager 2>/dev/null | head -6 || true
else
  echo "目录不存在（全新部署）"
fi

line "完成"
echo "把以上输出整段发给部署人员即可。本脚本没有任何写操作。"
