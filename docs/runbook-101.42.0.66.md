# 部署运行手册 · 101.42.0.66（腾讯云）

> 本文只针对这一台服务器，记录已探明事实、部署步骤、验证与回滚。
> 通用说明见 [server/deploy/README.md](../server/deploy/README.md)。

## 0. 发布流程约束（2026-10-28 老大明确要求，务必遵守）

```
查问题 → 从 git 拿最新代码 → 本地改 → 老大测试 → 老大说"发版" → 才上服务器
```

| 步骤 | 动作 | 边界 |
|---|---|---|
| 1. 取最新代码 | `git -c http.version=HTTP/1.1 fetch origin`，确认 `origin/develop` 是最新 commit | 不要基于过期的本地副本判断问题 |
| 2. 本地改 | 在本地仓库 `~/Desktop/学习文档/标讯助手`（develop 分支）修改 | **只改本地，不碰服务器** |
| 3. 提交到 git | commit + push 到 `origin/develop` | ✅ 允许（备份与协作） |
| 4. 交老大测试 | 给出**明确的测试步骤**（命令 / 页面路径 / 预期结果） | 必须说清怎么验 |
| 5. 等发版指令 | **老大明确说"发版"** 才继续 | ⛔ 没有这句话就停在这里 |
| 6. 部署 | 执行第 3 节的 `deploy.sh` | 仅在第 5 步通过后执行 |

> ⛔ **红线**：`deploy.sh` / `rsync` / `systemctl restart` 等任何改生产环境的动作，
> **必须等老大明确说"发版"**。"修好了""测试全绿""代码已提交" **都不等于可以上线**。
> 任何"要不要发版"的判断，一律先问，不要自行决定。

> 📌 部署前务必先备份数据库（见第 3 节），并确认 `deploy.sh` 的 `RSYNC_EXCLUDES`
> 仍排除 `/腾讯云/`、`*.pem`、`*.key`、`/.agents/`、`*.bak*`（私钥绝不能同步到公网机器）。

## 1. 服务器现状（2026-10-25 探测）

| 项 | 值 |
|---|---|
| 公网 IPv4 | `101.42.0.66`（腾讯云） |
| 开放端口 | 22 / 80 / 443（8000 当前未放行） |
| 系统 | Ubuntu 24.04（OpenSSH_9.6p1 Ubuntu-3ubuntu13.18，Python 3.12） |
| Web 服务器 | **Caddy** 占用 80/443，现有站点「A股每日涨幅榜」 |
| 证书 | Caddy 自签（Local Authority，探测时已过期，浏览器会提示不安全） |
| SSH | **仅公钥认证**；部署私钥在本机 `~/Desktop/学习文档/标讯助手/腾讯云/biaoxun2.pem`（用户 `ubuntu`） |
| sudo | 免密，口令为 `biaoxun`：`echo biaoxun \| sudo -S <命令>` |
| 域名 / 备案 | 无域名、无备案 → 2026-10-25 起改为 `http://101.42.0.66/` 根路径访问（纯 HTTP，无证书警告） |

> ⚠️ **私钥路径变更（2026-10-28 实测）**：本手册早期写的 `~/.ssh/biaoxun_deploy` 与 `~/Downloads/biaoxun2.pem`
> **均已失效**（Permission denied / 文件不存在）。当前唯一可用私钥是
> `~/Desktop/学习文档/标讯助手/腾讯云/biaoxun2.pem`。
>
> ⚠️ **GitHub 访问需强制 HTTP/1.1**（2026-10-28 实测）：本机 `github.com` 走默认 HTTP/2 会握手失败，
> 报 `Failed to connect to github.com port 443` 或代理 `CONNECT tunnel failed, 502`。
> 解决：`git -c http.version=HTTP/1.1 <fetch|push>`，并清空代理变量：
> `http_proxy= https_proxy= all_proxy= HTTP_PROXY= HTTPS_PROXY= ALL_PROXY= git -c http.version=HTTP/1.1 push origin develop`
> （WorkBuddy 沙箱内还需加 `dangerouslyDisableSandbox`）。

