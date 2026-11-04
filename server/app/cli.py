"""运维命令行：改密码 / 备份数据库 / 查看库统计。

用法（在 server/ 目录、用项目 venv 执行）：

    .venv/bin/python -m app.cli set-password sheshujuan '新密码'
    .venv/bin/python -m app.cli backup
    .venv/bin/python -m app.cli backup --dest /opt/biaoxun/backup/biaoxun-2026-10-25.db
    .venv/bin/python -m app.cli stats

说明：
- set-password 会同时踢掉该账号所有在线会话；
- backup 用 SQLite 在线备份 API，WAL 模式下也能拿到一致快照；
- 所有命令都直接读 BX_DB_PATH，和线上服务共用同一份配置。
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import config, db, security
from .services import crawler


def _fmt_size(num: int) -> str:
    size = float(num)
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            return "%.1f %s" % (size, unit)
        size /= 1024
    return "%d B" % num


def cmd_set_password(args: argparse.Namespace) -> int:
    rows = db.query_all("SELECT id, account, name FROM users WHERE account = ?", (args.account,))
    if not rows:
        print("❌ 账号不存在：%s" % args.account, file=sys.stderr)
        return 1
    if len(args.password) < 6:
        print("❌ 密码至少 6 位", file=sys.stderr)
        return 2
    user = rows[0]
    hashed = security.hash_password(args.password)
    db.execute(
        "UPDATE users SET password_hash = ?, salt = ? WHERE id = ?",
        (hashed["hash"], hashed["salt"], user["id"]),
    )
    db.execute("DELETE FROM sessions WHERE user_id = ?", (user["id"],))
    security.audit(
        {"name": "cli"}, "重置密码", user["account"], "通过命令行重置密码并清理会话"
    )
    print("✅ 已重置 %s（%s）的密码，在线会话已全部失效" % (user["name"], user["account"]))
    return 0


def cmd_backup(args: argparse.Namespace) -> int:
    src_path = Path(config.DB_PATH)
    if not src_path.is_file():
        print("❌ 数据库不存在：%s" % src_path, file=sys.stderr)
        return 1
    if args.dest:
        dest = Path(args.dest).expanduser().resolve()
    else:
        stamp = datetime.now().strftime("%Y-%m-%d-%H%M%S")
        dest = (Path(config.DATA_DIR) / "backups" / ("biaoxun-%s.db" % stamp)).resolve()
    dest.parent.mkdir(parents=True, exist_ok=True)

    # SQLite 在线备份：不锁库，WAL 下也能得到一致快照
    src = sqlite3.connect(str(src_path), timeout=15)
    try:
        dst = sqlite3.connect(str(dest))
        try:
            src.backup(dst)
            check = dst.execute("PRAGMA integrity_check").fetchone()
            # 备份文件切回 DELETE 日志模式，避免留下 -wal / -shm 旁文件
            dst.execute("PRAGMA journal_mode = DELETE")
            dst.commit()
        finally:
            dst.close()
    finally:
        src.close()

    # 已经切回 DELETE 日志模式并关闭连接，残余的 -wal/-shm 可以直接清掉
    for suffix in ("-wal", "-shm"):
        side = Path(str(dest) + suffix)
        if side.exists():
            side.unlink()

    ok = bool(check) and check[0] == "ok"
    if not ok:
        print("❌ 备份完整性校验失败：%r" % (check,), file=sys.stderr)
        return 3
    print("✅ 备份完成：%s（%s，完整性校验通过）" % (dest, _fmt_size(dest.stat().st_size)))
    return 0


def cmd_collect(args: argparse.Namespace) -> int:
    if not config.COLLECTOR_SCRIPT.is_file():
        print("❌ 采集脚本不存在：%s" % config.COLLECTOR_SCRIPT, file=sys.stderr)
        return 1
    print("▶ 开始采集（窗口 %s 天）..." % args.days)
    row = crawler.run_collect_now(days=args.days, operator="cli")
    status = row.get("status", "unknown")
    print(
        "状态：%s｜新增：%s 条｜成功站点：%s/%s"
        % (status, row.get("new_count", 0), row.get("sites_ok", 0), row.get("sites_total", 0))
    )
    message = (row.get("message") or "").strip()
    if message:
        print("说明：%s" % message[:600])
    return 0 if status == "ok" else 1


def cmd_stats(_: argparse.Namespace) -> int:
    tables: List[str] = [
        "groups",
        "group_members",
        "users",
        "sessions",
        "announcements",
        "progress_records",
        "assignment_records",
        "sources",
        "crawl_runs",
        "audit_log",
    ]
    print("数据库：%s（%s）" % (config.DB_PATH, _fmt_size(Path(config.DB_PATH).stat().st_size) if Path(config.DB_PATH).exists() else "不存在"))
    for table in tables:
        row: Optional[Dict[str, Any]] = db.query_one("SELECT COUNT(*) AS c FROM %s" % table)
        print("  %-20s %s" % (table, (row or {}).get("c", "-")))
    by_progress = db.query_all(
        "SELECT progress, COUNT(*) AS c FROM announcements GROUP BY progress ORDER BY c DESC"
    )
    if by_progress:
        print("公告进度分布：" + "，".join("%s=%s" % (r["progress"], r["c"]) for r in by_progress))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m app.cli", description="标讯助手运维命令行"
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_pwd = sub.add_parser("set-password", help="重置账号密码并清理其会话")
    p_pwd.add_argument("account", help="登录账号，例如 sheshujuan")
    p_pwd.add_argument("password", help="新密码（至少 6 位）")
    p_pwd.set_defaults(func=cmd_set_password)

    p_backup = sub.add_parser("backup", help="在线备份 SQLite 数据库")
    p_backup.add_argument(
        "--dest", default="", help="备份文件路径；默认 data/backups/biaoxun-时间戳.db"
    )
    p_backup.set_defaults(func=cmd_backup)

    p_collect = sub.add_parser("collect", help="立即执行一次采集并入库（供定时任务调用）")
    p_collect.add_argument("--days", type=int, default=3, help="采集最近 N 天，默认 3")
    p_collect.set_defaults(func=cmd_collect)

    p_stats = sub.add_parser("stats", help="打印各表行数与公告进度分布")
    p_stats.set_defaults(func=cmd_stats)
    return parser


def main(argv: Optional[List[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    db.init_db()
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
