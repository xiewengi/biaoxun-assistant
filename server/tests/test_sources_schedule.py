"""数据来源 + 定时任务 + 采集端点测试。"""
from __future__ import annotations

import json
import time

import pytest

from app import config, db
from app.routers import sources as sources_router
from app.services import crawler

SOURCE_KEYS = {
    "id",
    "name",
    "url",
    "domain",
    "sourceCode",
    "enabled",
    "lastStatus",
    "lastHttpCode",
    "lastLatencyMs",
    "lastCheckedAt",
    "lastMessage",
    "lastFoundLinks",
    "lastMatchedLinks",
}


def _create_source(client, headers, name="测试数据源", url="https://example.test/list", **extra):
    payload = {"name": name, "url": url}
    payload.update(extra)
    resp = client.post("/api/sources", headers=headers, json=payload)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _wait_run(client, headers, run_id, timeout=10.0):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        items = client.get("/api/collect/runs", headers=headers).json()["items"]
        last = next((it for it in items if it["id"] == run_id), None)
        if last and last["status"] != "running":
            return last
        time.sleep(0.05)
    raise AssertionError("采集 run %s 未在超时内结束：%s" % (run_id, last))


# ---------------------------------------------------------------- 鉴权


@pytest.mark.parametrize(
    "method,path,payload",
    [
        ("get", "/api/sources", None),
        ("post", "/api/sources", {"name": "匿名站", "url": "https://anon.test"}),
        ("patch", "/api/sources/1", {"enabled": False}),
        ("delete", "/api/sources/1", None),
        ("post", "/api/sources/1/refresh", None),
        ("post", "/api/collect", None),
        ("get", "/api/collect/runs", None),
        ("get", "/api/schedule", None),
        ("put", "/api/schedule", {"keywordText": "信息化"}),
    ],
)
def test_endpoints_require_login(client, method, path, payload):
    kwargs = {"json": payload} if payload is not None else {}
    resp = getattr(client, method)(path, **kwargs)
    assert resp.status_code == 401, resp.text


# ---------------------------------------------------------------- 列表 / 统计


def test_list_sources_and_stats(client, admin_headers):
    resp = client.get("/api/sources", headers=admin_headers)
    assert resp.status_code == 200, resp.text
    data = resp.json()
    items = data["items"]
    stats = data["stats"]

    assert len(items) > 0
    assert SOURCE_KEYS.issubset(items[0].keys())
    assert stats["total"] == len(items)

    enabled = [it for it in items if it["enabled"]]
    implemented = [
        it for it in enabled if it["sourceCode"] in ("czggzy", "ccgp", "gdgpo")
    ]
    generic = [it for it in enabled if it["sourceCode"] == "generic"]
    assert stats["enabled"] == len(enabled)
    assert stats["implemented"] == len(implemented)
    assert stats["generic"] == len(generic)
    # 种子数据里三个专用源都存在
    assert stats["implemented"] >= 3
    checked = [it["lastCheckedAt"] or "" for it in items]
    assert stats["lastCheckedAt"] == max(checked)


# ---------------------------------------------------------------- 新增 / 409


def test_create_source_and_duplicate_url(client, admin_headers):
    source = _create_source(client, admin_headers, url="https://example.test/dup")
    assert source["id"] > 0
    assert source["enabled"] is True
    assert source["sourceCode"] == "generic"
    assert source["domain"] == "example.test"
    assert source["lastStatus"] == ""

    # 同 URL 再建一次 → 409
    dup = client.post(
        "/api/sources",
        headers=admin_headers,
        json={"name": "重名站", "url": "https://example.test/dup"},
    )
    assert dup.status_code == 409
    assert "已存在" in dup.json()["detail"]

    listed = client.get("/api/sources", headers=admin_headers).json()["items"]
    assert sum(1 for it in listed if it["url"] == "https://example.test/dup") == 1


