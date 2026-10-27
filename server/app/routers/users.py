"""用户管理路由（仅管理员可写）。契约见 docs/api-contract.md 第 5 节。

users 是唯一权威登录表。成员从团队页面里选（不再手动输账号）；
换组时：如果目标组已有同账号的人，先从旧组踢掉再加入。
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .. import config, db, security, serializers

router = APIRouter(prefix="/api/users", tags=["users"])


class UserBody(BaseModel):
    account: Optional[str] = None
    name: Optional[str] = None
    phone: Optional[str] = None
    groupId: Optional[int] = None
    role: Optional[str] = None       # 'admin' | 'member'
    password: Optional[str] = None   # 新建必填；修改时留空不改密码


def _load_user(user_id: int) -> Dict[str, Any]:
    """带 group_name 的用户详情。"""
    row = db.query_one(
        """
        SELECT u.id, u.account, u.name, u.phone, u.role, u.group_id, u.created_at,
               g.name AS group_name
        FROM users u LEFT JOIN groups g ON g.id = u.group_id
        WHERE u.id = ?
        """,
        (user_id,),
    )
    if not row:
        raise HTTPException(status_code=404, detail="用户不存在")
    return serializers.user_to_api(row)


def _ensure_unique(conn, account: str, exclude_id: Optional[int] = None) -> None:
    sql = "SELECT id FROM users WHERE account = ?"
    params: List[Any] = [account]
    if exclude_id is not None:
        sql += " AND id != ?"
        params.append(exclude_id)
    if conn.execute(sql, params).fetchone():
        raise HTTPException(status_code=409, detail="账号已存在")


def _ensure_not_admin_of_other_group(conn, user_id: int, new_group_id: Optional[int]) -> None:
    """如果把一个组的 admin 账号移到另一个组，要先解除原组 admin 身份。"""
    row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    if not row:
        return
    old_gid = row["group_id"]
    if old_gid and old_gid != new_group_id and row["role"] == "admin":
        # 检查原组 groups.admin_account 是不是这个账号
        g = conn.execute(
            "SELECT id FROM groups WHERE id = ? AND admin_account = ?",
            (old_gid, row["account"]),
        ).fetchone()
        if g:
            # 不是删除组（防止 NULL 破坏数据），只解除 admin 身份
            conn.execute(
                "UPDATE users SET role = 'member' WHERE id = ?", (user_id,)
            )
            conn.execute(
                "UPDATE groups SET admin_account = '' WHERE id = ?", (old_gid,)
            )


def _transfer_member(conn, user_id: int, new_group_id: Optional[int]) -> None:
    """换组逻辑：
    - 如果新组已有这个 user_id（unique index 冲突），先从旧组 group_members 删掉
    - users.group_id 改到新组
    - 新组 group_members 里确保存在一行（upsert by user_id）
    """
    # 先清理旧组（如果有）
    old = conn.execute(
        "SELECT group_id FROM users WHERE id = ?", (user_id,)
    ).fetchone()
    old_gid = old["group_id"] if old else None

    # 检查新组是否已经加过这个人
    if new_group_id:
        dup = conn.execute(
            "SELECT id FROM group_members WHERE group_id = ? AND user_id = ?",
            (new_group_id, user_id),
        ).fetchone()
        if dup:
            # 直接从旧组踢掉就行，新组已经有了
            if old_gid and old_gid != new_group_id:
                conn.execute(
                    "DELETE FROM group_members WHERE group_id = ? AND user_id = ?",
                    (old_gid, user_id),
                )
        else:
            # 新组还没这个人，加一行
            u = conn.execute("SELECT name, phone FROM users WHERE id = ?", (user_id,)).fetchone()
            conn.execute(
                """INSERT INTO group_members (group_id, user_id, name, contact, position)
                   VALUES (?, ?, ?, ?, '成员')""",
                (new_group_id, user_id, u["name"], u["phone"] or ""),
            )
            # 旧组踢掉
            if old_gid and old_gid != new_group_id:
                conn.execute(
                    "DELETE FROM group_members WHERE group_id = ? AND user_id = ?",
                    (old_gid, user_id),
                )
    else:
        # 移出所有组
        if old_gid:
            conn.execute(
                "DELETE FROM group_members WHERE group_id = ? AND user_id = ?",
                (old_gid, user_id),
            )

    # 最后统一改 users.group_id
    conn.execute(
        "UPDATE users SET group_id = ? WHERE id = ?", (new_group_id, user_id)
    )


@router.get("")
def list_users(
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, Any]:
    security.require_jitubu(user, "查看用户列表")
    rows = db.query_all(
        """
        SELECT u.id, u.account, u.name, u.phone, u.role, u.group_id, u.created_at,
               g.name AS group_name
        FROM users u LEFT JOIN groups g ON g.id = u.group_id
        ORDER BY u.group_id IS NULL, u.group_id ASC, u.role DESC, u.id ASC
        """
    )
    return {"items": [serializers.user_to_api(r) for r in rows]}


@router.post("")
def create_user(
    body: UserBody,
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, Any]:
    security.require_jitubu(user, "创建账号")

    account = (body.account or "").strip()
    name = (body.name or "").strip()
    phone = (body.phone or "").strip()
    role = (body.role or "member").strip() or "member"
    group_id = body.groupId  # None 允许（先不分组）

    if not account:
        raise HTTPException(status_code=400, detail="账号不能为空")
    if not name:
        raise HTTPException(status_code=400, detail="姓名不能为空")
    if role not in ("admin", "member"):
        raise HTTPException(status_code=400, detail="角色必须是 admin 或 member")

    with db.get_conn() as conn:
        _ensure_unique(conn, account)
        if group_id is not None:
            g = conn.execute("SELECT id FROM groups WHERE id = ?", (group_id,)).fetchone()
            if not g:
                raise HTTPException(status_code=404, detail="目标小组不存在")

        hashed = security.hash_password(body.password or config.DEFAULT_PASSWORD)
        cur = conn.execute(
            """INSERT INTO users (account, name, phone, password_hash, salt, group_id, role)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (account, name, phone, hashed["hash"], hashed["salt"], group_id, role),
        )
        new_id = int(cur.lastrowid or 0)

        # 如果分了组，自动在 group_members 里补一行
        if group_id is not None:
            conn.execute(
                """INSERT INTO group_members (group_id, user_id, name, contact, position)
                   VALUES (?, ?, ?, ?, ?)""",
                (group_id, new_id, name, phone, "负责人" if role == "admin" else "成员"),
            )
            # 如果设为 admin，同步更新 groups.admin_account
            if role == "admin":
                conn.execute(
                    "UPDATE groups SET admin_account = ? WHERE id = ?",
                    (account, group_id),
                )

    security.audit(user, "创建账号", account, f"姓名 {name}，角色 {role}")
    return _load_user(new_id)


