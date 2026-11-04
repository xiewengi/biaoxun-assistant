#!/usr/bin/env bash
# =============================================================================
# 标讯助手 · 把 Caddy 根路径切换为标讯助手（替换掉原来的站点）
#
# 安全措施：
#   1. 改之前备份 /etc/caddy/Caddyfile；
#   2. 把旧站点线索（root / reverse_proxy / file_server 行）另存一份，便于清理旧文件；
#   3. 新配置先 caddy validate，不通过就不替换；
#   4. reload 后服务异常会自动回滚并重新 reload。
#
# 用法（服务器 root）：
#   bash switch-caddy-root.sh --dry-run        # 只打印新配置，不改
#   bash switch-caddy-root.sh                  # HTTPS（自签证书）
#   bash switch-caddy-root.sh --http-only      # 纯 HTTP，不弹证书警告
#   bash switch-caddy-root.sh --app-port 8000 --site-host <服务器IP>
#
# 注意：本脚本不会删除旧站点文件，只切换路由；确认新站正常后再手工清理。
# =============================================================================
set -euo pipefail

CADDYFILE="/etc/caddy/Caddyfile"
APP_PORT="8000"
SITE_HOST=""
HTTP_ONLY=0
DRY_RUN=0
FORCE=0
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log()  { echo; echo "▶ $*"; }
ok()   { echo "✅ $*"; }
warn() { echo "⚠️  $*"; }
die()  { echo "❌ $*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --caddyfile) CADDYFILE="${2:-}"; shift 2 ;;
    --caddyfile=*) CADDYFILE="${1#*=}"; shift ;;
    --app-port) APP_PORT="${2:-}"; shift 2 ;;
    --app-port=*) APP_PORT="${1#*=}"; shift ;;
    --site-host) SITE_HOST="${2:-}"; shift 2 ;;
    --site-host=*) SITE_HOST="${1#*=}"; shift ;;
    --http-only) HTTP_ONLY=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "未知参数：$1" ;;
  esac
done

if [[ "$DRY_RUN" != "1" ]]; then
  [[ "$(id -u)" -eq 0 ]] || die "需要 root 执行"
  [[ -f "$CADDYFILE" ]] || die "找不到 $CADDYFILE"
  command -v caddy >/dev/null 2>&1 || die "找不到 caddy 命令"
fi
[[ -d /opt/biaoxun ]] || [[ "$FORCE" == "1" ]] || die "未发现 /opt/biaoxun（应用还没部署？确认后加 --force）"

if [[ "$HTTP_ONLY" == "1" ]]; then
  NEW_CONFIG="$(mktemp /tmp/biaoxun.caddy.http.XXXXXX)"
  cat > "$NEW_CONFIG" <<EOF
# 标讯助手（由 switch-caddy-root.sh 生成，纯 HTTP）
:80 {
	encode gzip
	reverse_proxy 127.0.0.1:${APP_PORT} {
		header_up X-Real-IP {remote_host}
	}
}
EOF
else
  NEW_CONFIG="$(mktemp /tmp/biaoxun.caddy.https.XXXXXX)"
  if [[ -n "$SITE_HOST" ]]; then
    sed -e "s#127.0.0.1:8000#127.0.0.1:${APP_PORT}#g" \
        -e "s#__SITE_HOST__#${SITE_HOST}#g" \
        "$SCRIPT_DIR/caddy-root.conf" > "$NEW_CONFIG"
  else
    sed -e "s#127.0.0.1:8000#127.0.0.1:${APP_PORT}#g" \
        -e "s#https://__SITE_HOST__#:443#g" \
        -e "s#__SITE_HOST__#localhost#g" \
        "$SCRIPT_DIR/caddy-root.conf" > "$NEW_CONFIG"
  fi
fi

log "新 Caddy 配置"
cat "$NEW_CONFIG"

if [[ "$DRY_RUN" == "1" ]]; then
  echo
  echo "（--dry-run：未改动 ${CADDYFILE}）"
  rm -f "$NEW_CONFIG"
  exit 0
fi

log "校验新配置"
if ! caddy validate --config "$NEW_CONFIG" --adapter caddyfile; then
  rm -f "$NEW_CONFIG"
  die "caddy validate 失败，原配置未改动"
fi
ok "caddy validate 通过"

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="${CADDYFILE}.bak.${STAMP}"
HINTS="/etc/caddy/Caddyfile.old-hints.${STAMP}.txt"
cp -a "$CADDYFILE" "$BACKUP"
{
  echo "# 旧站点线索（${STAMP}），用于清理原站文件："
  grep -nE '^[[:space:]]*(root|reverse_proxy|file_server|try_files|respond)[[:space:]]' "$CADDYFILE" || true
} > "$HINTS"
ok "旧配置已备份：$BACKUP"
ok "旧站点线索：$HINTS"

restore() {
  warn "切换失败，正在回滚 Caddyfile"
  cp -a "$BACKUP" "$CADDYFILE"
  systemctl reload caddy >/dev/null 2>&1 || true
  rm -f "$NEW_CONFIG"
  die "已回滚到切换前配置"
}
trap restore ERR

install -m 644 "$NEW_CONFIG" "$CADDYFILE"
rm -f "$NEW_CONFIG"
systemctl reload caddy || die "caddy reload 失败"
ok "caddy 已 reload"

# 等 Caddy 起来并做本机健康检查
sleep 2
if [[ "$HTTP_ONLY" == "1" ]]; then
  URL="http://127.0.0.1/api/health"
  CURL_OPTS=(-fsS)
else
  if [[ -n "$SITE_HOST" ]]; then
    URL="https://${SITE_HOST}/api/health"
    CURL_OPTS=(-kfsS --resolve "${SITE_HOST}:443:127.0.0.1")
  else
    URL="https://127.0.0.1/api/health"
    CURL_OPTS=(-kfsS)
  fi
fi
HEALTH_OK=0
for _ in $(seq 1 10); do
  if curl "${CURL_OPTS[@]}" --max-time 5 "$URL" >/dev/null 2>&1; then
    HEALTH_OK=1
    break
  fi
  sleep 1
done
[[ "$HEALTH_OK" == "1" ]] || restore

trap - ERR
ok "健康检查通过：$URL"
echo
echo "🎉 已切换为标讯助手根路径："
if [[ "$HTTP_ONLY" == "1" ]]; then
  echo "   http://<服务器IP>/"
else
  echo "   https://<服务器IP>/   （自签证书，浏览器提示不安全时选择继续访问）"
fi
echo
echo "旧站点文件未删除。查看线索：cat $HINTS"
echo "确认新站正常后再删除旧文件；需要回滚时：cp $BACKUP $CADDYFILE && systemctl reload caddy"
