"""公告路由：列表 / 详情 / 新增 / 全量修改 / 逻辑删除 / 商机字段更新 / 确认 / 进度 / 分配 / 批量分配 / 记录 / 模板下载 / Excel 批量导入。

契约见 docs/api-contract.md 第 2 节，本文件只做参数校验与事务编排：
- 序列化统一走 `serializers.announcement_to_api`；
- 分配统一复用 `services.assignments.assign_one / batch_assign`；
- 所有接口需登录，分配/新增/修改/删除/导入类接口额外要求集团客户部；
- 已逻辑删除（is_deleted=1）的公告默认不出现在列表/详情/统计中。
"""
from __future__ import annotations

import io
import secrets
from datetime import date, datetime
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from .. import db, security
from ..serializers import announcement_to_api
from ..services.assignments import assign_one, batch_assign

router = APIRouter(prefix="/api/announcements", tags=["announcements"])

PROGRESS_VALUES = ("待分配", "已分配", "已确认")

# 商机管理必填字段（与 web/js/app.js REQUIRED_OPP_FIELDS 一致）
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
    # 根据采购人自动匹配区县（仅当用户未显式填 district 时）
    _auto_match_district(fields)
    return fields


def _auto_match_district(fields: Dict[str, Any]) -> None:
    """如果 district 为空，拿 buyer 查 buyer_district 表自动补（用 SHA-256 哈希匹配密文表）。"""
    if fields.get("district"):  # 用户已填，尊重
        return
    buyer = (fields.get("buyer") or "").strip()
    if not buyer:
        return
    from .. import crypto
    h = crypto.sha256_hex(buyer)
    row = db.query_one(
        "SELECT district FROM buyer_district WHERE buyer_hash = ? LIMIT 1",
        (h,),
    )
    if row and row.get("district"):
        fields["district"] = row["district"]


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
    security.require_permission(user, "announcements:create", "新增公告")
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


@router.post("/{ann_id}/assign")
def assign_announcement(
    ann_id: str,
    body: AssignBody,
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, Any]:
    security.require_any_permission(user, "announcements:assign", "announcements:update")
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
    security.require_any_permission(user, "announcements:assign", "announcements:update")
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


# ---------- Excel 模板 & 批量导入 ----------

# 导入模板列顺序（中文表头 + 英文别名，匹配 Excel 里用户可能填的写法）
TEMPLATE_COLUMNS: List[Tuple[str, str, bool]] = [
    # (数据库列名, 中文表头, 必填)
    ("project_name", "项目名称", True),
    ("title", "公告标题", True),
    ("project_code", "项目编号", False),
    ("buyer", "采购人", False),
    ("agency", "采购代理机构", False),
    ("budget", "预算金额", False),
    ("fund_source", "资金来源", False),
    ("district", "区县", False),
    ("region", "地市", False),
    ("ann_type", "公告类型", False),
    ("pub_date", "发布日期", False),
    ("deadline", "报名截止", False),
    ("bid_open_date", "开标时间", False),
    ("purchase_method", "采购方式", False),
    ("summary", "公告摘要", False),
    ("contact", "联系人", False),
    ("source_url", "公告链接", False),
    ("opportunity_code", "商机编码", False),
    ("opportunity_status", "商机状态", False),
    ("is_valid_opportunity", "是否有效商机", False),
    ("has_operator_involvement", "是否运营商参与", False),
    ("will_bid", "是否应标", False),
    ("tree_placement", "树状层级", False),
    ("current_handler", "当前跟进人", False),
    ("handler_group", "跟进小组", False),
    ("next_follow_up", "下一步跟进", False),
    ("progress", "进度", False),
]

