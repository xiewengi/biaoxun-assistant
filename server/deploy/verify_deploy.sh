#!/usr/bin/env bash
# =============================================================================
# 标讯助手 · 部署后验收脚本（在本地执行，不需要登录服务器）
#
# 用法：
#   ./server/deploy/verify_deploy.sh --base https://101.42.0.66/biaoxun --insecure
#   ./server/deploy/verify_deploy.sh --base http://101.42.0.66:8000
#   ./server/deploy/verify_deploy.sh --base https://example.com --insecure \
#       --account sheshujuan --password '你的密码'
#
# 参数：
#   --base URL       访问根地址（子路径部署时带 /biaoxun，结尾斜杠可有可无）
#   --account NAME   登录账号，默认 sheshujuan
#   --password PASS  登录密码，默认 123456
#   --insecure       跳过 HTTPS 证书校验（IP + 自签证书时用）
#
# 退出码：0 全部通过；1 有失败项
# =============================================================================
set -uo pipefail

BASE=""
ACCOUNT="sheshujuan"
PASSWORD="123456"
INSECURE=0

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base) BASE="${2:-}"; shift 2 ;;
    --base=*) BASE="${1#*=}"; shift ;;
    --account) ACCOUNT="${2:-}"; shift 2 ;;
    --account=*) ACCOUNT="${1#*=}"; shift ;;
    --password) PASSWORD="${2:-}"; shift 2 ;;
    --password=*) PASSWORD="${1#*=}"; shift ;;
    --insecure) INSECURE=1; shift ;;
    -h|--help) usage 0 ;;
    *) echo "未知参数：$1" >&2; usage 1 ;;
  esac
done

[[ -n "$BASE" ]] || { echo "❌ 缺少 --base" >&2; usage 1; }
BASE="${BASE%/}"
command -v curl >/dev/null 2>&1 || { echo "❌ 本机缺少 curl" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "❌ 本机缺少 python3" >&2; exit 1; }

CURL_OPTS=(-sS --max-time 15)
[[ "$INSECURE" == "1" ]] && CURL_OPTS+=(-k)

FAIL=0
PASS=0
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

check() { # check 名称 实际值 期望值
  local name="$1" actual="$2" expect="$3"
  if [[ "$actual" == "$expect" ]]; then
    printf '✅ %-28s %s\n' "$name" "$actual"
    PASS=$((PASS + 1))
  else
    printf '❌ %-28s 实际=%s 期望=%s\n' "$name" "$actual" "$expect"
    FAIL=$((FAIL + 1))
  fi
}

echo "▶ 验收目标：$BASE"
echo

# 1. 健康检查
HTTP=$(curl "${CURL_OPTS[@]}" -o "$TMP/health.json" -w '%{http_code}' "$BASE/api/health" || echo 000)
check "health HTTP" "$HTTP" "200"
HEALTH_OK=$(python3 -c "import json;print(json.load(open('$TMP/health.json')).get('ok'))" 2>/dev/null || echo parse_error)
check "health.ok" "$HEALTH_OK" "True"

# 2. 首页 + 静态资源
HTTP=$(curl "${CURL_OPTS[@]}" -o "$TMP/index.html" -w '%{http_code}' "$BASE/" || echo 000)
check "首页 HTTP" "$HTTP" "200"
if grep -q "标讯助手" "$TMP/index.html" 2>/dev/null; then
  check "首页标题" "yes" "yes"
else
  check "首页标题" "no" "yes"
fi
for asset in js/api.js js/data.js js/app.js; do
  HTTP=$(curl "${CURL_OPTS[@]}" -o /dev/null -w '%{http_code}' "$BASE/$asset" || echo 000)
  check "静态 $asset" "$HTTP" "200"
done

# 3. 登录
LOGIN_BODY="$TMP/login.json"
HTTP=$(curl "${CURL_OPTS[@]}" -o "$LOGIN_BODY" -w '%{http_code}' \
  -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d "{\"account\":\"$ACCOUNT\",\"password\":\"$PASSWORD\"}" || echo 000)
check "登录 HTTP" "$HTTP" "200"
TOKEN=$(python3 -c "import json;print(json.load(open('$LOGIN_BODY')).get('token',''))" 2>/dev/null || echo "")
if [[ -n "$TOKEN" ]]; then
  check "登录 token" "yes" "yes"
else
  check "登录 token" "no" "yes"
fi

if [[ -n "$TOKEN" ]]; then
  AUTH=(-H "Authorization: Bearer $TOKEN")

  # 4. 核心数据
  HTTP=$(curl "${CURL_OPTS[@]}" "${AUTH[@]}" -o "$TMP/ann.json" -w '%{http_code}' \
    "$BASE/api/announcements?page_size=3" || echo 000)
  check "公告接口 HTTP" "$HTTP" "200"
  ANN_TOTAL=$(python3 -c "import json;print(json.load(open('$TMP/ann.json')).get('total',-1))" 2>/dev/null || echo -1)
  if [[ "$ANN_TOTAL" =~ ^[0-9]+$ ]] && [[ "$ANN_TOTAL" -gt 0 ]]; then
    check "公告条数>0" "yes($ANN_TOTAL)" "yes($ANN_TOTAL)"
  else
    check "公告条数>0" "no($ANN_TOTAL)" "yes"
  fi

  HTTP=$(curl "${CURL_OPTS[@]}" "${AUTH[@]}" -o "$TMP/rem.json" -w '%{http_code}' \
    "$BASE/api/reminders?scope=me" || echo 000)
  check "提醒接口 HTTP" "$HTTP" "200"

  HTTP=$(curl "${CURL_OPTS[@]}" "${AUTH[@]}" -o "$TMP/groups.json" -w '%{http_code}' \
    "$BASE/api/groups" || echo 000)
  check "团队接口 HTTP" "$HTTP" "200"
  GROUP_COUNT=$(python3 -c "import json;print(len(json.load(open('$TMP/groups.json')).get('items',[])))" 2>/dev/null || echo 0)
  if [[ "$GROUP_COUNT" -ge 5 ]]; then
    check "小组数量>=5" "$GROUP_COUNT" "$GROUP_COUNT"
  else
    check "小组数量>=5" "$GROUP_COUNT" ">=5"
  fi

  HTTP=$(curl "${CURL_OPTS[@]}" "${AUTH[@]}" -o "$TMP/sources.json" -w '%{http_code}' \
    "$BASE/api/sources" || echo 000)
  check "数据源接口 HTTP" "$HTTP" "200"

  HTTP=$(curl "${CURL_OPTS[@]}" "${AUTH[@]}" -o /dev/null -w '%{http_code}' \
    "$BASE/api/schedule" || echo 000)
  check "定时任务接口 HTTP" "$HTTP" "200"
fi

echo
if [[ "$FAIL" -eq 0 ]]; then
  echo "🎉 验收通过：$PASS 项全部成功"
  exit 0
fi
echo "❌ 验收失败：$FAIL 项未通过（成功 $PASS 项）"
exit 1
