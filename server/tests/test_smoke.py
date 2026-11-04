"""部署冒烟：健康检查、静态托管、鉴权边界。"""


def test_health_ok_and_does_not_leak_paths(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["service"] == "biaoxun-api"
    # 公开接口不应回显服务器文件路径
    assert "db" not in body


def test_static_index_is_served(client):
    r = client.get("/")
    assert r.status_code == 200
    assert "标讯助手" in r.text
    # 前端依赖的三个脚本可访问
    for path in ("/js/data.js", "/js/api.js", "/js/app.js"):
        assert client.get(path).status_code == 200, path


def test_api_requires_login(client):
    assert client.get("/api/announcements").status_code == 401
    assert client.get("/api/groups").status_code == 401
    assert client.get("/api/sources").status_code == 401
    assert client.get("/api/schedule").status_code == 401
    assert client.get("/api/reminders").status_code == 401


def test_security_headers_present(client):
    for path in ("/", "/api/health"):
        r = client.get(path)
        assert r.status_code == 200, path
        csp = r.headers.get("content-security-policy", "")
        assert "default-src 'self'" in csp
        assert "script-src 'self'" in csp
        assert r.headers.get("x-content-type-options") == "nosniff"
        assert r.headers.get("x-frame-options") == "DENY"
        assert r.headers.get("referrer-policy") == "same-origin"
