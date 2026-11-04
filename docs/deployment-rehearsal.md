# 部署彩排记录（生产同构，2026-10-25）

> 目的：在拿到腾讯云服务器凭据前，用与 `deploy.sh` 完全一致的目录布局、全新 venv、
> 2 个 uvicorn worker 把「首次部署 → 写入 → 重启 → 更新部署 → 备份 → 恢复」全链路走一遍，
> 提前暴露只在生产布局下才会出现的问题。

## 1. 彩排布局（与 `/opt/biaoxun` 一致）

```
/tmp/bx-stage/
├── server/          # 代码 + 全新 .venv（未复用仓库里的 venv）
├── web/             # 前端静态文件 + 种子数据源（BX_STATIC_DIR 指向这里）
├── collector/       # 采集器 + sources.json
├── data/            # SQLite（biaoxun.db）
└── backup/          # backup.sh 产物
```

步骤严格按 `deploy/deploy.sh`：rsync 过滤同步 → 建 venv → 装 requirements →
预初始化种子 → 以 systemd 同款环境变量启动。

## 2. 验证结果

| 项目 | 结果 |
|---|---|
| 全新 venv 安装依赖 | ✅ fastapi 0.115.6，Python 3.9.6 |
| 应用导入预检查 | ✅ `import app.main` |
| 首次预初始化种子 | ✅ 5 小组 / 16 公告 / 50 数据源 / 5 用户 |
| `BX_STATIC_DIR` 生效 | ✅ 仅在 `web/` 放的探针文件返回 200；`/`、`/js/*.js`、CSS 全 200 |
| 2 个 worker 启动 | ✅ parent + 2 workers，无 SQLite 初始化竞争 |
| 登录 / 公告 / 提醒 | ✅ token 正常，16 条公告，stats 正确，16 条提醒 |
| 分配写入（含 receiver） | ✅ `测试接收人 / 饶平 / 已分配` |
| 40 并发写（10 并发度） | ✅ **40/40 返回 200**，无 `database is locked` |
| 重启后数据持久化 | ✅ 处理人、小组、进度、42 条进度记录全部保留 |
| 重启种子幂等 | ✅ 公告仍 16 条，无重复 |
| 更新部署（同款 rsync --delete） | ✅ `data/`、`.venv/` 未被删除，新代码（cli/backup/preflight）已同步 |
| 更新后重启 | ✅ 数据完好，服务可用 |
| `deploy/backup.sh` | ✅ 在线备份 180KB，完整性校验通过，无 `-wal/-shm` 残留 |
| 备份恢复 | ✅ 恢复库 `integrity_check=ok`，16 公告 / 5 用户 / 42 条记录，可直接启动 |
| 运维 CLI | ✅ `stats` / `backup` 实测通过，备份切回 DELETE 日志模式 |

## 3. 尚未在真机验证（需要服务器）

| 项目 | 原因 |
|---|---|
| systemd 单元安装与 `Restart=always` | 本机 macOS 无 systemd |
| nginx 反代 / `nginx -t` / 静态缓存 | 本机未装 nginx |
| firewalld / SELinux 策略 | 仅 Linux 有 |
| 腾讯云安全组连通性 | 控制台配置 |
| apt/dnf 安装 python3-venv 等 | 发行版差异 |

这些都在 `deploy.sh` 中有显式检查与报错，真机部署时按脚本输出即可定位。

## 4. 复现方式

```bash
# 仓库根目录
rm -rf /tmp/bx-stage && mkdir -p /tmp/bx-stage/data
rsync -a --exclude '.venv/' --exclude '__pycache__/' --exclude 'data/' server/ /tmp/bx-stage/server/
rsync -a --exclude '.DS_Store' web/ /tmp/bx-stage/web/
rsync -a --exclude '__pycache__/' --exclude '_ocr/' --exclude 'logs/' collector/ /tmp/bx-stage/collector/
cd /tmp/bx-stage/server
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
BX_DATA_DIR=/tmp/bx-stage/data BX_STATIC_DIR=/tmp/bx-stage/web \
  .venv/bin/python -c 'from app import seed; print(seed.run_seed())'
BX_DATA_DIR=/tmp/bx-stage/data BX_STATIC_DIR=/tmp/bx-stage/web \
  .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8020 --workers 2
```

## 5. 结论

应用在「目标目录 + 全新环境 + 2 worker + 重启/更新/备份恢复」下行为一致，没有发现阻断部署的问题。
真机剩余风险集中在 systemd/nginx/安全组三类，均已由脚本显式检查并给出报错信息。

---

## 6. 追加验证：真实 Caddy 子路径共存（2026-10-25）

服务器现状：80/443 被 Caddy 占用（已有「A股每日涨幅榜」站点），无域名/备案，标讯助手计划挂在
`https://<IP>/biaoxun/`。为确认不影响现有站点，用真实 Caddy v2.11.7 做了完整验证。

| 验证项 | 结果 |
|---|---|
| `caddy validate`（带 `route` + `uri strip_prefix` 片段） | ✅ Valid configuration |
| `/biaoxun`（无斜杠） | ✅ 308 → `/biaoxun/` |
| `/biaoxun/` 首页 / `/biaoxun/api/health` / `/biaoxun/js/app.js` | ✅ 全部 200，来自标讯助手 |
| 其他路径 `/somewhere` | ✅ 仍走原有兜底路由（测试里是故意指向空端口的 502） |
| Playwright 全页面（登录/公告/提醒/团队/定时/来源/详情） | ✅ 0 控制台报错，8 个 API 全部 `/biaoxun/api/*`，无误发到根路径 |
| `verify_deploy.sh --base http://127.0.0.1:8443/biaoxun` | ✅ 16/16 通过 |

结论：`route /biaoxun/* { uri strip_prefix /biaoxun; reverse_proxy 127.0.0.1:8000 }` 会稳定排在现有
站点的兜底 `reverse_proxy`/`file_server` 之前，不会影响「A股」站点；路由片段见
`server/deploy/caddy-biaoxun.conf`，插入脚本 `server/deploy/apply-caddy-subpath.py`（带备份 + validate + 回滚）。
