"""团队（小组）路由。契约见 docs/api-contract.md 第 4 节。

写操作需要同步三张表：groups / group_members / users（管理员账号）。
成员行可选 userId（新方案：关联 users 表）或 namePinyin（老方案兼容）。
"""
from __future__ import annotations

import sqlite3
from datetime import date
from typing import Any, Dict, List, Optional, Sequence, Tuple

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .. import config, db, security, serializers

router = APIRouter(prefix="/api/groups", tags=["teams"])

BUILTIN_GROUP_NAME = "集团客户部"


class MemberBody(BaseModel):
    name: str = ""
    namePinyin: str = ""
    contact: str = ""
    position: str = "成员"
    userId: Optional[int] = None   # 新方案：关联 users 表的 id


class GroupBody(BaseModel):
    name: Optional[str] = None
    region: Optional[str] = None
    admin: Optional[str] = None
    adminContact: Optional[str] = None
    adminAccount: Optional[str] = None
    position: Optional[str] = None
    password: Optional[str] = None
    members: Optional[List[MemberBody]] = None


def _load_group(group_id: int) -> Dict[str, Any]:
    row = db.query_one("SELECT * FROM groups WHERE id = ?", (group_id,))
    if not row:
        raise HTTPException(status_code=404, detail="小组不存在")
    members = db.query_all(
        "SELECT * FROM group_members WHERE group_id = ? ORDER BY id ASC", (group_id,)
    )
    return serializers.group_to_api(row, members)


def _ensure_unique(
    conn: sqlite3.Connection,
    name: str,
    admin_account: str,
    group_id: Optional[int] = None,
    user_id: Optional[int] = None,
) -> None:
    """小组名 / 管理员账号唯一性校验，冲突统一 409。"""
    current_group = group_id or -1
    row = conn.execute(
        "SELECT id FROM groups WHERE name = ? AND id != ?",
        (name, current_group),
    ).fetchone()
    if row:
        raise HTTPException(status_code=409, detail="小组名称已存在")
    row = conn.execute(
        "SELECT id FROM groups WHERE admin_account = ? AND id != ?",
        (admin_account, current_group),
    ).fetchone()
    if row:
        raise HTTPException(status_code=409, detail="管理员账号已存在")

    sql = "SELECT id FROM users WHERE account = ?"
    params: List[Any] = [admin_account]
    if user_id is not None:
        sql += " AND id != ?"
        params.append(user_id)
    row = conn.execute(sql, params).fetchone()
    if row:
        raise HTTPException(status_code=409, detail="管理员账号已存在")


def _normalize_members(
    members: Optional[Sequence[MemberBody]],
) -> List[Dict[str, Any]]:
    """去空、去重，返回 [{name, name_pinyin, contact, position, user_id}]。"""
    result: List[Dict[str, Any]] = []
    seen_names = set()
    seen_user_ids = set()
    for member in members or []:
        name = (member.name or "").strip()
        uid = member.userId
        if not name and not uid:
            continue
        if uid is not None:
            if uid in seen_user_ids:
                raise HTTPException(status_code=400, detail="成员重复：userId={}".format(uid))
            seen_user_ids.add(uid)
        if name and name in seen_names:
            raise HTTPException(status_code=400, detail="成员姓名重复：{}".format(name))
        if name:
            seen_names.add(name)
        result.append({
            "name": name,
            "name_pinyin": (member.namePinyin or "").strip(),
            "contact": (member.contact or "").strip(),
            "position": (member.position or "").strip() or "成员",
            "user_id": uid,
        })
    return result