@router.put("/{user_id}")
def update_user(
    user_id: int,
    body: UserBody,
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, Any]:
    security.require_jitubu(user, "修改账号")

    with db.get_conn() as conn:
        cur_row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        if not cur_row:
            raise HTTPException(status_code=404, detail="用户不存在")

        new_account = (body.account.strip() if body.account is not None else cur_row["account"])
        new_name = (body.name.strip() if body.name is not None else cur_row["name"])
        new_phone = (body.phone.strip() if body.phone is not None else cur_row["phone"])
        new_role = (body.role.strip() if body.role is not None else cur_row["role"])
        new_gid = body.groupId if body.groupId is not None else cur_row["group_id"]

        if not new_account:
            raise HTTPException(status_code=400, detail="账号不能为空")
        if new_role not in ("admin", "member"):
            raise HTTPException(status_code=400, detail="角色必须是 admin 或 member")

        _ensure_unique(conn, new_account, exclude_id=user_id)

        # 换组（如果 group_id 真的变了）
        if new_gid != cur_row["group_id"]:
            _ensure_not_admin_of_other_group(conn, user_id, new_gid)
            _transfer_member(conn, user_id, new_gid)

        conn.execute(
            """UPDATE users SET account = ?, name = ?, phone = ?, role = ?, group_id = ?
               WHERE id = ?""",
            (new_account, new_name, new_phone, new_role, new_gid, user_id),
        )

        # 改了姓名/电话/账号，同步 group_members 展示字段（如果有）
        conn.execute(
            """UPDATE group_members SET name = ?, contact = ? WHERE user_id = ?""",
            (new_name, new_phone, user_id),
        )

        # admin 切换：同步 groups.admin_account
        if new_role == "admin" and new_gid:
            conn.execute(
                "UPDATE groups SET admin_account = ? WHERE id = ?",
                (new_account, new_gid),
            )

        # 重置密码
        if body.password and body.password.strip():
            hashed = security.hash_password(body.password.strip())
            conn.execute(
                "UPDATE users SET password_hash = ?, salt = ? WHERE id = ?",
                (hashed["hash"], hashed["salt"], user_id),
            )

    security.audit(user, "修改账号", new_account, f"姓名 {new_name}，角色 {new_role}")
    return _load_user(user_id)


@router.delete("/{user_id}")
def delete_user(
    user_id: int,
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, Any]:
    security.require_jitubu(user, "删除账号")

    with db.get_conn() as conn:
        row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="用户不存在")
        # 级联删 group_members.user_id 行 + 清 groups.admin_account（如果是 admin）
        if row["role"] == "admin" and row["group_id"]:
            conn.execute(
                "UPDATE groups SET admin_account = '' WHERE id = ? AND admin_account = ?",
                (row["group_id"], row["account"]),
            )
        conn.execute("DELETE FROM users WHERE id = ?", (user_id,))

    security.audit(user, "删除账号", row["account"])
    return {"ok": True}


@router.post("/{user_id}/reset-password")
def reset_password(
    user_id: int,
    body: Optional[Dict[str, str]] = None,
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, Any]:
    security.require_jitubu(user, "重置密码")
    new_pw = (body or {}).get("password") or config.DEFAULT_PASSWORD
    new_pw = new_pw.strip()
    if not new_pw:
        raise HTTPException(status_code=400, detail="密码不能为空")
    row = db.query_one("SELECT * FROM users WHERE id = ?", (user_id,))
    if not row:
        raise HTTPException(status_code=404, detail="用户不存在")
    hashed = security.hash_password(new_pw)
    db.execute(
        "UPDATE users SET password_hash = ?, salt = ? WHERE id = ?",
        (hashed["hash"], hashed["salt"], user_id),
    )
    security.audit(user, "重置密码", row["account"])
    return {"ok": True, "account": row["account"]}
