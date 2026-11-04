"""数据来源 + 采集路由。契约见 docs/api-contract.md 第 5 节。"""
from __future__ import annotations

import sqlite3
import time
import urllib.parse
from datetime import datetime
from typing import Any, Dict, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from .. import db, security
from ..serializers import source_to_api
from ..services import crawler

router = APIRouter(tags=["sources"])

IMPLEMENTED_SOURCE_CODES = ("czggzy", "ccgp", "gdgpo")
PROBE_TIMEOUT = 8.0


class SourceCreate(BaseModel):
    name: str
    url: str
    domain: Optional[str] = None
    sourceCode: Optional[str] = None
    enabled: bool = True


class SourcePatch(BaseModel):
    name: Optional[str] = None
    url: Optional[str] = None
    domain: Optional[str] = None
    sourceCode: Optional[str] = None
    enabled: Optional[bool] = None


def _now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _domain_of(url: str) -> str:
    try:
        return (urllib.parse.urlsplit(url).hostname or "").lower()
    except ValueError:
        return ""


def _get_source(source_id: int) -> Dict[str, Any]:
    row = db.query_one("SELECT * FROM sources WHERE id = ?", (source_id,))
    if not row:
        raise HTTPException(status_code=404, detail="数据源不存在")
    return row


def _probe(url: str) -> Dict[str, Any]:
    """单站探活（模块级函数，测试可 monkeypatch）。

    返回 {ok, http_code, latency_ms, message}，不抛异常。
    """
    started = time.perf_counter()
    try:
        # trust_env=False：忽略服务器上的 HTTP(S)_PROXY，避免探活被代理劫持成 502
        resp = httpx.get(
            url, timeout=PROBE_TIMEOUT, follow_redirects=True, trust_env=False
        )
    except Exception as exc:  # noqa: BLE001 - 探活失败是正常业务结果
        latency = int((time.perf_counter() - started) * 1000)
        detail = (str(exc).strip() or exc.__class__.__name__)[:300]
        return {
            "ok": False,
            "http_code": None,
            "latency_ms": latency,
            "message": "连接失败: %s" % detail,
        }

    latency = int((time.perf_counter() - started) * 1000)
    code = resp.status_code
    ok = 200 <= code < 400
    return {
        "ok": ok,
        "http_code": code,
        "latency_ms": latency,
        "message": "正常 %dms" % latency if ok else "状态异常 HTTP %d" % code,
    }


@router.get("/api/sources")
def list_sources(user: Dict[str, Any] = Depends(security.get_current_user)) -> Dict[str, Any]:
    rows = db.query_all("SELECT * FROM sources ORDER BY id ASC")
    items = [source_to_api(r) for r in rows]
    enabled_rows = [r for r in rows if r.get("enabled")]
    checked = [r.get("last_checked_at") or "" for r in rows]
    stats = {
        "total": len(items),
        "enabled": len(enabled_rows),
        "implemented": sum(
            1
            for r in enabled_rows
            if (r.get("source_code") or "generic") in IMPLEMENTED_SOURCE_CODES
        ),
        "generic": sum(
            1 for r in enabled_rows if (r.get("source_code") or "generic") == "generic"
        ),
        "lastCheckedAt": max(checked) if checked else "",
    }
    return {"items": items, "stats": stats}


@router.post("/api/sources")
def create_source(
    body: SourceCreate,
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, Any]:
    name = (body.name or "").strip()
    url = (body.url or "").strip()
    if not name or not url:
        raise HTTPException(status_code=400, detail="数据源名称和地址不能为空")
    if db.query_one("SELECT id FROM sources WHERE url = ?", (url,)):
        raise HTTPException(status_code=409, detail="该地址的数据源已存在")

    source_code = (body.sourceCode or "generic").strip().lower() or "generic"
    domain = (body.domain or "").strip().lower() or _domain_of(url)
    try:
        source_id = db.execute(
            """INSERT INTO sources (name, url, domain, source_code, enabled)
               VALUES (?, ?, ?, ?, ?)""",
            (name, url, domain, source_code, 1 if body.enabled else 0),
        )
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=409, detail="该地址的数据源已存在")

    security.audit(user, "新增数据源", name, "url=%s" % url)
    return source_to_api(_get_source(source_id))


