"""公告路由：列表 / 详情 / 新增 / 全量修改 / 逻辑删除 / 商机字段更新 / 确认 / 进度 / 分配 / 批量分配 / 记录。

契约见 docs/api-contract.md 第 2 节，本文件只做参数校验与事务编排：
- 序列化统一走 `serializers.announcement_to_api`；
- 分配统一复用 `services.assignments.assign_one / batch_assign`；
- 所有接口需登录，分配/新增/修改/删除类接口额外要求集团客户部；
- 已逻辑删除（is_deleted=1）的公告默认不出现在列表/详情/统计中。
"""
from __future__ import annotations

import secrets
from datetime import date
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .. import db, security
from ..serializers import announcement_to_api
from ..services.assignments import assign_one, batch_assign

router = APIRouter(prefix="/api/announcements", tags=["announcements"])

PROGRESS_VALUES = ("待分配", "已分配", "已确认")

# 商机管理必填字段（与 demo/js/app.js REQUIRED_OPP_FIELDS 一致）
REQUIRED_OPP_FIELDS = (
    ("is_valid_opportunity", "是否有效商机"),
    ("has_operator_involvement", "是否有运营商参与"),
    ("opportunity_code", "商机编码"),
    ("will_bid", "是否应标"),
)

# PATCH 允许更新的字段：前端 camelCase -> 数据库列
PATCH_FIELDS = {
    "isValidOpportunity": "is_valid_opportunity",
    "hasOperatorInvolvement": "has_operator_involvement",
    "opportunityCode": "opportunity_code",
    "opportunityStatus": "opportunity_status",
    "willBid": "will_bid",
    "treePlacement": "tree_placement",
    "currentHandler": "current_handler",
    "nextFollowUp": "next_follow_up",
}

# PUT 全字段更新映射（前端 camelCase -> 数据库列）
PUT_FIELDS = {
    "title": "title",
    "projectName": "project_name",
    "projectCode": "project_code",
    "buyer": "buyer",
    "agency": "agency",
    "contact": "contact",
    "budget": "budget",
    "fundSource": "fund_source",
    "district": "district",
    "region": "region",
    "annType": "ann_type",
    "pubDate": "pub_date",
    "deadline": "deadline",
    "bidOpenDate": "bid_open_date",
    "purchaseMethod": "purchase_method",
    "summary": "summary",
    "sourceUrl": "source_url",
    "handlerGroup": "handler_group",
    "currentHandler": "current_handler",
    "progress": "progress",
    "nextFollowUp": "next_follow_up",
    "treePlacement": "tree_placement",
    "opportunityCode": "opportunity_code",
    "opportunityStatus": "opportunity_status",
    "isValidOpportunity": "is_valid_opportunity",
    "hasOperatorInvolvement": "has_operator_involvement",
    "willBid": "will_bid",
}

# 批量分配服务返回的中文原因 -> 契约约定的 skipped.reason
SKIP_REASON_MAP = {
    "已确认公告不可再分配": "已确认",
    "公告不存在": "不存在",
}


# ---------- 请求体 ----------
class AnnouncementPatchBody(BaseModel):
    isValidOpportunity: Optional[str] = None
    hasOperatorInvolvement: Optional[str] = None
    opportunityCode: Optional[str] = None
    opportunityStatus: Optional[str] = None
    willBid: Optional[str] = None
    treePlacement: Optional[str] = None
    currentHandler: Optional[str] = None
    nextFollowUp: Optional[str] = None


class AnnouncementFullBody(BaseModel):
    title: str = ""
    projectName: str = ""
    projectCode: str = ""
    buyer: str = ""
    agency: str = ""
    contact: str = ""
    budget: str = ""
    fundSource: str = ""
    district: str = ""
    region: str = ""
    annType: str = ""
    pubDate: str = ""
    deadline: str = ""
    bidOpenDate: str = ""
    purchaseMethod: str = ""
    summary: str = ""
    sourceUrl: str = ""
    handlerGroup: str = ""
    currentHandler: str = ""
    progress: str = "待分配"
    nextFollowUp: str = ""
    treePlacement: str = ""
    opportunityCode: str = ""
    opportunityStatus: str = ""
    isValidOpportunity: str = ""
    hasOperatorInvolvement: str = ""
    willBid: str = ""
    # 非表单字段（后端维护）允许传入但会忽略
    matchedKeywords: Optional[List[str]] = None
    businessTags: Optional[List[str]] = None
    contacts: Optional[Dict[str, Any]] = None


class ProgressBody(BaseModel):
    progress: str
    note: Optional[str] = None


class AssignBody(BaseModel):
    group: str
    receiver: Optional[str] = None


