"""鉴权：PBKDF2 口令哈希 + Bearer Token 会话。"""
from __future__ import annotations

import hashlib
import hmac
import secrets
from datetime import datetime, timedelta
from typing import Any, Dict, Optional

from fastapi import Depends, Header, HTTPException, status

from . import config, db

ALGO = "pbkdf2_sha256"
ITERATIONS = 120_000


def hash_password(password: str, salt: Optional[str] = None) -> Dict[str, str]:
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt.encode("utf-8"), ITERATIONS
    ).hex()
    return {"algo": ALGO, "salt": salt, "hash": digest}


def verify_password(password: str, salt: str, expected: str) -> bool:
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt.encode("utf-8"), ITERATIONS
    ).hex()
    return hmac.compare_digest(digest, expected)


def create_session(user_id: int) -> str:
    # 顺手清理过期会话，避免 sessions 表无限增长
    db.execute(
        "DELETE FROM sessions WHERE expires_at < datetime('now', 'localtime')"
    )
    token = secrets.token_urlsafe(32)
    expires = (datetime.now() + timedelta(days=config.SESSION_DAYS)).strftime(
        "%Y-%m-%d %H:%M:%S"
    )
    db.execute(
        "INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)",
        (token, user_id, expires),
    )
    return token


def delete_session(token: str) -> None:
    db.execute("DELETE FROM sessions WHERE token = ?", (token,))


def _parse_bearer(authorization: Optional[str]) -> Optional[str]:
    if not authorization:
        return None
    parts = authorization.split(None, 1)
    if len(parts) == 2 and parts[0].lower() == "bearer":
        return parts[1].strip()
    return None


def user_payload(row: Dict[str, Any]) -> Dict[str, Any]:
    """对外返回的用户信息（驼峰，与前端 state.currentUser 对齐）。"""
    return {
        "id": row["id"],
        "account": row["account"],
        "name": row["name"],
        "phone": row.get("phone", ""),
        "group": row.get("group_name") or "",
        "groupId": row.get("group_id"),
        "role": row.get("role", "admin"),
    }


def get_current_user(
    authorization: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    token = _parse_bearer(authorization)
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="未登录或缺少凭证",
            headers={"WWW-Authenticate": "Bearer"},
        )
    row = db.query_one(
        """
        SELECT u.id, u.account, u.name, u.phone, u.role, u.group_id, g.name AS group_name,
               s.expires_at
        FROM sessions s
        JOIN users u ON u.id = s.user_id
        LEFT JOIN groups g ON g.id = u.group_id
        WHERE s.token = ?
        """,
        (token,),
    )
    if not row:
        raise HTTPException(status_code=401, detail="登录已失效，请重新登录")
    if row["expires_at"] < datetime.now().strftime("%Y-%m-%d %H:%M:%S"):
        db.execute("DELETE FROM sessions WHERE token = ?", (token,))
        raise HTTPException(status_code=401, detail="登录已过期，请重新登录")
    return user_payload(row)


def require_jitubu(user: Dict[str, Any], action_label: str = "执行该操作") -> None:
    """集团客户部专属权限（分配 / 新增 / 修改 / 删除公告等）。"""
    if user.get("group") != "集团客户部":
        raise HTTPException(status_code=403, detail=f"仅管理员可{action_label}")


def require_group_admin(user: Dict[str, Any]) -> None:
    """任务分配权限：沿用历史口径（集团客户部），内部转调 require_jitubu。"""
    require_jitubu(user, "执行任务分配")


def audit(user: Dict[str, Any], action: str, target: str = "", detail: str = "") -> None:
    db.execute(
        "INSERT INTO audit_log (user_name, action, target, detail) VALUES (?, ?, ?, ?)",
        (user.get("name", ""), action, target, detail),
    )