# 中文表头 → DB 列名的显式映射（支持别名）
_HEADER_TO_DB: Dict[str, str] = {
    "项目名称": "project_name",
    "公告标题": "title",
    "标题": "title",
    "项目编号": "project_code",
    "采购人": "buyer",
    "招标人": "buyer",
    "采购代理机构": "agency",
    "代理机构": "agency",
    "预算金额": "budget",
    "预算": "budget",
    "资金来源": "fund_source",
    "区县": "district",
    "地市": "region",
    "地区": "region",
    "公告类型": "ann_type",
    "发布日期": "pub_date",
    "公告日期": "pub_date",
    "报名截止": "deadline",
    "截止时间": "deadline",
    "开标时间": "bid_open_date",
    "采购方式": "purchase_method",
    "公告摘要": "summary",
    "摘要": "summary",
    "联系人": "contact",
    "公告链接": "source_url",
    "链接": "source_url",
    "商机编码": "opportunity_code",
    "商机状态": "opportunity_status",
    "是否有效商机": "is_valid_opportunity",
    "是否运营商参与": "has_operator_involvement",
    "运营商参与": "has_operator_involvement",
    "是否应标": "will_bid",
    "应标": "will_bid",
    "树状层级": "tree_placement",
    "当前跟进人": "current_handler",
    "跟进人": "current_handler",
    "跟进小组": "handler_group",
    "小组": "handler_group",
    "下一步跟进": "next_follow_up",
    "进度": "progress",
    # 英文兜底
    "projectName": "project_name",
    "projectName": "project_name",
    "annType": "ann_type",
    "pubDate": "pub_date",
    "deadline": "deadline",
    "bidOpenDate": "bid_open_date",
    "fundSource": "fund_source",
    "sourceUrl": "source_url",
    "purchaseMethod": "purchase_method",
    "opportunityCode": "opportunity_code",
    "opportunityStatus": "opportunity_status",
    "isValidOpportunity": "is_valid_opportunity",
    "hasOperatorInvolvement": "has_operator_involvement",
    "willBid": "will_bid",
    "treePlacement": "tree_placement",
    "currentHandler": "current_handler",
    "handlerGroup": "handler_group",
    "nextFollowUp": "next_follow_up",
}

# 需要"是/否"的二值字段
_BOOLEAN_LIKE_COLS = {
    "is_valid_opportunity",
    "has_operator_involvement",
    "will_bid",
}

# progress 允许值
_PROGRESS_ALLOWED = {"", "待分配", "已分配", "已确认"}

# 日期列名（需要把 Excel date / text 统一成 YYYY-MM-DD）
_DATE_COLS = {"pub_date", "deadline", "bid_open_date", "next_follow_up"}


def _build_template_bytes() -> bytes:
    """生成导入模板 xlsx 二进制。含 1 行表头 + 1 行示例数据（浅灰）。"""
    try:
        from openpyxl import Workbook
        from openpyxl.styles import Alignment, Font, PatternFill
    except ImportError:
        raise HTTPException(status_code=500, detail="服务端缺少 openpyxl 依赖")

    wb = Workbook()
    ws = wb.active
    ws.title = "招标公告导入模板"

    # 表头
    header_font = Font(bold=True, color="FFFFFF")
    header_fill = PatternFill("solid", fgColor="3B82F6")
    required_fill = PatternFill("solid", fgColor="FEE2E2")
    center = Alignment(horizontal="center", vertical="center", wrap_text=True)

    for idx, (_, zh_name, required) in enumerate(TEMPLATE_COLUMNS, start=1):
        cell = ws.cell(row=1, column=idx, value=zh_name + (" *" if required else ""))
        cell.font = header_font
        cell.fill = header_fill if required else required_fill
        cell.alignment = center

    # 第 2 行：示例
    example_values: List[Any] = [
        "某镇智慧园区一期建设项目",
        "智慧园区一期建设项目采购公告",
        "445100-2026-01234",
        "潮州市某镇人民政府",
        "潮州某某咨询有限公司",
        "2,000,000元",
        "财政资金",
        "潮安",
        "潮州",
        "采购公告",
        "2026-10-27",
        "2026-11-05",
        "2026-11-06",
        "竞争性磋商",
        "建设智慧园区基础设施及平台",
        "张先生 0768-12345678",
        "https://gdgpo.czt.gd.gov.cn/notice?id=example",
        "BD20261027001",
        "跟进中",
        "是",
        "否",
        "是",
        "潮州/园区/一期",
        "张三",
        "政企事业部",
        "2026-10-30",
        "待分配",
    ]
    gray_font = Font(color="9CA3AF", italic=True)
    for idx, val in enumerate(example_values, start=1):
        c = ws.cell(row=2, column=idx, value=val)
        c.font = gray_font
        c.alignment = Alignment(vertical="center", wrap_text=True)

    # 列宽
    widths = [24, 36, 20, 26, 26, 16, 14, 10, 10, 12, 12, 12, 12, 12, 28, 22, 44, 16, 12, 14, 16, 10, 22, 14, 12, 14, 10]
    for idx, w in enumerate(widths, start=1):
        ws.column_dimensions[chr(64 + idx) if idx <= 26 else "A" + chr(64 + idx - 26)].width = w

    # 冻结首行
    ws.freeze_panes = "A2"

    # 第 3 行起留空
    buf = io.BytesIO()
    wb.save(buf)
    wb.close()
    return buf.getvalue()


