"""种子数据：首次启动把 Demo 里的公告 / 小组 / 数据源 / 定时任务灌进 SQLite。

幂等：每类数据只在表为空时写入，重复启动不会重复插入；
公告按主键 INSERT OR IGNORE，可安全补录新增条目。
"""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any, Dict, List

from . import config, db, security

DEMO_ANNOUNCEMENTS = config.REPO_DIR / "demo" / "data" / "announcements.json"
DEMO_SITE_RESULTS = config.REPO_DIR / "demo" / "data" / "site_results.json"
SOURCES_JSON = config.REPO_DIR / "collector" / "sources.json"

# 与 demo/js/data.js 的 TEAM_GROUPS 保持一致（顺序即展示优先级）
SEED_GROUPS: List[Dict[str, Any]] = [
    {"id": 1, "name": "集团客户部", "region": "集团客户部", "admin": "佘淑娟",
     "adminContact": "13600121222", "adminAccount": "sheshujuan",
     "createdAt": "2025-04-20", "position": "负责人"},
    {"id": 2, "name": "战客中心", "region": "战客中心", "admin": "李晓仪",
     "adminContact": "13923509399", "adminAccount": "lixiaoyi",
     "createdAt": "2025-01-15", "position": "负责人"},
    {"id": 3, "name": "市区", "region": "市区", "admin": "黄昕翀",
     "adminContact": "13828363210", "adminAccount": "huangxinchong",
     "createdAt": "2025-02-20", "position": "负责人"},
    {"id": 4, "name": "潮安", "region": "潮安", "admin": "林潇宇",
     "adminContact": "13534633962", "adminAccount": "linxiaoyu2",
     "createdAt": "2025-03-10", "position": "负责人"},
    {"id": 5, "name": "饶平", "region": "饶平", "admin": "林旭勋",
     "adminContact": "13923527333", "adminAccount": "linxuxun",
     "createdAt": "2025-04-05", "position": "负责人"},
]

SEED_KEYWORDS = (
    "信息化、智能化、弱电、智慧、数字、平台、系统、软件、大数据、云、机房、"
    "数据中心、网络、等保、网络安全、监控、安防、视频、雪亮、物联、5G、室分、"
    "无线覆盖、WiFi、专线、光缆、管道、通信、IDC、AI、大模型、数字人、无人机、"
    "低空、一卡通、门禁、停车、充电桩、光伏、储能、烟感、消防物联、明厨亮灶、在线监测"
).split("、")


def _read_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def seed_groups(conn: sqlite3.Connection) -> None:
    if conn.execute("SELECT COUNT(*) c FROM groups").fetchone()["c"]:
        return
    for g in SEED_GROUPS:
        conn.execute(
            """INSERT INTO groups
               (id, name, region, admin, admin_contact, admin_account, position, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (g["id"], g["name"], g["region"], g["admin"], g["adminContact"],
             g["adminAccount"], g["position"], g["createdAt"]),
        )
        pw = security.hash_password(config.DEFAULT_PASSWORD)
        conn.execute(
            """INSERT INTO users (account, name, phone, password_hash, salt, group_id, role)
               VALUES (?, ?, ?, ?, ?, ?, 'admin')""",
            (g["adminAccount"], g["admin"], g["adminContact"], pw["hash"], pw["salt"], g["id"]),
        )


def seed_announcements(conn: sqlite3.Connection) -> int:
    # 只在公告表为空时灌种子；否则用户删除的公告会在每次服务重启时被重新插回
    if conn.execute("SELECT COUNT(*) c FROM announcements").fetchone()["c"]:
        return 0
    items = _read_json(DEMO_ANNOUNCEMENTS, [])
    if not isinstance(items, list):
        return 0
    inserted = 0
    for a in items:
        cur = conn.execute(
            """INSERT OR IGNORE INTO announcements (
                id, title, project_name, project_code, buyer, agency, budget, fund_source,
                district, ann_type, pub_date, deadline, bid_open_date, summary, contact,
                contacts_json, source_url, region, purchase_method, matched_keywords,
                business_tags, is_valid_opportunity, has_operator_involvement,
                opportunity_code, opportunity_status, will_bid, tree_placement,
                current_handler, progress, created_at, next_follow_up
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                a.get("id") or "", a.get("title") or "", a.get("projectName") or "",
                a.get("projectCode") or "", a.get("buyer") or "", a.get("agency") or "",
                a.get("budget") or "", a.get("fundSource") or "", a.get("district") or "",
                a.get("annType") or "", a.get("pubDate") or "", a.get("deadline") or "",
                a.get("bidOpenDate") or "", a.get("summary") or "", a.get("contact") or "",
                json.dumps(a.get("contacts") or {}, ensure_ascii=False),
                a.get("sourceUrl") or "", a.get("region") or "", a.get("purchaseMethod") or "",
                json.dumps(a.get("matchedKeywords") or [], ensure_ascii=False),
                json.dumps(a.get("businessTags") or [], ensure_ascii=False),
                a.get("isValidOpportunity") or "", a.get("hasOperatorInvolvement") or "",
                a.get("opportunityCode") or "", a.get("opportunityStatus") or "",
                a.get("willBid") or "", a.get("treePlacement") or "",
                a.get("currentHandler") or "", a.get("progress") or "待分配",
                a.get("createdAt") or "", a.get("nextFollowUp") or "",
            ),
        )
        if cur.rowcount:
            inserted += 1
            for rec in a.get("progressRecords") or []:
                conn.execute(
                    """INSERT INTO progress_records
                       (ann_id, progress, follower, follow_date, note)
                       VALUES (?, ?, ?, ?, ?)""",
                    (a["id"], rec.get("progress", ""), rec.get("follower", ""),
                     rec.get("followDate", ""), rec.get("note", "")),
                )
    return inserted


