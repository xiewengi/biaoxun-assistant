#!/bin/bash
# 标讯助手 · 每日自动采集（launchd 调用）
# 装载见同目录 com.biaoxun.collect.plist；日志见 collector/logs/
set -u

BASE="/Users/yyym/Desktop/学习文档/标讯助手"
PY="/Users/yyym/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3"
LOG_DIR="$BASE/collector/logs"
DAYS="${1:-30}"          # 时间窗（天），可带参覆盖
SOURCES="${2:-all}"      # 数据源，可带参覆盖

mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/collect_$(date +%Y%m%d_%H%M).log"

{
  echo "===== $(date '+%F %T') 开始采集 days=${DAYS} source=${SOURCES} ====="
  cd "$BASE" || { echo "!! 进入 $BASE 失败"; exit 1; }
  PYTHONPATH="$BASE/pylibs" "$PY" collector/collect.py --days "$DAYS" --source "$SOURCES"
  rc=$?
  echo "===== 结束 exit=$rc ====="
} >> "$LOG" 2>&1

# 只留最近 30 份日志
ls -t "$LOG_DIR"/collect_*.log 2>/dev/null | tail -n +31 | xargs rm -f 2>/dev/null
exit ${rc:-0}