class BatchAssignBody(BaseModel):
    ids: List[str] = []
    group: str
    receiver: Optional[str] = None


# ---------- 辅助 ----------
def _today() -> str:
    return date.today().isoformat()


def _ann_id_exists(ann_id: str) -> bool:
    row = db.query_one(
        "SELECT 1 FROM announcements WHERE id = ? AND is_deleted = 0", (ann_id,)
    )
    return row is not None


def _get_ann_row(ann_id: str) -> Dict[str, Any]:
    row = db.query_one(
        "SELECT * FROM announcements WHERE id = ? AND is_deleted = 0", (ann_id,)
    )
    if not row:
        raise HTTPException(status_code=404, detail="公告不存在")
    return row


def _progress_records(ann_id: str) -> List[Dict[str, Any]]:
    return db.query_all(
        "SELECT * FROM progress_records WHERE ann_id = ? ORDER BY id ASC", (ann_id,)
    )


def _assignment_records(ann_id: str) -> List[Dict[str, Any]]:
    return db.query_all(
        "SELECT * FROM assignment_records WHERE ann_id = ? ORDER BY id ASC", (ann_id,)
    )


def _detail(ann_id: str) -> Dict[str, Any]:
    """详情序列化：带 progressRecords / assignmentRecords。"""
    row = _get_ann_row(ann_id)
    return announcement_to_api(
        row,
        progress_records=_progress_records(ann_id),
        assignment_records=_assignment_records(ann_id),
    )


def _stats() -> Dict[str, int]:
    """全库统计（与 Demo getStats 口径一致，不受列表筛选影响）。"""
    row = db.query_one(
        """
        SELECT
            SUM(CASE WHEN pub_date = ? AND is_deleted = 0 THEN 1 ELSE 0 END) AS today_count,
            SUM(CASE WHEN (progress = '待分配' OR current_handler = '') AND is_deleted = 0 THEN 1 ELSE 0 END)
                AS unassigned_count,
            SUM(CASE WHEN progress = '已分配' AND is_deleted = 0 THEN 1 ELSE 0 END) AS in_progress_count,
            SUM(CASE WHEN progress = '已确认' AND is_deleted = 0 THEN 1 ELSE 0 END) AS confirmed_count
        FROM announcements
        """,
        (_today(),),
    ) or {}
    return {
        "todayCount": int(row.get("today_count") or 0),
        "unassignedCount": int(row.get("unassigned_count") or 0),
        "inProgressCount": int(row.get("in_progress_count") or 0),
        "confirmedCount": int(row.get("confirmed_count") or 0),
    }


def _gen_ann_id() -> str:
    """生成形如 ANN1719283746 的公告编号，极端冲突时再生成一次。"""
    for _ in range(3):
        suffix = str(int(date.today().strftime("%y%m%d")) * 10**6 + secrets.randbelow(10**6))
        aid = f"ANN{suffix}"
        if not db.query_one("SELECT 1 FROM announcements WHERE id = ?", (aid,)):
            return aid
    return f"ANN{date.today().strftime('%y%m%d%H%M%S')}{secrets.randbelow(1000):03d}"


def _validate_form_body(body: AnnouncementFullBody) -> None:
    """保存前不做强校验，只提醒。空字符串、progress 非法值等让前端弹窗处理。"""
    if body.progress and body.progress not in PROGRESS_VALUES:
        # 不报错，前端提醒后用户确认即可
        pass


def _body_to_db_fields(body: AnnouncementFullBody) -> Dict[str, Any]:
    """表单 body → 数据库字段 dict（忽略 matchedKeywords / businessTags / contacts 等非表单字段）。"""
    data = body.model_dump(exclude_unset=False)
    fields: Dict[str, Any] = {}
    for camel, snake in PUT_FIELDS.items():
        val = data.get(camel)
        fields[snake] = val if val is not None else ""
    # 处理列表/字典 → JSON 字符串
    kw = data.get("matchedKeywords") or []
    tags = data.get("businessTags") or []
    contacts = data.get("contacts") or {}
    fields["matched_keywords"] = db.dumps(kw) if isinstance(kw, list) else db.dumps([])
    fields["business_tags"] = db.dumps(tags) if isinstance(tags, list) else db.dumps([])
    fields["contacts_json"] = db.dumps(contacts) if isinstance(contacts, dict) else db.dumps({})
    return fields


