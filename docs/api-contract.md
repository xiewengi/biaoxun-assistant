# 标讯助手后端 API 契约（v1）

> 本文件是前后端唯一约定。改接口先改这里。
> 服务：FastAPI + SQLite，入口 `server/app/main.py`，所有接口前缀 `/api`。
> 鉴权：登录后拿到 `token`，请求头带 `Authorization: Bearer <token>`。
> 错误：`HTTPException(status_code, detail="中文错误信息")`，前端直接展示 `detail`。

## 0. 通用约定

- 时间字符串：日期 `YYYY-MM-DD`，时间 `YYYY-MM-DD HH:MM:SS`。
- 公告对象（Ann）字段全部驼峰，与 `demo/js/data.js` 的公告结构一一对应：
  `id,title,projectName,projectCode,buyer,agency,budget,fundSource,district,annType,pubDate,deadline,bidOpenDate,summary,contact,contacts,sourceUrl,region,purchaseMethod,matchedKeywords,businessTags,isValidOpportunity,hasOperatorInvolvement,opportunityCode,opportunityStatus,willBid,treePlacement,currentHandler,handlerGroup,progress,createdAt,nextFollowUp,bidStatus`
  详情额外含 `progressRecords[]`、`assignmentRecords[]`、`confirmedAt`。
- 进度枚举：`待分配` / `已分配` / `已确认`（`app/serializers.py` 与前端 PROGRESS_OPTIONS 一致）。
- 分配权限：仅 `user.group == '集团客户部'`，统一用 `security.require_group_admin(user)`。
- 所有写操作后调用 `security.audit(user, 动作, 目标, 详情)`。
- 序列化统一走 `app/serializers.py`，不要各写一套。

## 1. 认证（已实现，`app/routers/auth.py`）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/login` | body `{account,password}` → `{token, user}`；失败 401 |
| POST | `/api/auth/logout` | 删除当前会话 → `{ok:true}` |
| GET | `/api/auth/me` | 当前用户 `{id,account,name,phone,group,groupId,role}` |

种子账号：`sheshujuan`(集团客户部) / `lixiaoyi` / `huangxinchong` / `linxiaoyu2` / `linxuxun`，密码均 `123456`。

## 2. 公告 `app/routers/announcements.py`

### GET `/api/announcements`
Query：`keyword, region, district, progress, bid_status, business_tag, page=1, page_size=10(0=全部)`
- `keyword` 模糊匹配 `title/project_name/buyer/matched_keywords`。
- `bid_status` 用 `serializers.compute_bid_status` 在内存过滤（分页前）。
- 按 `pub_date DESC, id DESC`。
响应：
```json
{"items":[Ann],"total":16,"page":1,"pageSize":10,
 "stats":{"todayCount":0,"unassignedCount":1,"inProgressCount":0,"confirmedCount":0}}
```
列表项不带 `progressRecords/assignmentRecords`。

### GET `/api/announcements/{ann_id}`
→ Ann（含 `progressRecords`、`assignmentRecords`，按 id 升序）。不存在 404「公告不存在」。

### PATCH `/api/announcements/{ann_id}`
body 可选：`isValidOpportunity,hasOperatorInvolvement,opportunityCode,opportunityStatus,willBid,treePlacement,currentHandler,nextFollowUp`
更新 `updated_at` → Ann（含记录）。空 body 400。

### POST `/api/announcements/{ann_id}/confirm`
校验 4 个必填：`isValidOpportunity, hasOperatorInvolvement, opportunityCode, willBid`。
缺失 → 400 `detail="请先完善以下必填项：\n  - xxx\n  - yyy"`。
成功：`progress='已确认'`、`confirmed_at=now`，插入进度记录
`{progress:'已确认', follower:user.name, follow_date:今天, note:'商机信息已完整确认'}` → Ann。

### POST `/api/announcements/{ann_id}/progress`
body `{progress, note?}`；progress 必须属于进度枚举（否则 400「无效的进度状态」）。
追加进度记录（follower=user.name，follow_date=今天，note 默认空），更新 `progress`；`已确认` 时写 `confirmed_at` → Ann。

### POST `/api/announcements/{ann_id}/assign`
body `{group, receiver?}`；权限：集团客户部。`receiver` 指定接收人（小组成员），为空则落小组管理员。
- 小组不存在 404；公告不存在 404；已确认公告 400「已确认公告不可再分配」。
- 设置 `current_handler=group.admin`、`handler_group=group.name`、`progress='已分配'`、`next_follow_up=今天+3天`。
- 写分配记录 `{assigner, assigner_group, assignee, assignee_group}` + 进度记录 `{progress:'已分配', note:'分配给{group} · {admin}'}`。
→ Ann。

### POST `/api/announcements/batch-assign`
body `{ids:[...], group, receiver?}` → `{updated:int, skipped:[{id,reason}], items:[Ann]}`。
已确认的跳过（reason「已确认」），不存在跳过（reason「不存在」）。**必须复用 `services/assignments.batch_assign`。**

