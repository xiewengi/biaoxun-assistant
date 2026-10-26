"""数据库行 → 前端 JSON 的序列化（统一在这里，避免各路由字段漂移）。"""
from __future__ import annotations

from datetime import date, datetime
from typing import Any, Dict, List, Optional

from .db import loads_maybe


def compute_bid_status(ann: Dict[str, Any]) -> str:
    """与 demo/js/app.js computeBidStatus 完全一致。"""
    ann_type = ann.get("annType") or ""
    if "意向" in ann_type:
        return "意向"
    open_date = ann.get("bidOpenDate") or ""
    if not open_date or open_date == "—":
        return "挂网"
    try:
        open_d = datetime.strptime(open_date[:10], "%Y-%m-%d").date()
    except ValueError:
        return "挂网"
    today = date.today()
    if open_d < today:
        return "截止报名"
    if open_d == today:
        return "开标"
    return "挂网"


def progress_record_to_api(row: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": row.get("id"),
        "progress": row.get("progress", ""),
        "follower": row.get("follower", ""),
        "followDate": row.get("follow_date", ""),
        "note": row.get("note", ""),
        "attachment": row.get("attachment", ""),
    }


def assignment_to_api(row: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": row.get("id"),
        "assigner": row.get("assigner", ""),
        "assignerGroup": row.get("assigner_group", ""),
        "assignee": row.get("assignee", ""),
        "assigneeGroup": row.get("assignee_group", ""),
        "assignedAt": row.get("assigned_at", ""),
        "note": row.get("note", ""),
    }


def announcement_to_api(
    row: Dict[str, Any],
    progress_records: Optional[List[Dict[str, Any]]] = None,
    assignment_records: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    ann = {
        "id": row["id"],
        "title": row.get("title", ""),
        "projectName": row.get("project_name", ""),
        "projectCode": row.get("project_code", ""),
        "buyer": row.get("buyer", ""),
        "agency": row.get("agency", ""),
        "budget": row.get("budget", ""),
        "fundSource": row.get("fund_source", ""),
        "district": row.get("district", ""),
        "annType": row.get("ann_type", ""),
        "pubDate": row.get("pub_date", ""),
        "deadline": row.get("deadline", ""),
        "bidOpenDate": row.get("bid_open_date", ""),
        "summary": row.get("summary", ""),
        "contact": row.get("contact", ""),
        "contacts": loads_maybe(row.get("contacts_json"), {}),
        "sourceUrl": row.get("source_url", ""),
        "region": row.get("region", ""),
        "purchaseMethod": row.get("purchase_method", ""),
        "matchedKeywords": loads_maybe(row.get("matched_keywords"), []),
        "businessTags": loads_maybe(row.get("business_tags"), []),
        "isValidOpportunity": row.get("is_valid_opportunity", ""),
        "hasOperatorInvolvement": row.get("has_operator_involvement", ""),
        "opportunityCode": row.get("opportunity_code", ""),
        "opportunityStatus": row.get("opportunity_status", ""),
        "willBid": row.get("will_bid", ""),
        "treePlacement": row.get("tree_placement", ""),
        "currentHandler": row.get("current_handler", ""),
        "handlerGroup": row.get("handler_group", ""),
        "progress": row.get("progress", "待分配"),
        "createdAt": row.get("created_at", ""),
        "nextFollowUp": row.get("next_follow_up", ""),
        "confirmedAt": row.get("confirmed_at", "") or None,
        "updatedAt": row.get("updated_at", ""),
    }
    ann["bidStatus"] = compute_bid_status(ann)
    if progress_records is not None:
        ann["progressRecords"] = [progress_record_to_api(r) for r in progress_records]
    if assignment_records is not None:
        ann["assignmentRecords"] = [assignment_to_api(r) for r in assignment_records]
    return ann


def group_to_api(row: Dict[str, Any], members: List[Dict[str, Any]]) -> Dict[str, Any]:
    return {
        "id": row["id"],
        "name": row.get("name", ""),
        "region": row.get("region", ""),
        "admin": row.get("admin", ""),
        "adminContact": row.get("admin_contact", ""),
        "adminAccount": row.get("admin_account", ""),
        "position": row.get("position", ""),
        "createdAt": row.get("created_at", ""),
        "members": [m.get("name", "") for m in members],
        "memberPinyin": [m.get("name_pinyin", "") for m in members],
        "memberContacts": [m.get("contact", "") for m in members],
        "memberDetails": [
            {
                "id": m.get("id"),
                "name": m.get("name", ""),
                "namePinyin": m.get("name_pinyin", ""),
                "contact": m.get("contact", ""),
                "position": m.get("position", ""),
            }
            for m in members
        ],
    }


def source_to_api(row: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": row["id"],
        "name": row.get("name", ""),
        "url": row.get("url", ""),
        "domain": row.get("domain", ""),
        "sourceCode": row.get("source_code", "generic"),
        "enabled": bool(row.get("enabled")),
        "lastStatus": row.get("last_status", ""),
        "lastHttpCode": row.get("last_http_code"),
        "lastLatencyMs": row.get("last_latency_ms"),
        "lastCheckedAt": row.get("last_checked_at", ""),
        "lastMessage": row.get("last_message", ""),
        "lastFoundLinks": row.get("last_found_links", 0),
        "lastMatchedLinks": row.get("last_matched_links", 0),
    }


def schedule_to_api(row: Dict[str, Any]) -> Dict[str, Any]:
    keywords = loads_maybe(row.get("keyword_list"), [])
    return {
        "keywordList": keywords,
        "keywordText": "、".join(keywords),
        "crawlInterval": row.get("crawl_interval", ""),
        "reminderInterval": row.get("reminder_interval", ""),
        "crawlStatus": row.get("crawl_status", ""),
        "crawlDays": row.get("crawl_days", 3),
        "updatedAt": row.get("updated_at", ""),
    }
