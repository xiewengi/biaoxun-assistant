"""运维 CLI 测试：改密、备份、统计。"""
from __future__ import annotations

import sqlite3

from app import cli, db, security


def test_set_password_changes_login_and_kills_sessions(client):
    login = client.post(
        "/api/auth/login", json={"account": "linxiaoyu2", "password": "123456"}
    )
    assert login.status_code == 200
    token = login.json()["token"]
    headers = {"Authorization": "Bearer " + token}
    assert client.get("/api/auth/me", headers=headers).status_code == 200

    assert cli.main(["set-password", "linxiaoyu2", "NewPass#2026"]) == 0

    # 旧密码失效、新密码可登录
    assert (
        client.post(
            "/api/auth/login", json={"account": "linxiaoyu2", "password": "123456"}
        ).status_code
        == 401
    )
    fresh = client.post(
        "/api/auth/login", json={"account": "linxiaoyu2", "password": "NewPass#2026"}
    )
    assert fresh.status_code == 200

    # 旧会话被清理
    assert client.get("/api/auth/me", headers=headers).status_code == 401


def test_set_password_validates_account_and_length(client):
    assert cli.main(["set-password", "nobody", "whatever"]) == 1
    assert cli.main(["set-password", "linxiaoyu2", "123"]) == 2
    row = db.query_one("SELECT salt FROM users WHERE account = 'linxiaoyu2'")
    hashed = security.hash_password("123456", row["salt"])
    assert (
        db.query_one(
            "SELECT password_hash FROM users WHERE account = 'linxiaoyu2'"
        )["password_hash"]
        == hashed["hash"]
    )


def test_backup_creates_consistent_copy(client, tmp_path):
    dest = tmp_path / "backup" / "biaoxun-test.db"
    assert cli.main(["backup", "--dest", str(dest)]) == 0
    assert dest.is_file()

    conn = sqlite3.connect(str(dest))
    try:
        assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert conn.execute("SELECT COUNT(*) FROM announcements").fetchone()[0] == 15
        assert conn.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 5
    finally:
        conn.close()


def test_stats_runs(client, capsys):
    assert cli.main(["stats"]) == 0
    out = capsys.readouterr().out
    assert "announcements" in out
    assert "公告进度分布" in out


def test_collect_requires_script(client, monkeypatch, capsys):
    from pathlib import Path

    from app import config

    monkeypatch.setattr(config, "COLLECTOR_SCRIPT", Path("/nonexistent/collect.py"))
    assert cli.main(["collect"]) == 1
    assert "采集脚本不存在" in capsys.readouterr().err


def test_collect_success(client, monkeypatch, capsys):
    from app.services import crawler

    calls = {}

    def fake_run(days, operator):
        calls["days"] = days
        calls["operator"] = operator
        return {
            "status": "ok",
            "new_count": 2,
            "sites_ok": 46,
            "sites_total": 50,
            "message": "采集完成，新增 2 条",
        }

    monkeypatch.setattr(crawler, "run_collect_now", fake_run)
    assert cli.main(["collect", "--days", "2"]) == 0
    out = capsys.readouterr().out
    assert "新增：2" in out
    assert "46/50" in out
    assert calls == {"days": 2, "operator": "cli"}


def test_collect_failure_returns_nonzero(client, monkeypatch):
    from app.services import crawler

    monkeypatch.setattr(
        crawler,
        "run_collect_now",
        lambda days, operator: {"status": "error", "new_count": 0, "message": "boom"},
    )
    assert cli.main(["collect"]) == 1
