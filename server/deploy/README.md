# 标讯助手 · 服务器部署手册

> 适用：FastAPI + SQLite + 静态前端（`demo/`），目标腾讯云 Linux（Ubuntu 22.04 / Debian / CentOS Stream / Rocky / Alma）。
> 默认安装目录：`/opt/biaoxun`；数据库：`/opt/biaoxun/data/biaoxun.db`；服务名：`biaoxun`。
> 一键脚本：[`deploy.sh`](./deploy.sh)；服务单元：[`biaoxun.service`](./biaoxun.service)；Nginx 站点：[`nginx-biaoxun.conf`](./nginx-biaoxun.conf)；通用启动：[`../run.sh`](../run.sh)。

---

## 0. 一页速查

| 场景 | 命令 |
| --- | --- |
| 部署前体检（服务器上只读） | `bash server/deploy/preflight.sh` |
| 部署后验收（本地执行） | `./server/deploy/verify_deploy.sh --base https://<IP>/biaoxun --insecure` |
| 首次部署（root） | `./server/deploy/deploy.sh --host 1.2.3.4` |
| 首次部署（ubuntu 用户） | `./server/deploy/deploy.sh --host 1.2.3.4 --user ubuntu` |
| 更新部署 | `git pull` 后重跑同一条 `deploy.sh` |
| 健康检查（服务器本机） | `curl http://127.0.0.1:8000/api/health` |
| 服务状态 | `systemctl status biaoxun --no-pager` |
| 实时日志 | `journalctl -u biaoxun -f` |
| 重启服务 | `sudo systemctl restart biaoxun` |
| Nginx 校验 / 重载 | `sudo nginx -t && sudo systemctl reload nginx` |
| 数据库备份 | `sudo -u biaoxun /opt/biaoxun/server/deploy/backup.sh` |

---

## 1. 部署架构与目录

```
本地仓库
├── server/                 FastAPI 代码、requirements.txt、deploy/
├── demo/                   静态前端（同时是首次启动的种子数据源）
└── deploy.sh ──rsync──▶ 服务器 /opt/biaoxun/
                          ├── server/            代码 + .venv（虚拟环境）
                          ├── demo/              种子数据源（announcements/site_results）
                          ├── web/               对外静态站点（由 demo/ 发布而来）
                          ├── data/biaoxun.db    SQLite（WAL）
                          └── backup/            可选：数据库备份（脚本不会删除）

systemd: biaoxun.service
  └── uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 2
        └── 同时提供 /api/* 与静态前端（StaticFiles）

nginx: 0.0.0.0:80 / :443
  ├── /api/ ──proxy──▶ 127.0.0.1:8000
  └── /     ──proxy──▶ 127.0.0.1:8000（FastAPI 托管静态前端）
```

关键点：

- **应用只监听 `127.0.0.1`**，公网流量必须经 Nginx 或 SSH 隧道进入，避免 8000 端口裸奔。
- `demo/` 必须保留在服务器上：`app/seed.py` 首次启动会读 `demo/data/announcements.json` 和 `demo/data/site_results.json` 灌种子数据；对外页面则从 `web/` 读取。
- `data/`、`web/`、`.venv/`、`backup/` 被部署脚本排除，更新时不会覆盖或删除。
- `deploy.sh` 的 rsync 带 `--delete`：`/opt/biaoxun` 下**本地不存在、也不在排除列表**的文件会被删除。不要把手工脚本/临时文件直接放在该目录，放 `data/` 或 `backup/`，或修改 `deploy.sh` 的 `RSYNC_EXCLUDES`。

---

## 2. 服务器前置

### 2.1 腾讯云安全组

在腾讯云控制台 → 云服务器 → 安全组，放行：

| 端口 | 协议 | 来源 | 用途 |
| --- | --- | --- | --- |
| 22 | TCP | 你的办公网 IP（尽量别 0.0.0.0/0） | SSH 部署/运维 |
| 80 | TCP | 0.0.0.0/0 | HTTP（Nginx） |
| 443 | TCP | 0.0.0.0/0 | HTTPS（启用证书后） |
| 8000 | TCP | 仅测试时临时放行你的 IP | 临时直连后端（生产不要开） |

服务器内若开了 firewalld（CentOS 常见）：

```bash
sudo firewall-cmd --permanent --add-service=http
sudo firewall-cmd --permanent --add-service=https
sudo firewall-cmd --reload
```

> 安全组和 firewalld 是两道门，只开一个不够。

Ubuntu 若启用了 ufw：

```bash
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw status
```

### 2.1.1 80/443 已被 Caddy 占用（无域名场景）

如果服务器上已经有 Caddy 在跑别的站点（例如页面标题是「A股每日涨幅榜」），**不要停掉它**。此时不装 nginx，
把标讯助手作为 systemd 服务监听 `127.0.0.1:8000`，再在现有 Caddyfile 里加一段子路径路由：

```caddyfile
	# 标讯助手：https://<IP>/biaoxun/
	# route 会排在现有站点的兜底 reverse_proxy / file_server 之前
	redir /biaoxun /biaoxun/ 308
	route /biaoxun/* {
		uri strip_prefix /biaoxun
		reverse_proxy 127.0.0.1:8000
	}
```

