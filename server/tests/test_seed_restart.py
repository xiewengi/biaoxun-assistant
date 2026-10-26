"""种子回归：服务重启不应把用户删除的种子公告插回来。"""

from app import db, seed


def test_seed_does_not_reinsert_after_restart(client):
    total = db.query_one("SELECT COUNT(*) c FROM announcements")["c"]
    assert total == 15
    target = db.query_one("SELECT id FROM announcements ORDER BY id LIMIT 1")["id"]
    db.execute("DELETE FROM announcements WHERE id = ?", (target,))
    assert db.query_one("SELECT COUNT(*) c FROM announcements")["c"] == 14

    stats = seed.run_seed()
    assert stats["announcements"] == 0
    assert db.query_one("SELECT COUNT(*) c FROM announcements")["c"] == 14
    assert db.query_one("SELECT 1 FROM announcements WHERE id = ?", (target,)) is None
