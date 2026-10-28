"""采集触发与增量入库服务。

职责：
- 检查采集脚本是否可用（不存在时由路由层返回 501）；
- 在后台 daemon 线程里跑 ``collector/collect.py``；
- 采集结束后读取 ``demo/data/announcements.json``，按 seed.py 的字段映射
  增量 ``INSERT OR IGNORE`` 进 announcements（同时补 progress_records）；
- 回写 ``crawl_runs`` 的运行状态。
"""
from __future__ import annotations

import json
import subprocess
import sys
import threading
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Tuple

from .. import config, db
from .. import crypto

# 采集器固定把结果写到仓库 demo/data/announcements.json；测试可 monkeypatch 本常量。
ANNOUNCEMENTS_JSON = config.REPO_DIR / "demo" / "data" / "announcements.json"

# 单次采集最长耗时（秒）。采集器慢，但不能无限挂住后台线程。
COLLECT_TIMEOUT_SECONDS = 3600

_INSERT_ANNOUNCEMENT_SQL = """
INSERT OR IGNORE INTO announcements (
    id, title, project_name, project_code, buyer, agency, budget, fund_source,
    district, ann_type, pub_date, deadline, bid_open_date, summary, contact,
    contacts_json, source_url, region, purchase_method, matched_keywords,
    business_tags, is_valid_opportunity, has_operator_involvement,
    opportunity_code, opportunity_status, will_bid, tree_placement,
    current_handler, progress, created_at, next_follow_up
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
"""


def _now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _tail(text: str, limit: int = 300) -> str:
    text = (text or "").strip()
    if len(text) <= limit:
        return text
    return "…" + text[-limit:]


def collector_available() -> bool:
    """采集脚本是否存在（每次调用现取 config，方便部署/测试覆盖）。"""
    try:
        return Path(config.COLLECTOR_SCRIPT).is_file()
    except OSError:
        return False


def start_collect(days: int = 3, operator: str = "") -> int:
    """写入 running 记录并启动后台采集线程，立即返回 crawl_runs.id。"""
    run_id = db.execute(
        "INSERT INTO crawl_runs (status, operator) VALUES ('running', ?)",
        (operator,),
    )
    thread = threading.Thread(
        target=_run_collector,
        args=(run_id, max(1, int(days or 3))),
        name="biaoxun-collect-%s" % run_id,
        daemon=True,
    )
    thread.start()
    return run_id


def _run_collector(run_id: int, days: int) -> None:
    """后台线程主体：执行脚本 → 读取结果 → 增量入库 → 回写运行记录。"""
    script = Path(config.COLLECTOR_SCRIPT)
    returncode = -1
    output_tail = ""

    try:
        proc = subprocess.run(
            [sys.executable, str(script), "--days", str(days)],
            cwd=str(script.parent),
            capture_output=True,
            text=True,
            timeout=COLLECT_TIMEOUT_SECONDS,
        )
        returncode = proc.returncode
        output_tail = _tail((proc.stdout or "") + "\n" + (proc.stderr or ""))
    except subprocess.TimeoutExpired:
        _finish_run(run_id, "error", 0, "采集超时（超过 %s 秒）" % COLLECT_TIMEOUT_SECONDS)
        return
    except Exception as exc:  # noqa: BLE001 - 后台线程必须兜底，否则 run 永远 running
        _finish_run(run_id, "error", 0, "采集失败: %s" % exc)
        return

    new_count = 0
    insert_error = ""
    try:
        items = _read_output()
        new_count = _insert_announcements(items)
    except Exception as exc:  # noqa: BLE001
        insert_error = str(exc) or exc.__class__.__name__

    sites_total, sites_ok = _site_stats()

    if returncode == 0 and not insert_error:
        status = "ok"
        message = "采集完成，新增 %d 条" % new_count
        if output_tail:
            message += "；" + output_tail
        _finish_run(run_id, status, new_count, message, sites_ok, sites_total)
        return

    status = "error"
    parts: List[str] = []
    if returncode != 0:
        parts.append("采集脚本退出码 %s" % returncode)
    if insert_error:
        parts.append("入库失败: %s" % insert_error)
    if output_tail:
        parts.append(output_tail)
    _finish_run(
        run_id, status, new_count, "；".join(parts) or "采集失败", sites_ok, sites_total
    )


