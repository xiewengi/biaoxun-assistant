"""鉴权：PBKDF2 口令哈希 + Bearer Token 会话。"""
from __future__ import annotations

import hashlib
import hmac
import secrets
from datetime import datetime, timedelta
from typing import Any, Dict, Optional

from fastapi import Depends, Header, HTTPException, Query, status

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
        "role": row.get("role", "member"),
    }


def get_current_user(
    authorization: Optional[str] = Header(default=None),
    token_param: Optional[str] = Query(default=None, alias="token"),
) -> Dict[str, Any]:
    # 优先从 Header Bearer 取，没有就 fallback 到 query param token（浏览器直接下载文件时用）
    token = _parse_bearer(authorization) or (token_param.strip() if token_param else "")
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
    return enrich_user_with_permissions(user_payload(row))


def _get_user_permissions(user_id: int) -> set[str]:
    """查用户的所有 permission code 集合（直接走 db 模块，方便路由层调用）。"""
    rows = db.query_all(
        """
        SELECT p.code
        FROM permissions p
        JOIN role_permissions rp ON rp.permission_id = p.id
        JOIN roles r ON r.id = rp.role_id
        WHERE r.code = (SELECT role FROM users WHERE id = ?)
        """,
        (user_id,),
    )
    return {r["code"] for r in rows}


def require_permission(user: Dict[str, Any], perm_code: str, label: str = "执行该操作") -> None:
    """RBAC 单权限检查：super_admin 直接放行；否则查 role_permissions。"""
    if user.get("role") == "super_admin":
        return
    row = db.query_one(
        """
        SELECT 1 FROM role_permissions rp
        JOIN permissions p ON p.id = rp.permission_id
        JOIN roles r ON r.id = rp.role_id
        WHERE r.code = ? AND p.code = ?
        LIMIT 1
        """,
        (user.get("role"), perm_code),
    )
    if not row:
        raise HTTPException(status_code=403, detail=f"无权限：{label}")


def require_any_permission(user: Dict[str, Any], *perm_codes: str) -> None:
    """任一权限命中即可放行。super_admin 直接放行。"""
    if user.get("role") == "super_admin":
        return
    if not perm_codes:
        return
    placeholders = ",".join(["?"] * len(perm_codes))
    row = db.query_one(
        f"""
        SELECT 1 FROM role_permissions rp
        JOIN permissions p ON p.id = rp.permission_id
        JOIN roles r ON r.id = rp.role_id
        WHERE r.code = ? AND p.code IN ({placeholders})
        LIMIT 1
        """,
        (user.get("role"), *perm_codes),
    )
    if not row:
        raise HTTPException(status_code=403, detail=f"无权限：需要权限 {list(perm_codes)} 之一")


def apply_data_scope(user: Dict[str, Any], table: str, conn=None) -> tuple[str, list]:
    """统一封装的数据行级过滤。返回 (sql_fragment, params)，需要自己拼到 WHERE 里。

    规则：
    - super_admin / jitubu_admin → ("", []) 不加过滤
    - group_admin（针对 announcements / groups 等有 group 关联的表）→ (" AND group_id = ?", [user['groupId']])
    - member：announcements 老大口径是全员可见，列表不过滤；改/删自己的由路由层单独校验。这里统一返回 ("", [])。
    """
    role = user.get("role", "")
    if role in ("super_admin", "jitubu_admin"):
        return "", []

    if role == "group_admin":
        tables_with_group_scope = {"announcements", "groups", "group_members"}
        if table in tables_with_group_scope:
            gid = user.get("groupId")
            if gid is not None:
                return " AND group_id = ?", [gid]
        return "", []

    # member / 其他：默认不过滤（公告列表全员可见）
    return "", []


def enrich_user_with_permissions(user: Dict[str, Any]) -> Dict[str, Any]:
    """给 user payload 加 permissions 列表（super_admin 返回全量 code）。"""
    role = user.get("role", "")
    if role == "super_admin":
        rows = db.query_all("SELECT code FROM permissions")
        user["permissions"] = sorted(r["code"] for r in rows)
    else:
        user["permissions"] = sorted(_get_user_permissions(user["id"]))
    return user


def require_jitubu(user: Dict[str, Any], action_label: str = "执行该操作") -> None:
    """集团客户部专属权限（分配 / 新增 / 修改 / 删除公告等）。
    兼容中间态：super_admin / jitubu_admin / 老口径 group='集团客户部' 都放行。
    """
    if user.get("role") in ("super_admin", "jitubu_admin"):
        return
    if user.get("group") == "集团客户部":
        return
    raise HTTPException(status_code=403, detail=f"仅管理员可{action_label}")


def require_group_admin(user: Dict[str, Any]) -> None:
    """任务分配权限：沿用历史口径（集团客户部），内部转调 require_jitubu。
    新代码请用 require_permission(user, "announcements:assign", ...)。"""
    require_jitubu(user, "执行任务分配")


def audit(user: Dict[str, Any], action: str, target: str = "", detail: str = "") -> None:
    db.execute(
        "INSERT INTO audit_log (user_name, action, target, detail) VALUES (?, ?, ?, ?)",
        (user.get("name", ""), action, target, detail),
    )