@router.patch("/api/sources/{source_id}")
def update_source(
    source_id: int,
    body: SourcePatch,
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, Any]:
    current = _get_source(source_id)
    sets = []
    params = []

    if body.name is not None:
        name = body.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="数据源名称不能为空")
        sets.append("name = ?")
        params.append(name)

    if body.url is not None:
        url = body.url.strip()
        if not url:
            raise HTTPException(status_code=400, detail="数据源地址不能为空")
        dup = db.query_one(
            "SELECT id FROM sources WHERE url = ? AND id <> ?", (url, source_id)
        )
        if dup:
            raise HTTPException(status_code=409, detail="该地址的数据源已存在")
        sets.append("url = ?")
        params.append(url)
        # 未显式改 domain 时跟随新 url 推导，避免展示域名过期
        if body.domain is None:
            sets.append("domain = ?")
            params.append(_domain_of(url))

    if body.domain is not None:
        sets.append("domain = ?")
        params.append(body.domain.strip().lower())

    if body.sourceCode is not None:
        source_code = body.sourceCode.strip().lower() or "generic"
        sets.append("source_code = ?")
        params.append(source_code)

    if body.enabled is not None:
        sets.append("enabled = ?")
        params.append(1 if body.enabled else 0)

    if sets:
        params.append(source_id)
        db.execute(
            "UPDATE sources SET %s WHERE id = ?" % ", ".join(sets), tuple(params)
        )
        security.audit(
            user,
            "修改数据源",
            current.get("name", ""),
            "id=%s 字段=%s" % (source_id, ",".join(s.split(" = ")[0] for s in sets)),
        )
    return source_to_api(_get_source(source_id))


@router.delete("/api/sources/{source_id}")
def delete_source(
    source_id: int,
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, Any]:
    current = _get_source(source_id)
    db.execute("DELETE FROM sources WHERE id = ?", (source_id,))
    security.audit(user, "删除数据源", current.get("name", ""), "id=%s" % source_id)
    return {"ok": True}


@router.post("/api/sources/{source_id}/refresh")
def refresh_source(
    source_id: int,
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, Any]:
    current = _get_source(source_id)
    result = _probe(current.get("url", ""))
    ok = bool(result.get("ok"))
    message = result.get("message") or ("正常" if ok else "连接失败")
    checked_at = _now()

    db.execute(
        """UPDATE sources
           SET last_status = ?, last_http_code = ?, last_latency_ms = ?,
               last_checked_at = ?, last_message = ?
           WHERE id = ?""",
        (
            "ok" if ok else "fail",
            result.get("http_code"),
            result.get("latency_ms"),
            checked_at,
            message,
            source_id,
        ),
    )
    security.audit(user, "探活数据源", current.get("name", ""), message)
    return source_to_api(_get_source(source_id))


@router.post("/api/collect")
def trigger_collect(
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, Any]:
    if not crawler.collector_available():
        raise HTTPException(status_code=501, detail="服务器未安装采集脚本")

    schedule = db.query_one("SELECT crawl_days FROM schedule_config WHERE id = 1")
    days = int((schedule or {}).get("crawl_days") or 3)
    run_id = crawler.start_collect(days=days, operator=user.get("name", ""))
    security.audit(user, "触发采集", "collector", "run_id=%s days=%s" % (run_id, days))
    return {"runId": run_id, "status": "started"}


@router.get("/api/collect/runs")
def collect_runs(
    limit: int = Query(default=10, ge=1, le=100),
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, Any]:
    rows = db.query_all(
        "SELECT * FROM crawl_runs ORDER BY id DESC LIMIT ?", (limit,)
    )
    return {"items": [crawler.run_to_api(r) for r in rows]}