- 片段文件：[`caddy-biaoxun.conf`](./caddy-biaoxun.conf)；该段要写在现有站点的兜底规则之前。
- 前端已支持子路径（脚本用相对路径，API 根路径自动推导为 `/biaoxun/api`），无需改代码。
- 操作方式一：备份 `/etc/caddy/Caddyfile` → 手动插入片段 → `caddy validate --config /etc/caddy/Caddyfile` → `systemctl reload caddy`。
- 操作方式二（推荐，自动备份 + validate + 失败回滚）：

  ```bash
  python3 /opt/biaoxun/server/deploy/apply-caddy-subpath.py --dry-run   # 先看插入位置
  python3 /opt/biaoxun/server/deploy/apply-caddy-subpath.py --reload    # 写入并 reload
  ```
- 访问 `https://<IP>/biaoxun/`；Caddy 自签证书会让浏览器提示“不安全”，选择继续访问即可（无域名/无备案时属正常）。

`deploy.sh` 检测到 Caddy 时会打印上述提示，不会自动改 Caddyfile。

### 2.1.2 用标讯助手替换现有 Caddy 站点（旧站不要了）

如果 80/443 上的旧站点已确认不再需要，可以让标讯助手直接占根路径：

```bash
# 上传脚本
scp -i ~/.ssh/biaoxun2.pem server/deploy/switch-caddy-root.sh \
    server/deploy/caddy-root.conf ubuntu@<IP>:/tmp/bx-switch/

# 先 dry-run 看配置，再执行（自动备份 + caddy validate + 健康检查 + 失败回滚）
ssh -i ~/.ssh/biaoxun2.pem ubuntu@<IP> \
  'sudo bash /tmp/bx-switch/switch-caddy-root.sh --site-host <IP> --app-port 8000'
```

要点：
- `--site-host <IP>` 会写入全局 `default_sni`，否则用 IP 访问 HTTPS 时浏览器不带 SNI，Caddy 会 TLS 握手失败；
- 旧 Caddyfile 备份在 `/etc/caddy/Caddyfile.bak.<时间戳>`，旧站点线索在 `/etc/caddy/Caddyfile.old-hints.<时间戳>.txt`；
- 脚本**不会删除旧站点文件**，确认新站正常后再手工清理；
- 想避免自签证书警告可用 `--http-only`（纯 HTTP，无加密，不推荐公网使用）。

### 2.2 域名与备案（大陆服务器必读）

| 情况 | 方案 | 说明 |
| --- | --- | --- |
| 有域名，已完成 ICP 备案 | 域名 A 记录 → 公网 IP；Nginx 80/443 + certbot | 正式生产方案 |
| 有域名，未备案 | 先备案；期间用 IP + 高端口或 SSH 隧道 | 大陆机房 80/443 对外提供 Web 通常会被拦截/要求备案 |
| 无域名，仅测试 | SSH 隧道（推荐）或 IP + 8000 + 安全组 | 不要长期把 8000 暴露公网 |
| 香港/海外服务器 | 无需 ICP，但 HTTPS 仍需域名 | certbot 不支持给裸 IP 签证书 |

> 一句话：**大陆服务器的域名要先用 80/443 对外提供 Web，必须先完成 ICP 备案**；备案前用 IP + 高端口（安全组临时放行）或 SSH 隧道测试。

**测试方案 A：SSH 隧道（最安全，无需改配置）**

```bash
# 在你本地 Mac 执行，保持窗口不关
ssh -N -L 8000:127.0.0.1:8000 -p 22 root@<服务器IP>
# 浏览器打开 http://127.0.0.1:8000
```

**测试方案 B：临时监听 0.0.0.0:8000**

> 应用默认只监听 127.0.0.1。临时改成 0.0.0.0 需要 systemd drop-in，部署脚本不会覆盖 drop-in。

```bash
sudo systemctl edit biaoxun
# 写入：
[Service]
ExecStart=
ExecStart=/opt/biaoxun/server/.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 2

sudo systemctl daemon-reload
sudo systemctl restart biaoxun
```

然后在安全组临时放行 `8000/TCP`（尽量限制来源 IP），访问 `http://<服务器IP>:8000`。测试完删除 override 并重启：

```bash
sudo rm -f /etc/systemd/system/biaoxun.service.d/override.conf
sudo systemctl daemon-reload
sudo systemctl restart biaoxun
```

**域名 + HTTPS 正式流程**

1. 域名 A 记录指向服务器公网 IP，等待解析生效：`dig +short biaoxun.example.com`。
2. 大陆服务器完成 ICP 备案，且 80 端口可访问。
3. 修改 Nginx 配置中的 `server_name _;` 为实际域名（部署脚本安装后路径 `/etc/nginx/conf.d/biaoxun.conf`）。
4. 安装并申请证书：

```bash
# Ubuntu/Debian
sudo apt-get install -y certbot python3-certbot-nginx
# CentOS/RHEL（certbot 在 EPEL）
sudo dnf install -y epel-release
sudo dnf install -y certbot python3-certbot-nginx

sudo certbot --nginx -d biaoxun.example.com -d www.biaoxun.example.com
sudo certbot renew --dry-run
sudo systemctl enable --now certbot.timer
```

