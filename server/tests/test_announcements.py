"""公告域 API 测试（docs/api-contract.md 第 2 节）。

每个用例由 conftest 重建临时库并灌种子，用例之间不共享状态。
"""
from __future__ import annotations

from datetime import date, timedelta
from typing import Any, Dict, List

BASE = "/api/announcements"
MISSING_ID = "ANN-NOT-EXIST"

REQUIRED_OPP = {
    "isValidOpportunity": "是",
    "hasOperatorInvolvement": "否",
    "opportunityCode": "OPP-TEST-001",
    "willBid": "是",
}


def _list(client, headers, **params) -> Dict[str, Any]:
    params.setdefault("page", 1)
    params.setdefault("page_size", 0)
    r = client.get(BASE, params=params, headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


def _all_items(client, headers) -> List[Dict[str, Any]]:
    return _list(client, headers)["items"]


def _first_id(client, headers) -> str:
    return _all_items(client, headers)[0]["id"]


def _detail(client, headers, ann_id: str) -> Dict[str, Any]:
    r = client.get(f"{BASE}/{ann_id}", headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


def _fill_required(client, headers, ann_id: str) -> None:
    r = client.patch(f"{BASE}/{ann_id}", json=REQUIRED_OPP, headers=headers)
    assert r.status_code == 200, r.text


def _confirm(client, headers, ann_id: str) -> Dict[str, Any]:
    _fill_required(client, headers, ann_id)
    r = client.post(f"{BASE}/{ann_id}/confirm", headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


def test_requires_login(client):
    """所有公告接口都必须登录（未带 token → 401）。"""
    assert client.get(BASE).status_code == 401
    assert client.get(f"{BASE}/{MISSING_ID}").status_code == 401
    assert client.get(f"{BASE}/{MISSING_ID}/records").status_code == 401
    assert client.patch(f"{BASE}/{MISSING_ID}", json={}).status_code == 401
    assert client.post(f"{BASE}/{MISSING_ID}/confirm").status_code == 401
    assert client.post(
        f"{BASE}/{MISSING_ID}/progress", json={"progress": "已分配"}
    ).status_code == 401
    assert client.post(
        f"{BASE}/{MISSING_ID}/assign", json={"group": "潮安"}
    ).status_code == 401
    assert client.post(
        f"{BASE}/batch-assign", json={"ids": [], "group": "潮安"}
    ).status_code == 401


def test_list_filters_pagination_and_stats(client, admin_headers):
    """列表：筛选、排序、分页、page_size=0、列表项不含记录、stats 自洽。"""
    data = _list(client, admin_headers)
    assert data["total"] == 15
    assert len(data["items"]) == 15
    assert data["page"] == 1
    assert data["pageSize"] == 0

    # 列表项不带详情记录
    for item in data["items"]:
        assert "progressRecords" not in item
        assert "assignmentRecords" not in item
        assert item["title"]

    # 按 pub_date DESC, id DESC
    keys = [(item["pubDate"], item["id"]) for item in data["items"]]
    assert keys == sorted(keys, reverse=True)

    # district 过滤
    body = _list(client, admin_headers, district="潮安")
    assert body["total"] == 2
    assert all(item["district"] == "潮安" for item in body["items"])

    # progress 过滤
    body = _list(client, admin_headers, progress="待分配")
    assert body["total"] == 15
    assert all(item["progress"] == "待分配" for item in body["items"])

    # keyword 模糊匹配 title/projectName/buyer/matchedKeywords
    keyword = "凤凰镇"
    body = _list(client, admin_headers, keyword=keyword)
    assert body["total"] >= 1
    for item in body["items"]:
        haystack = " ".join(
            [
                item["title"],
                item["projectName"],
                item["buyer"],
                " ".join(item["matchedKeywords"]),
            ]
        )
        assert keyword in haystack

    # 分页
    page1 = _list(client, admin_headers, page=1, page_size=5)
    assert page1["total"] == 15
    assert page1["pageSize"] == 5
    assert len(page1["items"]) == 5
    page2 = _list(client, admin_headers, page=2, page_size=5)
    assert len(page2["items"]) == 5
    assert {i["id"] for i in page1["items"]}.isdisjoint(
        {i["id"] for i in page2["items"]}
    )
    page3 = _list(client, admin_headers, page=3, page_size=5)
    assert len(page3["items"]) == 5
    page4 = _list(client, admin_headers, page=4, page_size=5)
    assert len(page4["items"]) == 0

    # 默认 page_size=10
    default_page = client.get(BASE, headers=admin_headers)
    assert default_page.status_code == 200
    assert len(default_page.json()["items"]) == 10
    assert default_page.json()["pageSize"] == 10

    # stats 与全量数据自洽（不受筛选影响）
    today = date.today().isoformat()
    expected = {
        "todayCount": sum(1 for i in data["items"] if i["pubDate"] == today),
        "unassignedCount": sum(
            1 for i in data["items"] if i["progress"] == "待分配" or not i["currentHandler"]
        ),
        "inProgressCount": sum(1 for i in data["items"] if i["progress"] == "已分配"),
        "confirmedCount": sum(1 for i in data["items"] if i["progress"] == "已确认"),
    }
    assert data["stats"] == expected
    assert expected["unassignedCount"] == 15


def test_detail_includes_records(client, admin_headers):
    """详情含 progressRecords / assignmentRecords / confirmedAt。"""
    ann_id = _first_id(client, admin_headers)
    detail = _detail(client, admin_headers, ann_id)

    assert detail["id"] == ann_id
    assert isinstance(detail["progressRecords"], list)
    assert len(detail["progressRecords"]) >= 1
    assert isinstance(detail["assignmentRecords"], list)
    assert detail["assignmentRecords"] == []
    assert "confirmedAt" in detail
    assert detail["bidStatus"] in ("意向", "挂网", "截止报名", "开标")

    records = client.get(f"{BASE}/{ann_id}/records", headers=admin_headers)
    assert records.status_code == 200
    assert records.json() == {
        "progressRecords": detail["progressRecords"],
        "assignmentRecords": detail["assignmentRecords"],
    }


def test_patch_opportunity_fields_persisted(client, admin_headers):
    """PATCH 商机字段落库；空 body 400。"""
    ann_id = _first_id(client, admin_headers)
    payload = {
        "isValidOpportunity": "是",
        "hasOperatorInvolvement": "否",
        "opportunityCode": "OPP-2026-0001",
        "opportunityStatus": "跟进中",
        "willBid": "是",
        "treePlacement": "行业树/政务",
        "currentHandler": "林潇宇",
        "nextFollowUp": "2026-11-01",
    }
    r = client.patch(f"{BASE}/{ann_id}", json=payload, headers=admin_headers)
    assert r.status_code == 200, r.text
    for key, value in payload.items():
        assert r.json()[key] == value

    # 重新读取确认真的落库
    detail = _detail(client, admin_headers, ann_id)
    for key, value in payload.items():
        assert detail[key] == value
    assert detail["progress"] == "待分配"  # PATCH 不改进度

    # 空 body → 400
    empty = client.patch(f"{BASE}/{ann_id}", json={}, headers=admin_headers)
    assert empty.status_code == 400


def test_confirm_required_fields_then_success(client, admin_headers):
    """confirm：缺必填 400 且提示含「必填」；补齐后 200 且 progress=已确认。"""
    ann_id = _first_id(client, admin_headers)
    before = _detail(client, admin_headers, ann_id)
    before_count = len(before["progressRecords"])

    r = client.post(f"{BASE}/{ann_id}/confirm", headers=admin_headers)
    assert r.status_code == 400
    message = r.json()["detail"]
    assert "必填" in message
    assert "商机编码" in message
    assert "是否应标" in message
    assert _detail(client, admin_headers, ann_id)["progress"] == "待分配"

    _fill_required(client, admin_headers, ann_id)
    r = client.post(f"{BASE}/{ann_id}/confirm", headers=admin_headers)
    assert r.status_code == 200, r.text
    detail = r.json()

    assert detail["progress"] == "已确认"
    assert detail["confirmedAt"]
    assert len(detail["progressRecords"]) == before_count + 1
    last = detail["progressRecords"][-1]
    assert last["progress"] == "已确认"
    assert last["follower"] == "佘淑娟"
    assert last["followDate"] == date.today().isoformat()
    assert last["note"] == "商机信息已完整确认"


def test_progress_invalid_and_append(client, admin_headers):
    """progress：非法值 400；合法值追加记录并更新公告进度。"""
    ann_id = _first_id(client, admin_headers)
    before = _detail(client, admin_headers, ann_id)

    r = client.post(
        f"{BASE}/{ann_id}/progress", json={"progress": "乱七八糟"}, headers=admin_headers
    )
    assert r.status_code == 400
    assert "无效的进度状态" in r.json()["detail"]
    assert len(_detail(client, admin_headers, ann_id)["progressRecords"]) == len(
        before["progressRecords"]
    )

    r = client.post(
        f"{BASE}/{ann_id}/progress",
        json={"progress": "已分配", "note": "电话沟通"},
        headers=admin_headers,
    )
    assert r.status_code == 200, r.text
    detail = r.json()
    assert detail["progress"] == "已分配"
    assert len(detail["progressRecords"]) == len(before["progressRecords"]) + 1
    last = detail["progressRecords"][-1]
    assert last["progress"] == "已分配"
    assert last["note"] == "电话沟通"
    assert last["follower"] == "佘淑娟"

    # 已确认会写 confirmedAt
    r = client.post(
        f"{BASE}/{ann_id}/progress", json={"progress": "已确认"}, headers=admin_headers
    )
    assert r.status_code == 200, r.text
    assert r.json()["progress"] == "已确认"
    assert r.json()["confirmedAt"]


def test_member_cannot_assign(client, member_headers, admin_headers):
    """非集团客户部执行分配 → 403。"""
    ann_id = _first_id(client, admin_headers)

    r = client.post(
        f"{BASE}/{ann_id}/assign", json={"group": "潮安"}, headers=member_headers
    )
    assert r.status_code == 403

    r = client.post(
        f"{BASE}/batch-assign",
        json={"ids": [ann_id], "group": "潮安"},
        headers=member_headers,
    )
    assert r.status_code == 403
    # 未产生任何分配
    assert _detail(client, admin_headers, ann_id)["assignmentRecords"] == []


def test_admin_assign_success(client, admin_headers):
    """admin 分配成功：处理人/小组/进度/下次跟进 + 分配记录、进度记录各 +1。"""
    ann_id = _first_id(client, admin_headers)
    before = _detail(client, admin_headers, ann_id)
    assert before["progress"] == "待分配"
    assert len(before["progressRecords"]) >= 1
    assert before["assignmentRecords"] == []

    r = client.post(
        f"{BASE}/{ann_id}/assign", json={"group": "潮安"}, headers=admin_headers
    )
    assert r.status_code == 200, r.text
    detail = r.json()

    assert detail["currentHandler"] == "林潇宇"
    assert detail["handlerGroup"] == "潮安"
    assert detail["progress"] == "已分配"
    assert detail["nextFollowUp"] == (
        date.today() + timedelta(days=3)
    ).isoformat()
    assert len(detail["assignmentRecords"]) == len(before["assignmentRecords"]) + 1
    assert len(detail["progressRecords"]) == len(before["progressRecords"]) + 1

    record = detail["assignmentRecords"][-1]
    assert record["assigner"] == "佘淑娟"
    assert record["assignerGroup"] == "集团客户部"
    assert record["assignee"] == "林潇宇"
    assert record["assigneeGroup"] == "潮安"

    last_progress = detail["progressRecords"][-1]
    assert last_progress["progress"] == "已分配"
    assert "分配给潮安" in last_progress["note"]
    assert "林潇宇" in last_progress["note"]

    # 小组不存在 → 404
    r = client.post(
        f"{BASE}/{ann_id}/assign", json={"group": "不存在组"}, headers=admin_headers
    )
    assert r.status_code == 404

    # 已确认公告不可再分配 → 400
    confirmed_id = _all_items(client, admin_headers)[1]["id"]
    _confirm(client, admin_headers, confirmed_id)
    r = client.post(
        f"{BASE}/{confirmed_id}/assign", json={"group": "潮安"}, headers=admin_headers
    )
    assert r.status_code == 400
    assert "已确认" in r.json()["detail"]


def test_batch_assign_skips_confirmed(client, admin_headers):
    """批量分配：跳过已确认/不存在，返回 skipped；成功项正常分配。"""
    ids = [item["id"] for item in _all_items(client, admin_headers)]
    confirmed_id, normal_id = ids[0], ids[1]
    confirmed_detail = _confirm(client, admin_headers, confirmed_id)
    confirmed_count = len(confirmed_detail["progressRecords"])

    r = client.post(
        f"{BASE}/batch-assign",
        json={"ids": [confirmed_id, normal_id, MISSING_ID], "group": "潮安"},
        headers=admin_headers,
    )
    assert r.status_code == 200, r.text
    body = r.json()

    assert body["updated"] == 1
    assert [item["id"] for item in body["items"]] == [normal_id]
    skipped = {item["id"]: item["reason"] for item in body["skipped"]}
    assert skipped == {confirmed_id: "已确认", MISSING_ID: "不存在"}

    # 成功项已分配
    normal = _detail(client, admin_headers, normal_id)
    assert normal["progress"] == "已分配"
    assert normal["currentHandler"] == "林潇宇"
    assert normal["handlerGroup"] == "潮安"
    assert len(normal["assignmentRecords"]) == 1

    # 已确认项保持不变，且没有新增进度记录
    confirmed_after = _detail(client, admin_headers, confirmed_id)
    assert confirmed_after["progress"] == "已确认"
    assert confirmed_after["handlerGroup"] == ""
    assert len(confirmed_after["progressRecords"]) == confirmed_count


def test_not_found_returns_404(client, admin_headers):
    """不存在的公告：详情/记录/PATCH/confirm/progress/assign 全部 404。"""
    r = client.get(f"{BASE}/{MISSING_ID}", headers=admin_headers)
    assert r.status_code == 404
    assert r.json()["detail"] == "公告不存在"

    assert client.get(f"{BASE}/{MISSING_ID}/records", headers=admin_headers).status_code == 404
    assert (
        client.patch(
            f"{BASE}/{MISSING_ID}", json={"willBid": "是"}, headers=admin_headers
        ).status_code
        == 404
    )
    assert (
        client.post(f"{BASE}/{MISSING_ID}/confirm", headers=admin_headers).status_code
        == 404
    )
    assert (
        client.post(
            f"{BASE}/{MISSING_ID}/progress",
            json={"progress": "已分配"},
            headers=admin_headers,
        ).status_code
        == 404
    )
    r = client.post(
        f"{BASE}/{MISSING_ID}/assign", json={"group": "潮安"}, headers=admin_headers
    )
    assert r.status_code == 404
    assert r.json()["detail"] == "公告不存在"


def test_admin_assign_with_receiver_sets_that_person(client, admin_headers):
    """指定接收人时，处理人/记录落接收人，而不是小组管理员。"""
    ann_id = _first_id(client, admin_headers)
    r = client.post(
        f"{BASE}/{ann_id}/assign",
        json={"group": "潮安", "receiver": "张三"},
        headers=admin_headers,
    )
    assert r.status_code == 200, r.text
    detail = r.json()
    assert detail["currentHandler"] == "张三"
    assert detail["handlerGroup"] == "潮安"
    record = detail["assignmentRecords"][-1]
    assert record["assignee"] == "张三"
    assert record["assigneeGroup"] == "潮安"
    assert "张三" in detail["progressRecords"][-1]["note"]


def test_batch_assign_with_receiver(client, admin_headers):
    """批量分配同样支持接收人。"""
    ids = [item["id"] for item in _all_items(client, admin_headers)[:2]]
    r = client.post(
        f"{BASE}/batch-assign",
        json={"ids": ids, "group": "市区", "receiver": "李四"},
        headers=admin_headers,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["updated"] == 2
    for item in body["items"]:
        assert item["currentHandler"] == "李四"
        assert item["handlerGroup"] == "市区"