def seed_sources(conn: sqlite3.Connection) -> int:
    if conn.execute("SELECT COUNT(*) c FROM sources").fetchone()["c"]:
        return 0
    registry = _read_json(SOURCES_JSON, [])
    if not isinstance(registry, list):
        registry = []
    site_results = _read_json(DEMO_SITE_RESULTS, [])
    status_by_domain = {}
    if isinstance(site_results, list):
        for r in site_results:
            status_by_domain[r.get("url", "")] = r

    count = 0
    for s in registry:
        url = s.get("url") or ""
        probe = status_by_domain.get(url) or {}
        conn.execute(
            """INSERT OR IGNORE INTO sources
               (name, url, domain, source_code, enabled,
                last_status, last_http_code, last_latency_ms, last_checked_at,
                last_message, last_found_links, last_matched_links)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                s.get("name") or url, url, s.get("domain") or "",
                s.get("sourceCode") or "generic", 1 if s.get("enabled") else 0,
                "ok" if probe.get("ok") else ("fail" if probe else ""),
                probe.get("http_code"), probe.get("latency_ms"),
                probe.get("checked_at") or "",
                probe.get("status_msg") or probe.get("error_detail") or "",
                probe.get("found_links") or 0, probe.get("matched_links") or 0,
            ),
        )
        count += 1
    return count


def seed_schedule(conn: sqlite3.Connection) -> None:
    if conn.execute("SELECT COUNT(*) c FROM schedule_config").fetchone()["c"]:
        return
    conn.execute(
        """INSERT INTO schedule_config
           (id, keyword_list, crawl_interval, reminder_interval, crawl_status, crawl_days)
           VALUES (1, ?, '每2小时', '每天 09:00, 15:00', '运行中', 3)""",
        (json.dumps(SEED_KEYWORDS, ensure_ascii=False),),
    )


def run_seed() -> Dict[str, int]:
    db.init_db()
    stats = {"groups": 0, "announcements": 0, "sources": 0, "users": 0}
    with db.get_conn() as conn:
        before = conn.execute("SELECT COUNT(*) c FROM users").fetchone()["c"]
        seed_groups(conn)
        stats["groups"] = conn.execute("SELECT COUNT(*) c FROM groups").fetchone()["c"]
        stats["announcements"] = seed_announcements(conn)
        stats["sources"] = seed_sources(conn)
        seed_schedule(conn)
        after = conn.execute("SELECT COUNT(*) c FROM users").fetchone()["c"]
        stats["users"] = after - before
    return stats


if __name__ == "__main__":
    print(json.dumps(run_seed(), ensure_ascii=False, indent=2))
