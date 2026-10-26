# 标讯助手后端（FastAPI + SQLite）

## 目录结构

```
server/
├── app/
│   ├── main.py            # FastAPI 入口：建表、种子、路由、静态托管
│   ├── config.py          # 全部配置走环境变量
│   ├── db.py              # SQLite 连接与通用查询
│   ├── schema.sql         # 建表 DDL（幂等）
│   ├── security.py        # PBKDF2 口令 + Bearer 会话 + 权限
│   ├── serializers.py     # DB 行 → 前端 camelCase
│   ├── seed.py            # 首次启动灌 demo 数据
│   ├── routers/           # auth / announcements / reminders / teams / sources / schedule
│   └── services/          # assignments（分配）/ crawler（采集）
├── tests/                 # pytest（每个用例独立临时库）
├── deploy/                # systemd / nginx / 部署脚本 / 手册
├── requirements.txt
└── run.sh
```

## 本地启动

```bash
cd server
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m app.seed          # 可选：手动初始化库
.venv/bin/uvicorn app.main:app --reload --port 8000
# 浏览器打开 http://127.0.0.1:8000
```

首次启动自动建表 + 灌种子数据（5 个小组 / 16 条公告 / 50 个数据源 / 定时任务配置）。
种子账号：`sheshujuan`（集团客户部）/ `lixiaoyi` / `huangxinchong` / `linxiaoyu2` / `linxuxun`，密码 `123456`。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `BX_DATA_DIR` | `server/data` | 数据目录 |
| `BX_DB_PATH` | `<DATA_DIR>/biaoxun.db` | SQLite 文件 |
| `BX_STATIC_DIR` | 仓库 `demo/` | 前端静态目录 |
| `BX_COLLECTOR` | 仓库 `collector/collect.py` | 采集脚本；不存在时 `/api/collect` 返回 501 |
| `BX_SESSION_DAYS` | `7` | 登录有效期 |
| `BX_DEFAULT_PASSWORD` | `123456` | 新建小组管理员默认密码 |
| `BX_CORS_ORIGINS` | 本地几个端口 | 跨域白名单（逗号分隔） |

## 数据库

SQLite（WAL 模式），文件默认 `server/data/biaoxun.db`。表：

| 表 | 用途 |
|---|---|
| `groups` / `group_members` | 小组与成员 |
| `users` / `sessions` | 登录账号（由小组管理员派生）、会话 |
| `announcements` | 招标公告主表（含商机字段、处理人、进度） |
| `progress_records` | 进度记录 |
| `assignment_records` | 任务分配记录 |
| `sources` | 数据来源注册表 + 最近探活状态 |
| `schedule_config` | 定时任务配置（单行） |
| `crawl_runs` | 采集运行记录 |
| `audit_log` | 轻量操作审计 |

建表脚本：`app/schema.sql`（`CREATE TABLE IF NOT EXISTS`，可重复执行）。
备份：`sqlite3 data/biaoxun.db ".backup /backup/biaoxun-$(date +%F).db"`。

## 安全说明

| 项 | 现状 |
|---|---|
| 口令 | PBKDF2-HMAC-SHA256（12 万轮）+ 随机盐，不存明文 |
| 会话 | Bearer Token，默认 7 天；登录时清理过期会话；改密立即踢下线 |
| 权限 | 分配任务仅「集团客户部」；其余写接口要求登录 |
| 响应头 | `CSP(script-src 'self')`、`X-Content-Type-Options`、`X-Frame-Options`、`Referrer-Policy`；HTTPS 下自动加 HSTS |
| 审计 | 登录、改商机、确认、分配、团队/来源/配置变更写入 `audit_log` |

残余风险：公告正文来自外部招投标网站，前端用 `innerHTML` 渲染。CSP 已阻断脚本执行（实测注入 `onerror` 被浏览器拒绝），但仍可能出现布局干扰/诱导链接。要彻底消除，需要后端对富文本做 HTML 白名单清洗（后续迭代）。

## 运维命令（改密 / 备份 / 统计）

```bash
cd server
# 重置密码（同时清理该账号所有会话）
.venv/bin/python -m app.cli set-password sheshujuan '新的强密码'
# 在线备份（默认 server/data/backups/biaoxun-时间戳.db，带完整性校验）
.venv/bin/python -m app.cli backup
.venv/bin/python -m app.cli backup --dest /path/to/backup.db
# 立即执行一次采集并入库（定时任务调用的也是它）
.venv/bin/python -m app.cli collect --days 3
# 各表行数与公告进度分布
.venv/bin/python -m app.cli stats
```

服务器上直接跑 `server/deploy/backup.sh`（保留 14 天，可挂 crontab）。

## 测试

```bash
cd server && .venv/bin/python -m pytest -q
```

## 接口

完整契约见仓库根 `docs/api-contract.md`。健康检查：`GET /api/health`。