# ---------- 路由 ----------
@router.get("")
def list_announcements(
    keyword: str = "",
    region: str = "",
    district: str = "",
    progress: str = "",
    bid_status: str = "",
    business_tag: str = "",
    page: int = 1,
    page_size: int = 10,
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, Any]:
    """公告列表：筛选 → 内存过滤 bidStatus/businessTag → 分页；page_size=0 返回全部。"""
    conditions: List[str] = ["is_deleted = 0"]
    params: List[Any] = []
    if region:
        conditions.append("region = ?")
        params.append(region)
    if district:
        conditions.append("district = ?")
        params.append(district)
    if progress:
        conditions.append("progress = ?")
        params.append(progress)
    if keyword:
        like = f"%{keyword}%"
        conditions.append(
            "(title LIKE ? OR project_name LIKE ? OR buyer LIKE ? OR matched_keywords LIKE ?)"
        )
        params.extend([like, like, like, like])

    sql = "SELECT * FROM announcements"
    sql += " WHERE " + " AND ".join(conditions)
    sql += " ORDER BY pub_date DESC, id DESC"

    rows = db.query_all(sql, params)
    items = [announcement_to_api(row) for row in rows]
    # bid_status / business_tag 依赖派生字段或 JSON 数组，在分页前内存过滤
    if bid_status:
        items = [item for item in items if item["bidStatus"] == bid_status]
    if business_tag:
        items = [item for item in items if business_tag in item["businessTags"]]

    total = len(items)
    page = max(1, int(page or 1))
    page_size = max(0, int(page_size if page_size is not None else 10))
    if page_size == 0:
        page_items = items
    else:
        start = (page - 1) * page_size
        page_items = items[start:start + page_size]

    return {
        "items": page_items,
        "total": total,
        "page": page,
        "pageSize": page_size,
        "stats": _stats(),
    }


@router.post("")
def create_announcement(
    body: AnnouncementFullBody,
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, Any]:
    """新增公告（集团客户部）。"""
    security.require_jitubu(user, "新增公告")
    _validate_form_body(body)
    fields = _body_to_db_fields(body)
    fields["id"] = _gen_ann_id()

    assignments = ", ".join(f"{k} = ?" for k in fields)
    params = list(fields.values())
    db.execute(
        f"INSERT INTO announcements ({', '.join(fields.keys())}) VALUES ({', '.join(['?'] * len(fields))})",
        params,
    )
    security.audit(user, "新增公告", fields["id"],
                   f"项目：{fields.get('project_name') or fields.get('title')}")
    return _detail(fields["id"])


@router.get("/{ann_id}")
def get_announcement(
    ann_id: str,
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, Any]:
    return _detail(ann_id)


@router.put("/{ann_id}")
def update_announcement_full(
    ann_id: str,
    body: AnnouncementFullBody,
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, Any]:
    """全字段修改（集团客户部），覆盖商机管理的 PATCH 之外的场景。"""
    security.require_jitubu(user, "修改公告")
    _get_ann_row(ann_id)  # 存在性检查
    _validate_form_body(body)
    fields = _body_to_db_fields(body)
    # id / created_at / confirmed_at / is_deleted / deleted_at 不在表单里，不由 PUT 改
    for k in ("id", "created_at", "confirmed_at", "is_deleted", "deleted_at"):
        fields.pop(k, None)
    fields["updated_at"] = None  # 下面 SQL 直接写 datetime('now', 'localtime')

    assignments_parts = []
    params: List[Any] = []
    for k, v in fields.items():
        assignments_parts.append(f"{k} = ?")
        params.append(v)
    assignments_parts.append("updated_at = datetime('now', 'localtime')")
    params.append(ann_id)

    db.execute(
        f"UPDATE announcements SET {', '.join(assignments_parts)} WHERE id = ?",
        params,
    )
    security.audit(user, "修改公告", ann_id, f"项目：{fields.get('project_name') or fields.get('title')}")
    return _detail(ann_id)


@router.delete("/{ann_id}")
def delete_announcement(
    ann_id: str,
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, Any]:
    """逻辑删除（集团客户部）。已确认的公告允许删除（业务上确实需要"无法恢复"，但数据保留）。"""
    security.require_jitubu(user, "删除公告")
    row = db.query_one("SELECT is_deleted, project_name, title FROM announcements WHERE id = ?", (ann_id,))
    if not row:
        raise HTTPException(status_code=404, detail="公告不存在")
    if row.get("is_deleted"):
        raise HTTPException(status_code=400, detail="公告已删除")
    db.execute(
        "UPDATE announcements SET is_deleted = 1, deleted_at = datetime('now', 'localtime'), "
        "updated_at = datetime('now', 'localtime') WHERE id = ?",
        (ann_id,),
    )
    security.audit(
        user, "删除公告（逻辑）", ann_id,
        f"项目：{row.get('project_name') or row.get('title')}"
    )
    return {"ok": True, "id": ann_id}