### GET `/api/announcements/{ann_id}/records`
→ `{progressRecords:[], assignmentRecords:[]}`

## 3. 任务提醒 `app/routers/reminders.py`

### GET `/api/reminders?district=&scope=me|all`
由公告实时计算（不落库）：
- 跳过 `progress=='已确认'`。
- `progress=='待分配'` → `{id:"admin-"+ann_id, type:"admin-assign", label:"管理员分派", level:"urgent",
  title:"项目「{projectName或title前30}...」已入库 {N} 天未分配", targetId, time:createdAt, district,
  annTitle, annProgress, annCurrentHandler}`
- `progress=='已分配'` → `{id:"sales-"+ann_id, type:"sales-follow", label:"业务员跟进",
  level: next_follow_up<=今天?"urgent" : <=今天+3?"warn" : "info",
  title:"项目「{projectName或title前30}...」需跟进", targetId, time:next_follow_up, ...}`
- `scope` 默认 `me` → 返回 `current_handler == user.name` 或 `handler_group == user.group` 的（指派给本组成员时小组管理员也能看到）；`all` 仅集团客户部可用，返回全部。
- 按 `level`(urgent>warn>info) 再按 `time` 升序。
响应 `{items:[], total, counts:{urgent,warn,info}}`。

### POST `/api/reminders/batch-assign`
body `{ids:[公告id], group}`（前端传 targetId）→ 同 `/api/announcements/batch-assign` 的响应。

## 4. 团队 `app/routers/teams.py`

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/groups` | `{items:[Group]}`，按 id 升序（顺序＝展示优先级） |
| POST | `/api/groups` | 新建，body 见下 |
| PUT | `/api/groups/{id}` | 编辑，body 同上（`password` 可选＝重置管理员密码） |
| DELETE | `/api/groups/{id}` | 删除；集团客户部禁止删除（400） |

body：
```json
{"name":"潮安","region":"潮安","admin":"林潇宇","adminContact":"135...","adminAccount":"linxiaoyu2",
 "position":"负责人","password":"123456",
 "members":[{"name":"张三","namePinyin":"zhangsan","contact":"138...","position":"成员"}]}
```
- `name`、`adminAccount` 唯一（冲突 409，中文提示）。
- 创建/编辑同步 `groups` + `group_members` + `users`（管理员账号，密码默认 `security` 种子密码 `123456`）。
- Group 结构：`{id,name,region,admin,adminContact,adminAccount,position,createdAt,members:[名字],memberPinyin:[],memberContacts:[],memberDetails:[{id,name,namePinyin,contact,position}]}`。

## 5. 数据来源 `app/routers/sources.py`

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/sources` | `{items:[Source], stats:{total,enabled,implemented,generic,lastCheckedAt}}`，implemented=`czggzy/ccgp/gdgpo` 且 enabled |
| POST | `/api/sources` | `{name,url,domain?,sourceCode?,enabled?}`，url 重复 409 |
| PATCH | `/api/sources/{id}` | `{enabled?,name?,url?,domain?,sourceCode?}` → Source |
| DELETE | `/api/sources/{id}` | `{ok:true}` |
| POST | `/api/sources/{id}/refresh` | 单站探活（httpx，timeout 8s，follow_redirects），写回 `last_status/http_code/latency_ms/checked_at/message`（如「正常 864ms」/「连接失败: xxx」）→ Source |
| POST | `/api/collect` | 触发采集：`{runId,status}`。采集脚本不存在 501「服务器未安装采集脚本」。后台线程执行，结束后把 announcements.json 增量入库并回写 `crawl_runs` |
| GET | `/api/collect/runs?limit=10` | `{items:[{id,startedAt,finishedAt,status,sitesOk,sitesTotal,newCount,message}]}` |

Source 字段：`{id,name,url,domain,sourceCode,enabled,lastStatus,lastHttpCode,lastLatencyMs,lastCheckedAt,lastMessage,lastFoundLinks,lastMatchedLinks}`。

## 6. 定时任务 `app/routers/schedule.py`

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/schedule` | Schedule |
| PUT | `/api/schedule` | 部分更新 |

body：`{keywordList?:[], keywordText?:"a、b、c", crawlInterval?, reminderInterval?, crawlStatus?, crawlDays?}`
- 传 `keywordText` 时按 `、，,换行` 切分去重；传 `keywordList` 优先。
- 返回 Schedule：`{keywordList,keywordText,crawlInterval,reminderInterval,crawlStatus,crawlDays,updatedAt}`。

## 7. 其他

- `GET /api/health` → `{ok:true,...}`（已实现）
- 前端静态文件由 `main.py` 挂在 `/`（`BX_STATIC_DIR`，默认仓库 `demo/`）。