**原则：不动「A股」站点，只往 Caddyfile 加一段 `/biaoxun` 路由；不需要改安全组。**

## 2. 部署前检查（SSH 可用后执行）

```bash
KEY=~/Desktop/学习文档/标讯助手/腾讯云/biaoxun2.pem
SSH="ssh -i $KEY -o ConnectTimeout=10 ubuntu@101.42.0.66"

# 只读体检
$SSH 'bash -s' < server/deploy/preflight.sh

# Caddy 现状（改之前必须先看）
$SSH 'cat /etc/caddy/Caddyfile; systemctl is-active caddy; ss -lntp | grep -E ":(80|443|8000)\b"'

# 确认没有旧部署 / 磁盘充足
$SSH 'ls -la /opt/biaoxun 2>/dev/null || echo 全新; df -h /; free -h'
```

预期：`/opt/biaoxun` 不存在、磁盘 >2GB、8000 未被监听、Caddy active。

## 3. 部署应用（不改 80/443）

```bash
cd "/Users/yyym/Desktop/学习文档/标讯助手"

PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple \
  ./server/deploy/deploy.sh \
    --host 101.42.0.66 \
    --user ubuntu \
    --identity ~/Desktop/学习文档/标讯助手/腾讯云/biaoxun2.pem
```

脚本会：rsync 代码 → 建 `biaoxun` 用户 → venv + 依赖（含采集器可选依赖）→ 前端同步到
`/opt/biaoxun/web` → 预初始化 SQLite 种子 → 安装并启动 `biaoxun.service`（127.0.0.1:8000）
→ 检测到 Caddy 后**跳过 nginx**并打印子路径提示 → 本机健康检查。

成功后服务器本机：`curl http://127.0.0.1:8000/api/health` 返回 `{"ok":true,...}`。

## 4. 接入 Caddy 子路径

```bash
$SSH 'cat /etc/caddy/Caddyfile'          # 先确认现有站点块结构

# 把脚本传上去
scp -i ~/Desktop/学习文档/标讯助手/腾讯云/biaoxun2.pem server/deploy/apply-caddy-subpath.py ubuntu@101.42.0.66:/tmp/

# dry-run 看插入位置（不写文件）
$SSH 'python3 /tmp/apply-caddy-subpath.py --caddyfile /etc/caddy/Caddyfile --dry-run'

# 正式写入：自动备份 + caddy validate + 失败回滚 + reload
$SSH 'python3 /tmp/apply-caddy-subpath.py --caddyfile /etc/caddy/Caddyfile --reload'
```

脚本插入内容（`route` 保证排在原站点兜底 `reverse_proxy`/`file_server` 之前）：

```caddyfile
	# 标讯助手：/biaoxun/ → 127.0.0.1:8000（由 apply-caddy-subpath.py 添加）
	redir /biaoxun /biaoxun/ 308
	route /biaoxun/* {
		uri strip_prefix /biaoxun
		reverse_proxy 127.0.0.1:8000
	}
```

该片段已在本地用真实 Caddy v2.11.7 验证：`/biaoxun` 308、子路径 200、其他路径仍走原路由。

## 5. 验收

```bash
# 接口与静态资源 16 项检查（自签证书加 --insecure）
./server/deploy/verify_deploy.sh --base https://101.42.0.66/biaoxun --insecure

# 浏览器全流程（登录/6 个页面/详情），截图落到 screenshots/subpath/
PLAYWRIGHT_BROWSERS_PATH=./.pw-browsers \
  node scripts/ui_check_subpath.js https://101.42.0.66/biaoxun/
```

预期：验收 16/16 通过；浏览器 0 控制台报错、0 失败请求；API 全部在 `/biaoxun/api/*`。