> `certbot --nginx` 会改写 `biaoxun.conf`。`deploy.sh` 检测到 `managed by Certbot` 标记时会**跳过覆盖**以保护 HTTPS；代价是后续模板更新（例如改 APP_PORT）需要手动合并配置。备份文件在 `biaoxun.conf.bak`。

### 2.3 系统与 Python 版本

- 推荐：Ubuntu 22.04/24.04、Debian 11/12、CentOS Stream 9、Rocky/Alma 9。
- 要求：**Python ≥ 3.9**（`uvicorn 0.34` 的要求）。Ubuntu 22.04 自带 3.10，Debian 12 自带 3.11。
- **CentOS 7 已 EOL，自带 Python 3.6，不满足要求**。请升级系统，或单独安装 Python 3.9+ 并调整 `ExecStart` 指向对应解释器。
- **CentOS Stream 8 / RHEL 8 默认 python3 也是 3.6**：需额外安装 `python39` 并让 `python3` 指向 3.9，否则 `deploy.sh` 会在版本检查处退出。
- 最低配置建议 1 核 1G 可跑；正式使用建议 2 核 2G 起。

---

## 3. 安装系统依赖

`deploy.sh` 会自动安装 Python venv/pip/rsync，但 Nginx、sqlite3 命令行工具、证书工具建议先手动装好（脚本检测到 Nginx 才会配置站点）。

### Ubuntu 22.04 / Debian 11/12

```bash
sudo apt-get update
sudo apt-get install -y \
  python3 python3-venv python3-pip \
  rsync nginx curl sqlite3 ca-certificates

python3 --version          # 必须 >= 3.9
nginx -v
sqlite3 --version
```

### CentOS Stream 8/9 / Rocky / Alma

```bash
sudo dnf install -y \
  python3 python3-pip \
  rsync nginx curl sqlite ca-certificates \
  policycoreutils-python-utils

python3 --version          # 必须 >= 3.9

# SELinux（CentOS 默认 Enforcing）：允许 Nginx 反代本机 8000
sudo setsebool -P httpd_can_network_connect 1

# firewalld 放行 80/443
sudo firewall-cmd --permanent --add-service=http
sudo firewall-cmd --permanent --add-service=https
sudo firewall-cmd --reload
```

老系统把 `dnf` 换成 `yum`。`deploy.sh` 检测到 SELinux Enforcing 时也会自动执行 `setsebool`。

**CentOS Stream 8 / RHEL 8（默认 Python 3.6）额外步骤**：

```bash
sudo dnf install -y python39 python39-pip
sudo alternatives --install /usr/bin/python3 python3 /usr/bin/python3.9 10
python3 --version          # 应显示 3.9.x
python3 -m venv /tmp/venv-test && rm -rf /tmp/venv-test   # 验证 venv/ensurepip 可用
```

如果 `venv` 仍不可用，补装 `python39-devel`/`python39-pip`，或直接升级到 CentOS Stream 9。

### 国内服务器 pip 慢

最省事：**在本地执行部署时带上镜像地址**，脚本会自动透传到服务器上的两条 pip 命令：

```bash
PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple \
  ./server/deploy/deploy.sh --host <IP> --user root
```

也可以登录服务器手动安装：

```bash
# 在服务器上临时使用清华源（脚本默认走官方 PyPI）
/opt/biaoxun/server/.venv/bin/pip install -r /opt/biaoxun/server/requirements.txt \
  -i https://pypi.tuna.tsinghua.edu.cn/simple
```

或写入 `/etc/pip.conf`：

```ini
[global]
index-url = https://pypi.tuna.tsinghua.edu.cn/simple
```

---

## 4. 首次部署

### 4.1 配置 SSH

如果服务器已经只认公钥、而你手上已有私钥文件，直接用 `--identity` 指定即可：

```bash
ssh -i ~/.ssh/biaoxun_deploy root@<服务器IP> 'id -u'
./server/deploy/deploy.sh --host <服务器IP> --identity ~/.ssh/biaoxun_deploy
```

否则按下面新建并用 `ssh-copy-id` 上传：

```bash
# 本地生成密钥（已有可跳过）
ssh-keygen -t ed25519 -C "biaoxun-deploy"

# 上传公钥（以后免密）
ssh-copy-id -i ~/.ssh/id_ed25519.pub -p 22 root@<服务器IP>

# 验证
ssh -p 22 root@<服务器IP> 'id -u && python3 --version'
```

腾讯云控制台也可以绑定密钥。若只能用密码：`deploy.sh` 会提示先 `ssh-copy-id`，或允许你交互输入密码；脚本使用 SSH ControlMaster 复用连接，后续 rsync 不会反复要密码。

**非 root 用户（如 ubuntu）**：需要免密 sudo，因为 rsync 要以 root 写入 `/opt/biaoxun`。腾讯云 Ubuntu 镜像的 `ubuntu` 用户通常已满足；若没有：

```bash
echo 'ubuntu ALL=(ALL) NOPASSWD:ALL' | sudo tee /etc/sudoers.d/biaoxun-deploy
sudo chmod 440 /etc/sudoers.d/biaoxun-deploy
```

