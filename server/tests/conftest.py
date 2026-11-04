"""测试夹具：每个用例独立临时 SQLite，自动建表 + 种子数据。"""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

# 必须在 import app 之前设置静态目录（main.py 在导入期挂载静态文件）
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
_BOOT_TMP = tempfile.mkdtemp(prefix="bx-boot-")
os.environ.setdefault("BX_DATA_DIR", _BOOT_TMP)
os.environ.setdefault("BX_DB_PATH", os.path.join(_BOOT_TMP, "boot.db"))
os.environ.setdefault("BX_STATIC_DIR", str(ROOT.parent / "web"))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import config  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "biaoxun-test.db")
    with TestClient(app) as c:
        yield c


@pytest.fixture()
def admin_headers(client):
    r = client.post(
        "/api/auth/login", json={"account": "sheshujuan", "password": "123456"}
    )
    assert r.status_code == 200, r.text
    return {"Authorization": "Bearer " + r.json()["token"]}


@pytest.fixture()
def member_headers(client, admin_headers):
    """业务员（role=member）的登录凭证。

    业务员账号在真实业务里是由集团管理员在「用户管理」页面新增的，
    所以这里走同一条路径：用管理员的 token 调 POST /api/users 建一个
    role='member' 的账号，再用它登录。

    注意：不能直接用种子里的 linxiaoyu2 —— RBAC 改造后它是小组管理员
    (group_admin)，权限矩阵里明确带有 announcements:assign，
    拿它测「业务员不能分配」会得到错误的 200。
    """
    r = client.post(
        "/api/users",
        json={
            "account": "test_yewuyuan",
            "name": "测试业务员",
            "phone": "13900000001",
            "groupId": 4,          # 潮安
            "role": "member",
            "password": "123456",
        },
        headers=admin_headers,
    )
    assert r.status_code == 200, r.text
    r = client.post(
        "/api/auth/login", json={"account": "test_yewuyuan", "password": "123456"}
    )
    assert r.status_code == 200, r.text
    return {"Authorization": "Bearer " + r.json()["token"]}