def _replace_members(
    conn: sqlite3.Connection,
    group_id: int,
    members: Optional[Sequence[MemberBody]],
) -> None:
    """成员数组整体替换。

    - 带 userId 的：先踢掉旧组 group_members 记录，再 upsert 到本 group，users.group_id 同步迁移。
    - 不带 userId 的（老方案兼容）：直接写 group_members 旧字段。
    """
    normalized = _normalize_members(members)
    new_user_ids = {m["user_id"] for m in normalized if m.get("user_id") is not None}

    # 旧组成员里哪些 userId 不在新列表了 → 从 users.group_id 清理
    old_users_in_group = conn.execute(
        "SELECT user_id FROM group_members WHERE group_id = ? AND user_id IS NOT NULL",
        (group_id,),
    ).fetchall()
    for row in old_users_in_group:
        if row["user_id"] not in new_user_ids:
            conn.execute(
                "UPDATE users SET group_id = NULL WHERE id = ? AND group_id = ?",
                (row["user_id"], group_id),
            )

    # 清空本 group 的 group_members（清空后按新列表重写）
    conn.execute("DELETE FROM group_members WHERE group_id = ?", (group_id,))

    for m in normalized:
        uid = m.get("user_id")
        if uid is not None:
            # 先踢掉旧组
            conn.execute(
                "DELETE FROM group_members WHERE user_id = ? AND group_id != ?",
                (uid, group_id),
            )
            # 从 users 表拉最新展示字段
            u = conn.execute(
                "SELECT name, phone FROM users WHERE id = ?", (uid,)
            ).fetchone()
            display_name = m["name"] or (u["name"] if u else "")
            contact = m["contact"] or (u["phone"] if u else "")
            conn.execute(
                """INSERT INTO group_members
                   (group_id, user_id, name, name_pinyin, contact, position)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (group_id, uid, display_name, "", contact, m["position"]),
            )
            conn.execute(
                "UPDATE users SET group_id = ? WHERE id = ?", (group_id, uid)
            )
        else:
            conn.execute(
                """INSERT INTO group_members
                   (group_id, name, name_pinyin, contact, position)
                   VALUES (?, ?, ?, ?, ?)""",
                (group_id, m["name"], m["name_pinyin"], m["contact"], m["position"]),
            )


@router.get("")
def list_groups(
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, Any]:
    rows = db.query_all("SELECT * FROM groups ORDER BY id ASC")
    items = [
        serializers.group_to_api(
            row,
            db.query_all(
                "SELECT * FROM group_members WHERE group_id = ? ORDER BY id ASC",
                (row["id"],),
            ),
        )
        for row in rows
    ]
    return {"items": items}


@router.post("")
def create_group(
    body: GroupBody,
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, Any]:
    name = (body.name or "").strip()
    region = (body.region or "").strip()
    admin = (body.admin or "").strip()
    admin_contact = (body.adminContact or "").strip()
    admin_account = (body.adminAccount or "").strip()
    position = (body.position or "").strip() or "负责人"
    password = body.password or config.DEFAULT_PASSWORD

    if not name:
        raise HTTPException(status_code=400, detail="小组名称不能为空")
    if not region:
        raise HTTPException(status_code=400, detail="所属区域不能为空")
    if not admin:
        raise HTTPException(status_code=400, detail="负责人姓名不能为空")
    if not admin_account:
        raise HTTPException(status_code=400, detail="管理员账号不能为空")

    with db.get_conn() as conn:
        _ensure_unique(conn, name, admin_account)
        cur = conn.execute(
            """INSERT INTO groups
               (name, region, admin, admin_contact, admin_account, position, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                name,
                region,
                admin,
                admin_contact,
                admin_account,
                position,
                date.today().isoformat(),
            ),
        )
        group_id = int(cur.lastrowid or 0)
        hashed = security.hash_password(password)
        conn.execute(
            """INSERT INTO users (account, name, phone, password_hash, salt, group_id, role)
               VALUES (?, ?, ?, ?, ?, ?, 'admin')""",
            (admin_account, admin, admin_contact, hashed["hash"], hashed["salt"], group_id),
        )
        _replace_members(conn, group_id, body.members)

    security.audit(user, "新建小组", name, "负责人 {}（{}）".format(admin, admin_account))
    return _load_group(group_id)


