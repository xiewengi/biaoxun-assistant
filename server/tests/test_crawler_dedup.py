"""采集入库去重测试：URL / 项目编号 / 标题+日期 三种键。"""
from __future__ import annotations

from app.services import crawler


def _item(**over):
    base = {
        "id": "ANN209901019999",
        "title": "潮州市测试项目招标公告",
        "projectName": "潮州市测试项目",
        "projectCode": "TEST-CODE-001",
        "sourceUrl": "https://example.com/notice/1",
        "pubDate": "2099-01-01",
        "createdAt": "2099-01-01",
        "progressRecords": [{"progress": "待分配", "follower": "系统", "followDate": "2099-01-01", "note": "x"}],
    }
    base.update(over)
    return base


def test_insert_then_dedup_by_url(client):
    assert crawler._insert_announcements([_item()]) == 1
    # 同 URL、不同 id（模拟每天重新生成 id）
    assert crawler._insert_announcements([_item(id="ANN209901018888", projectCode="OTHER")]) == 0


def test_dedup_by_project_code(client):
    crawler._insert_announcements([_item()])
    same_code = _item(
        id="ANN209901017777",
        title="完全不同的标题但项目编号相同",
        sourceUrl="https://example.com/notice/2",
    )
    assert crawler._insert_announcements([same_code]) == 0


def test_dedup_by_title_and_date(client):
    crawler._insert_announcements([_item()])
    same_title = _item(
        id="ANN209901016666",
        projectCode="CODE-XYZ",
        sourceUrl="https://example.com/notice/3",
    )
    assert crawler._insert_announcements([same_title]) == 0


def test_generic_title_same_date_is_not_false_positive(client):
    first = _item(
        id="ANN209901015555",
        title="招标公告",
        projectCode="CODE-A",
        sourceUrl="https://example.com/a",
    )
    second = _item(
        id="ANN209901014444",
        title="招标公告",
        projectCode="CODE-B",
        sourceUrl="https://example.com/b",
    )
    assert crawler._insert_announcements([first]) == 1
    assert crawler._insert_announcements([second]) == 1


def test_dedup_within_same_batch(client):
    a = _item(id="ANN209901013333", projectCode="BATCH-1")
    b = _item(id="ANN209901012222", projectCode="BATCH-2")  # 同 URL
    assert crawler._insert_announcements([a, b]) == 1
