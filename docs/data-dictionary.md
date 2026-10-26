# 标讯助手 · 数据字典

> 本文件由线上 SQLite 库结构自动生成，字段说明维护在 `scripts/gen_data_dictionary.py`。

## 1. 概览

| 项 | 值 |
| --- | --- |
| 后端 | FastAPI（Python 3.12） |
| 数据库 | SQLite 3.45.1，WAL 模式 |
| 线上路径 | `/opt/biaoxun/data/biaoxun.db` |
| 表数量 | 11 张 |
| 当前总行数 | 134 行 |
| 时间格式 | 日期 `YYYY-MM-DD`，时间 `YYYY-MM-DD HH:MM:SS`（本地时区） |
| JSON 字段 | 以 TEXT 存储 JSON 字符串：`contacts_json`、`matched_keywords`、`business_tags`、`keyword_list` |

## 2. 表清单

| 表名 | 中文名 | 字段数 | 当前行数 | 用途 |
| --- | --- | ---: | ---: | --- |
| `announcements` | 招标公告 | 34 | 16 | 核心业务表：公告正文摘要、商机字段、当前处理人与进度；采集器按 id 增量入库。 |
| `assignment_records` | 任务分配记录 | 8 | 0 | 公告每次分配给小组/接收人的历史流水。 |
| `audit_log` | 操作审计 | 6 | 15 | 登录、确认商机、分配、团队/来源/配置变更等写操作留痕。 |
| `crawl_runs` | 采集运行记录 | 9 | 12 | 每次采集（页面按钮 / API / systemd 定时任务）的运行结果与统计。 |
| `group_members` | 小组成员 | 7 | 0 | 小组下的业务员名单，编辑小组时整体替换；同一小组内姓名唯一。 |
| `groups` | 小组（团队） | 8 | 5 | 业务小组及管理员；顺序即团队页展示优先级，集团客户部固定为 id=1、不可删除。 |
| `progress_records` | 进度记录 | 8 | 16 | 公告每一次进度变更的流水（分配、确认、手工更新），按 id 升序展示。 |
| `schedule_config` | 定时任务配置 | 7 | 1 | 单行配置表（id 恒为 1）：关键词、采集间隔、提醒间隔、运行状态、采集窗口。 |
| `sessions` | 登录会话 | 4 | 14 | Bearer Token 会话；登录时清理过期记录，改密会删除该账号全部会话。 |
| `sources` | 数据来源 | 14 | 50 | 采集站点注册表 + 最近一次探活结果；采集器读取同一份注册信息。 |
| `users` | 登录账号 | 9 | 5 | 由小组管理员派生的登录账号；口令用 PBKDF2-HMAC-SHA256 加盐存储。 |

## 3. 表关系

| 主表 | 关系 | 从表 | 说明 |
| --- | --- | --- | --- |
| `groups` | 1 : N | `group_members` | group_members.group_id → groups.id（删除小组级联删除成员） |
| `groups` | 1 : N | `users` | users.group_id → groups.id（删除小组时账号一并删除） |
| `users` | 1 : N | `sessions` | sessions.user_id → users.id（级联删除） |
| `announcements` | 1 : N | `progress_records` | progress_records.ann_id → announcements.id（级联删除） |
| `announcements` | 1 : N | `assignment_records` | assignment_records.ann_id → announcements.id（级联删除） |
| `groups` | 逻辑关联 | `announcements` | announcements.handler_group 存小组名称（无外键，便于历史留痕） |

```text
groups ──1:N──> group_members
groups ──1:N──> users ──1:N──> sessions
announcements ──1:N──> progress_records
announcements ──1:N──> assignment_records
announcements.handler_group ──逻辑──> groups.name
（sources / schedule_config / crawl_runs / audit_log 为独立表）
```

## 4. 表结构明细

### 招标公告 · `announcements`

核心业务表：公告正文摘要、商机字段、当前处理人与进度；采集器按 id 增量入库。