## 6. 上线后收尾

```bash
# 1) 改默认密码（每个账号一次）
$SSH 'cd /opt/biaoxun/server && sudo -u biaoxun env BX_DATA_DIR=/opt/biaoxun/data \
  .venv/bin/python -m app.cli set-password sheshujuan "新强密码"'

# 2) 配每日备份（biaoxun 用户 crontab）
$SSH 'sudo -u biaoxun crontab -e'
#   15 3 * * * /opt/biaoxun/server/deploy/backup.sh >> /opt/biaoxun/data/backup.log 2>&1

# 3) 查看服务与日志
$SSH 'systemctl status biaoxun --no-pager; journalctl -u biaoxun -n 50 --no-pager'
```

## 7. 回滚

| 场景 | 操作 |
|---|---|
| 只想下线标讯助手 | `systemctl disable --now biaoxun`（数据保留在 `/opt/biaoxun/data`） |
| Caddy 路由出问题 | 恢复 `/etc/caddy/Caddyfile.bak.<时间戳>` → `caddy validate --config /etc/caddy/Caddyfile` → `systemctl reload caddy` |
| 应用异常 | `journalctl -u biaoxun -n 100`；代码可重跑 deploy.sh 覆盖，数据不受影响 |
| 数据库损坏 | 用 `backup.sh` 生成的备份替换 `data/biaoxun.db` 后重启服务 |

## 7.1 备用路径：SSH 不可用时

如果无法把公钥加到服务器，用离线发布包（详细步骤见 [deploy/README.md 4.5](../server/deploy/README.md)）：

```bash
./server/deploy/package.sh                      # 本地生成 dist/biaoxun-release-*.tar.gz
# 通过腾讯云网页终端上传 tar.gz 到 /root，解压后：
cd /root/biaoxun-release && sudo bash install.sh \
  --pip-index-url https://pypi.tuna.tsinghua.edu.cn/simple
```

之后仍需按第 4 节在 Caddyfile 里加 `/biaoxun` 路由（或让标讯助手直接占用一个已放行的端口）。

## 8. 已知风险

1. **自签证书**：`https://101.42.0.66/biaoxun/` 浏览器会提示不安全；没有域名/备案时属正常。若后续备案，可给 Caddy 配正式证书。
2. **Caddy 证书过期**：现有站点证书在探测时已过期；reload 后 Caddy 可能自动续期（内部 CA），也可能维持现状——不影响标讯助手路由。
3. **采集器依赖**：`/api/collect` 需要 `collector/requirements.txt` 安装成功；失败只影响「刷新抓取」按钮，不影响主站。
4. **安全组**：不需要放行 8000；若以后想独立端口访问，需要另行放行并改 systemd 监听地址。

---

## 9. 实际部署记录（2026-10-25 完成）

| 项 | 结果 |
|---|---|
| SSH | `ubuntu@101.42.0.66`，私钥 `~/Desktop/学习文档/标讯助手/腾讯云/biaoxun2.pem`（与公钥 `skey-oftylro3` 配对），免密 sudo（口令 `biaoxun`） |
| 部署方式 | `deploy.sh --user ubuntu --identity ...` + 清华 pip 镜像 |
| 安装目录 | `/opt/biaoxun`（server/web/collector/data/backup），systemd `biaoxun` 监听 `127.0.0.1:8000`（2 workers） |
| 采集器依赖 | 首次因 collector 目录权限失败，`chown biaoxun` 后补装成功（trafilatura 2.3.1 等） |
| Caddy | 已切换为根路径纯 HTTP：`:80` → `127.0.0.1:8000`（HTTPS 已关闭，备份仍保留） |
| 旧站 | 「A股每日涨幅榜」已停止并删除（`stockrank.service`、`/opt/stockrank`）；备份 `/opt/backup/ashare-20261025-122819.tar.gz`；旧 Caddyfile 备份 `/etc/caddy/Caddyfile.bak.20261025-123049` |
| 备份 | 每日 03:15 `backup.sh`（biaoxun crontab），手动首备 `biaoxun-2026-10-25-123141.db` |
| 验收 | `verify_deploy.sh --base http://101.42.0.66` → **16/16 通过**；Playwright 全页面 0 报错 |
| 定时采集 | systemd timer `biaoxun-collect.timer`，每 2 小时 :15 触发（下次 14:17）；首次手动运行 12:49–12:55，新增 4 条，成功站点 46/50，DB 总数 16→20 |
| 访问地址 | **http://101.42.0.66/**（按老大要求改为纯 HTTP，无证书警告） |