def _read_output() -> List[Dict[str, Any]]:
    """读取采集器输出 JSON（demo/data/announcements.json）。"""
    path = Path(ANNOUNCEMENTS_JSON)
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise ValueError("采集结果不是数组：%s" % path)
    return data


GENERIC_TITLES = {
    "招标公告", "采购公告", "采购意向公告", "竞争性磋商公告",
    "结果公告", "中标公告", "竞争性谈判公告",
}


def _is_duplicate(conn, item: Dict[str, Any], seen_urls, seen_codes, seen_titles) -> bool:
    """按 URL / 项目编号 /（标题+发布日期）判重，避免同一公告每天换 ID 重复入库。"""
    url = str(item.get("sourceUrl") or "").strip()
    code = str(item.get("projectCode") or "").strip()
    title = str(item.get("title") or "").strip()
    pub = str(item.get("pubDate") or "").strip()

    if url:
        if url in seen_urls:
            return True
        if conn.execute(
            "SELECT 1 FROM announcements WHERE source_url = ? LIMIT 1", (url,)
        ).fetchone():
            return True
    if code and code not in ("—", "-"):
        if code in seen_codes:
            return True
        if conn.execute(
            "SELECT 1 FROM announcements WHERE project_code = ? LIMIT 1", (code,)
        ).fetchone():
            return True
    if title and len(title) >= 8 and title not in GENERIC_TITLES and pub:
        key = (title, pub)
        if key in seen_titles:
            return True
        if conn.execute(
            "SELECT 1 FROM announcements WHERE title = ? AND pub_date = ? LIMIT 1",
            (title, pub),
        ).fetchone():
            return True
    return False


def _insert_announcements(items: List[Dict[str, Any]]) -> int:
    """增量入库，返回真实新增条数（已存在的 id 会被忽略）。

    字段映射与 app/seed.py 的 seed_announcements 保持一致；进度记录随新公告写入。
    buyer_district 映射：INSERT 前如果 item.district 为空，按 buyer 的 SHA-256
    查 buyer_district.buyer_hash 自动补 district（与 router 层 _auto_match_district 同逻辑）。
    """
    # 一次性全量加载 buyer_district 映射（3342 条量级，内存友好）
    bmap = {r["buyer_hash"]: r["district"] for r in db.query_all(
        "SELECT buyer_hash, district FROM buyer_district"
    )}
    inserted = 0
    seen_urls, seen_codes, seen_titles = set(), set(), set()
    with db.get_conn() as conn:
        for item in items:
            if not isinstance(item, dict):
                continue
            ann_id = str(item.get("id") or "").strip()
            if not ann_id:
                continue
            if _is_duplicate(conn, item, seen_urls, seen_codes, seen_titles):
                continue

            # === buyer_district 自动匹配（优先级高于 collector 的 guess_district） ===
            # buyer_district 里的是业务上精确映射（如"潮州潮安"），collector 的 guess_district
            # 只是关键词粗匹配（如"潮安"）。只要 buyer_district 命中就覆盖。
            buyer_name = (item.get("buyer") or "").strip()
            if buyer_name:
                h = crypto.sha256_hex(buyer_name)
                hit = bmap.get(h)
                if hit:
                    item["district"] = hit
            cur = conn.execute(
                _INSERT_ANNOUNCEMENT_SQL,
                (
                    ann_id,
                    item.get("title") or "",
                    item.get("projectName") or "",
                    item.get("projectCode") or "",
                    item.get("buyer") or "",
                    item.get("agency") or "",
                    item.get("budget") or "",
                    item.get("fundSource") or "",
                    item.get("district") or "",
                    item.get("annType") or "",
                    item.get("pubDate") or "",
                    item.get("deadline") or "",
                    item.get("bidOpenDate") or "",
                    item.get("summary") or "",
                    item.get("contact") or "",
                    json.dumps(item.get("contacts") or {}, ensure_ascii=False),
                    item.get("sourceUrl") or "",
                    item.get("region") or "",
                    item.get("purchaseMethod") or "",
                    json.dumps(item.get("matchedKeywords") or [], ensure_ascii=False),
                    json.dumps(item.get("businessTags") or [], ensure_ascii=False),
                    item.get("isValidOpportunity") or "",
                    item.get("hasOperatorInvolvement") or "",
                    item.get("opportunityCode") or "",
                    item.get("opportunityStatus") or "",
                    item.get("willBid") or "",
                    item.get("treePlacement") or "",
                    item.get("currentHandler") or "",
                    item.get("progress") or "待分配",
                    item.get("createdAt") or "",
                    item.get("nextFollowUp") or "",
                ),
            )
            if not cur.rowcount:
                continue
            inserted += 1
            url = str(item.get("sourceUrl") or "").strip()
            code = str(item.get("projectCode") or "").strip()
            title = str(item.get("title") or "").strip()
            pub = str(item.get("pubDate") or "").strip()
            if url:
                seen_urls.add(url)
            if code and code not in ("—", "-"):
                seen_codes.add(code)
            if title and len(title) >= 8 and title not in GENERIC_TITLES and pub:
                seen_titles.add((title, pub))
            for rec in item.get("progressRecords") or []:
                if not isinstance(rec, dict):
                    continue
                conn.execute(
                    """INSERT INTO progress_records
                       (ann_id, progress, follower, follow_date, note)
                       VALUES (?, ?, ?, ?, ?)""",
                    (
                        ann_id,
                        rec.get("progress", ""),
                        rec.get("follower", ""),
                        rec.get("followDate", ""),
                        rec.get("note", ""),
                    ),
                )
    return inserted