def _normalize_date(value: Any) -> str:
    """把 Excel date / datetime / 字符串统一成 YYYY-MM-DD；非法返回空串。"""
    if value is None:
        return ""
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    s = str(value).strip()
    if not s or s in ("—", "-", "/", "--"):
        return ""
    # 兼容 2026/10/27、2026.10.27、2026-10-27
    s2 = s.replace("/", "-").replace(".", "-")
    try:
        return datetime.strptime(s2[:10], "%Y-%m-%d").date().isoformat()
    except ValueError:
        return ""


def _normalize_yes_no(value: Any) -> str:
    """是/否/空；接受 y/Y/1/true 作为是。"""
    if value is None:
        return ""
    s = str(value).strip()
    if not s:
        return ""
    if s.lower() in ("y", "yes", "true", "1", "是"):
        return "是"
    if s.lower() in ("n", "no", "false", "0", "否"):
        return "否"
    return s  # 原样透传，后面让业务层决定


def _row_to_fields(row: Dict[str, Any]) -> Dict[str, Any]:
    """把一条 Excel 行（已转成 db 列名 dict）清洗成可入库字段。"""
    fields: Dict[str, Any] = {}
    for col, val in row.items():
        if col in _DATE_COLS:
            fields[col] = _normalize_date(val)
        elif col in _BOOLEAN_LIKE_COLS:
            fields[col] = _normalize_yes_no(val)
        else:
            fields[col] = str(val).strip() if val is not None else ""
    # 兜底：title 空 → 用 project_name
    if not fields.get("title") and fields.get("project_name"):
        fields["title"] = fields["project_name"]
    if not fields.get("project_name") and fields.get("title"):
        fields["project_name"] = fields["title"]
    # progress 非法 → 默认"待分配"
    progress = fields.get("progress") or ""
    if progress and progress not in _PROGRESS_ALLOWED:
        fields["progress"] = "待分配"
    elif not progress:
        fields["progress"] = "待分配"
    return fields


def _existing_id_for_match(conn, fields: Dict[str, Any]) -> Optional[str]:
    """按 project_code + source_url 或 title+buyer+pub_date 查重，返回已有 id（已逻辑删除的也匹配，避免再次导入）。"""
    project_code = (fields.get("project_code") or "").strip()
    source_url = (fields.get("source_url") or "").strip()
    if project_code and source_url:
        row = conn.execute(
            "SELECT id FROM announcements WHERE project_code = ? AND source_url = ? LIMIT 1",
            (project_code, source_url),
        ).fetchone()
        if row:
            return row["id"]
    title = (fields.get("title") or "").strip()
    buyer = (fields.get("buyer") or "").strip()
    pub_date = (fields.get("pub_date") or "").strip()
    if title and buyer and pub_date:
        row = conn.execute(
            "SELECT id FROM announcements WHERE title = ? AND buyer = ? AND pub_date = ? LIMIT 1",
            (title, buyer, pub_date),
        ).fetchone()
        if row:
            return row["id"]
    return None


def _auto_match_district_for_fields(fields: Dict[str, Any], conn) -> None:
    """同路由内 _auto_match_district 的连接版本（复用 buyer_district 哈希匹配）。"""
    if fields.get("district"):
        return
    buyer = (fields.get("buyer") or "").strip()
    if not buyer:
        return
    from .. import crypto
    h = crypto.sha256_hex(buyer)
    row = conn.execute(
        "SELECT district FROM buyer_district WHERE buyer_hash = ? LIMIT 1",
        (h,),
    ).fetchone()
    if row and row[0]:
        fields["district"] = row[0]


@router.get("/import-template.xlsx")
def download_import_template(
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> StreamingResponse:
    """下载招标公告批量导入模板（.xlsx，含表头+示例行）。浏览器通过 query param token 也能鉴权。"""
    security.require_permission(user, "announcements:import", "下载导入模板")
    content = _build_template_bytes()
    filename = f"announcement_import_template_{date.today().isoformat()}.xlsx"
    return StreamingResponse(
        io.BytesIO(content),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "no-store",
        },
    )


