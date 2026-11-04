// ===== 数据层（数据来自后端 API）=====
// 说明：原先内联在 INLINE_ANN / INLINE_SITE 中的演示数据已停用，
// 公告、数据来源、团队、定时配置统一从 FastAPI 读取。

// ============================================================
// 团队优先级 / 顺序说明（勿随意改动！）
//   ① 集团客户部   —— 战略级客户，固定排在团队管理页首卡
//   ② 战客中心
//   ③ 市区
//   ④ 潮安
//   ⑤ 饶平
// 若后续新增团队，必须先与老大确认是否需要调整排序。
// ============================================================
let TEAM_GROUPS = [];

// 进度选项（预制）——老大 2026-10-23 新增「已确认」状态
const PROGRESS_OPTIONS = ['待分配', '已分配', '已确认'];

// 任务提醒离线兜底（正常流程以 GET /api/reminders 为准）
function generateReminders(announcements) {
  const reminders = [];
  let id = 1;
  announcements.forEach(a => {
    // 已确认的公告不再生成任何提醒
    if (a.progress === '已确认') return;
    // 管理员超时未分配提醒
    if (a.progress === '待分配' || !a.currentHandler) {
      reminders.push({
        id: id++,
        type: 'admin-assign',
        label: '管理员分派',
        title: `项目「${(a.projectName || a.title).slice(0, 30)}...」已入库 ${Math.floor(Math.random()*3)+1} 天未分配`,
        targetId: a.id,
        time: a.createdAt,
        level: 'urgent',
        district: a.district,
        annTitle: a.title,
        annProgress: a.progress || '待分配',
        annCurrentHandler: a.currentHandler || ''
      });
    }
    // 业务员跟进提醒
    if (a.progress === '已分配') {
      const daysToFollow = Math.floor(Math.random()*5);
      reminders.push({
        id: id++,
        type: 'sales-follow',
        label: '业务员跟进',
        title: `项目「${(a.projectName || a.title).slice(0, 30)}...」需跟进`,
        targetId: a.id,
        time: a.nextFollowUp,
        level: daysToFollow <= 1 ? 'urgent' : (daysToFollow <= 3 ? 'warn' : 'info'),
        district: a.district,
        annTitle: a.title,
        annProgress: a.progress || '已分配',
        annCurrentHandler: a.currentHandler || ''
      });
    }
  });
  return reminders;
}

// 定时任务配置（运行时由 GET /api/schedule 赋值）
let SCHEDULE_CONFIG = {
  keywordList: [],
  keywordText: '',
  crawlInterval: '',
  reminderInterval: '',
  crawlStatus: '',
  crawlDays: 3,
  updatedAt: '',
};

// 数据源注册表（运行时由 GET /api/sources 赋值）
let SOURCES_DATA = [];

// ===== 数据加载函数 =====
async function loadAnnouncements() {
  const data = await API.listAnnouncements({ page_size: 0 });
  if (Array.isArray(data)) return data;
  return (data && Array.isArray(data.items)) ? data.items : [];
}

// Source → 任务提醒页 / 定时任务页使用的 siteResults 结构
function mapSourceToSiteResult(s) {
  const ok = s.lastStatus === 'ok';
  const latency = Number(s.lastLatencyMs) || 0;
  const statusMsg = ok
    ? `正常 ${latency}ms`
    : (s.lastStatus ? '连接失败' : '未检测');
  return {
    name: s.name,
    url: s.url,
    ok: ok,
    http_code: s.lastHttpCode === null || s.lastHttpCode === undefined ? '' : s.lastHttpCode,
    latency_ms: latency,
    status_msg: statusMsg,
    error_detail: ok ? '' : (s.lastMessage || (s.lastStatus ? '连接失败' : '尚未检测')),
    found_links: Number(s.lastFoundLinks) || 0,
    matched_links: Number(s.lastMatchedLinks) || 0,
  };
}

async function loadSiteResults() {
  const data = await API.listSources();
  const items = Array.isArray(data) ? data : ((data && data.items) || []);
  return items.map(mapSourceToSiteResult);
}

async function loadGroups() {
  const data = await API.listGroups();
  TEAM_GROUPS = Array.isArray(data) ? data : ((data && data.items) || []);
  return TEAM_GROUPS;
}

async function loadSources() {
  const data = await API.listSources();
  SOURCES_DATA = Array.isArray(data) ? data : ((data && data.items) || []);
  return SOURCES_DATA;
}

async function loadSchedule() {
  const data = await API.getSchedule();
  const next = Object.assign({}, SCHEDULE_CONFIG, data || {});
  if (!Array.isArray(next.keywordList)) {
    next.keywordList = String(next.keywordText || '')
      .split(/[、,，\n]/)
      .map(s => s.trim())
      .filter(Boolean);
  }
  SCHEDULE_CONFIG = next;
  return SCHEDULE_CONFIG;
}
