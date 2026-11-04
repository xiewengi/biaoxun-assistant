"""任务分配服务：单条 / 批量把公告分配给某个小组。

公告页与任务提醒页共用，避免两套分配逻辑漂移。
"""
from __future__ import annotations

import sqlite3
from datetime import date, timedelta
from typing import Any, Dict, Iterable, List, Optional, Tuple


def _fetch_group(conn: sqlite3.Connection, group_name: str) -> Optional[Dict[str, Any]]:
    row = conn.execute(
        "SELECT * FROM groups WHERE name = ?", (group_name,)
    ).fetchone()
    return dict(row) if row else None


def _fetch_ann(conn: sqlite3.Connection, ann_id: str) -> Optional[Dict[str, Any]]:
    row = conn.execute("SELECT * FROM announcements WHERE id = ?", (ann_id,)).fetchone()
    return dict(row) if row else None


def assign_one(
    conn: sqlite3.Connection,
    ann_id: str,
    group_name: str,
    operator: Dict[str, Any],
    note: str = "",
    follow_up_days: int = 3,
    receiver: str = "",
) -> Tuple[bool, str]:
    """分配单条公告。返回 (是否成功, 失败原因)。"""
    ann = _fetch_ann(conn, ann_id)
    if not ann:
        return False, "公告不存在"
    if ann["progress"] == "已确认":
        return False, "已确认公告不可再分配"
    group = _fetch_group(conn, group_name)
    if not group:
        return False, "小组不存在"

    today = date.today()
    next_follow = (today + timedelta(days=follow_up_days)).isoformat()
    # receiver 为空时默认落到小组管理员（与 Demo 的「接收人」下拉一致）
    handler = (receiver or "").strip() or (group["admin"] or "")
    conn.execute(
        """UPDATE announcements
           SET current_handler = ?, handler_group = ?, progress = '已分配',
               next_follow_up = ?, updated_at = datetime('now', 'localtime')
           WHERE id = ?""",
        (handler, group["name"], next_follow, ann_id),
    )
    conn.execute(
        """INSERT INTO assignment_records
           (ann_id, assigner, assigner_group, assignee, assignee_group, note)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (
            ann_id,
            operator.get("name", ""),
            operator.get("group", ""),
            handler,
            group["name"],
            note,
        ),
    )
    conn.execute(
        """INSERT INTO progress_records (ann_id, progress, follower, follow_date, note)
           VALUES (?, '已分配', ?, ?, ?)""",
        (
            ann_id,
            operator.get("name", ""),
            today.isoformat(),
            note or f"分配给{group['name']} · {handler}",
        ),
    )
    return True, ""


def batch_assign(
    conn: sqlite3.Connection,
    ann_ids: Iterable[str],
    group_name: str,
    operator: Dict[str, Any],
    note: str = "",
    receiver: str = "",
) -> Dict[str, Any]:
    """批量分配，返回 {updated, skipped:[{id,reason}], ids:[成功id]}。"""
    updated = 0
    skipped: List[Dict[str, str]] = []
    ok_ids: List[str] = []
    seen = set()
    for ann_id in ann_ids:
        if not ann_id or ann_id in seen:
            continue
        seen.add(ann_id)
        ok, reason = assign_one(
            conn, ann_id, group_name, operator, note, receiver=receiver
        )
        if ok:
            updated += 1
            ok_ids.append(ann_id)
        else:
            skipped.append({"id": ann_id, "reason": reason})
    return {"updated": updated, "skipped": skipped, "ids": ok_ids}