### 4.2 执行一键部署

```bash
cd "/Users/yyym/Desktop/学习文档/标讯助手"

chmod +x server/deploy/deploy.sh server/run.sh

# root 用户
./server/deploy/deploy.sh --host 1.2.3.4

# 指定私钥文件（ssh 默认密钥不叫 id_ed25519 时）
./server/deploy/deploy.sh --host 1.2.3.4 --identity ~/.ssh/biaoxun_deploy

# Ubuntu 镜像常用 ubuntu 用户
./server/deploy/deploy.sh --host 1.2.3.4 --user ubuntu

# 自定义 SSH 端口 / 安装目录 / 应用端口
./server/deploy/deploy.sh \
  --host biaoxun.example.com \
  --user root \
  --port 2222 \
  --remote-dir /opt/biaoxun \
  --app-port 8000
```

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--host` | 无（必填） | 服务器公网 IP 或域名 |
| `--user` | `root` | SSH 登录用户（内部变量 `SSH_USER`，避免与本机 `$USER` 冲突） |
| `--port` | `22` | SSH 端口 |
| `--remote-dir` | `/opt/biaoxun` | 远程安装目录（必须是绝对路径） |
| `--app-port` | `8000` | 应用监听端口，systemd 与 Nginx 会同步替换 |

脚本执行内容（每步都有中文输出）：

1. 本地检查文件与 `ssh`/`rsync`，建立 SSH 连接。
2. 远程预检并安装 `rsync`（缺才装）。
3. 本地用 rsync 增量同步，排除 `.venv`、`__pycache__`、`data`、`.git`、`node_modules`、`.pw-browsers`、`*.db`、`web/`、`backup/`。
4. 检测 `apt-get` / `dnf` / `yum`；安装 `python3-venv`、`python3-pip`（已有跳过）；校验 Python ≥ 3.9。
5. 创建 `biaoxun` 系统用户（存在跳过）、`/opt/biaoxun/data`，创建/复用 `.venv` 并安装 `requirements.txt`。
6. 发布 `demo/` → `/opt/biaoxun/web/`。
7. 安装 `/etc/systemd/system/biaoxun.service`，`daemon-reload`、`enable`、`restart`。
8. 已装 Nginx 则安装 `/etc/nginx/conf.d/biaoxun.conf`、禁用发行版默认站点、`nginx -t`、reload；未装则只打印安装命令。
9. 检测 SELinux 并放行 Nginx 反代；提示 firewalld。
10. 循环请求 `/api/health`，失败会打印 `journalctl` 日志并以非 0 退出。

> 脚本不写死任何密码/密钥，密码/密钥只在你的 SSH 客户端和 systemd 环境中。可反复执行，幂等。

### 4.3 验证

在服务器上：

```bash
systemctl status biaoxun --no-pager
curl -s http://127.0.0.1:8000/api/health
curl -I http://127.0.0.1:8000/
curl -I http://127.0.0.1/
```

健康检查应返回类似：

```json
{"ok":true,"service":"biaoxun-api","version":"1.0.0","db":"/opt/biaoxun/data/biaoxun.db"}
```

在本地：

```bash
curl -I http://<服务器IP>/
```

浏览器打开 `http://<服务器IP>/`（或域名）。能打开登录页、能登录即部署成功。

本地 macOS 调试可以直接用通用启动脚本（默认 127.0.0.1:8000）：

```bash
./server/run.sh
# 或指定端口/worker
BX_PORT=8010 BX_WORKERS=1 ./server/run.sh
```

> 首次启动会自动建表并灌入种子数据（公告、小组、数据源、定时任务）。种子账号初始密码来自 `BX_DEFAULT_PASSWORD`，**默认 `123456`**。
>
> 如果是全新环境、尚未录入业务数据，建议在首次启动前就换掉默认密码；已经启动过也没关系，按下面的顺序重建即可（**会清空现有数据**，仅限空库）：
>
> ```bash
> sudo systemctl edit biaoxun
> # [Service]
> # Environment=BX_DEFAULT_PASSWORD=请换成强密码
> sudo systemctl daemon-reload
> sudo systemctl stop biaoxun
> sudo rm -f /opt/biaoxun/data/biaoxun.db /opt/biaoxun/data/biaoxun.db-wal /opt/biaoxun/data/biaoxun.db-shm
> sudo systemctl start biaoxun
> ```
>
> 种子只在用户表为空时写入，已初始化后单独改 `BX_DEFAULT_PASSWORD` **不会**重置旧账号密码。

### 4.3.1 上线后改密码（推荐）

后端自带运维 CLI，不用装 sqlite3，也不用停服务：

```bash
cd /opt/biaoxun/server
sudo -u biaoxun env BX_DATA_DIR=/opt/biaoxun/data \
  .venv/bin/python -m app.cli set-password sheshujuan '换成你的强密码'
# 其余账号同理：set-password <账号> <新密码>
```

改密会同时踢掉该账号所有在线会话。查看库状态：`... -m app.cli stats`。

### 4.4 手工部署（脚本不可用时）