> 安全待办：
> 1. 默认密码仍是 `123456`，公网可访问，建议立即改密（`app.cli set-password`）。
> 2. 旧 A股 的 systemd 单元里有 `OPENROUTER_API_KEY`，已随备份保留，建议到 OpenRouter 后台轮换该 key。

### 9.1 采集质量修复（2026-10-25 下午）

| 问题 | 原因 | 处理 |
|---|---|---|
| 列表出现「深圳能源…」 | 该公告是深圳能源**多电厂联合采购**，正文含潮安厂（潮安区沙溪镇）、湘桥厂（湘桥区铁铺镇），属潮州相关；不是城市过滤失效 | 保留 1 条；标题由「招标公告」回填为项目名，区县由「湘桥」改为「市区」（多区县） |
| 出现「广东省农村产权流转交易管理服务平台」 | 抓到的是平台首页，正文导航里含「潮州」被旧逻辑误判 | 删除；新增 `looks_like_announcement` 排除首页/导航页 |
| 同一公告重复两条 | 旧 ID 用 Python `hash()`，进程间不稳定，每天换 ID | 改为 md5 稳定 ID；入库按 URL / 项目编号 /（标题+日期）去重 |
| 城市过滤 | 旧逻辑把整页 5000 字（含导航城市列表）参与判断 | 改为标题/项目名/采购人/正文前 1500 字；导航页直接排除 |

修复后手动采集：13:08–13:14，新增 1 条（即上述多电厂公告），无首页噪声；当前库 17 条。

### 9.2 删除测试分配数据 + 采集窗口调整（2026-10-26）

- 删除公告 `ANN202610090265`（韩东新城防洪整治二期，发布 2026-10-09，测试分配给市区黄昕翀）；
  删除前备份：`/opt/biaoxun/backup/biaoxun-2026-10-26-083244.db`。
- 该公告发布日距今 17 天，旧定时窗口只有 3 天，删除后无法重抓；已将 systemd 定时任务窗口改为 **30 天**。
- 同时修复 gdgpo 关键词匹配只看正文前 300 字的问题（扩到 3000 字），单条流水线实测可重新产出该公告。
- 下一次定时运行（10:19 左右）会以新 ID（稳定 md5）重新入库，进度为「待分配」。

### 9.3 种子重复回填修复（2026-10-26）

问题：`seed.run_seed()` 每次进程启动都会对 `web/data/announcements.json` 做 `INSERT OR IGNORE`，
导致用户删除的种子公告在服务重启（含部署）后被重新插回。本次删除测试公告后就复现了一次。

修复：`seed_announcements()` 只在 `announcements` 表为空时灌种子；新增回归测试
`tests/test_seed_restart.py`。已实测：删除后重启服务，公告数保持 16，不再回填。

### 9.4 10:17 定时任务验证（2026-10-26）

10:17:46–10:24:34 首次以 30 天窗口运行：**新增 3 条**，公告总数 16 → 19，无重复 URL。
被删的「韩东新城防洪二期」以新 ID `ANN20261009398EEE` 重新入库，进度「待分配」。

> 页面上看到 16 条是任务还在跑（7 分钟）时的瞬时状态。

