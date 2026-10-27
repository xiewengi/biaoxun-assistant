-- ============================================================
-- 标讯助手 · SQLite 建表脚本
-- 说明：脚本可重复执行（IF NOT EXISTS），应用启动时自动执行。
-- 时间统一存 TEXT（ISO8601 / YYYY-MM-DD），便于直观看库。
-- ============================================================

PRAGMA foreign_keys = ON;

-- ---------- 小组（团队） ----------
CREATE TABLE IF NOT EXISTS groups (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL UNIQUE,
    region        TEXT NOT NULL,
    admin         TEXT NOT NULL DEFAULT '',
    admin_contact TEXT NOT NULL DEFAULT '',
    admin_account TEXT NOT NULL DEFAULT '',
    position      TEXT NOT NULL DEFAULT '负责人',
    created_at    TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS group_members (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id    INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    name_pinyin TEXT NOT NULL DEFAULT '',
    contact     TEXT NOT NULL DEFAULT '',
    position    TEXT NOT NULL DEFAULT '成员',
    created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members(group_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_group_members_name ON group_members(group_id, name);

-- ---------- 登录用户（账号由小组管理员派生） ----------
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    account       TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    phone         TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    salt          TEXT NOT NULL,
    group_id      INTEGER REFERENCES groups(id) ON DELETE SET NULL,
    role          TEXT NOT NULL DEFAULT 'admin',
    created_at    TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_users_group ON users(group_id);

CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- ---------- 招标公告 ----------
CREATE TABLE IF NOT EXISTS announcements (
    id                       TEXT PRIMARY KEY,              -- 公告编号 ANNxxxx
    title                    TEXT NOT NULL,
    project_name             TEXT NOT NULL DEFAULT '',
    project_code             TEXT NOT NULL DEFAULT '',
    buyer                    TEXT NOT NULL DEFAULT '',
    agency                   TEXT NOT NULL DEFAULT '',
    budget                   TEXT NOT NULL DEFAULT '',
    fund_source              TEXT NOT NULL DEFAULT '',
    district                 TEXT NOT NULL DEFAULT '',
    ann_type                 TEXT NOT NULL DEFAULT '',
    pub_date                 TEXT NOT NULL DEFAULT '',
    deadline                 TEXT NOT NULL DEFAULT '',
    bid_open_date            TEXT NOT NULL DEFAULT '',
    summary                  TEXT NOT NULL DEFAULT '',
    contact                  TEXT NOT NULL DEFAULT '',
    contacts_json            TEXT NOT NULL DEFAULT '{}',    -- JSON: {purchaser,agency,project}
    source_url               TEXT NOT NULL DEFAULT '',
    region                   TEXT NOT NULL DEFAULT '',
    purchase_method          TEXT NOT NULL DEFAULT '',
    matched_keywords         TEXT NOT NULL DEFAULT '[]',    -- JSON array
    business_tags            TEXT NOT NULL DEFAULT '[]',    -- JSON array
    is_valid_opportunity     TEXT NOT NULL DEFAULT '',
    has_operator_involvement TEXT NOT NULL DEFAULT '',
    opportunity_code         TEXT NOT NULL DEFAULT '',
    opportunity_status       TEXT NOT NULL DEFAULT '',
    will_bid                 TEXT NOT NULL DEFAULT '',
    tree_placement           TEXT NOT NULL DEFAULT '',
    current_handler          TEXT NOT NULL DEFAULT '',
    handler_group            TEXT NOT NULL DEFAULT '',
    progress                 TEXT NOT NULL DEFAULT '待分配',
    next_follow_up           TEXT NOT NULL DEFAULT '',
    created_at               TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    confirmed_at             TEXT NOT NULL DEFAULT '',
    updated_at               TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    is_deleted               INTEGER NOT NULL DEFAULT 0,   -- 0=正常 1=已逻辑删除
    deleted_at               TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_ann_pub_date ON announcements(pub_date);
CREATE INDEX IF NOT EXISTS idx_ann_district ON announcements(district);
CREATE INDEX IF NOT EXISTS idx_ann_progress ON announcements(progress);
CREATE INDEX IF NOT EXISTS idx_ann_code ON announcements(project_code);
CREATE INDEX IF NOT EXISTS idx_ann_handler_group ON announcements(handler_group);

-- ---------- 进度记录 ----------
CREATE TABLE IF NOT EXISTS progress_records (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ann_id      TEXT NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
    progress    TEXT NOT NULL,
    follower    TEXT NOT NULL DEFAULT '',
    follow_date TEXT NOT NULL DEFAULT '',
    note        TEXT NOT NULL DEFAULT '',
    attachment  TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_progress_records_ann ON progress_records(ann_id);

-- ---------- 任务分配记录 ----------
CREATE TABLE IF NOT EXISTS assignment_records (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    ann_id         TEXT NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
    assigner       TEXT NOT NULL DEFAULT '',
    assigner_group TEXT NOT NULL DEFAULT '',
    assignee       TEXT NOT NULL DEFAULT '',
    assignee_group TEXT NOT NULL DEFAULT '',
    note           TEXT NOT NULL DEFAULT '',
    assigned_at    TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_assignment_records_ann ON assignment_records(ann_id);

-- ---------- 数据来源 ----------
CREATE TABLE IF NOT EXISTS sources (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    name              TEXT NOT NULL,
    url               TEXT NOT NULL,
    domain            TEXT NOT NULL DEFAULT '',
    source_code       TEXT NOT NULL DEFAULT 'generic',
    enabled           INTEGER NOT NULL DEFAULT 1,
    last_status       TEXT NOT NULL DEFAULT '',   -- ok / fail / ''
    last_http_code    INTEGER,
    last_latency_ms   INTEGER,
    last_checked_at   TEXT NOT NULL DEFAULT '',
    last_message      TEXT NOT NULL DEFAULT '',
    last_found_links  INTEGER NOT NULL DEFAULT 0,
    last_matched_links INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sources_url ON sources(url);

-- ---------- 定时任务配置（单行，id=1） ----------
CREATE TABLE IF NOT EXISTS schedule_config (
    id                INTEGER PRIMARY KEY CHECK (id = 1),
    keyword_list      TEXT NOT NULL DEFAULT '',   -- JSON array
    crawl_interval    TEXT NOT NULL DEFAULT '每2小时',
    reminder_interval TEXT NOT NULL DEFAULT '每天 09:00, 15:00',
    crawl_status      TEXT NOT NULL DEFAULT '运行中',
    crawl_days        INTEGER NOT NULL DEFAULT 3,
    updated_at        TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- ---------- 采集运行记录 ----------
CREATE TABLE IF NOT EXISTS crawl_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    finished_at TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'running',  -- running / ok / error
    sites_ok    INTEGER NOT NULL DEFAULT 0,
    sites_total INTEGER NOT NULL DEFAULT 0,
    new_count   INTEGER NOT NULL DEFAULT 0,
    message     TEXT NOT NULL DEFAULT '',
    operator    TEXT NOT NULL DEFAULT ''
);

-- ---------- 采购人-区县 基础资料 ----------
-- 加密列（buyer_hash 等）由 db.py 的 _migrate_buyer_encryption 增量迁移补充
CREATE TABLE IF NOT EXISTS buyer_district (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    buyer       TEXT NOT NULL,
    district    TEXT NOT NULL DEFAULT '',
    remark      TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- ---------- 操作审计（轻量） ----------
CREATE TABLE IF NOT EXISTS audit_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_name  TEXT NOT NULL DEFAULT '',
    action     TEXT NOT NULL,
    target     TEXT NOT NULL DEFAULT '',
    detail     TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