```bash
# 本地
rsync -azh --delete \
  --exclude '.git/' --exclude '.venv/' --exclude '__pycache__/' \
  --exclude 'node_modules/' --exclude '.pw-browsers/' \
  --exclude '/server/data/' --exclude '/data/' --exclude '/web/' \
  --exclude '*.db' \
  ./ root@<IP>:/opt/biaoxun/

# 服务器
sudo groupadd -r biaoxun 2>/dev/null || true
sudo useradd -r -g biaoxun -d /opt/biaoxun -s /usr/sbin/nologin biaoxun 2>/dev/null || true
sudo install -d -m 750 -o biaoxun -g biaoxun /opt/biaoxun/data
sudo chown -R biaoxun:biaoxun /opt/biaoxun/server
sudo -u biaoxun python3 -m venv /opt/biaoxun/server/.venv
sudo -u biaoxun /opt/biaoxun/server/.venv/bin/pip install -r /opt/biaoxun/server/requirements.txt
sudo install -d -m 755 /opt/biaoxun/web
sudo rsync -a --delete /opt/biaoxun/demo/ /opt/biaoxun/web/
sudo chown -R biaoxun:biaoxun /opt/biaoxun/web
# 预初始化数据库，避免 2 个 worker 首启竞争
sudo -u biaoxun env BX_DATA_DIR=/opt/biaoxun/data BX_STATIC_DIR=/opt/biaoxun/web \
  /opt/biaoxun/server/.venv/bin/python -c \
  'import sys; sys.path.insert(0, "/opt/biaoxun/server"); from app import seed; seed.run_seed()'
sudo chown -R biaoxun:biaoxun /opt/biaoxun/data
sudo cp /opt/biaoxun/server/deploy/biaoxun.service /etc/systemd/system/biaoxun.service
sudo systemctl daemon-reload && sudo systemctl enable --now biaoxun
# Nginx：sudo cp /opt/biaoxun/server/deploy/nginx-biaoxun.conf /etc/nginx/conf.d/biaoxun.conf
sudo nginx -t && sudo systemctl reload nginx
```

---

## 4.5 离线发布包（无法从本地 SSH/rsync 时）

适用于只拿到腾讯云网页终端（OrcaTerm）或文件上传的情况，不需要本机能 SSH。

```bash
# 1) 本地打包
./server/deploy/package.sh
# 产物：dist/biaoxun-release-<时间>.tar.gz + .sha256

# 2) 把 tar.gz 上传到服务器（网页终端的文件上传 / 任意传输工具），然后：
mkdir -p /root/biaoxun-release
tar -xzf biaoxun-release-*.tar.gz -C /root/biaoxun-release
cd /root/biaoxun-release

# 3) root 执行安装（幂等，可重复跑）
sudo bash install.sh
# 国内 pip 慢：
sudo bash install.sh --pip-index-url https://pypi.tuna.tsinghua.edu.cn/simple

# 4) 本地验收（如果应用直接监听公网端口）
./server/deploy/verify_deploy.sh --base http://<IP>:8000
```

`install.sh` 做的事与 `deploy.sh` 的远程部分一致：系统依赖 → 建 `biaoxun` 用户 → 装代码与前端 →
venv + 依赖（含采集器可选依赖）→ 首次初始化数据库 → 安装并启动 systemd → 健康检查 → Caddy 提示。
选项：`--prefix` / `--port` / `--user` / `--no-deps` / `--no-user` / `--no-systemd` / `--no-collector`。

> 注意：`install.sh` 只监听 `127.0.0.1:8000`，公网访问仍需 Caddy 子路径（见 2.1.1）或反向代理；
> 若直接暴露 8000，需同时在安全组放行并给 systemd 加 `--host 0.0.0.0`（不推荐）。

### 4.6 定时采集（systemd timer）

`deploy.sh` 会自动安装并启用：

| 单元 | 作用 |
|---|---|
| `biaoxun-collect.service` | 以 `biaoxun` 身份执行 `python -m app.cli collect --days 30`（单次同步采集 + 入库） |
| `biaoxun-collect.timer` | 每 2 小时的第 15 分钟触发，`Persistent=true`，随机延迟最多 5 分钟 |

```bash
# 下次触发时间
systemctl list-timers biaoxun-collect.timer --no-pager

# 手动跑一次（阻塞到采集完成）
sudo systemctl start biaoxun-collect.service
journalctl -u biaoxun-collect.service -f

# 改频率：编辑 /etc/systemd/system/biaoxun-collect.timer 的 OnCalendar
sudo systemctl daemon-reload && sudo systemctl restart biaoxun-collect.timer
```

定时任务采集窗口 **30 天**（覆盖历史公告，避免只抓最近几天导致旧公告删除后无法补回）；手动 `app.cli collect` 默认 3 天，可用 `--days N` 指定。运行记录在页面的「定时任务」页 / `GET /api/collect/runs`。

## 5. 更新部署

```bash
cd "/Users/yyym/Desktop/学习文档/标讯助手"
git pull

# 与首次部署同一条命令
./server/deploy/deploy.sh --host 1.2.3.4
```

更新时会发生什么：