@router.get("/{ann_id}/records")
def get_announcement_records(
    ann_id: str,
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, Any]:
    ann = _detail(ann_id)
    return {
        "progressRecords": ann["progressRecords"],
        "assignmentRecords": ann["assignmentRecords"],
    }


@router.patch("/{ann_id}")
def update_announcement(
    ann_id: str,
    body: AnnouncementPatchBody = AnnouncementPatchBody(),
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, Any]:
    _get_ann_row(ann_id)
    submitted = body.model_dump(exclude_unset=True)
    updates = {
        PATCH_FIELDS[key]: value
        for key, value in submitted.items()
        if key in PATCH_FIELDS and value is not None
    }
    if not updates:
        raise HTTPException(status_code=400, detail="请至少提交一个可更新的商机字段")

    assignments = ", ".join(f"{column} = ?" for column in updates)
    params: List[Any] = list(updates.values()) + [ann_id]
    db.execute(
        f"UPDATE announcements SET {assignments}, "
        "updated_at = datetime('now', 'localtime') WHERE id = ?",
        params,
    )
    security.audit(
        user, "更新公告", ann_id, "更新字段：" + "、".join(submitted.keys())
    )
    return _detail(ann_id)


@router.post("/{ann_id}/confirm")
def confirm_announcement(
    ann_id: str,
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, Any]:
    row = _get_ann_row(ann_id)
    missing = [
        label
        for column, label in REQUIRED_OPP_FIELDS
        if not str(row.get(column) or "").strip()
    ]
    if missing:
        raise HTTPException(
            status_code=400,
            detail="请先完善以下必填项：\n  - " + "\n  - ".join(missing),
        )

    db.execute(
        """UPDATE announcements
           SET progress = '已确认',
               confirmed_at = datetime('now', 'localtime'),
               updated_at = datetime('now', 'localtime')
           WHERE id = ?""",
        (ann_id,),
    )
    db.execute(
        """INSERT INTO progress_records (ann_id, progress, follower, follow_date, note)
           VALUES (?, '已确认', ?, ?, '商机信息已完整确认')""",
        (ann_id, user.get("name", ""), _today()),
    )
    security.audit(user, "确认商机", ann_id, "商机信息已完整确认")
    return _detail(ann_id)


@router.post("/{ann_id}/progress")
def update_progress(
    ann_id: str,
    body: ProgressBody,
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, Any]:
    if body.progress not in PROGRESS_VALUES:
        raise HTTPException(status_code=400, detail="无效的进度状态")
    _get_ann_row(ann_id)

    note = body.note or ""
    db.execute(
        """INSERT INTO progress_records (ann_id, progress, follower, follow_date, note)
           VALUES (?, ?, ?, ?, ?)""",
        (ann_id, body.progress, user.get("name", ""), _today(), note),
    )
    if body.progress == "已确认":
        db.execute(
            """UPDATE announcements
               SET progress = ?, confirmed_at = datetime('now', 'localtime'),
                   updated_at = datetime('now', 'localtime')
               WHERE id = ?""",
            (body.progress, ann_id),
        )
    else:
        db.execute(
            """UPDATE announcements
               SET progress = ?, updated_at = datetime('now', 'localtime')
               WHERE id = ?""",
            (body.progress, ann_id),
        )
    security.audit(user, "更新进度", ann_id, f"{body.progress}：{note}")
    return _detail(ann_id)


@router.post("/{ann_id}/assign")
def assign_announcement(
    ann_id: str,
    body: AssignBody,
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, Any]:
    security.require_group_admin(user)
    group_name = (body.group or "").strip()

    with db.get_conn() as conn:
        ok, reason = assign_one(
            conn, ann_id, group_name, user, receiver=(body.receiver or "").strip()
        )
    if not ok:
        if reason in ("公告不存在", "小组不存在"):
            raise HTTPException(status_code=404, detail=reason)
        raise HTTPException(status_code=400, detail=reason)

    security.audit(user, "分配任务", ann_id, f"分配给{group_name}")
    return _detail(ann_id)


@router.post("/batch-assign")
def batch_assign_announcements(
    body: BatchAssignBody,
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, Any]:
    security.require_group_admin(user)
    group_name = (body.group or "").strip()

    with db.get_conn() as conn:
        result = batch_assign(
            conn, body.ids, group_name, user, receiver=(body.receiver or "").strip()
        )

    skipped = [
        {"id": item["id"], "reason": SKIP_REASON_MAP.get(item["reason"], item["reason"])}
        for item in result["skipped"]
    ]
    items = [_detail(ann_id) for ann_id in result["ids"]]
    security.audit(user, "批量分配", "", f"分配给{group_name}，成功{result['updated']}条")
    return {"updated": result["updated"], "items": items, "skipped": skipped}
