"""定时任务配置路由。契约见 docs/api-contract.md 第 6 节。"""
from __future__ import annotations

import re
from datetime import datetime
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from .. import db, security
from ..serializers import schedule_to_api

router = APIRouter(prefix="/api/schedule", tags=["schedule"])

# 契约：按「、，,换行」切分关键词
_KEYWORD_SEP = re.compile(r"[、，,\n\r]+")


class SchedulePatch(BaseModel):
    keywordList: Optional[List[str]] = None
    keywordText: Optional[str] = None
    crawlInterval: Optional[str] = None
    reminderInterval: Optional[str] = None
    crawlStatus: Optional[str] = None
    crawlDays: Optional[int] = None


def _now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _get_row() -> Dict[str, Any]:
    """单行表：缺失时补一行默认配置，保证读写都有落点。"""
    row = db.query_one("SELECT * FROM schedule_config WHERE id = 1")
    if not row:
        db.execute("INSERT OR IGNORE INTO schedule_config (id) VALUES (1)")
        row = db.query_one("SELECT * FROM schedule_config WHERE id = 1")
    return row or {}


def _dedupe(values: List[str]) -> List[str]:
    out: List[str] = []
    seen = set()
    for value in values:
        keyword = str(value or "").strip()
        if keyword and keyword not in seen:
            seen.add(keyword)
            out.append(keyword)
    return out


def _split_keyword_text(text: str) -> List[str]:
    return _dedupe(_KEYWORD_SEP.split(text or ""))


@router.get("")
def get_schedule(user: Dict[str, Any] = Depends(security.get_current_user)) -> Dict[str, Any]:
    return schedule_to_api(_get_row())


@router.put("")
def update_schedule(
    body: SchedulePatch,
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, Any]:
    sets = []
    params: List[Any] = []

    if body.keywordList is not None:
        keywords = _dedupe(body.keywordList)
        sets.append("keyword_list = ?")
        params.append(db.dumps(keywords))
    elif body.keywordText is not None:
        keywords = _split_keyword_text(body.keywordText)
        sets.append("keyword_list = ?")
        params.append(db.dumps(keywords))

    if body.crawlInterval is not None:
        sets.append("crawl_interval = ?")
        params.append(body.crawlInterval.strip())
    if body.reminderInterval is not None:
        sets.append("reminder_interval = ?")
        params.append(body.reminderInterval.strip())
    if body.crawlStatus is not None:
        sets.append("crawl_status = ?")
        params.append(body.crawlStatus.strip())
    if body.crawlDays is not None:
        sets.append("crawl_days = ?")
        params.append(int(body.crawlDays))

    sets.append("updated_at = ?")
    params.append(_now())

    db.execute(
        "UPDATE schedule_config SET %s WHERE id = 1" % ", ".join(sets), tuple(params)
    )
    security.audit(
        user,
        "更新定时任务",
        "schedule",
        "字段=%s" % ",".join(s.split(" = ")[0] for s in sets if s != "updated_at = ?"),
    )
    return schedule_to_api(_get_row())