| 项 | 值 |
| --- | --- |
| 主键 | `id` |
| 外键 | — |
| 索引 | 索引(handler_group)；索引(project_code)；索引(progress)；索引(district)；索引(pub_date)；唯一索引(id)（自动） |
| 当前行数 | 16 |

| 字段 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | 文本 | PK | — | 公告编号（主键），采集器生成，如 ANN202610234478 |
| `title` | 文本 | 是 | — | 公告完整标题 |
| `project_name` | 文本 | 是 | '' | 项目名称（列表主展示字段） |
| `project_code` | 文本 | 是 | '' | 项目/采购编号，采集去重优先键 |
| `buyer` | 文本 | 是 | '' | 采购人名称 |
| `agency` | 文本 | 是 | '' | 采购代理机构 |
| `budget` | 文本 | 是 | '' | 预算金额（保留原始字符串，含千分位/元） |
| `fund_source` | 文本 | 是 | '' | 资金来源 |
| `district` | 文本 | 是 | '' | 所属区县：潮安 / 市区 / 湘桥 / 饶平 等 |
| `ann_type` | 文本 | 是 | '' | 公告类型，如 采购公告 / 采购意向公告 / 招标公告 |
| `pub_date` | 文本 | 是 | '' | 发布日期（YYYY-MM-DD） |
| `deadline` | 文本 | 是 | '' | 报名截止日期 |
| `bid_open_date` | 文本 | 是 | '' | 开标日期；标讯状态由它派生 |
| `summary` | 文本 | 是 | '' | 项目概况全文（采集正文，可能较长） |
| `contact` | 文本 | 是 | '' | 联系方式原始串（三方联系人拼接） |
| `contacts_json` | 文本 | 是 | '{}' | 结构化联系方式 JSON：{purchaser, agency, project} |
| `source_url` | 文本 | 是 | '' | 原始公告链接 |
| `region` | 文本 | 是 | '' | 所属地市（当前为潮州） |
| `purchase_method` | 文本 | 是 | '' | 采购方式，如 公开招标 / 竞争性磋商 |
| `matched_keywords` | 文本 | 是 | '[]' | 命中的采集关键词，JSON 数组 |
| `business_tags` | 文本 | 是 | '[]' | 业务标签，JSON 数组（平台/专线/机房 等） |
| `is_valid_opportunity` | 文本 | 是 | '' | 商机字段：是否有效商机（是/否，空=未填） |
| `has_operator_involvement` | 文本 | 是 | '' | 商机字段：是否有运营商参与（是/否） |
| `opportunity_code` | 文本 | 是 | '' | 商机字段：商机编码（自由填写） |
| `opportunity_status` | 文本 | 是 | '' | 商机字段：商机了解情况（自由填写） |
| `will_bid` | 文本 | 是 | '' | 商机字段：是否应标（准备应标/已经应标/弃标） |
| `tree_placement` | 文本 | 是 | '' | 商机字段：挂树选择 |
| `current_handler` | 文本 | 是 | '' | 当前处理人姓名（默认区域小组管理员，可指定成员） |
| `handler_group` | 文本 | 是 | '' | 当前处理小组名称（逻辑关联 groups.name，无外键） |
| `progress` | 文本 | 是 | '待分配' | 业务进度：待分配 / 已分配 / 已确认 |
| `next_follow_up` | 文本 | 是 | '' | 下次跟进日期（分配时默认 = 今天 + 3 天） |
| `created_at` | 文本 | 是 | datetime('now', 'localtime') | 创建时间（本地时间，YYYY-MM-DD HH:MM:SS） |
| `confirmed_at` | 文本 | 是 | '' | 商机信息确认时间；未确认为空 |
| `updated_at` | 文本 | 是 | datetime('now', 'localtime') | 最后更新时间 |

### 任务分配记录 · `assignment_records`

公告每次分配给小组/接收人的历史流水。

| 项 | 值 |
| --- | --- |
| 主键 | `id` |
| 外键 | `ann_id` → `announcements.id` |
| 索引 | 索引(ann_id) |
| 当前行数 | 0 |