期间混入一条手工接口测试数据（`ANN261026816595` / production-deploy-v1，audit_log 显示 10:22:54
由 sheshujuan 登录后「新增公告」写入，非采集产生），已删除；库中无 example.com 残留。

## 10. 三方一致性核对 + 结构重构（2026-10-28）

### 10.1 核对结论

| 核对项 | 结论 |
|---|---|
| 本地 ↔ GitHub | ✅ 完全一致（`develop` = `60e5036`） |
| 本地 ↔ 服务器 | ✅ 代码一致（64 个共有文件中 61 个 SHA256 相同；3 处差异为运行数据与旧副本） |

差异说明：`announcements.json` 是运行数据（服务器 22 条 md5 ID / 本地 16 条种子数据，DB 实际 26 条）；
服务器 `/opt/biaoxun/demo/` 是旧副本，**线上实际服务目录是 `web/`**（systemd `BX_STATIC_DIR=/opt/biaoxun/web`）。

### 10.2 安全加固

- **清除服务器私钥副本**：`/opt/biaoxun/腾讯云/biaoxun2.pem`（rsync 把本地 `腾讯云/` 目录带上去的）已删除，
  同源垃圾 `.agents/`、`标讯助手demo.html.bak*` 一并清理。
- **修根因**：`deploy.sh` 的 `RSYNC_EXCLUDES` 补上 `/腾讯云/`、`*.pem`、`*.key`、`/.agents/`、`*.bak*`，
  避免下次 deploy 再次把私钥同步到公网机器。`package.sh` 是白名单打包，天然无此问题。
- 服务健康未受影响：清理后 `biaoxun.service` active、`/api/health` 正常、DB 26 条不变。

### 10.3 前端目录重构：demo/ → web/

**背景**：原设计是 `demo/`（源码）+ `web/`（发布副本）双目录，服务器上两份都存在，
导致「本地看着不一致」的困扰，且每次 deploy 要多一次 rsync 复制。

**改动**：源码目录 `demo/` 重命名为 `web/`，**取消双目录**。

| 项 | 改前 | 改后 |
|---|---|---|
| 仓库前端目录 | `demo/` | `web/` |
| 服务器前端目录 | `demo/`（源码）+ `web/`（副本） | `web/`（唯一，rsync 直接同步） |
| systemd `BX_STATIC_DIR` | `/opt/biaoxun/web` | `/opt/biaoxun/web`（不变） |
| seed 种子路径 | `demo/data/*.json` | `web/data/*.json` |
| deploy.sh 6.7 步 | `rsync demo/ → web/` | 仅校验 + 清理历史 `demo/` |

**同步改动**：`config.py`、`seed.py`（常量改名 `DEMO_*` → `SEED_*`）、`services/crawler.py`、
`serializers.py`、`routers/announcements.py`、`tests/conftest.py`、`deploy.sh`、`install.sh`、
`package.sh`、`caddy-biaoxun.conf`、全部相关文档。

**同时删除**：根目录单文件离线版 `标讯助手demo.html`（标题「标讯助手 - Demo（离线版）」）
及其在 `collector/collect.py` 中的写回逻辑 `inject_single_file()`。
> 该文件是**独立单文件版**，与 `web/` 目录的正式前端无关；服务器从未部署过它。

**验证**：`bash -n` + `py_compile` 全通过；pytest **58 passed / 16 failed**，
其中 16 项失败经 `git stash` 基线对比确认为**改动前既有失败**（RBAC 改造引入），与本次重构无关；
端到端启动 uvicorn：健康检查 OK、静态资源 200、登录成功、seed 从 `web/data` 读入 15 条公告。

### 10.4 未处理事项

- 默认密码仍是 `123456`（公网可访问），按老大要求本次不改，建议后续处理。
- 旧 A股 的 `OPENROUTER_API_KEY` 建议到 OpenRouter 后台轮换。
- pytest 里 16 项 RBAC 相关失败建议单独排期修复。
