"""任务提醒路由。契约见 docs/api-contract.md 第 3 节。

提醒由公告实时计算、不落库：
- 待分配 → admin-assign（urgent）
- 已分配 → sales-follow（按 next_follow_up 距今天数分 urgent / warn / info）
- 已确认 → 不生成提醒
"""
from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .. import db, security, serializers
from ..services import assignments

router = APIRouter(prefix="/api/reminders", tags=["reminders"])

LEVEL_RANK = {"urgent": 0, "warn": 1, "info": 2}


class BatchAssignBody(BaseModel):
    ids: List[str] = Field(default_factory=list)
    group: str = ""


def _parse_iso_date(value: str) -> Optional[date]:
    """解析 YYYY-MM-DD / YYYY-MM-DD HH:MM:SS，失败返回 None。"""
    text = (value or "").strip()
    if not text:
        return None
    try:
        return datetime.strptime(text[:10], "%Y-%m-%d").date()
    except ValueError:
        return None


def _days_in_stock(created_at: str, today: date) -> int:
    """created_at 到今天的自然日差（未来/非法时间按 0 计）。"""
    created = _parse_iso_date(created_at)
    if not created:
        return 0
    return max((today - created).days, 0)


def _follow_up_level(next_follow_up: str, today: date) -> str:
    """跟进提醒等级：<=今天 urgent，<=今天+3 warn，其余 info。"""
    follow = _parse_iso_date(next_follow_up)
    if not follow:
        return "info"
    if follow <= today:
        return "urgent"
    if follow <= today + timedelta(days=3):
        return "warn"
    return "info"


def _subject(ann: Dict[str, Any]) -> str:
    text = ann.get("project_name") or ann.get("title") or ""
    return text[:30]


def _to_admin_reminder(ann: Dict[str, Any], today: date) -> Dict[str, Any]:
    days = _days_in_stock(ann.get("created_at", ""), today)
    return {
        "id": "admin-" + str(ann["id"]),
        "type": "admin-assign",
        "label": "管理员分派",
        "level": "urgent",
        "title": f"项目「{_subject(ann)}...」已入库 {days} 天未分配",
        "targetId": ann["id"],
        "time": ann.get("created_at", ""),
        "district": ann.get("district", ""),
        "annTitle": ann.get("title", ""),
        "annProgress": ann.get("progress", ""),
        "annCurrentHandler": ann.get("current_handler", ""),
    }


def _to_sales_reminder(ann: Dict[str, Any], today: date) -> Dict[str, Any]:
    return {
        "id": "sales-" + str(ann["id"]),
        "type": "sales-follow",
        "label": "业务员跟进",
        "level": _follow_up_level(ann.get("next_follow_up", ""), today),
        "title": f"项目「{_subject(ann)}...」需跟进",
        "targetId": ann["id"],
        "time": ann.get("next_follow_up", ""),
        "district": ann.get("district", ""),
        "annTitle": ann.get("title", ""),
        "annProgress": ann.get("progress", ""),
        "annCurrentHandler": ann.get("current_handler", ""),
    }


@router.get("")
def list_reminders(
    district: str = "",
    scope: str = "me",
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, Any]:
    scope = (scope or "me").strip().lower()
    if scope not in ("me", "all"):
        raise HTTPException(status_code=400, detail="scope 参数无效，只能是 me 或 all")
    if scope == "all":
        security.require_permission(user, "announcements:assign", "查看所有提醒")

    district = (district or "").strip()
    sql = "SELECT * FROM announcements WHERE progress != '已确认'"
    params: List[Any] = []
    if district:
        sql += " AND district = ?"
        params.append(district)
    sql += " ORDER BY id ASC"
    rows = db.query_all(sql, params)

    today = date.today()
    items: List[Dict[str, Any]] = []
    for ann in rows:
        progress = ann.get("progress") or ""
        if progress == "待分配":
            item = _to_admin_reminder(ann, today)
        elif progress == "已分配":
            item = _to_sales_reminder(ann, today)
        else:
            continue
        if scope == "me":
            # 自己名下的，或本小组名下的（成员被指派时小组管理员也能跟进）
            handler = ann.get("current_handler", "") or ""
            handler_group = ann.get("handler_group", "") or ""
            if handler != user.get("name", "") and not (
                handler_group and handler_group == user.get("group", "")
            ):
                continue
        items.append(item)

    # urgent > warn > info，同等级按 time 升序（ISO 字符串可直接比较）
    items.sort(key=lambda r: (LEVEL_RANK.get(r["level"], 9), r.get("time") or ""))

    counts = {"urgent": 0, "warn": 0, "info": 0}
    for item in items:
        if item["level"] in counts:
            counts[item["level"]] += 1
    return {"items": items, "total": len(items), "counts": counts}


SKIP_REASON_MAP = {
    "已确认公告不可再分配": "已确认",
    "公告不存在": "不存在",
}


def _skip_reason(reason: str) -> str:
    """把服务层原因收敛为契约文案（已确认 / 不存在）。"""
    return SKIP_REASON_MAP.get(reason, reason)


@router.post("/batch-assign")
def batch_assign(
    body: BatchAssignBody,
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, Any]:
    security.require_permission(user, "announcements:assign", "批量分配任务提醒")
    group_name = (body.group or "").strip()
    group = db.query_one("SELECT * FROM groups WHERE name = ?", (group_name,))
    if not group:
        raise HTTPException(status_code=404, detail="小组不存在")

    with db.get_conn() as conn:
        result = assignments.batch_assign(conn, body.ids, group["name"], user)

    items: List[Dict[str, Any]] = []
    for ann_id in result["ids"]:
        row = db.query_one("SELECT * FROM announcements WHERE id = ?", (ann_id,))
        if row:
            items.append(serializers.announcement_to_api(row))

    security.audit(
        user,
        "批量分配提醒",
        group["name"],
        "成功 {} 条，跳过 {} 条".format(result["updated"], len(result["skipped"])),
    )
    return {
        "updated": result["updated"],
        "skipped": [
            {"id": s["id"], "reason": _skip_reason(s["reason"])}
            for s in result["skipped"]
        ],
        "items": items,
    }