| 字段 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | 整数 | PK | — | 主键；公告表为业务编号（ANN+日期+序号） |
| `ann_id` | 文本 | 是 | — | 所属公告编号，关联 announcements.id |
| `assigner` | 文本 | 是 | '' | 分配人 |
| `assigner_group` | 文本 | 是 | '' | 分配人所属小组 |
| `assignee` | 文本 | 是 | '' | 接收人 |
| `assignee_group` | 文本 | 是 | '' | 接收小组 |
| `note` | 文本 | 是 | '' | 备注 / 跟进说明 |
| `assigned_at` | 文本 | 是 | datetime('now', 'localtime') | 分配时间 |

### 操作审计 · `audit_log`

登录、确认商机、分配、团队/来源/配置变更等写操作留痕。

| 项 | 值 |
| --- | --- |
| 主键 | `id` |
| 外键 | — |
| 索引 | 索引(created_at) |
| 当前行数 | 15 |

| 字段 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | 整数 | PK | — | 主键；公告表为业务编号（ANN+日期+序号） |
| `user_name` | 文本 | 是 | '' | 操作人姓名（cli 表示命令行） |
| `action` | 文本 | 是 | — | 动作，如 登录/确认商机/分配任务/更新小组 |
| `target` | 文本 | 是 | '' | 操作对象（公告编号/小组名/账号等） |
| `detail` | 文本 | 是 | '' | 动作详情 |
| `created_at` | 文本 | 是 | datetime('now', 'localtime') | 创建时间（本地时间，YYYY-MM-DD HH:MM:SS） |

### 采集运行记录 · `crawl_runs`

每次采集（页面按钮 / API / systemd 定时任务）的运行结果与统计。

| 项 | 值 |
| --- | --- |
| 主键 | `id` |
| 外键 | — |
| 索引 | — |
| 当前行数 | 12 |

| 字段 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | 整数 | PK | — | 主键；公告表为业务编号（ANN+日期+序号） |
| `started_at` | 文本 | 是 | datetime('now', 'localtime') | 开始时间 |
| `finished_at` | 文本 | 是 | '' | 结束时间 |
| `status` | 文本 | 是 | 'running' | 运行状态：running / ok / error |
| `sites_ok` | 整数 | 是 | 0 | 本次成功站点数 |
| `sites_total` | 整数 | 是 | 0 | 启用站点总数 |
| `new_count` | 整数 | 是 | 0 | 本次新增公告数 |
| `message` | 文本 | 是 | '' | 说明 / 错误信息（截断至 500 字） |
| `operator` | 文本 | 是 | '' | 触发者（cli / 页面操作人） |

### 小组成员 · `group_members`

小组下的业务员名单，编辑小组时整体替换；同一小组内姓名唯一。

| 项 | 值 |
| --- | --- |
| 主键 | `id` |
| 外键 | `group_id` → `groups.id` |
| 索引 | 唯一索引(group_id, name)；索引(group_id) |
| 当前行数 | 0 |

| 字段 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | 整数 | PK | — | 主键；公告表为业务编号（ANN+日期+序号） |
| `group_id` | 整数 | 是 | — | 所属小组，关联 groups.id |
| `name` | 文本 | 是 | — | 成员姓名 |
| `name_pinyin` | 文本 | 是 | '' | 成员登录/拼音账号，仅作展示与账号参考 |
| `contact` | 文本 | 是 | '' | 联系方式 |
| `position` | 文本 | 是 | '成员' | 岗位名称 |
| `created_at` | 文本 | 是 | datetime('now', 'localtime') | 创建时间（本地时间，YYYY-MM-DD HH:MM:SS） |

### 小组（团队） · `groups`

业务小组及管理员；顺序即团队页展示优先级，集团客户部固定为 id=1、不可删除。

| 项 | 值 |
| --- | --- |
| 主键 | `id` |
| 外键 | — |
| 索引 | 唯一索引(name)（自动） |
| 当前行数 | 5 |