def test_create_source_defaults_and_disabled(client, admin_headers):
    # 绑定端口时 domain 只保留 host，sourceCode 默认 generic，enabled=False 生效
    source = _create_source(
        client,
        admin_headers,
        url="https://port.example:8443/index",
        enabled=False,
    )
    assert source["domain"] == "port.example"
    assert source["sourceCode"] == "generic"
    assert source["enabled"] is False

    stats = client.get("/api/sources", headers=admin_headers).json()["stats"]
    enabled_items = [
        it
        for it in client.get("/api/sources", headers=admin_headers).json()["items"]
        if it["enabled"]
    ]
    assert stats["enabled"] == len(enabled_items)


# ---------------------------------------------------------------- 改 / 删


def test_update_toggle_and_delete_source(client, admin_headers):
    first = _create_source(client, admin_headers, url="https://example.test/a")
    second = _create_source(client, admin_headers, url="https://example.test/b")

    # 启停 + 改名
    resp = client.patch(
        "/api/sources/%s" % first["id"],
        headers=admin_headers,
        json={"enabled": False, "name": "改名后的源"},
    )
    assert resp.status_code == 200, resp.text
    patched = resp.json()
    assert patched["enabled"] is False
    assert patched["name"] == "改名后的源"

    # URL 撞车 → 409
    resp = client.patch(
        "/api/sources/%s" % second["id"],
        headers=admin_headers,
        json={"url": first["url"]},
    )
    assert resp.status_code == 409

    # 改 URL 时 domain 自动跟随
    resp = client.patch(
        "/api/sources/%s" % second["id"],
        headers=admin_headers,
        json={"url": "https://moved.example.test/x"},
    )
    assert resp.status_code == 200
    assert resp.json()["domain"] == "moved.example.test"

    # 删除 → ok，再删 → 404
    resp = client.delete("/api/sources/%s" % first["id"], headers=admin_headers)
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}
    ids = [it["id"] for it in client.get("/api/sources", headers=admin_headers).json()["items"]]
    assert first["id"] not in ids

    assert client.delete(
        "/api/sources/%s" % first["id"], headers=admin_headers
    ).status_code == 404
    assert client.patch(
        "/api/sources/%s" % first["id"], headers=admin_headers, json={"enabled": True}
    ).status_code == 404


# ---------------------------------------------------------------- 探活