| 内容 | 行为 |
| --- | --- |
| `server/` 代码 | rsync 覆盖为本地版本 |
| `demo/` | 覆盖（种子数据源） |
| `web/` | 由 `demo/` 重新发布 |
| `server/.venv` | 保留；`pip install -r` 增量更新依赖 |
| `data/biaoxun.db` | **保留，不覆盖**（rsync 排除） |
| `backup/` | **保留，不删除** |
| systemd / Nginx | 重新安装（Certbot 托管的 Nginx 配置会跳过） |
| 服务 | `systemctl restart biaoxun`，通常 1–3 秒不可用 |

更新前建议先备份数据库（见第 7 节）。如果只改了前端，也会重启服务，属正常现象。

---

## 6. 日志查看

```bash
# 服务实时日志
journalctl -u biaoxun -f

# 最近 200 行
journalctl -u biaoxun -n 200 --no-pager

# 指定时间
journalctl -u biaoxun --since "10 min ago"
journalctl -u biaoxun --since today

# Nginx
sudo nginx -t
tail -f /var/log/nginx/access.log
tail -f /var/log/nginx/error.log
systemctl status nginx --no-pager

# 端口与进程
sudo ss -ltnp | grep -E ':(80|443|8000)\b'
```

应用日志走 journal（`StandardOutput=journal`），没有单独日志文件。

---

## 7. SQLite 备份与恢复

### 7.1 在线备份（推荐自带脚本）

SQLite 开了 WAL，**不要直接 `cp biaoxun.db`**（可能漏掉 `-wal` 中的已提交数据）。仓库自带备份脚本，用 Python 的在线备份 API 做一致性快照，服务器无需安装 sqlite3：

```bash
sudo -u biaoxun mkdir -p /opt/biaoxun/backup
sudo -u biaoxun /opt/biaoxun/server/deploy/backup.sh
ls -lh /opt/biaoxun/backup/
```

脚本默认保留最近 14 天（`find -mtime +14 -delete`），备份完成会打印路径与体积，并做 `PRAGMA integrity_check`。

也可以直接调 CLI 自定义落点：

```bash
cd /opt/biaoxun/server
sudo -u biaoxun env BX_DATA_DIR=/opt/biaoxun/data \
  .venv/bin/python -m app.cli backup --dest /opt/biaoxun/backup/manual.db
```

### 7.2 定时备份（每天 03:00）

直接用仓库自带脚本，加入 biaoxun 用户 crontab 即可（`sudo -u biaoxun crontab -e`）：

```cron
15 3 * * * /opt/biaoxun/server/deploy/backup.sh >> /opt/biaoxun/data/backup.log 2>&1
```

手动执行一次验证：

```bash
sudo -u biaoxun /opt/biaoxun/server/deploy/backup.sh
```

> 备份目录 `/opt/biaoxun/backup/` 已被 `deploy.sh` 的 rsync 排除，更新不会删除。异地容灾请再同步到 COS/另一台机器（`coscli`、`rclone` 等）。

### 7.3 恢复

```bash
# 1) 停服务，避免写入
sudo systemctl stop biaoxun

# 2) 保底：备份当前库
sudo cp -a /opt/biaoxun/data/biaoxun.db /opt/biaoxun/data/biaoxun.db.before-restore

# 3) 删掉旧库（含 WAL/SHM），再复制快照。停服状态下复制是安全的。
sudo rm -f /opt/biaoxun/data/biaoxun.db \
            /opt/biaoxun/data/biaoxun.db-wal \
            /opt/biaoxun/data/biaoxun.db-shm
sudo cp -a /opt/biaoxun/backup/biaoxun-20261025-030000.db /opt/biaoxun/data/biaoxun.db

# 4) 修正属主（SQLite 之后会按需重建 WAL/SHM）
sudo chown biaoxun:biaoxun /opt/biaoxun/data/biaoxun.db

# 5) 启动并验证
sudo systemctl start biaoxun
curl -s http://127.0.0.1:8000/api/health
```

不要对正在运行的服务直接 `cp`，也不要在复制后保留旧的 `-wal`/`-shm`。

### 7.4 备份要包含什么

| 内容 | 路径 | 是否必须 |
| --- | --- | --- |
| SQLite 数据库 | `/opt/biaoxun/data/biaoxun.db` | ✅ |
| systemd drop-in | `/etc/systemd/system/biaoxun.service.d/` | 有自定义环境变量/端口时 |
| Nginx 配置 | `/etc/nginx/conf.d/biaoxun.conf` | 有域名/证书定制时 |
| 证书 | `/etc/letsencrypt/` | 启用 HTTPS 时（certbot 自身也应备份） |

---

## 8. 回滚

### 8.1 代码回滚（推荐：本地切版本再部署）

```bash
cd "/Users/yyym/Desktop/学习文档/标讯助手"
git log --oneline -10
git checkout <上一个稳定 commit 或 tag>

./server/deploy/deploy.sh --host 1.2.3.4

git checkout main   # 回滚完成后切回
```

`data/` 不在同步范围内，回滚代码不会动数据库。若新版本同时改过数据结构/数据，回滚代码后请按 7.3 恢复对应时间点的数据库备份。

### 8.2 服务器本地快照回滚（无法访问本地仓库时）

更新前在服务器留一份代码快照：

```bash
sudo cp -a /opt/biaoxun/server /opt/biaoxun/server.bak-$(date +%F)
```