| 字段 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | 整数 | PK | — | 主键；公告表为业务编号（ANN+日期+序号） |
| `name` | 文本 | 是 | — | 小组名称（唯一），如 集团客户部 / 战客中心 / 市区 / 潮安 / 饶平 |
| `region` | 文本 | 是 | — | 所属区域，用于按区域分配公告 |
| `admin` | 文本 | 是 | '' | 小组管理员姓名 |
| `admin_contact` | 文本 | 是 | '' | 管理员联系方式 |
| `admin_account` | 文本 | 是 | '' | 管理员登录账号（与 users.account 对应） |
| `position` | 文本 | 是 | '负责人' | 岗位名称 |
| `created_at` | 文本 | 是 | datetime('now', 'localtime') | 小组创建日期 |

### 进度记录 · `progress_records`

公告每一次进度变更的流水（分配、确认、手工更新），按 id 升序展示。

| 项 | 值 |
| --- | --- |
| 主键 | `id` |
| 外键 | `ann_id` → `announcements.id` |
| 索引 | 索引(ann_id) |
| 当前行数 | 16 |

| 字段 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | 整数 | PK | — | 主键；公告表为业务编号（ANN+日期+序号） |
| `ann_id` | 文本 | 是 | — | 所属公告编号，关联 announcements.id |
| `progress` | 文本 | 是 | — | 本次进度值（待分配/已分配/已确认） |
| `follower` | 文本 | 是 | '' | 操作人（进度记录里的跟进人） |
| `follow_date` | 文本 | 是 | '' | 跟进日期（YYYY-MM-DD） |
| `note` | 文本 | 是 | '' | 备注 / 跟进说明 |
| `attachment` | 文本 | 是 | '' | 附件（预留字段，当前不使用） |
| `created_at` | 文本 | 是 | datetime('now', 'localtime') | 创建时间（本地时间，YYYY-MM-DD HH:MM:SS） |

### 定时任务配置 · `schedule_config`

单行配置表（id 恒为 1）：关键词、采集间隔、提醒间隔、运行状态、采集窗口。

| 项 | 值 |
| --- | --- |
| 主键 | `id` |
| 外键 | — |
| 索引 | — |
| 当前行数 | 1 |

| 字段 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | 整数 | PK | — | 固定为 1（单行配置） |
| `keyword_list` | 文本 | 是 | '' | 采集关键词，JSON 数组（页面可增删） |
| `crawl_interval` | 文本 | 是 | '每2小时' | 采集间隔展示值，如 每2小时 |
| `reminder_interval` | 文本 | 是 | '每天 09:00, 15:00' | 提醒运行间隔展示值，如 每天 09:00, 15:00 |
| `crawl_status` | 文本 | 是 | '运行中' | 运行状态：运行中 / 已暂停（仅展示） |
| `crawl_days` | 整数 | 是 | 3 | 每次采集回溯天数，默认 3 |
| `updated_at` | 文本 | 是 | datetime('now', 'localtime') | 最后更新时间 |

### 登录会话 · `sessions`

Bearer Token 会话；登录时清理过期记录，改密会删除该账号全部会话。

| 项 | 值 |
| --- | --- |
| 主键 | `token` |
| 外键 | `user_id` → `users.id` |
| 索引 | 索引(user_id)；唯一索引(token)（自动） |
| 当前行数 | 14 |

| 字段 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `token` | 文本 | PK | — | 会话 Token（随机 URL-safe 字符串，主键） |
| `user_id` | 整数 | 是 | — | 所属账号，关联 users.id |
| `created_at` | 文本 | 是 | datetime('now', 'localtime') | 创建时间（本地时间，YYYY-MM-DD HH:MM:SS） |
| `expires_at` | 文本 | 是 | — | 过期时间（默认登录后 7 天） |

### 数据来源 · `sources`

采集站点注册表 + 最近一次探活结果；采集器读取同一份注册信息。

| 项 | 值 |
| --- | --- |
| 主键 | `id` |
| 外键 | — |
| 索引 | 唯一索引(url) |
| 当前行数 | 50 |