def test_refresh_probe_ok_and_fail_persisted(client, admin_headers, monkeypatch):
    source = _create_source(client, admin_headers, url="https://probe.example.test/")
    seen = []

    def probe_ok(url):
        seen.append(url)
        return {"ok": True, "http_code": 200, "latency_ms": 864, "message": "正常 864ms"}

    monkeypatch.setattr(sources_router, "_probe", probe_ok)
    resp = client.post(
        "/api/sources/%s/refresh" % source["id"], headers=admin_headers
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert seen == ["https://probe.example.test/"]
    assert body["lastStatus"] == "ok"
    assert body["lastHttpCode"] == 200
    assert body["lastLatencyMs"] == 864
    assert body["lastMessage"] == "正常 864ms"
    assert body["lastCheckedAt"]

    # 落库：列表里能读到同样的探活结果
    listed = [
        it
        for it in client.get("/api/sources", headers=admin_headers).json()["items"]
        if it["id"] == source["id"]
    ][0]
    assert listed["lastStatus"] == "ok"
    assert listed["lastHttpCode"] == 200
    assert listed["lastLatencyMs"] == 864
    assert listed["lastCheckedAt"] == body["lastCheckedAt"]

    # 失败探活 → last_status=fail + 中文错误信息
    monkeypatch.setattr(
        sources_router,
        "_probe",
        lambda url: {
            "ok": False,
            "http_code": None,
            "latency_ms": 120,
            "message": "连接失败: 拒绝连接",
        },
    )
    resp = client.post(
        "/api/sources/%s/refresh" % source["id"], headers=admin_headers
    )
    body = resp.json()
    assert body["lastStatus"] == "fail"
    assert body["lastHttpCode"] is None
    assert body["lastLatencyMs"] == 120
    assert body["lastMessage"].startswith("连接失败: ")


def test_refresh_missing_source_404(client, admin_headers):
    resp = client.post("/api/sources/999999/refresh", headers=admin_headers)
    assert resp.status_code == 404
    assert resp.json()["detail"] == "数据源不存在"


# ---------------------------------------------------------------- 采集


def test_collect_without_script_returns_501(client, admin_headers, monkeypatch, tmp_path):
    monkeypatch.setattr(config, "COLLECTOR_SCRIPT", tmp_path / "not-installed.py")
    resp = client.post("/api/collect", headers=admin_headers)
    assert resp.status_code == 501
    assert resp.json()["detail"] == "服务器未安装采集脚本"
    assert client.get("/api/collect/runs", headers=admin_headers).json()["items"] == []


def test_collect_runs_list(client, admin_headers):
    payloads = [
        ("2026-10-25 09:00:00", "2026-10-25 09:05:00", "ok", 48, 50, 3, "采集完成，新增 3 条"),
        ("2026-10-25 10:00:00", "2026-10-25 10:01:00", "error", 0, 50, 0, "采集脚本退出码 1"),
        ("2026-10-25 11:00:00", "", "running", 0, 0, 0, ""),
    ]
    ids = [
        db.execute(
            """INSERT INTO crawl_runs
               (started_at, finished_at, status, sites_ok, sites_total, new_count, message)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            payload,
        )
        for payload in payloads
    ]

    resp = client.get("/api/collect/runs?limit=2", headers=admin_headers)
    assert resp.status_code == 200, resp.text
    items = resp.json()["items"]
    assert len(items) == 2
    assert [it["id"] for it in items] == sorted(ids, reverse=True)[:2]
    assert set(items[0].keys()) == {
        "id",
        "startedAt",
        "finishedAt",
        "status",
        "sitesOk",
        "sitesTotal",
        "newCount",
        "message",
    }
    # 默认 limit=10 能拿到全部
    all_items = client.get("/api/collect/runs", headers=admin_headers).json()["items"]
    assert len(all_items) == 3
    assert all_items[0]["status"] == "running"


def test_collect_success_inserts_incrementally(
    client, admin_headers, monkeypatch, tmp_path
):
    record = {
        "id": "ANN20261025TEST",
        "title": "潮州测试项目招标公告",
        "projectName": "潮州测试项目",
        "projectCode": "P-TEST-001",
        "buyer": "测试采购人",
        "agency": "测试代理",
        "budget": "100,000.00元",
        "fundSource": "财政",
        "district": "湘桥",
        "annType": "招标公告",
        "pubDate": "2026-10-25",
        "deadline": "2026-11-01",
        "bidOpenDate": "2026-11-02",
        "summary": "测试摘要",
        "contact": "联系人：张三",
        "contacts": {"purchaser": {"name": "测试采购人"}},
        "sourceUrl": "https://example.test/ann/1",
        "region": "潮州",
        "purchaseMethod": "公开招标",
        "matchedKeywords": ["信息化", "平台"],
        "businessTags": ["平台"],
        "currentHandler": "佘淑娟",
        "progress": "待分配",
        "createdAt": "2026-10-25",
        "nextFollowUp": "2026-10-27",
        "progressRecords": [
            {
                "progress": "待分配",
                "follower": "系统",
                "followDate": "2026-10-25",
                "note": "新公告自动入库",
            }
        ],
    }
    output = tmp_path / "announcements.json"
    output.write_text(json.dumps([record], ensure_ascii=False), encoding="utf-8")

    fake_script = tmp_path / "fake_collect.py"
    fake_script.write_text(
        "import sys, pathlib\n"
        "pathlib.Path('argv.txt').write_text('|'.join(sys.argv[1:]), encoding='utf-8')\n"
        "print('fake collector ok')\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(config, "COLLECTOR_SCRIPT", fake_script)
    monkeypatch.setattr(crawler, "ANNOUNCEMENTS_JSON", output)

    # 采集天数取 schedule_config.crawlDays
    client.put("/api/schedule", headers=admin_headers, json={"crawlDays": 7})

    resp = client.post("/api/collect", headers=admin_headers)
    assert resp.status_code == 200, resp.text
    payload = resp.json()
    assert payload["status"] == "started"
    assert isinstance(payload["runId"], int)

    run = _wait_run(client, admin_headers, payload["runId"])
    assert run["status"] == "ok", run
    assert run["newCount"] == 1
    assert run["finishedAt"]
    assert run["sitesTotal"] >= 1
    assert (tmp_path / "argv.txt").read_text(encoding="utf-8") == "--days|7"

    ann = db.query_one("SELECT * FROM announcements WHERE id = ?", (record["id"],))
    assert ann is not None
    assert ann["title"] == record["title"]
    assert ann["matched_keywords"] == '["信息化", "平台"]'
    progress = db.query_one(
        "SELECT * FROM progress_records WHERE ann_id = ?", (record["id"],)
    )
    assert progress is not None
    assert progress["note"] == "新公告自动入库"

    # 同一份输出再入库：INSERT OR IGNORE → 0 新增
    assert crawler._insert_announcements([record]) == 0


# ---------------------------------------------------------------- 定时任务


def test_schedule_read_and_keyword_text_split(client, admin_headers):
    resp = client.get("/api/schedule", headers=admin_headers)
    assert resp.status_code == 200, resp.text
    initial = resp.json()
    assert isinstance(initial["keywordList"], list)
    assert initial["keywordList"]
    assert initial["keywordText"] == "、".join(initial["keywordList"])
    assert initial["crawlDays"] == 3

    resp = client.put(
        "/api/schedule",
        headers=admin_headers,
        json={"keywordText": "信息化、智能化，信息化\n5G, 平台,,，\n"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["keywordList"] == ["信息化", "智能化", "5G", "平台"]
    assert body["keywordText"] == "信息化、智能化、5G、平台"
    assert body["updatedAt"]

    # 持久化
    again = client.get("/api/schedule", headers=admin_headers).json()
    assert again["keywordList"] == body["keywordList"]
    assert again["updatedAt"] == body["updatedAt"]


def test_schedule_keyword_list_priority_and_fields(client, admin_headers):
    resp = client.put(
        "/api/schedule",
        headers=admin_headers,
        json={
            "keywordList": ["AI", "AI", " 大数据 ", ""],
            "keywordText": "不应生效、关键词",
            "crawlInterval": "每1小时",
            "reminderInterval": "每天 08:30",
            "crawlStatus": "已暂停",
            "crawlDays": 7,
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["keywordList"] == ["AI", "大数据"]
    assert body["keywordText"] == "AI、大数据"
    assert body["crawlInterval"] == "每1小时"
    assert body["reminderInterval"] == "每天 08:30"
    assert body["crawlStatus"] == "已暂停"
    assert body["crawlDays"] == 7

    # 空 keywordList 是显式清空
    cleared = client.put(
        "/api/schedule", headers=admin_headers, json={"keywordList": []}
    ).json()
    assert cleared["keywordList"] == []
    assert cleared["keywordText"] == ""


# ---------------------------------------------------------------- 审计


def test_write_operations_are_audited(client, admin_headers):
    source = _create_source(client, admin_headers, url="https://audit.example.test/")
    client.patch(
        "/api/sources/%s" % source["id"], headers=admin_headers, json={"enabled": False}
    )
    client.put("/api/schedule", headers=admin_headers, json={"crawlDays": 5})
    client.delete("/api/sources/%s" % source["id"], headers=admin_headers)

    actions = [
        row["action"]
        for row in db.query_all(
            "SELECT action FROM audit_log ORDER BY id ASC"
        )
    ]
    assert "新增数据源" in actions
    assert "修改数据源" in actions
    assert "删除数据源" in actions
    assert "更新定时任务" in actions