回滚：

```bash
sudo systemctl stop biaoxun
sudo rsync -a --delete /opt/biaoxun/server.bak-2026-10-25/ /opt/biaoxun/server/
sudo chown -R biaoxun:biaoxun /opt/biaoxun/server
sudo systemctl start biaoxun
```

### 8.3 配置回滚

- systemd：每次部署会把旧单元备份为 `/etc/systemd/system/biaoxun.service.bak`。
  ```bash
  sudo cp -a /etc/systemd/system/biaoxun.service.bak /etc/systemd/system/biaoxun.service
  sudo systemctl daemon-reload && sudo systemctl restart biaoxun
  ```
- Nginx：旧配置备份为 `/etc/nginx/conf.d/biaoxun.conf.bak`。
  ```bash
  sudo cp -a /etc/nginx/conf.d/biaoxun.conf.bak /etc/nginx/conf.d/biaoxun.conf
  sudo nginx -t && sudo systemctl reload nginx
  ```
- 数据：按 7.3 恢复备份。

---

## 9. 环境变量

应用配置见 `server/app/config.py`，全部可用环境变量覆盖：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `BX_DATA_DIR` | `server/data` | 数据目录；unit 中为 `/opt/biaoxun/data` |
| `BX_STATIC_DIR` | 仓库 `demo/` | 前端目录；unit 中为 `/opt/biaoxun/web` |
| `BX_DB_PATH` | `$BX_DATA_DIR/biaoxun.db` | 可单独指定数据库文件 |
| `BX_DEFAULT_PASSWORD` | `123456` | 首次种子用户密码；**上线前必须改** |
| `BX_SESSION_DAYS` | `7` | 登录会话有效期（天） |
| `BX_CORS_ORIGINS` | 本地 8000/8765/5173 | 允许跨域来源，逗号分隔；同源部署无需配置 |

用 systemd drop-in 覆盖（不要直接改 unit，部署会被覆盖）：

```bash
sudo systemctl edit biaoxun
```

写入：

```ini
[Service]
Environment=BX_DEFAULT_PASSWORD=请换成强密码
Environment=BX_SESSION_DAYS=7
Environment=BX_CORS_ORIGINS=https://biaoxun.example.com
```

```bash
sudo systemctl daemon-reload
sudo systemctl restart biaoxun
```

注意：

- **种子只在用户表为空时写入**。首次启动后改 `BX_DEFAULT_PASSWORD` 不会改已有账号密码；全新空库可按 4.3 的步骤设置后重建数据库，已有业务数据则需单独改库，生产请先规划好初始密码。
- `BX_CORS_ORIGINS` 用英文逗号分隔，不要带结尾斜杠。前端与 API 同源（都走 Nginx）时不需要配。
- 不要在任何脚本/仓库里写死密码，统一走 drop-in 或密钥管理。

---

## 10. 常见故障

### 10.1 502 Bad Gateway

| 检查 | 命令/判断 |
| --- | --- |
| 后端是否活着 | `systemctl status biaoxun`；`curl http://127.0.0.1:8000/api/health` |
| 端口是否一致 | `ss -ltnp \| grep 8000`；Nginx 配置里 proxy_pass 端口 |
| SELinux 拦截 | `sudo tail -50 /var/log/nginx/error.log` 出现 `Permission denied` |
| 应用启动报错 | `journalctl -u biaoxun -n 100 --no-pager` |

处理：

```bash
sudo systemctl restart biaoxun
sudo setsebool -P httpd_can_network_connect 1   # CentOS SELinux
sudo nginx -t && sudo systemctl reload nginx
```

### 10.2 500 Internal Server Error

```bash
journalctl -u biaoxun -n 200 --no-pager
```

常见原因：

- `unable to open database file`：`/opt/biaoxun/data` 权限不对。
  ```bash
  sudo chown -R biaoxun:biaoxun /opt/biaoxun/data
  sudo chmod 750 /opt/biaoxun/data
  ```
- `ModuleNotFoundError`：依赖没装进 venv。
  ```bash
  sudo -u biaoxun /opt/biaoxun/server/.venv/bin/pip install -r /opt/biaoxun/server/requirements.txt
  ```
- 缺少 `demo/data/announcements.json`：种子文件没同步，检查 `/opt/biaoxun/demo/data/`。
- SQLite `database is locked`：长事务/多进程写冲突，见 10.10。

### 10.3 静态页面 404 / 打开是 Nginx 欢迎页

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `/` 404，`/api/health` 正常 | `web/` 没有 `index.html` 或 `BX_STATIC_DIR` 不对 | `ls /opt/biaoxun/web/index.html`；`systemctl cat biaoxun` 看环境变量 |
| 打开是 Welcome to nginx | 默认站点没禁用 | `ls /etc/nginx/sites-enabled/`；删除 `default`；或重跑 `deploy.sh` |
| `/api/` 404 但静态正常 | Nginx location 被改动 | `sudo nginx -T \| grep -A5 'location /api/'` |
| 静态 403 | 权限 | `sudo chown -R biaoxun:biaoxun /opt/biaoxun/web` |

```bash
curl -I http://127.0.0.1:8000/          # 绕过 Nginx，直连后端
curl -I http://127.0.0.1/               # 经 Nginx
```

