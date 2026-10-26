"""SQLite 访问层：连接、建表、通用查询助手。

约定：
- 每个请求独立连接（FastAPI 同步路由跑在线程池，sqlite3 连接不跨线程复用）。
- 开启 WAL + foreign_keys，读多写少场景足够。
- 查询返回 dict（sqlite3.Row -> dict），由路由层负责转换为前端 camelCase。
"""
from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

from . import config

SCHEMA_PATH = Path(__file__).resolve().parent / "schema.sql"


def _connect() -> sqlite3.Connection:
    config.DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(config.DB_PATH), timeout=15, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    return conn


@contextmanager
def get_conn() -> Iterable[sqlite3.Connection]:
    conn = _connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _ensure_column(conn: sqlite3.Connection, table: str, column: str, ddl: str) -> None:
    """列迁移：有则跳过，无则 ALTER TABLE ADD COLUMN。"""
    cols = {row[1] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    if column not in cols:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")


def init_db() -> None:
    """建表（幂等）+ 增量列迁移（软删除等后加字段）。"""
    with get_conn() as conn:
        conn.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
        # 2026-10-26 新增：公告软删除
        _ensure_column(conn, "announcements", "is_deleted",
                       "INTEGER NOT NULL DEFAULT 0")
        _ensure_column(conn, "announcements", "deleted_at",
                       "TEXT NOT NULL DEFAULT ''")


def rows_to_dicts(rows: Iterable[sqlite3.Row]) -> List[Dict[str, Any]]:
    return [dict(r) for r in rows]


def query_all(sql: str, params: Iterable[Any] = ()) -> List[Dict[str, Any]]:
    with get_conn() as conn:
        return rows_to_dicts(conn.execute(sql, tuple(params)).fetchall())


def query_one(sql: str, params: Iterable[Any] = ()) -> Optional[Dict[str, Any]]:
    with get_conn() as conn:
        row = conn.execute(sql, tuple(params)).fetchone()
        return dict(row) if row else None


def execute(sql: str, params: Iterable[Any] = ()) -> int:
    """执行写语句，返回 lastrowid。"""
    with get_conn() as conn:
        cur = conn.execute(sql, tuple(params))
        return int(cur.lastrowid or 0)


def executemany(sql: str, seq: Iterable[Iterable[Any]]) -> None:
    with get_conn() as conn:
        conn.executemany(sql, [tuple(s) for s in seq])


def loads_maybe(value: Any, default: Any) -> Any:
    """数据库里存 JSON 字符串，读出时容错解析。"""
    if value is None or value == "":
        return default
    if isinstance(value, (list, dict)):
        return value
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return default


def dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)