@router.put("/{group_id}")
def update_group(
    group_id: int,
    body: GroupBody,
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, Any]:
    row = db.query_one("SELECT * FROM groups WHERE id = ?", (group_id,))
    if not row:
        raise HTTPException(status_code=404, detail="小组不存在")

    name = (body.name if body.name is not None else row["name"]).strip()
    region = (body.region if body.region is not None else row["region"]).strip()
    admin = (body.admin if body.admin is not None else row["admin"]).strip()
    admin_contact = (
        body.adminContact if body.adminContact is not None else row["admin_contact"]
    ).strip()
    admin_account = (
        body.adminAccount if body.adminAccount is not None else row["admin_account"]
    ).strip()
    position = (body.position if body.position is not None else row["position"]).strip()

    if not name:
        raise HTTPException(status_code=400, detail="小组名称不能为空")
    if not region:
        raise HTTPException(status_code=400, detail="所属区域不能为空")
    if not admin:
        raise HTTPException(status_code=400, detail="负责人姓名不能为空")
    if not admin_account:
        raise HTTPException(status_code=400, detail="管理员账号不能为空")

    with db.get_conn() as conn:
        admin_user = conn.execute(
            "SELECT * FROM users WHERE group_id = ? ORDER BY id ASC LIMIT 1",
            (group_id,),
        ).fetchone()
        if admin_user is None and row["admin_account"]:
            admin_user = conn.execute(
                "SELECT * FROM users WHERE account = ?", (row["admin_account"],)
            ).fetchone()
        admin_user_id = int(admin_user["id"]) if admin_user else None

        _ensure_unique(conn, name, admin_account, group_id, admin_user_id)

        conn.execute(
            """UPDATE groups
               SET name = ?, region = ?, admin = ?, admin_contact = ?,
                   admin_account = ?, position = ?
               WHERE id = ?""",
            (name, region, admin, admin_contact, admin_account, position, group_id),
        )

        if admin_user:
            conn.execute(
                """UPDATE users
                   SET account = ?, name = ?, phone = ?, group_id = ?
                   WHERE id = ?""",
                (admin_account, admin, admin_contact, group_id, admin_user_id),
            )
            if body.password:
                hashed = security.hash_password(body.password)
                conn.execute(
                    "UPDATE users SET password_hash = ?, salt = ? WHERE id = ?",
                    (hashed["hash"], hashed["salt"], admin_user_id),
                )
        else:
            hashed = security.hash_password(body.password or config.DEFAULT_PASSWORD)
            conn.execute(
                """INSERT INTO users
                   (account, name, phone, password_hash, salt, group_id, role)
                   VALUES (?, ?, ?, ?, ?, ?, 'admin')""",
                (
                    admin_account,
                    admin,
                    admin_contact,
                    hashed["hash"],
                    hashed["salt"],
                    group_id,
                ),
            )

        if body.members is not None:
            _replace_members(conn, group_id, body.members)

    security.audit(user, "编辑小组", name, "负责人 {}（{}）".format(admin, admin_account))
    return _load_group(group_id)


@router.delete("/{group_id}")
def delete_group(
    group_id: int,
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, Any]:
    row = db.query_one("SELECT * FROM groups WHERE id = ?", (group_id,))
    if not row:
        raise HTTPException(status_code=404, detail="小组不存在")
    if row["name"] == BUILTIN_GROUP_NAME:
        raise HTTPException(
            status_code=400, detail="集团客户部为系统内置小组，不可删除"
        )

    with db.get_conn() as conn:
        # 先删该组管理员账号（sessions 级联清理），避免删组后账号仍可登录
        conn.execute("DELETE FROM users WHERE group_id = ?", (group_id,))
        conn.execute("DELETE FROM groups WHERE id = ?", (group_id,))

    security.audit(user, "删除小组", row["name"])
    return {"ok": True}
