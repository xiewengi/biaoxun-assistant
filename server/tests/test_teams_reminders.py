"""任务提醒（第 3 节）+ 团队（第 4 节）路由测试。

每个用例由 conftest 的 client fixture 重建独立临时库并灌种子数据，
用例之间不共享状态。
"""
from __future__ import annotations

from datetime import date, timedelta
from typing import Any, Dict

from app import db


def _iso(offset: int = 0) -> str:
    return (date.today() + timedelta(days=offset)).isoformat()


def _login(client, account: str, password: str = "123456"):
    return client.post(
        "/api/auth/login", json={"account": account, "password": password}
    )


def _insert_ann(
    ann_id: str,
    *,
    project_name: str = "测试项目",
    district: str = "潮安",
    progress: str = "待分配",
    handler: str = "",
    next_follow_up: str = "",
    created_at: str = "",
) -> None:
    db.execute(
        """INSERT INTO announcements
           (id, title, project_name, district, progress, current_handler,
            handler_group, next_follow_up, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            ann_id,
            project_name + "招标公告",
            project_name,
            district,
            progress,
            handler,
            "潮安" if progress == "已分配" else "",
            next_follow_up,
            created_at or date.today().isoformat(),
        ),
    )


def _wipe_announcements() -> None:
    db.execute("DELETE FROM announcements")


def _prepare_reminders() -> None:
    """四条提醒样本：待分配 / 已分配三级 + 一条已确认（应排除）。"""
    _wipe_announcements()
    _insert_ann(
        "A1",
        project_name="潮安智慧园区综合项目",
        district="潮安",
        progress="待分配",
        created_at=_iso(-5),
    )
    _insert_ann(
        "B1",
        district="潮安",
        progress="已分配",
        handler="林潇宇",
        next_follow_up=_iso(0),
    )
    _insert_ann(
        "C1",
        district="市区",
        progress="已分配",
        handler="佘淑娟",
        next_follow_up=_iso(2),
    )
    _insert_ann(
        "D1",
        district="潮安",
        progress="已分配",
        handler="林潇宇",
        next_follow_up=_iso(10),
    )
    _insert_ann("E1", district="潮安", progress="已确认")


# ---------------------------------------------------------------- 提醒


def test_reminders_requires_login(client):
    assert client.get("/api/reminders").status_code == 401
    assert client.get("/api/reminders?scope=all").status_code == 401
    assert client.post("/api/reminders/batch-assign", json={"ids": []}).status_code == 401
    assert client.get("/api/groups").status_code == 401


def test_reminders_levels_order_and_counts(client, admin_headers):
    _prepare_reminders()

    r = client.get("/api/reminders?scope=all", headers=admin_headers)
    assert r.status_code == 200, r.text
    data = r.json()
    items = data["items"]

    assert [i["id"] for i in items] == [
        "admin-A1",
        "sales-B1",
        "sales-C1",
        "sales-D1",
    ]
    assert [i["level"] for i in items] == ["urgent", "urgent", "warn", "info"]
    assert data["total"] == 4
    assert data["counts"] == {"urgent": 2, "warn": 1, "info": 1}

    admin_item = items[0]
    assert admin_item["type"] == "admin-assign"
    assert admin_item["label"] == "管理员分派"
    assert admin_item["targetId"] == "A1"
    assert admin_item["time"] == _iso(-5)
    assert admin_item["district"] == "潮安"
    assert admin_item["annProgress"] == "待分配"
    assert "已入库 5 天未分配" in admin_item["title"]
    assert "潮安智慧园区综合项目" in admin_item["title"]

    sales_item = items[1]
    assert sales_item["type"] == "sales-follow"
    assert sales_item["label"] == "业务员跟进"
    assert sales_item["annCurrentHandler"] == "林潇宇"
    assert "需跟进" in sales_item["title"]

    # 已确认公告不生成提醒
    assert all(i["targetId"] != "E1" for i in items)


def test_reminders_district_filter_and_me_scope(client, admin_headers, member_headers):
    _prepare_reminders()

    # 集团客户部：all 可按 district 过滤
    r = client.get(
        "/api/reminders?scope=all&district=潮安", headers=admin_headers
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert [i["id"] for i in data["items"]] == ["admin-A1", "sales-B1", "sales-D1"]
    assert data["counts"] == {"urgent": 2, "warn": 0, "info": 1}

    # 普通成员：me 只看 current_handler 是自己
    r = client.get("/api/reminders?scope=me&district=潮安", headers=member_headers)
    assert r.status_code == 200, r.text
    items = r.json()["items"]
    assert [i["id"] for i in items] == ["sales-B1", "sales-D1"]
    assert r.json()["counts"] == {"urgent": 1, "warn": 0, "info": 1}

    # 管理员 me：只看到分给自己的
    r = client.get("/api/reminders?scope=me", headers=admin_headers)
    assert r.status_code == 200, r.text
    assert [i["id"] for i in r.json()["items"]] == ["sales-C1"]

    # 非法 scope
    assert (
        client.get("/api/reminders?scope=other", headers=admin_headers).status_code
        == 400
    )


def test_reminders_scope_all_forbidden_for_member(client, member_headers):
    """业务员不能查看全部提醒 → 403。

    RBAC 改造后错误文案由「仅集团客户部可…」改为「无权限：查看所有提醒」，
    这里断言 RBAC 化的提示语。
    """
    r = client.get("/api/reminders?scope=all", headers=member_headers)
    assert r.status_code == 403
    assert "无权限" in r.json()["detail"]


def test_reminders_batch_assign_success(client, admin_headers):
    _wipe_announcements()
    _insert_ann("P1", project_name="待分配一")
    _insert_ann("P2", project_name="待分配二")
    _insert_ann("P3", project_name="已确认项目", progress="已确认")

    r = client.post(
        "/api/reminders/batch-assign",
        json={"ids": ["P1", "P2", "P3", "NOPE"], "group": "潮安"},
        headers=admin_headers,
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["updated"] == 2
    assert [i["id"] for i in data["items"]] == ["P1", "P2"]
    for item in data["items"]:
        assert item["progress"] == "已分配"
        assert item["currentHandler"] == "林潇宇"
        assert item["handlerGroup"] == "潮安"
        assert item["nextFollowUp"] == _iso(3)

    skipped = {s["id"]: s["reason"] for s in data["skipped"]}
    assert skipped == {"P3": "已确认", "NOPE": "不存在"}

    # 落库：分配记录 + 进度记录
    assert db.query_one(
        "SELECT COUNT(*) AS c FROM assignment_records WHERE ann_id IN ('P1','P2')"
    )["c"] == 2
    assert db.query_one(
        "SELECT progress FROM progress_records WHERE ann_id = 'P1' ORDER BY id DESC"
    )["progress"] == "已分配"

    # 重新计算提醒：两条都已变成业务员跟进，next_follow_up=今天+3 → warn
    r = client.get("/api/reminders?scope=all", headers=admin_headers)
    items = r.json()["items"]
    assert [i["id"] for i in items] == ["sales-P1", "sales-P2"]
    assert all(i["level"] == "warn" for i in items)


def test_reminders_batch_assign_permissions(client, admin_headers, member_headers):
    _wipe_announcements()
    _insert_ann("Q1")

    r = client.post(
        "/api/reminders/batch-assign",
        json={"ids": ["Q1"], "group": "潮安"},
        headers=member_headers,
    )
    assert r.status_code == 403
    assert "无权限" in r.json()["detail"]

    r = client.post(
        "/api/reminders/batch-assign",
        json={"ids": ["Q1"], "group": "不存在小组"},
        headers=admin_headers,
    )
    assert r.status_code == 404
    assert "小组不存在" in r.json()["detail"]


# ---------------------------------------------------------------- 团队


def test_list_groups_seeded_order(client, admin_headers):
    r = client.get("/api/groups", headers=admin_headers)
    assert r.status_code == 200, r.text
    items = r.json()["items"]
    assert [g["id"] for g in items] == [1, 2, 3, 4, 5]
    assert [g["name"] for g in items] == [
        "集团客户部",
        "战客中心",
        "市区",
        "潮安",
        "饶平",
    ]
    first = items[0]
    assert first["admin"] == "佘淑娟"
    assert first["adminAccount"] == "sheshujuan"
    assert first["members"] == []
    assert first["memberPinyin"] == []
    assert first["memberContacts"] == []
    assert first["memberDetails"] == []


def test_create_group_default_password_login(client, admin_headers):
    body = {
        "name": "测试组",
        "region": "测试组",
        "admin": "张负责人",
        "adminContact": "13900001111",
        "adminAccount": "xiangqiao_admin",
        "position": "负责人",
        "members": [
            {
                "name": "张三",
                "namePinyin": "zhangsan",
                "contact": "13800001111",
                "position": "成员",
            },
            {"name": "李四", "namePinyin": "lisi", "contact": "", "position": "成员"},
        ],
    }
    r = client.post("/api/groups", json=body, headers=admin_headers)
    assert r.status_code == 200, r.text
    group = r.json()
    assert group["id"] == 6
    assert group["name"] == "测试组"
    assert group["region"] == "测试组"
    assert group["admin"] == "张负责人"
    assert group["adminAccount"] == "xiangqiao_admin"
    assert group["createdAt"] == date.today().isoformat()
    assert group["members"] == ["张三", "李四"]
    assert group["memberPinyin"] == ["zhangsan", "lisi"]
    assert group["memberContacts"] == ["13800001111", ""]
    assert [m["name"] for m in group["memberDetails"]] == ["张三", "李四"]

    # 新账号默认密码 123456 可登录，并归属新小组
    r = _login(client, "xiangqiao_admin")
    assert r.status_code == 200, r.text
    user = r.json()["user"]
    assert user["group"] == "测试组"
    assert user["groupId"] == 6
    assert user["name"] == "张负责人"

    # 列表按 id 升序，新小组排最后
    items = client.get("/api/groups", headers=admin_headers).json()["items"]
    assert [g["id"] for g in items] == [1, 2, 3, 4, 5, 6]
    assert items[-1]["name"] == "测试组"


def test_create_group_conflicts(client, admin_headers):
    r = client.post(
        "/api/groups",
        json={
            "name": "潮安",
            "region": "潮安",
            "admin": "某人",
            "adminAccount": "new_admin_one",
        },
        headers=admin_headers,
    )
    assert r.status_code == 409
    assert "小组名称" in r.json()["detail"]

    r = client.post(
        "/api/groups",
        json={
            "name": "新小组",
            "region": "新小组",
            "admin": "某人",
            "adminAccount": "linxiaoyu2",
        },
        headers=admin_headers,
    )
    assert r.status_code == 409
    assert "账号" in r.json()["detail"]

    # 冲突请求没有留下脏数据
    assert len(client.get("/api/groups", headers=admin_headers).json()["items"]) == 5


def test_update_group_replace_members_and_reset_password(client, admin_headers):
    r = client.post(
        "/api/groups",
        json={
            "name": "测试组",
            "region": "测试组",
            "admin": "测试负责人",
            "adminContact": "13800002222",
            "adminAccount": "test_admin",
            "password": "oldpass",
            "members": [{"name": "张三"}, {"name": "李四"}],
        },
        headers=admin_headers,
    )
    assert r.status_code == 200, r.text
    group_id = r.json()["id"]

    # 成员数组整体替换（只传成员，其他字段保持）
    r = client.put(
        "/api/groups/{}".format(group_id),
        json={
            "members": [
                {
                    "name": "王五",
                    "namePinyin": "wangwu",
                    "contact": "13700003333",
                    "position": "成员",
                },
                {"name": "赵六"},
            ]
        },
        headers=admin_headers,
    )
    assert r.status_code == 200, r.text
    group = r.json()
    assert group["name"] == "测试组"
    assert group["admin"] == "测试负责人"
    assert group["members"] == ["王五", "赵六"]
    assert group["memberPinyin"] == ["wangwu", ""]
    assert group["memberContacts"] == ["13700003333", ""]
    stored = db.query_all(
        "SELECT name FROM group_members WHERE group_id = ? ORDER BY id", (group_id,)
    )
    assert [m["name"] for m in stored] == ["王五", "赵六"]

    # 不传 password 时旧密码不变
    assert _login(client, "test_admin", "oldpass").status_code == 200

    # 传 password 重置管理员密码
    r = client.put(
        "/api/groups/{}".format(group_id),
        json={"password": "newpass"},
        headers=admin_headers,
    )
    assert r.status_code == 200, r.text
    assert _login(client, "test_admin", "oldpass").status_code == 401
    assert _login(client, "test_admin", "newpass").status_code == 200

    # 改小组名 + 负责人 + 管理员账号，users 表同步
    r = client.put(
        "/api/groups/{}".format(group_id),
        json={
            "name": "测试组改名",
            "admin": "新负责人",
            "adminContact": "13600005555",
            "adminAccount": "test_admin2",
        },
        headers=admin_headers,
    )
    assert r.status_code == 200, r.text
    renamed = r.json()
    assert renamed["name"] == "测试组改名"
    assert renamed["admin"] == "新负责人"
    assert renamed["adminAccount"] == "test_admin2"
    assert renamed["members"] == ["王五", "赵六"]

    assert _login(client, "test_admin", "newpass").status_code == 401
    r = _login(client, "test_admin2", "newpass")
    assert r.status_code == 200, r.text
    assert r.json()["user"]["name"] == "新负责人"
    assert r.json()["user"]["phone"] == "13600005555"
    assert r.json()["user"]["group"] == "测试组改名"


def test_update_group_conflicts_and_missing(client, admin_headers):
    # 改成已有小组名 → 409
    r = client.put("/api/groups/4", json={"name": "市区"}, headers=admin_headers)
    assert r.status_code == 409
    assert "小组名称" in r.json()["detail"]

    # 改成已有管理员账号 → 409
    r = client.put(
        "/api/groups/4", json={"adminAccount": "sheshujuan"}, headers=admin_headers
    )
    assert r.status_code == 409
    assert "账号" in r.json()["detail"]

    # 不存在的小组
    assert (
        client.put("/api/groups/9999", json={"name": "x"}, headers=admin_headers).status_code
        == 404
    )

    # 冲突失败后原数据不变
    group = client.get("/api/groups", headers=admin_headers).json()["items"][3]
    assert group["name"] == "潮安"
    assert group["adminAccount"] == "linxiaoyu2"


def test_delete_ordinary_group(client, admin_headers):
    r = client.post(
        "/api/groups",
        json={
            "name": "临时组",
            "region": "临时组",
            "admin": "临时负责人",
            "adminContact": "13800004444",
            "adminAccount": "temp_admin",
            "members": [{"name": "临时成员"}],
        },
        headers=admin_headers,
    )
    assert r.status_code == 200, r.text
    group_id = r.json()["id"]
    user_row = db.query_one("SELECT * FROM users WHERE account = 'temp_admin'")
    assert user_row["group_id"] == group_id

    r = client.delete("/api/groups/{}".format(group_id), headers=admin_headers)
    assert r.status_code == 200, r.text
    assert r.json() == {"ok": True}

    items = client.get("/api/groups", headers=admin_headers).json()["items"]
    assert [g["id"] for g in items] == [1, 2, 3, 4, 5]

    assert db.query_one("SELECT * FROM groups WHERE id = ?", (group_id,)) is None
    assert db.query_one(
        "SELECT COUNT(*) AS c FROM group_members WHERE group_id = ?", (group_id,)
    )["c"] == 0
    # 管理员账号随小组一起删除，避免删组后残留账号仍可登录
    assert db.query_one("SELECT * FROM users WHERE account = 'temp_admin'") is None
    login = client.post(
        "/api/auth/login", json={"account": "temp_admin", "password": "123456"}
    )
    assert login.status_code == 401

    # 删组后可复用原管理员账号新建小组（不再 409）
    again = client.post(
        "/api/groups",
        json={
            "name": "临时组2",
            "region": "临时组2",
            "admin": "临时负责人",
            "adminContact": "13800004444",
            "adminAccount": "temp_admin",
        },
        headers=admin_headers,
    )
    assert again.status_code == 200, again.text
    client.delete(
        "/api/groups/{}".format(again.json()["id"]), headers=admin_headers
    )

    # 重复删除 → 404
    assert (
        client.delete("/api/groups/{}".format(group_id), headers=admin_headers).status_code
        == 404
    )


def test_delete_builtin_group_forbidden(client, admin_headers):
    r = client.delete("/api/groups/1", headers=admin_headers)
    assert r.status_code == 400
    assert "集团客户部" in r.json()["detail"]
    assert (
        db.query_one("SELECT * FROM groups WHERE id = 1")["name"] == "集团客户部"
    )
    assert len(client.get("/api/groups", headers=admin_headers).json()["items"]) == 5


def test_reminder_me_scope_includes_group_tasks(client, member_headers):
    """指派给本组普通成员时，小组管理员在 me 视图也能看到跟进提醒。"""
    _wipe_announcements()
    _insert_ann(
        "X1",
        district="潮安",
        progress="已分配",
        handler="张三",
        next_follow_up=_iso(1),
    )
    r = client.get("/api/reminders?scope=me&district=潮安", headers=member_headers)
    assert r.status_code == 200, r.text
    items = r.json()["items"]
    assert [i["id"] for i in items] == ["sales-X1"]
    assert items[0]["annCurrentHandler"] == "张三"