| 字段 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | 整数 | PK | — | 主键；公告表为业务编号（ANN+日期+序号） |
| `name` | 文本 | 是 | — | 网站名称 |
| `url` | 文本 | 是 | — | 站点地址（唯一） |
| `domain` | 文本 | 是 | '' | 站点域名 |
| `source_code` | 文本 | 是 | 'generic' | 采集适配器：czggzy / gdgpo / ccgp / generic |
| `enabled` | 整数 | 是 | 1 | 是否启用：1 启用 / 0 停用 |
| `last_status` | 文本 | 是 | '' | 最近探活结果：ok / fail / 空（未检测） |
| `last_http_code` | 整数 | 否 | — | 最近探活 HTTP 状态码 |
| `last_latency_ms` | 整数 | 否 | — | 最近探活耗时（毫秒） |
| `last_checked_at` | 文本 | 是 | '' | 最近探活时间 |
| `last_message` | 文本 | 是 | '' | 探活说明，如「正常 864ms」「连接失败: ...」 |
| `last_found_links` | 整数 | 是 | 0 | 最近探活发现链接数 |
| `last_matched_links` | 整数 | 是 | 0 | 最近探活命中关键词链接数 |
| `created_at` | 文本 | 是 | datetime('now', 'localtime') | 创建时间（本地时间，YYYY-MM-DD HH:MM:SS） |

### 登录账号 · `users`

由小组管理员派生的登录账号；口令用 PBKDF2-HMAC-SHA256 加盐存储。

| 项 | 值 |
| --- | --- |
| 主键 | `id` |
| 外键 | `group_id` → `groups.id` |
| 索引 | 索引(group_id)；唯一索引(account)（自动） |
| 当前行数 | 5 |

| 字段 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | 整数 | PK | — | 主键；公告表为业务编号（ANN+日期+序号） |
| `account` | 文本 | 是 | — | 登录账号（唯一） |
| `name` | 文本 | 是 | — | 姓名（用于公告处理人、提醒可见性匹配） |
| `phone` | 文本 | 是 | '' | 手机号 / 联系电话 |
| `password_hash` | 文本 | 是 | — | 口令哈希（PBKDF2-HMAC-SHA256，12 万轮） |
| `salt` | 文本 | 是 | — | 口令随机盐（十六进制） |
| `group_id` | 整数 | 否 | — | 所属小组，关联 groups.id |
| `role` | 文本 | 是 | 'admin' | 角色，当前均为 admin |
| `created_at` | 文本 | 是 | datetime('now', 'localtime') | 创建时间（本地时间，YYYY-MM-DD HH:MM:SS） |

## 5. 枚举与取值约定

| 字段 | 取值 |
| --- | --- |
| announcements.progress / progress_records.progress | 待分配 → 已分配 → 已确认 |
| announcements.ann_type | 采购公告 / 采购意向公告 / 招标公告 / 建设工程招标公告 / 采购需求 等（采集器白名单） |
| announcements.will_bid | 准备应标 / 已经应标 / 弃标（可空） |
| announcements.is_valid_opportunity / has_operator_involvement | 是 / 否（可空） |
| sources.last_status | ok / fail / 空（未检测） |
| sources.source_code | czggzy（潮州公共资源）/ gdgpo（广东省政府采购）/ ccgp（中国政府采购）/ generic（通用适配器） |
| crawl_runs.status | running / ok / error |
| users.role | admin（当前所有账号均为管理员） |
| schedule_config.crawl_status | 运行中 / 已暂停 |

## 6. 运维说明

- **备份**：`server/deploy/backup.sh`（SQLite 在线备份 API，保留 14 天），线上每日 03:15 自动执行。
- **迁移**：建表脚本 `server/app/schema.sql` 使用 `CREATE TABLE IF NOT EXISTS`；新增字段需手动 `ALTER TABLE` 或重建库。
- **字符集**：SQLite UTF-8；中文全文检索用 `LIKE`（当前数据量足够）。
- **删除策略**：小组→成员/账号、公告→记录 均 `ON DELETE CASCADE`；删除小组会同时删除其管理员账号。