def _site_stats() -> Tuple[int, int]:
    """按 sources 表现状统计 (启用站点总数, 其中状态正常的站点数)。"""
    rows = db.query_all("SELECT enabled, last_status FROM sources")
    enabled = [r for r in rows if r.get("enabled")]
    ok = sum(1 for r in enabled if (r.get("last_status") or "") == "ok")
    return len(enabled), ok


def _finish_run(
    run_id: int,
    status: str,
    new_count: int,
    message: str,
    sites_ok: int = 0,
    sites_total: int = 0,
) -> None:
    db.execute(
        """UPDATE crawl_runs
           SET status = ?, finished_at = ?, new_count = ?,
               sites_ok = ?, sites_total = ?, message = ?
           WHERE id = ?""",
        (
            status,
            _now(),
            int(new_count or 0),
            int(sites_ok or 0),
            int(sites_total or 0),
            _tail(message, 500),
            run_id,
        ),
    )


def run_to_api(row: Dict[str, Any]) -> Dict[str, Any]:
    """crawl_runs 行 → 契约中的驼峰结构。"""
    return {
        "id": row.get("id"),
        "startedAt": row.get("started_at", ""),
        "finishedAt": row.get("finished_at", ""),
        "status": row.get("status", ""),
        "sitesOk": row.get("sites_ok", 0),
        "sitesTotal": row.get("sites_total", 0),
        "newCount": row.get("new_count", 0),
        "message": row.get("message", ""),
    }


def run_collect_now(days: int = 3, operator: str = "cli") -> Dict[str, Any]:
    """同步执行一次采集（cron / systemd timer 用），返回 crawl_runs 行。

    与 API 触发的区别：不另起线程，直接阻塞到采集和入库完成，
    方便 systemd 判断成功/失败并防止并发重叠。
    """
    run_id = db.execute(
        "INSERT INTO crawl_runs (status, operator) VALUES ('running', ?)",
        (operator,),
    )
    _run_collector(run_id, max(1, int(days or 3)))
    row = db.query_one("SELECT * FROM crawl_runs WHERE id = ?", (run_id,))
    return row or {}