@router.post("/import-excel")
async def import_announcements_excel(
    file: UploadFile = File(...),
    skip_duplicates: bool = Form(True),
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, Any]:
    """上传 Excel，批量导入招标公告。

    - skip_duplicates=true（默认）：已存在的公告跳过
    - skip_duplicates=false：已存在的公告覆盖更新（以 Excel 为准，id/创建时间保留）
    - 查重键：先看 project_code + source_url，再看 title + buyer + pub_date
    - 必填：项目名称、公告标题；progress 非法值会被静默降级为「待分配」
    - 采购人-区县能自动匹配（复用 buyer_district）
    """
    security.require_permission(user, "announcements:import", "批量导入")

    filename = (file.filename or "").lower()
    if not filename.endswith((".xlsx", ".xls")):
        raise HTTPException(status_code=400, detail="只支持 .xlsx / .xls 格式")

    try:
        from openpyxl import load_workbook
    except ImportError:
        raise HTTPException(status_code=500, detail="服务端缺少 openpyxl 依赖")

    content = await file.read()
    try:
        wb = load_workbook(io.BytesIO(content), read_only=True, data_only=True)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Excel 解析失败：{e}")

    ws = wb.active
    rows_iter = ws.iter_rows(values_only=True)
    header = next(rows_iter, None)
    if not header:
        raise HTTPException(status_code=400, detail="Excel 为空，请检查文件")

    header_list = [str(c).strip() if c is not None else "" for c in header]
    # 列索引映射：db_col → excel_col_index
    col_idx: Dict[str, int] = {}
    for i, h in enumerate(header_list):
        if not h:
            continue
        # 模板里必填列会带 " *" 后缀，trim 掉再匹配
        h_clean = h
        if h.endswith(" *"):
            h_clean = h[:-2].strip()
        db_col = _HEADER_TO_DB.get(h_clean) or _HEADER_TO_DB.get(h)
        if db_col:
            col_idx[db_col] = i

    missing_required = [zh for db_col, zh, req in TEMPLATE_COLUMNS
                        if req and db_col not in col_idx]
    if missing_required:
        raise HTTPException(
            status_code=400,
            detail=(
                "Excel 表头缺少必填列：" + "、".join(missing_required)
                + "。请下载最新模板导入：/api/announcements/import-template.xlsx"
            ),
        )

    # 一次性取出现有公告的 (project_code, source_url, id) 和 (title, buyer, pub_date, id)
    # 用内存 dict 加速查重，避免每行都查一次
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    created = 0
    updated = 0
    skipped = 0
    errors: List[Dict[str, Any]] = []

    with db.get_conn() as conn:
        for line_no, row in enumerate(rows_iter, start=2):
            if not row or all(c is None or str(c).strip() == "" for c in row):
                continue

            raw: Dict[str, Any] = {}
            for db_col, idx in col_idx.items():
                raw[db_col] = row[idx] if idx < len(row) else None

            # 先粗校验必填
            project_name_v = raw.get("project_name")
            title_v = raw.get("title")
            if (project_name_v is None or str(project_name_v).strip() == "") \
                    and (title_v is None or str(title_v).strip() == ""):
                errors.append({"line": line_no, "reason": "项目名称与公告标题不能同时为空"})
                continue

            try:
                fields = _row_to_fields(raw)
            except Exception as e:
                errors.append({"line": line_no, "reason": f"字段清洗异常：{e}"})
                continue

            # 自动匹配区县
            _auto_match_district_for_fields(fields, conn)

            existing_id = _existing_id_for_match(conn, fields)
            if existing_id is None:
                # 新建
                ann_id = _gen_ann_id()
                fields["id"] = ann_id
                keys = list(fields.keys())
                conn.execute(
                    f"INSERT INTO announcements ({', '.join(keys)}) VALUES ({', '.join(['?'] * len(keys))})",
                    [fields[k] for k in keys],
                )
                created += 1
            else:
                if skip_duplicates:
                    skipped += 1
                else:
                    # 覆盖更新：保留 id / created_at / confirmed_at
                    for k in ("id", "created_at", "confirmed_at", "is_deleted", "deleted_at"):
                        fields.pop(k, None)
                    assignments = [f"{k} = ?" for k in fields.keys()]
                    assignments.append("updated_at = ?")
                    params = list(fields.values()) + [now_str, existing_id]
                    conn.execute(
                        f"UPDATE announcements SET {', '.join(assignments)} WHERE id = ?",
                        params,
                    )
                    # 如果这条被覆盖的公告原来是逻辑删除，恢复它
                    conn.execute(
                        "UPDATE announcements SET is_deleted = 0, deleted_at = '' WHERE id = ?",
                        (existing_id,),
                    )
                    updated += 1

    wb.close()
    security.audit(
        user, "批量导入招标公告", file.filename or "excel",
        f"新增{created}，更新{updated}，跳过{skipped}，异常{len(errors)}"
    )
    return {
        "ok": True,
        "created": created,
        "updated": updated,
        "skipped": skipped,
        "errors": errors[:100],  # 最多回传 100 条错误，避免响应体过大
        "total_errors": len(errors),
    }
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
    security.require_permission(user, "announcements:update", "修改公告")
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
    security.require_permission(user, "announcements:delete", "删除公告")
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