### 10.4 端口占用

```bash
sudo ss -ltnp | grep -E ':(80|8000)\b'
sudo lsof -i :8000
```

- 8000 被占：换端口并重新部署，脚本会同步改 systemd 与 Nginx：
  ```bash
  ./server/deploy/deploy.sh --host 1.2.3.4 --app-port 8080
  ```
  若 Nginx 被 Certbot 托管而跳过覆盖，需要手动把 `proxy_pass` 端口改为 8080。
- 80 被占：停掉冲突服务（如 Apache/httpd），或改用其他端口。
- systemd 反复重启：`journalctl -u biaoxun -n 100` 看真实报错。

### 10.5 权限问题

```bash
namei -l /opt/biaoxun/data/biaoxun.db
sudo -u biaoxun test -w /opt/biaoxun/data && echo data-writable
sudo -u biaoxun test -x /opt/biaoxun/server/.venv/bin/uvicorn && echo venv-ok
```

修复：

```bash
sudo chown -R biaoxun:biaoxun /opt/biaoxun/server /opt/biaoxun/web /opt/biaoxun/data
sudo chmod 750 /opt/biaoxun/data
sudo chmod 755 /opt/biaoxun/web
```

### 10.6 SELinux（CentOS/RHEL）

```bash
getenforce
sudo ausearch -m avc -ts recent | tail -20
sudo setsebool -P httpd_can_network_connect 1
sudo restorecon -Rv /opt/biaoxun
sudo systemctl restart nginx
```

`getenforce` 返回 `Enforcing` 且 Nginx error log 有 `(13: Permission denied)`，基本就是 SELinux 拦截 Nginx 连后端。

### 10.7 CORS 报错

浏览器控制台出现 `No 'Access-Control-Allow-Origin' header`：

- 正常部署（前端和 API 同源）**不应出现** CORS；先确认访问的是同一个域名/端口。
- 前后端分离时配置：
  ```bash
  sudo systemctl edit biaoxun
  # [Service]
  # Environment=BX_CORS_ORIGINS=https://front.example.com
  sudo systemctl daemon-reload && sudo systemctl restart biaoxun
  ```
- 因为后端 `allow_credentials=True`，不要用 `*`，要写明确来源；协议/域名/端口必须完全一致。
- 修改后强刷浏览器，确认请求没有旧缓存。

### 10.8 Nginx 配置校验失败

```bash
sudo nginx -t
```

`deploy.sh` 在 `nginx -t` 失败时会自动恢复 `.bak`。常见：

- 80 端口被 Apache/其他 Nginx 实例占用；
- 多个 `server_name`/`default_server` 冲突；
- 证书路径不存在；
- 模板中域名没改却启用了 HTTPS。

### 10.9 腾讯云安全组 / 备案拦截

- 本地 `curl` 超时：先确认安全组 80/443 已放行、服务器 firewalld 已放行。
- 域名访问被重定向到备案提示：完成 ICP 备案。
- 80 能通、443 不通：安全组没放行 443 或证书没配好。

### 10.10 SQLite `database is locked`

- 本项目使用 WAL + 15 秒 busy timeout，2 worker 下读多写少足够。
- 不要在 NFS/对象存储挂载点上放数据库。
- 避免长时间事务；备份用 `.backup`，不要 `cp` 正在写入的库。
- 检查是否有多个进程同时写同一个库：`sudo lsof /opt/biaoxun/data/biaoxun.db`。
- 临时缓解：把 systemd `ExecStart` 的 `--workers 2` 改成 `--workers 1`（用 drop-in 覆盖，见第 9 节），降低并发写。

### 10.11 Python 版本过低

```bash
python3 --version
```

CentOS 7 自带 3.6，`uvicorn 0.34` 无法运行。升级系统，或安装 Python 3.9+ 后把 unit 的 `ExecStart` 改为对应解释器创建的 venv。

### 10.12 部署后前端仍旧

Nginx 给静态资源加了 1 小时缓存。强刷（Cmd/Ctrl+Shift+R）或调小 `nginx-biaoxun.conf` 中的 `expires`。更新部署本身会替换 `web/` 文件。

---

## 11. 验收清单

- [ ] `bash -n server/deploy/deploy.sh`、`bash -n server/run.sh` 通过。
- [ ] `systemctl status biaoxun` 为 `active (running)`，且 `systemctl is-enabled biaoxun` 为 `enabled`。
- [ ] `curl http://127.0.0.1:8000/api/health` 返回 `{"ok":true,...}`。
- [ ] `curl -I http://127.0.0.1/` 经 Nginx 返回 200。
- [ ] 浏览器打开公网 IP/域名，能加载登录页并登录。
- [ ] 安全组只放行 22/80/443（测试端口用完即关）。
- [ ] 已配置数据库每日备份，并做过一次恢复演练。
- [ ] 已改掉默认密码 `123456`（空库时按 4.3 的步骤设置 `BX_DEFAULT_PASSWORD` 重建种子）。
- [ ] 可选：域名备案完成 + certbot 证书 + 80→443 跳转。
- [ ] 服务器重启后服务自动拉起（`sudo reboot` 后复查）。
