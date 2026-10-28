"""应用配置：全部可用环境变量覆盖，方便本地 / 服务器两套环境。"""
from __future__ import annotations

import os
from pathlib import Path

# server/ 目录
BASE_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = BASE_DIR.parent

# 数据目录（SQLite 文件 + 日志），默认 server/data
DATA_DIR = Path(os.getenv("BX_DATA_DIR", BASE_DIR / "data")).resolve()
DB_PATH = Path(os.getenv("BX_DB_PATH", DATA_DIR / "biaoxun.db")).resolve()

# 前端静态目录：默认仓库 web/；部署时同样是 /opt/biaoxun/web
STATIC_DIR = Path(os.getenv("BX_STATIC_DIR", REPO_DIR / "web")).resolve()

# 采集脚本（存在才允许触发真实采集）
COLLECTOR_SCRIPT = Path(
    os.getenv("BX_COLLECTOR", REPO_DIR / "collector" / "collect.py")
).resolve()

# 会话有效期（天）
SESSION_DAYS = int(os.getenv("BX_SESSION_DAYS", "7"))

# 默认新用户 / 种子用户密码
DEFAULT_PASSWORD = os.getenv("BX_DEFAULT_PASSWORD", "123456")

# 允许跨域来源（本地静态服务器 8765 联调用；部署同源可收紧）
CORS_ORIGINS = [
    o.strip()
    for o in os.getenv(
        "BX_CORS_ORIGINS",
        "http://127.0.0.1:8000,http://localhost:8000,"
        "http://127.0.0.1:8765,http://localhost:8765,"
        "http://127.0.0.1:5173,http://localhost:5173",
    ).split(",")
    if o.strip()
]
