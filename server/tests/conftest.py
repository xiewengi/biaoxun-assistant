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
os.environ.setdefault("BX_STATIC_DIR", str(ROOT.parent / "demo"))

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
def member_headers(client):
    r = client.post(
        "/api/auth/login", json={"account": "linxiaoyu2", "password": "123456"}
    )
    assert r.status_code == 200, r.text
    return {"Authorization": "Bearer " + r.json()["token"]}
