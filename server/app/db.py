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


        # 2026-10-26 新增：成员关联 user 表（独立用户页上线）
        _ensure_column(conn, "group_members", "user_id",
                        "INTEGER REFERENCES users(id) ON DELETE SET NULL")
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id)"
        )
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_group_members_user "
            "ON group_members(group_id, user_id) WHERE user_id IS NOT NULL"
        )

        # 2026-10-27 新增：buyer_district 表 buyer 字段加密 + buyer_hash 辅助列
        _migrate_buyer_encryption(conn)


def _migrate_buyer_encryption(conn: sqlite3.Connection) -> None:
    """迁移：buyer_district.buyer 从明文→密文，新增 buyer_hash 列。幂等。"""
    cols = {row[1] for row in conn.execute("PRAGMA table_info(buyer_district)").fetchall()}
    if "buyer_district" not in {row[0] for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'").fetchall()}:
        return  # 表不存在，schema.sql 会直接建带加密字段的版本

    # 1) 确保 buyer_hash 列存在
    if "buyer_hash" not in cols:
        conn.execute("ALTER TABLE buyer_district ADD COLUMN buyer_hash TEXT NOT NULL DEFAULT ''")

    # 2) 把现有明文 buyer 转成密文 + 填 hash（如果还没加密过）
    # 判断密文特征：base64 且长度 > 32（IV12+tag16+至少1字节密文=29+base64开销≈40+）
    from .crypto import encrypt as _enc, sha256_hex as _sha

    rows = conn.execute("SELECT id, buyer, buyer_hash FROM buyer_district").fetchall()
    for r in rows:
        buyer = r["buyer"] or ""
        if not buyer:
            continue
        # 如果 buyer_hash 已经有值，且 buyer 看起来是密文（包含 base64 特征且长度够），跳过
        if r["buyer_hash"] and len(buyer) >= 44 and all(c in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=" for c in buyer):
            continue
        # 明文 → 密文 + 填 hash
        encrypted = _enc(buyer)
        h = _sha(buyer)
        conn.execute(
            "UPDATE buyer_district SET buyer = ?, buyer_hash = ? WHERE id = ?",
            (encrypted, h, r["id"]),
        )

    # 3) 建唯一索引（幂等）
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_buyer_district_hash ON buyer_district(buyer_hash)"
    )


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
