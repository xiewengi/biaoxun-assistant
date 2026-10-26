"""FastAPI 入口：初始化数据库/种子数据、挂载 API 路由与前端静态文件。"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import Any, Dict

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from . import config, db, seed

logger = logging.getLogger("biaoxun")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    stats = seed.run_seed()
    logger.info("数据库就绪：%s（%s）", config.DB_PATH, stats)
    yield


app = FastAPI(title="标讯助手 API", version="1.0.0", lifespan=lifespan)

# 安全响应头：CSP 禁止内联脚本，可挡住爬虫内容里混入的 <script>/onerror 注入
CSP_POLICY = (
    "default-src 'self'; "
    "script-src 'self'; "
    "style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data:; "
    "font-src 'self' data:; "
    "connect-src 'self'; "
    "object-src 'none'; "
    "base-uri 'self'; "
    "form-action 'self'; "
    "frame-ancestors 'none'"
)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    headers = response.headers
    headers.setdefault("X-Content-Type-Options", "nosniff")
    headers.setdefault("X-Frame-Options", "DENY")
    headers.setdefault("Referrer-Policy", "same-origin")
    headers.setdefault("Content-Security-Policy", CSP_POLICY)
    if request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https":
        headers.setdefault(
            "Strict-Transport-Security", "max-age=31536000; includeSubDomains"
        )
    return response


app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---- API 路由 ----
from .routers import announcements as announcements_router  # noqa: E402
from .routers import auth as auth_router  # noqa: E402
from .routers import reminders as reminders_router  # noqa: E402
from .routers import schedule as schedule_router  # noqa: E402
from .routers import sources as sources_router  # noqa: E402
from .routers import teams as teams_router  # noqa: E402

app.include_router(auth_router.router)
app.include_router(announcements_router.router)
app.include_router(reminders_router.router)
app.include_router(teams_router.router)
app.include_router(sources_router.router)
app.include_router(schedule_router.router)


@app.get("/api/health")
def health() -> Dict[str, Any]:
    # 公开接口，不回显服务器文件路径
    return {"ok": True, "service": "biaoxun-api", "version": "1.0.0"}


# ---- 前端静态文件（部署时为 /opt/biaoxun/web） ----
if config.STATIC_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(config.STATIC_DIR), html=True), name="web")
else:  # pragma: no cover
    logger.warning("未找到前端静态目录：%s", config.STATIC_DIR)
