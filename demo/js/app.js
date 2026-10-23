// ===== 主应用逻辑（由标讯助手demo.html 自动同步）=====

// --- script[2] ---
// 标讯助手 Demo - 主应用逻辑

// 登录账号（由 TEAM_GROUPS 自动派生，统一密码 123456）
const USERS = TEAM_GROUPS.map(g => ({
  account: g.adminAccount,
  name: g.admin,
  phone: g.adminContact,
  group: g.name,
  groupId: g.id,
  password: '123456'
}));

// 登录持久化 key
const LS_USER = 'currentUser';

// 商机管理必填字段（老大 2026-10-23 定案）
const REQUIRED_OPP_FIELDS = [
  { key: 'isValidOpportunity', label: '是否有效商机' },
  { key: 'hasOperatorInvolvement', label: '是否有运营商参与' },
  { key: 'opportunityCode', label: '商机编码' },
  { key: 'willBid', label: '是否应标' },
];

let state = {
  currentUser: null,      // { account, name, phone, group, groupId }
  page: 'announcements',
  announcements: [],
  siteResults: [],        // 真实站点采集结果
  filteredList: [],
  reminders: [],
  selectedReminderIds: new Set(),
  filters: { keyword: '', region: '', district: '', progress: '', bidStatus: '', businessTag: '' },
  detailId: null,
  modal: null, // 'assign' | 'batch-assign' | 'reminder-batch-assign' | 'progress' | 'add-group' | 'edit-group' | null
  assignAnnId: null,
  progressAnnId: null,
  editGroupId: null,
  selectedAnnIds: new Set(),
  // 翻页
  pageSize: 10,           // 10 / 50 / 100 / 0(全部)
  currentPage: 1,
  reminderDistrictFilter: '',  // 任务提醒页专属区县筛选
};

// ============ 初始化 ============
// ============ 商机管理 localStorage 持久化 ============
function restoreOpportunities() {
  try {
    const saved = JSON.parse(localStorage.getItem('opp_fields') || '{}');
    for (const ann of state.announcements) {
      const s = saved[ann.id];
      if (s) {
        for (const [k, v] of Object.entries(s)) {
          // 数组字段: 存时是JSON字符串, 读时parse
          if (k === 'progressRecords' && typeof v === 'string') {
            try { ann.progressRecords = JSON.parse(v); } catch { ann.progressRecords = []; }
          } else {
            ann[k] = v;
          }
        }
      }
    }
  } catch (e) {}
}
function saveOpportunityField(annId, field, value) {
  try {
    const saved = JSON.parse(localStorage.getItem('opp_fields') || '{}');
    saved[annId] = saved[annId] || {};
    // 数组字段自动JSON序列化
    if (Array.isArray(value)) {
      saved[annId][field] = JSON.stringify(value);
    } else {
      saved[annId][field] = value;
    }
    localStorage.setItem('opp_fields', JSON.stringify(saved));
  } catch (e) {}
}
function bindOpportunityEvents() {
  document.querySelectorAll('[data-opp-field]').forEach(el => {
    const annId = state.detailId;
    if (!annId) return;
    const field = el.dataset.oppField;
    const ev = el.tagName === 'SELECT' ? 'change' : 'input';
    el.addEventListener(ev, () => {
      const ann = state.announcements.find(x => x.id === annId);
      if (ann) ann[field] = el.value;
      saveOpportunityField(annId, field, el.value);
    });
  });
}

// ============ 商机管理 · 信息已确认（校验 + 保存） ============
function confirmOpportunity() {
  const annId = state.detailId;
  if (!annId) return;
  const ann = state.announcements.find(x => x.id === annId);
  if (!ann) return;

  // 先从 DOM 同步商机字段到 ann 对象（防止用户填了表单但对象没更新）
  document.querySelectorAll('[data-opp-field]').forEach(el => {
    const field = el.dataset.oppField;
    ann[field] = el.value;
    saveOpportunityField(annId, field, el.value);
  });

  // 校验 4 个必填字段
  const missing = [];
  REQUIRED_OPP_FIELDS.forEach(f => {
    const v = (ann[f.key] || '').trim();
    if (!v) missing.push(f.label);
  });
  if (missing.length > 0) {
    alert('请先完善以下必填项：\n  - ' + missing.join('\n  - '));
    return;
  }

  // 保存为「已确认」
  ann.progress = '已确认';
  ann.progressRecords = ann.progressRecords || [];
  ann.progressRecords.push({
    progress: '已确认',
    follower: state.currentUser ? state.currentUser.name : '当前用户',
    followDate: new Date().toISOString().slice(0, 10),
    note: '商机信息已完整确认'
  });
  saveOpportunityField(annId, 'progress', '已确认');
  saveOpportunityField(annId, 'progressRecords', ann.progressRecords);

  // 重新生成提醒（过滤掉已确认）
  state.reminders = generateReminders(state.announcements);

  alert('✅ 商机信息已确认！');
  render();
}

async function init() {
  state.announcements = await loadAnnouncements();
  state.siteResults = await loadSiteResults();
  state.reminders = generateReminders(state.announcements);
  restoreOpportunities();
  // 恢复登录态
  try {
    const saved = localStorage.getItem(LS_USER);
    if (saved) state.currentUser = JSON.parse(saved);
  } catch (e) {}
  applyFilters();
  render();
}

// ============ 筛选逻辑 ============
function applyFilters() {
  const f = state.filters;
  state.filteredList = state.announcements.filter(a => {
    if (f.keyword) {
      const kw = f.keyword.toLowerCase();
      if (!a.title.toLowerCase().includes(kw) && !a.projectName.toLowerCase().includes(kw) && !a.buyer.toLowerCase().includes(kw) && !a.matchedKeywords.some(k => k.toLowerCase().includes(kw)))
        return false;
    }
    if (f.region && a.region !== f.region) return false;
    if (f.district && a.district !== f.district) return false;
    if (f.progress && a.progress !== f.progress) return false;
    if (f.bidStatus && computeBidStatus(a) !== f.bidStatus) return false;
    if (f.businessTag && !(a.businessTags || []).includes(f.businessTag)) return false;
    return true;
  });
  state.filteredList.sort((a, b) => b.pubDate.localeCompare(a.pubDate));
  state.currentPage = 1;  // 筛选变化时回到第一页
}

// ============ 渲染主框架 ============
function render() {
  const app = document.getElementById('app');

  // 未登录 → 渲染独立登录页（不要主框架）
  if (!state.currentUser) {
    app.innerHTML = renderLoginPage();
    bindLoginEvents();
    return;
  }

  app.innerHTML = `
    <div class="flex h-screen overflow-hidden">
      ${renderSidebar()}
      <div class="flex-1 flex flex-col overflow-hidden">
        ${renderHeader()}
        <main class="flex-1 scrollbar-thin p-6" style="overflow-y:auto;overflow-x:hidden">
          ${renderPage()}
        </main>
      </div>
    </div>
    ${state.modal === 'assign' ? renderAssignModal() : state.modal === 'batch-assign' ? renderBatchAssignModal() : state.modal === 'reminder-batch-assign' ? renderReminderBatchAssignModal() : state.modal === 'kw-delete' ? renderKwDeleteModal() : ''}
    ${state.modal === 'progress' ? renderProgressModal() : ''}
    ${state.modal === 'add-group' ? renderAddGroupModal() : ''}
    ${state.modal === 'edit-group' ? renderEditGroupModal() : ''}
  `;
  bindEvents();
}

// ============ 登录页面 ============
function renderLoginPage() {
  return `
    <!-- 动态渐变背景 -->
    <div class="login-bg h-screen w-screen relative overflow-hidden flex items-center justify-center">
      <!-- 装饰圆 -->
      <div class="login-blob login-blob-1"></div>
      <div class="login-blob login-blob-2"></div>
      <div class="login-blob login-blob-3"></div>
      
      <!-- 毛玻璃卡片 -->
      <div class="login-card fade-in" style="width:420px">
        <!-- Logo + 标题 -->
        <div class="text-center mb-8">
          <div class="w-[200px] h-14 mx-auto rounded-xl flex items-center justify-center text-white font-bold text-2xl shadow-lg tracking-wider"
               style="background:linear-gradient(135deg,#3b82f6 0%,#1e40af 100%)">
            标讯助手
          </div>
          <div class="text-sm text-gray-500 mt-4">智能招标信息管理平台</div>
        </div>

        <!-- 登录表单 -->
        <div class="space-y-4">
          <!-- 账号 -->
          <div class="login-input-wrap">
            <svg class="login-input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/>
            </svg>
            <input id="login-account" type="text" placeholder="请输入账号"
                   class="login-input"
                   autocomplete="username">
          </div>
          
          <!-- 密码 -->
          <div class="login-input-wrap">
            <svg class="login-input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
              <path d="M7 11V7a5 5 0 0110 0v4"/>
            </svg>
            <input id="login-password" type="password" placeholder="请输入密码"
                   class="login-input"
                   autocomplete="current-password">
          </div>

          <!-- 登录按钮 -->
          <button id="login-btn" class="login-btn">
            <span>登 录</span>
            <svg class="login-btn-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <path d="M5 12h14M12 5l7 7-7 7"/>
            </svg>
          </button>
        </div>

        <!-- 底部提示 -->
        <div class="mt-7 pt-5 border-t border-gray-200/60">
          <div class="flex items-center justify-center gap-1.5 text-xs text-gray-400">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/>
              <path d="M9 12l2 2 4-4"/>
            </svg>
            <span>演示环境</span>
          </div>
          <div class="text-center text-xs text-gray-300 mt-2 leading-relaxed">
            账号：sheshujuan / lixiaoyi / huangxinchong / linxiaoyu2 / linxuxun<br>
            密码统一：<span class="font-mono text-gray-400">123456</span>
          </div>
        </div>
      </div>
    </div>
  `;
}

function bindLoginEvents() {
  const btn = document.getElementById('login-btn');
  if (!btn) return;
  btn.onclick = doLogin;
  document.querySelectorAll('#login-account, #login-password').forEach(el => {
    el.onkeydown = (e) => { if (e.key === 'Enter') doLogin(); };
  });
}

function doLogin() {
  const account = document.getElementById('login-account').value.trim();
  const password = document.getElementById('login-password').value.trim();
  if (!account || !password) { alert('请输入账号和密码'); return; }
  const u = USERS.find(x => x.account === account && x.password === password);
  if (!u) { alert('账号或密码错误'); return; }
  // 登录成功
  const user = { account: u.account, name: u.name, phone: u.phone, group: u.group, groupId: u.groupId };
  state.currentUser = user;
  localStorage.setItem(LS_USER, JSON.stringify(user));
  render();
}

function doLogout() {
  if (!confirm('确认退出登录？')) return;
  state.currentUser = null;
  localStorage.removeItem(LS_USER);
  state.selectedReminderIds.clear();
  state.selectedAnnIds.clear();
  state.detailId = null;
  state.modal = null;
  render();
}

function renderSidebar() {
  const items = [
    { key: 'announcements', label: '招标公告', icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01' },
    { key: 'reminders', label: '任务提醒', icon: 'M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9' },
    { key: 'team', label: '团队管理', icon: 'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z' },
    { key: 'schedule', label: '定时任务', icon: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z' },
    { key: 'sources', label: '数据来源', icon: 'M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z' },
  ];
  return `
    <aside class="w-60 bg-white border-r border-gray-200 flex flex-col">
      <div class="h-16 flex items-center gap-3 px-5 border-b border-gray-200">
        <div class="w-9 h-9 bg-gradient-to-br from-blue-500 to-blue-700 rounded-lg flex items-center justify-center text-white font-bold text-sm">标</div>
        <div>
          <div class="font-semibold text-gray-900">标讯助手</div>
          <div class="text-xs text-gray-400">Demo v1.0</div>
        </div>
      </div>
      <nav class="flex-1 py-3 px-2 space-y-1">
        ${items.map(i => `
          <div class="sidebar-item ${state.page === i.key ? 'active' : ''} flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer text-sm text-gray-600" data-page="${i.key}">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.8">
              <path stroke-linecap="round" stroke-linejoin="round" d="${i.icon}"></path>
            </svg>
            ${i.label}
            ${i.key === 'reminders' ? (() => { const cnt = getFilteredReminders().length; return cnt > 0 ? `<span class="ml-auto bg-red-500 text-white text-xs px-1.5 py-0.5 rounded-full animate-pulse">${cnt}</span>` : ''; })() : ''}
          </div>
        `).join('')}
      </nav>
      <div class="px-4 py-3 border-t border-gray-200 text-xs text-gray-400">
        <div>战略客户中心</div>
        <div>行业：党政/医疗/工业…</div>
      </div>
    </aside>
  `;
}

function renderHeader() {
  const pageTitle = { announcements: '招标公告', sources: '数据来源', reminders: '任务提醒', team: '团队管理', schedule: '定时任务配置' }[state.page];
  const stats = getStats();
  const siteOk = state.siteResults.filter(r => r.ok).length;
  const lastCrawl = state.siteResults.length > 0 
    ? new Date(Math.max(...state.siteResults.map(r => 0))).toLocaleString('zh-CN') 
    : '—';
  return `
    <header class="h-16 bg-white border-b border-gray-200 flex items-center px-6 gap-6">
      <div>
        <h1 class="text-lg font-semibold text-gray-900">${pageTitle}</h1>
        <p class="text-xs text-gray-400">当前共 ${state.filteredList.length} 条公告 · 数据来源 ${siteOk}/${SOURCES_DATA.filter(s => s.enabled).length} 个网站</p>
      </div>
      ${state.page === 'announcements' ? `
        <div class="ml-auto flex items-center gap-2">
          <div class="text-sm text-gray-500">
            <span class="font-semibold text-gray-700">${stats.todayCount}</span> 今日新增 · 
            <span class="font-semibold text-orange-600">${stats.unassignedCount}</span> 待分配 · 
            <span class="font-semibold text-blue-600">${stats.inProgressCount}</span> 已分配
          </div>
          <button class="text-xs text-gray-400 hover:text-blue-600 px-3 py-1.5 border border-gray-200 rounded-lg" id="btn-refresh">
            🔄 刷新抓取
          </button>
        </div>
      ` : `<div class="ml-auto text-sm text-gray-500"></div>`}
      <!-- 当前登录用户 -->
      <div class="flex items-center gap-3 pl-3 ml-2 border-l border-gray-200">
        <div class="text-right">
          <div class="text-sm font-medium text-gray-800">${state.currentUser ? state.currentUser.name : ''}</div>
          <div class="text-xs text-gray-400">${state.currentUser ? state.currentUser.group : ''}</div>
        </div>
        <button id="btn-logout" class="text-xs text-gray-500 hover:text-red-600 px-2.5 py-1.5 border border-gray-200 rounded-lg hover:bg-gray-50">
          退出
        </button>
      </div>
    </header>
  `;
}

function getStats() {
  const today = new Date().toISOString().slice(0, 10);
  return {
    todayCount: state.announcements.filter(a => a.pubDate === today).length,
    unassignedCount: state.announcements.filter(a => a.progress === '待分配' || !a.currentHandler).length,
    inProgressCount: state.announcements.filter(a => a.progress === '已分配').length,
  };
}

// ============ 页面渲染 ============
function renderPage() {
  if (state.detailId) return renderAnnouncementDetail();
  switch (state.page) {
    case 'announcements': return renderAnnouncementList();
    case 'sources': return renderSources();
    case 'reminders': return renderReminders();
    case 'team': return renderTeam();
    case 'schedule': return renderSchedule();
  }
}

// ---- 招标公告列表 ----
function renderAnnouncementList() {
  const districts = [...new Set(state.announcements.map(a => a.district))].sort();
  const tags = [...new Set(state.announcements.flatMap(a => a.businessTags || []))].sort();
  const progresses = ['待分配', '已分配'];
  const bidStatuses = ['意向', '挂网', '截止报名', '开标'];

  // 翻页逻辑
  const total = state.page === 'reminders' ? state.reminders.length : state.filteredList.length;
  const pageSize = state.pageSize === 0 ? total : state.pageSize;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(state.currentPage, totalPages);
  const startIdx = (currentPage - 1) * pageSize;
  const pageData = state.pageSize === 0 ? state.filteredList : state.filteredList.slice(startIdx, startIdx + pageSize);

  // 页码按钮（最多显示7个）
  let pageButtons = [];
  if (totalPages <= 7) {
    for (let i = 1; i <= totalPages; i++) pageButtons.push(i);
  } else {
    pageButtons.push(1);
    let s = Math.max(2, currentPage - 1);
    let e = Math.min(totalPages - 1, currentPage + 1);
    if (s > 2) pageButtons.push('...');
    for (let i = s; i <= e; i++) pageButtons.push(i);
    if (e < totalPages - 1) pageButtons.push('...');
    pageButtons.push(totalPages);
  }

  return `
    <!-- 筛选区 + 批量操作（同一行，右侧浮入） -->
    <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-3 mb-3">
      <div class="flex flex-wrap items-center gap-2">
        <input type="text" placeholder="搜索标题 / 采购人 / 关键词..." 
               class="min-w-[200px] w-[340px] h-9 px-3 border border-gray-200 rounded text-sm focus:outline-none focus:border-blue-400" 
               value="${state.filters.keyword}" data-filter="keyword">
        <select class="h-9 px-2.5 border border-gray-200 rounded text-sm focus:outline-none focus:border-blue-400" data-filter="district">
          <option value="">全部区县</option>
          ${districts.map(d => `<option value="${d}" ${state.filters.district===d?'selected':''}>${d}</option>`).join('')}
        </select>
        <select class="h-9 px-2.5 border border-gray-200 rounded text-sm focus:outline-none focus:border-blue-400" data-filter="businessTag">
          <option value="">全部业务标签</option>
          ${tags.map(t => `<option value="${t}" ${state.filters.businessTag===t?'selected':''}>${t}</option>`).join('')}
        </select>
        <select class="h-9 px-2.5 border border-gray-200 rounded text-sm focus:outline-none focus:border-blue-400" data-filter="progress">
          <option value="">全部进度</option>
          ${progresses.map(p => `<option value="${p}" ${state.filters.progress===p?'selected':''}>${p}</option>`).join('')}
        </select>
        <select class="h-9 px-2.5 border border-gray-200 rounded text-sm focus:outline-none focus:border-blue-400" data-filter="bidStatus">
          <option value="">全部标讯状态</option>
          ${bidStatuses.map(s => `<option value="${s}" ${state.filters.bidStatus===s?'selected':''}>${s}</option>`).join('')}
        </select>

        <!-- 批量操作：默认隐藏，选中时 inline 出现在最右侧 -->
        <div id="batchBar" style="display:none" class="flex items-center gap-1.5 ml-auto">
          <span id="batchCount" class="text-xs text-blue-600 font-medium whitespace-nowrap">已选 0 条</span>
          ${state.currentUser && state.currentUser.group === '集团客户部'
          ? `<button class="px-3 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700" id="batchAssignBtn">批量分配</button>`
          : `<button class="px-3 py-1 text-xs bg-gray-300 text-white rounded cursor-not-allowed" id="batchAssignBtn" disabled title="仅集团客户部可批量分配">批量分配</button>`}
          <button class="px-3 py-1 text-xs border border-gray-200 text-gray-600 rounded hover:bg-gray-50" id="batchClearBtn">清空选择</button>
        </div>
      </div>
    </div>

    <!-- 公告表格 -->
    <div class="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden" style="width:100%">
      <div class="scrollbar-thin" style="border-radius:inherit;overflow-x:auto">
        <div style="width:1394px;min-width:1394px;box-sizing:content-box">
          <table class="text-sm border-separate" style="width:100%;border-spacing:0">
                        <thead class="text-gray-500 text-xs">
              <tr>
                <th class="px-2 py-3 text-center font-medium sticky left-0 z-20" style="background:#f9fafb;width:44px">
                  <input type="checkbox" id="annSelectAll">
                </th>
                <th class="px-4 py-3 text-left font-medium sticky left-0 z-10" style="background:#f9fafb;width:300px">项目名称 / 项目编码</th>
                <th class="px-3 py-3 text-left font-medium" style="background:#f9fafb;width:130px">采购人</th>
                <th class="px-3 py-3 text-left font-medium" style="background:#f9fafb;width:130px">代理机构</th>
                <th class="px-3 py-3 text-left font-medium" style="background:#f9fafb;width:100px">预算</th>
                <th class="px-3 py-3 text-left font-medium" style="background:#f9fafb;width:60px">区县</th>
                <th class="px-3 py-3 text-left font-medium" style="background:#f9fafb;width:100px">业务标签</th>
                <th class="px-3 py-3 text-left font-medium" style="background:#f9fafb;width:90px">发布日期</th>
                <th class="px-3 py-3 text-left font-medium" style="background:#f9fafb;width:90px">报名截止</th>
                <th class="px-3 py-3 text-left font-medium" style="background:#f9fafb;width:70px">处理人</th>
                <th class="px-3 py-3 text-left font-medium" style="background:#f9fafb;width:80px">进度</th>
                 <th class="px-3 py-3 text-left font-medium" style="background:#f9fafb;width:80px">标讯状态</th>
                <th class="px-4 py-3 text-center font-medium sticky right-0 z-10" style="background:#f9fafb;width:120px">操作</th>
              </tr>
            </thead>
                        <tbody>
              ${pageData.length === 0 ? `
                <tr><td colspan="13" class="py-16 text-center text-gray-400">暂无符合条件的公告</td></tr>
              ` : pageData.map(a => `
                <tr class="ann-row border-t border-gray-50 hover:bg-gray-50" data-id="${a.id}">
                  <td class="px-2 py-3 text-center sticky left-0 ann-row-first" style="background:#fff;width:44px">
                    <input type="checkbox" class="ann-row-check" data-id="${a.id}">
                  </td>
                  <td class="px-4 py-3 sticky left-0 ann-row-first" style="background:#fff;width:300px">
                    <div class="font-medium text-gray-800 max-w-[400px] truncate cursor-pointer hover:text-blue-600" data-detail="${a.id}">${a.projectName || a.title}</div>
                    <div class="flex items-center gap-2 mt-1">
                      <span class="text-xs text-gray-400 font-mono">${a.projectCode}</span>
                      <span class="text-gray-300">|</span>
                      <div class="flex flex-wrap gap-1">
                        ${a.matchedKeywords.slice(0, 3).map(k => `<span class="tag tag-purple">${k}</span>`).join('')}
                        ${a.matchedKeywords.length > 3 ? `<span class="tag tag-gray">+${a.matchedKeywords.length-3}</span>` : ''}
                      </div>
                    </div>
                  </td>
                  <td class="px-3 py-3 text-gray-600 truncate" style="width:130px" title="${a.buyer}">${a.buyer}</td>
                  <td class="px-3 py-3 text-gray-500 truncate" style="width:130px" title="${a.agency}">${a.agency}</td>
                  <td class="px-3 py-3 font-semibold text-orange-600 whitespace-nowrap" style="width:100px">${a.budget}</td>
                  <td class="px-3 py-3" style="width:60px"><span class="tag tag-blue">${a.district}</span></td>
                  <td class="px-3 py-3" style="width:100px">${(a.businessTags || []).map(t => `<span class="tag tag-green mr-1">${t}</span>`).join('') || '<span class="text-gray-400 text-xs">—</span>'}</td>
                  <td class="px-3 py-3 text-gray-500 whitespace-nowrap" style="width:90px">${a.pubDate}</td>
                  <td class="px-3 py-3 text-gray-500 whitespace-nowrap" style="width:90px">${a.deadline}</td>
                  <td class="px-3 py-3 text-gray-700 whitespace-nowrap" style="width:70px">${a.currentHandler || '-'}</td>
                  <td class="px-3 py-3 whitespace-nowrap" style="width:80px">${renderProgressTag(a.progress)}</td>
                  <td class="px-3 py-3 whitespace-nowrap" style="width:80px">${renderBidStatusTag(a)}</td>
                  <td class="px-4 py-3 text-center whitespace-nowrap sticky right-0 ann-row-last" style="background:#fff;width:120px">
                    ${a.progress === '待分配' || !a.currentHandler ? 
                      (state.currentUser && state.currentUser.group === '集团客户部'
                        ? `<button class="text-blue-600 hover:underline text-xs mr-2" data-assign="${a.id}">分配</button>`
                        : `<button class="text-gray-300 text-xs cursor-not-allowed mr-2" disabled title="仅集团客户部可分配">分配</button>`)
                      : ''}
                    <button class="text-blue-600 hover:underline text-xs" data-detail="${a.id}">详情</button>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
<!-- 分页 -->
    <div class="flex items-center justify-between mt-4 text-sm text-gray-500">
      <!-- 左：统计 + 每页N条 -->
      <div class="flex items-center gap-3">
        <span>共 <span class="font-semibold text-gray-700">${total}</span> 条</span>
        <span class="text-gray-300">|</span>
        <span>
          每页
          <select class="h-7 px-2 border border-gray-200 rounded text-sm mx-1" data-page-size>
            <option value="10" ${state.pageSize===10?'selected':''}>10</option>
            <option value="50" ${state.pageSize===50?'selected':''}>50</option>
            <option value="100" ${state.pageSize===100?'selected':''}>100</option>
            <option value="0" ${state.pageSize===0?'selected':''}>全部</option>
          </select>
          条
        </span>
        <span class="text-gray-300">|</span>
        <span>第 ${total === 0 ? 0 : startIdx + 1} - ${Math.min(startIdx + pageSize, total)} 条</span>
      </div>

      <!-- 右：分页按钮 -->
      ${totalPages > 1 ? `
      <div class="flex items-center gap-1">
        <button class="px-3 py-1 border border-gray-200 rounded text-sm text-gray-500 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed" 
                data-page-btn="prev" ${currentPage===1?'disabled':''}>← 上一页</button>
        ${pageButtons.map(b => 
          b === '...' 
            ? `<span class="px-2 py-1 text-gray-400">...</span>`
            : `<button class="min-w-[32px] px-2 py-1 border rounded text-sm ${b===currentPage?'bg-blue-600 text-white border-blue-600':'border-gray-200 text-gray-600 hover:bg-gray-50'}" 
                      data-page-btn="${b}">${b}</button>`
        ).join('')}
        <button class="px-3 py-1 border border-gray-200 rounded text-sm text-gray-500 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed" 
                data-page-btn="next" ${currentPage===totalPages?'disabled':''}>下一页 →</button>
      </div>
      ` : ''}
    </div>
  `;
}

function renderProgressTag(p) {
  const map = {
    '待分配': 'tag-red',
    '已分配': 'tag-blue',
    '已确认': 'tag-green',
  };
  return `<span class="tag ${map[p] || 'tag-gray'}">${p}</span>`;
}

// 标讯状态：根据 annType + bidOpenDate 动态计算
function computeBidStatus(a) {
  const today = new Date(); today.setHours(0,0,0,0);
  const t = a.annType || '';
  if (t.includes('意向')) return '意向';
  if (!a.bidOpenDate || a.bidOpenDate === '—') return '挂网';
  const open = new Date(a.bidOpenDate); open.setHours(0,0,0,0);
  if (open < today) return '截止报名';
  if (open.getTime() === today.getTime()) return '开标';
  return '挂网';
}

function renderBidStatusTag(a) {
  const status = computeBidStatus(a);
  const map = {
    '意向': 'tag-yellow',
    '挂网': 'tag-blue',
    '截止报名': 'tag-gray',
    '开标': 'tag-green',
  };
  return `<span class="tag ${map[status] || 'tag-gray'}">${status}</span>`;
}

// ========== 三方联系方式渲染 ==========
function renderContacts(a) {
  const c = a.contacts || {};
  const sections = [
    { key: "purchaser", label: "采购人" },
    { key: "agency",    label: "采购代理机构" },
    { key: "project",   label: "项目联系" },
  ];
  const cards = [];
  for (const sec of sections) {
    const s = c[sec.key] || {};
    const name    = s.name    || "";
    const address = s.address || "";
    const person  = s.person  || "";
    const phone   = s.phone   || "";
    if (!name && !address && !person && !phone) continue;
    const parts = [];
    if (name)    parts.push(`<div class="font-medium text-gray-800 mb-1">${name}</div>`);
    if (address) parts.push(`<div class="text-gray-500 text-xs break-all">📍 ${address}</div>`);
    if (person)  parts.push(`<div class="text-gray-500 text-xs break-all">👤 ${person}</div>`);
    if (phone)   parts.push(`<div class="text-gray-500 text-xs break-all">📞 ${phone}</div>`);
    cards.push(`
      <div class="p-3 bg-gray-50 rounded-lg overflow-hidden">
        <div class="text-xs text-blue-600 font-medium mb-1">${sec.label}</div>
        ${parts.join("")}
      </div>`);
  }
  if (cards.length === 0) {
    return `<div class="text-gray-400 text-sm">${a.contact || "—"}</div>`;
  }
  return `<div class="grid grid-cols-3 gap-3">${cards.join("")}</div>`;
}

// ---- 公告详情 ----
function renderAnnouncementDetail() {
  const a = state.announcements.find(x => x.id === state.detailId);
  if (!a) { state.detailId = null; return renderAnnouncementList(); }
  const isConfirmed = a.progress === '已确认';
  const disabledAttr = isConfirmed ? 'disabled' : '';
  
  return `
    <div class="max-w-5xl mx-auto">
      <button class="text-gray-500 hover:text-blue-600 text-sm mb-4" data-back>← 返回列表</button>
      
      <div class="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden mb-4">
        <div class="p-6 border-b border-gray-100">
          <div class="flex items-start gap-3">
            <div class="flex-1">
              <h2 class="text-xl font-semibold text-gray-900 leading-snug mb-2">${a.projectName || a.title}</h2>
              <div class="flex flex-wrap gap-1.5">
                ${a.matchedKeywords.map(k => `<span class="tag tag-purple">🔑 ${k}</span>`).join('')}
                <span class="tag tag-green">业务标签：${(a.businessTags || []).map(t => `<span class="tag tag-green mr-1">${t}</span>`).join('') || '<span class="text-gray-400">—</span>'}</span>
                <span class="tag tag-blue">${a.district}</span>
                ${renderProgressTag(a.progress)}
                ${renderBidStatusTag(a)}
              </div>
            </div>
            <div class="flex gap-2">
              ${isConfirmed
                ? `<button class="px-4 py-2 bg-gray-300 text-white rounded-lg text-sm cursor-not-allowed" disabled title="商机已确认, 不可分配">任务分配</button>`
                : (state.currentUser && state.currentUser.group === '集团客户部'
                  ? `<button class="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700" data-assign="${a.id}">任务分配</button>`
                  : `<button class="px-4 py-2 bg-gray-300 text-white rounded-lg text-sm cursor-not-allowed" disabled title="仅集团客户部可分配">任务分配</button>`)}
              <!-- 进度更新按钮暂时注释, 后续需要再启用 -->
              <!-- <button class="px-4 py-2 border border-gray-200 rounded-lg text-sm hover:bg-gray-50" data-progress="${a.id}">进度更新</button> -->
              ${a.progress === '已确认'
                ? `<button class="px-4 py-2 bg-green-500 text-white rounded-lg text-sm opacity-70 cursor-not-allowed" disabled>✓ 信息已确认</button>`
                : `<button id="btn-confirm-opp" class="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">✅ 信息已确认</button>`}
            </div>
          </div>
        </div>
        
        <div class="p-6">
          <div class="grid grid-cols-2 gap-x-10 gap-y-4 text-sm">
            <div><span class="text-gray-400">项目编码：</span><span class="font-mono text-gray-700">${a.projectCode}</span></div>
            <div><span class="text-gray-400">公告类型：</span><span class="text-gray-700">${a.annType}</span></div>
            <div><span class="text-gray-400">标讯状态：</span>${renderBidStatusTag(a)}</div>
            <div><span class="text-gray-400">采购人：</span><span class="text-gray-700">${a.buyer}</span></div>
            <div><span class="text-gray-400">代理机构：</span><span class="text-gray-700">${a.agency}</span></div>
            <div><span class="text-gray-400">采购方式：</span><span class="text-gray-700">${a.purchaseMethod || '—'}</span></div>
            <div><span class="text-gray-400">预算金额：</span><span class="text-orange-600 font-semibold">${a.budget}</span></div>
            <div><span class="text-gray-400">资金来源：</span><span class="text-gray-700">${a.fundSource}</span></div>
            <div><span class="text-gray-400">所属区县：</span><span class="text-gray-700">${a.district}</span></div>
            <div><span class="text-gray-400">所属区域：</span><span class="text-gray-700">${a.region}</span></div>
            <div><span class="text-gray-400">发布日期：</span><span class="text-gray-700">${a.pubDate}</span></div>
            <div><span class="text-gray-400">报名截止：</span><span class="text-gray-700">${a.deadline}</span></div>
            <div><span class="text-gray-400">开标日期：</span><span class="text-gray-700">${a.bidOpenDate}</span></div>
            <div><span class="text-gray-400">创建时间：</span><span class="text-gray-700">${a.createdAt}</span></div>
            <div><span class="text-gray-400">当前处理人：</span><span class="text-gray-700">${a.currentHandler || '未分配'}</span></div>
            <div class="col-span-2"><span class="text-gray-400">命中关键词：</span><span class="text-gray-700">${a.matchedKeywords.map(k => `<span class="tag tag-purple mr-1">${k}</span>`).join('')}</span></div>
            <div class="col-span-2"><span class="text-gray-400">业务标签：</span><span class="text-gray-700">业务标签：${(a.businessTags || []).map(t => `<span class="tag tag-green mr-1">${t}</span>`).join('') || '<span class="text-gray-400">—</span>'}</span></div>
          </div>

          <div class="mt-6 pt-4 border-t border-gray-100">
            <div class="text-gray-400 text-sm mb-2">📞 联系方式</div>
            ${renderContacts(a)}
          </div>
          
          <div class="mt-4 pt-4 border-t border-gray-100">
            <div class="text-gray-400 text-sm mb-2">原始链接</div>
            <a href="${a.sourceUrl}" target="_blank" class="text-blue-600 hover:underline text-sm break-all">${a.sourceUrl}</a>
          </div>

          <div class="mt-4 pt-4 border-t border-gray-100">
            <div class="text-gray-400 text-sm mb-2">项目概况全文</div>
            <div class="text-gray-700 text-sm leading-relaxed whitespace-pre-wrap bg-gray-50 rounded-lg p-4">${a.summary}</div>
          </div>

                    <!-- 商机管理 -->
          <div class="mt-6 pt-5 pb-4 border-t border-gray-100">
            <div class="text-gray-500 text-sm font-medium mb-3">🎯 商机管理</div>
            <div class="grid grid-cols-3 gap-x-2 gap-y-4 text-sm">
              <div class="px-3">                <label class="text-gray-500 text-sm mb-2 block">是否有效商机（有无信息化）</label>
                <select data-opp-field="isValidOpportunity" ${disabledAttr} class="w-full h-10 px-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-blue-400 bg-white">
                  <option value="">请选择</option>
                  <option value="是" ${a.isValidOpportunity === '是' ? 'selected' : ''}>是</option>
                  <option value="否" ${a.isValidOpportunity === '否' ? 'selected' : ''}>否</option>
                </select>
              </div>
              <div class="px-3">                <label class="text-gray-500 text-sm mb-2 block">是否有运营商参与</label>
                <select data-opp-field="hasOperatorInvolvement" ${disabledAttr} class="w-full h-10 px-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-blue-400 bg-white">
                  <option value="">请选择</option>
                  <option value="是" ${a.hasOperatorInvolvement === '是' ? 'selected' : ''}>是</option>
                  <option value="否" ${a.hasOperatorInvolvement === '否' ? 'selected' : ''}>否</option>
                </select>
              </div>
              <div class="px-3">                <label class="text-gray-500 text-sm mb-2 block">商机编码</label>
                <input data-opp-field="opportunityCode" ${disabledAttr} value="${a.opportunityCode || ''}" class="w-full h-10 px-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-blue-400" placeholder="由用户自由填写">
              </div>
              <div class="col-span-3 px-3">                <label class="text-gray-500 text-sm mb-2 block">商机了解情况</label>
                <textarea data-opp-field="opportunityStatus" ${disabledAttr} rows="4" class="w-full px-3 py-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-blue-400 resize-none h-28" placeholder="由用户自由填写"></textarea>
              </div>
              <div class="px-3">                <label class="text-gray-500 text-sm mb-2 block">是否应标</label>
                <select data-opp-field="willBid" ${disabledAttr} class="w-full h-10 px-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-blue-400 bg-white">
                  <option value="">请选择</option>
                  <option value="准备应标" ${a.willBid === '准备应标' ? 'selected' : ''}>准备应标</option>
                  <option value="已经应标" ${a.willBid === '已经应标' ? 'selected' : ''}>已经应标</option>
                  <option value="弃标" ${a.willBid === '弃标' ? 'selected' : ''}>弃标</option>
                </select>
              </div>
              <div class="px-3">                <label class="text-gray-500 text-sm mb-2 block">挂树选择</label>
                <select data-opp-field="treePlacement" ${disabledAttr} class="w-full h-10 px-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-blue-400 bg-white">
                  <option value="">请选择</option>
                </select>
              </div>
            </div>

          </div>
        </div>
      </div>

      <!-- 进度记录 -->
      <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <h3 class="font-semibold text-gray-900 mb-4">📋 进度记录</h3>
        <div class="space-y-3">
          ${(a.progressRecords || []).map(r => `
            <div class="flex items-start gap-3 p-3 bg-gray-50 rounded-lg">
              <div class="w-2 h-2 mt-1.5 rounded-full bg-blue-500 flex-shrink-0"></div>
              <div class="flex-1">
                <div class="flex items-center gap-2 text-sm">
                  <span class="font-medium text-gray-800">${r.progress}</span>
                  <span class="text-gray-400">·</span>
                  <span class="text-gray-500">${r.follower}</span>
                  <span class="text-gray-400 ml-auto text-xs">${r.followDate}</span>
                </div>
                <div class="text-gray-600 text-sm mt-1">${r.note}</div>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    </div>
  `;
}

// ---- 任务提醒 ----
// 任务提醒页的"有效提醒"过滤：排除已分配 + 按区县筛选
function getFilteredReminders() {
  const user = state.currentUser;
  return state.reminders.filter(r => {
    const ann = state.announcements.find(a => a.id === r.targetId);
    // 已确认的公告 → 不再显示提醒
    if (ann && ann.progress === '已确认') return false;
    // 权限过滤：只看分配给当前登录人的
    if (user && r.annCurrentHandler !== user.name) return false;
    // 进度过滤
    if (r.type === 'admin-assign') {
      if (!(ann && ann.progress === '待分配')) return false;
    }
    if (r.type === 'sales-follow') {
      if (!(ann && ann.progress === '已分配')) return false;
    }
    // 区县过滤
    if (state.reminderDistrictFilter && r.district !== state.reminderDistrictFilter) return false;
    return true;
  });
}

function renderReminders() {
  const liveReminders = getFilteredReminders();

  const urgent = liveReminders.filter(r => r.level === 'urgent');
  const warn = liveReminders.filter(r => r.level === 'warn');
  const info = liveReminders.filter(r => r.level === 'info');

  // 翻页（和招标公告页共享 state.pageSize / state.currentPage）
  const total = liveReminders.length;
  const pageSize = state.pageSize === 0 ? total : state.pageSize;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(state.currentPage, totalPages);
  const startIdx = (currentPage - 1) * pageSize;
  const pageData = state.pageSize === 0 ? liveReminders : liveReminders.slice(startIdx, startIdx + pageSize);

  // 页码按钮
  let pageButtons = [];
  if (totalPages <= 7) {
    for (let i = 1; i <= totalPages; i++) pageButtons.push(i);
  } else {
    pageButtons.push(1);
    let s = Math.max(2, currentPage - 1);
    let e = Math.min(totalPages - 1, currentPage + 1);
    if (s > 2) pageButtons.push('...');
    for (let i = s; i <= e; i++) pageButtons.push(i);
    if (e < totalPages - 1) pageButtons.push('...');
    pageButtons.push(totalPages);
  }

  const allOnPageIds = pageData.map(r => r.id);
  const selectedCount = [...state.selectedReminderIds].filter(id => allOnPageIds.includes(id)).length;
  const allCheckedOnPage = allOnPageIds.length > 0 && allOnPageIds.every(id => state.selectedReminderIds.has(id));
  const someCheckedOnPage = selectedCount > 0 && !allCheckedOnPage;

  return `
    <!-- 需求1：级别卡片暂时注释掉，后面需要再启用
    <div class="grid grid-cols-3 gap-4 mb-6">
      <div class="bg-white rounded-xl border border-gray-100 p-5">
        <div class="text-xs text-gray-500 mb-1">紧急</div>
        <div class="text-2xl font-bold text-red-600">${urgent.length}</div>
        <div class="text-xs text-gray-400 mt-1">超时未处理 / 即将到期</div>
      </div>
      <div class="bg-white rounded-xl border border-gray-100 p-5">
        <div class="text-xs text-gray-500 mb-1">关注</div>
        <div class="text-2xl font-bold text-orange-500">${warn.length}</div>
        <div class="text-xs text-gray-400 mt-1">3天内需跟进</div>
      </div>
      <div class="bg-white rounded-xl border border-gray-100 p-5">
        <div class="text-xs text-gray-500 mb-1">一般</div>
        <div class="text-2xl font-bold text-blue-500">${info.length}</div>
        <div class="text-xs text-gray-400 mt-1">按计划跟进</div>
      </div>
    </div>
    -->

    <!-- 区县筛选 + 批量操作栏 -->
    <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-3 mb-3 flex items-center gap-3 flex-wrap">
      <!-- 区县筛选 -->
      <div class="flex items-center gap-2">
        <span class="text-xs text-gray-500">区县筛选</span>
        <select id="reminder-district-filter" class="h-8 px-2 border border-gray-200 rounded text-sm focus:outline-none focus:border-blue-400 min-w-[110px]">
          <option value="">全部区县</option>
          ${[...new Set(state.announcements.map(a => a.district))].sort().map(d => `<option value="${d}" ${state.reminderDistrictFilter===d?'selected':''}>${d}</option>`).join('')}
        </select>
        ${state.reminderDistrictFilter ? `<button id="reminder-district-clear" class="text-xs text-blue-500 hover:underline">清除</button>` : ''}
      </div>
      
      <div class="h-5 w-px bg-gray-200"></div>
      
      <div class="text-sm text-gray-500 flex-1">
        ${selectedCount > 0
          ? `已选中 <span class="font-semibold text-blue-600">${selectedCount}</span> 条`
          : '点击左侧复选框选择要批量分配的提醒'}
      </div>
      <button id="reminder-clear-selection"
              class="px-3 py-1.5 text-xs text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
              ${selectedCount === 0 ? 'disabled' : ''}>
        清除选择
      </button>
      ${state.currentUser && state.currentUser.group === '集团客户部'
              ? `<button id="reminder-batch-assign"
                  class="px-4 py-1.5 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
                  ${selectedCount === 0 ? 'disabled' : ''}>
                  📋 批量分配（${selectedCount}）
                </button>`
              : `<button id="reminder-batch-assign" disabled title="仅集团客户部可批量分配"
                  class="px-4 py-1.5 text-xs bg-gray-300 text-white rounded-lg cursor-not-allowed">
                  📋 批量分配（${selectedCount}）
                </button>`}
    </div>

    <!-- 任务提醒表格（横拉 + 翻页，和招标公告页同结构） -->
    <div class="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden" style="width:100%">
      <div class="scrollbar-thin" style="border-radius:inherit;overflow-x:auto">
        <div style="width:1150px;min-width:1150px;box-sizing:content-box">
          <table class="text-sm border-separate" style="width:100%;border-spacing:0">
            <thead class="text-gray-500 text-xs">
              <tr>
                <th class="px-2 py-3 text-center font-medium sticky left-0 z-20" style="background:#f9fafb;width:44px">
                  <input type="checkbox" id="reminderSelectAll"
                         class="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                         ${allCheckedOnPage ? 'checked' : ''}
                         ${someCheckedOnPage ? 'data-indeterminate="1"' : ''}>
                </th>
                <!-- 需求1：级别列暂时注释 <th class="px-3 py-3 text-left font-medium sticky left-0 z-10" style="background:#f9fafb;width:70px">级别</th> -->
                <th class="px-3 py-3 text-left font-medium" style="background:#f9fafb;width:90px">任务类型</th>
                <th class="px-3 py-3 text-left font-medium" style="background:#f9fafb;width:320px">公告标题 / 提醒内容</th>
                <th class="px-3 py-3 text-left font-medium" style="background:#f9fafb;width:90px">区县</th>
                <th class="px-3 py-3 text-left font-medium" style="background:#f9fafb;width:80px">当前进度</th>
                <th class="px-3 py-3 text-left font-medium" style="background:#f9fafb;width:80px">处理人</th>
                <th class="px-3 py-3 text-left font-medium" style="background:#f9fafb;width:100px">时间</th>
                <th class="px-4 py-3 text-center font-medium sticky right-0 z-10" style="background:#f9fafb;width:150px">操作</th>
              </tr>
            </thead>
            <tbody>
              ${pageData.length === 0 ? `
                <tr><td colspan="8" class="py-16 text-center text-gray-400">暂无任务提醒</td></tr>
              ` : pageData.map(r => `
                <tr class="ann-row border-t border-gray-50 hover:bg-gray-50 ${state.selectedReminderIds.has(r.id) ? 'bg-blue-50/40' : ''}">
                  <td class="px-2 py-3 text-center sticky left-0 ann-row-first" style="background:#fff;width:44px">
                    <input type="checkbox"
                           class="reminder-row-check w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                           data-id="${r.id}"
                           ${state.selectedReminderIds.has(r.id) ? 'checked' : ''}>
                  </td>
                  <!-- 需求1：级别列暂时注释
                  <td class="px-3 py-3 sticky left-0 ann-row-first" style="background:#fff;width:70px">
                    ${r.level === 'urgent' ? '<span class="tag tag-red">紧急</span>' : r.level === 'warn' ? '<span class="tag tag-yellow">关注</span>' : '<span class="tag tag-blue">一般</span>'}
                  </td>
                  -->
                  <td class="px-3 py-3 text-gray-600" style="width:90px">${r.label}</td>
                  <td class="px-3 py-3" style="width:320px">
                    <div class="font-medium text-gray-800 max-w-[400px] truncate cursor-pointer hover:text-blue-600" title="${r.annTitle || r.title}" data-detail="${r.targetId}">${r.annTitle || r.title}</div>
                    <div class="text-xs text-gray-400 mt-0.5">${r.title}</div>
                  </td>
                  <td class="px-3 py-3" style="width:90px">${r.district ? `<span class="tag tag-blue">${r.district}</span>` : '<span class="text-gray-300">-</span>'}</td>
                  <td class="px-3 py-3" style="width:80px">${renderProgressTag(r.annProgress || '待分配')}</td>
                  <td class="px-3 py-3 text-gray-700 whitespace-nowrap" style="width:80px">${r.annCurrentHandler || '-'}</td>
                  <td class="px-3 py-3 text-gray-500 whitespace-nowrap" style="width:100px">${r.time}</td>
                  <td class="px-4 py-3 text-center whitespace-nowrap sticky right-0 ann-row-last" style="background:#fff;width:150px">
                    <button class="text-blue-600 hover:underline text-xs mr-2" data-detail="${r.targetId}">查看公告</button>
                    ${r.type === 'admin-assign' || r.annProgress === '待分配' ?
                      (state.currentUser && state.currentUser.group === '集团客户部'
                        ? `<button class="text-blue-600 hover:underline text-xs" data-assign="${r.targetId}">分配</button>`
                        : `<button class="text-gray-300 text-xs cursor-not-allowed" disabled title="仅集团客户部可分配">分配</button>`)
                      : ''}
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- 分页 -->
    <div class="flex items-center justify-between mt-4 text-sm text-gray-500">
      <div class="flex items-center gap-3">
        <span>共 <span class="font-semibold text-gray-700">${total}</span> 条</span>
        <span class="text-gray-300">|</span>
        <span>
          每页
          <select class="h-7 px-2 border border-gray-200 rounded text-sm mx-1" data-page-size>
            <option value="10" ${state.pageSize===10?'selected':''}>10</option>
            <option value="50" ${state.pageSize===50?'selected':''}>50</option>
            <option value="100" ${state.pageSize===100?'selected':''}>100</option>
            <option value="0" ${state.pageSize===0?'selected':''}>全部</option>
          </select>
          条
        </span>
        <span class="text-gray-300">|</span>
        <span>第 ${total === 0 ? 0 : startIdx + 1} - ${Math.min(startIdx + pageSize, total)} 条</span>
      </div>
      <div class="flex items-center gap-1.5">
        <button class="px-2.5 py-1 border rounded text-sm border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                data-page-btn="prev" ${currentPage===1?'disabled':''}>← 上一页</button>
        ${pageButtons.map(b => b === '...'
          ? `<span class="px-2 text-gray-400">…</span>`
          : `<button class="min-w-[32px] px-2 py-1 border rounded text-sm ${b===currentPage?'bg-blue-600 text-white border-blue-600':'border-gray-200 text-gray-600 hover:bg-gray-50'}" 
                     data-page-btn="${b}">${b}</button>`
        ).join('')}
        <button class="px-2.5 py-1 border rounded text-sm border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                data-page-btn="next" ${currentPage===totalPages?'disabled':''}>下一页 →</button>
      </div>
    </div>
  `;
}

function patchReminderCheckboxIndeterminate() {
  const box = document.getElementById('reminderSelectAll');
  if (!box) return;
  if (box.dataset.indeterminate === '1') box.indeterminate = true;
  else box.indeterminate = false;
}

// ---- 团队管理 ----
function renderTeam() {
  return `
    <div class="flex justify-between items-center mb-4">
      <div class="text-sm text-gray-500">共 ${TEAM_GROUPS.length} 个小组</div>
      <button class="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700" data-add-group>＋ 新增小组</button>
    </div>
    
    <div class="grid grid-cols-2 gap-4">
      ${TEAM_GROUPS.map(g => `
        <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-5 group-card" data-group-id="${g.id}">
          <div class="flex items-start justify-between mb-4">
            <div class="flex-1">
              <h3 class="font-semibold text-gray-900 text-lg">${g.name}</h3>
              <div class="text-xs text-gray-400 mt-1">区域：${g.region} · 创建于 ${g.createdAt}</div>
            </div>
            <div class="flex items-center gap-2">
              <button class="text-xs text-blue-600 hover:text-blue-800 px-2 py-1 border border-blue-200 rounded hover:bg-blue-50" data-edit-group="${g.id}">✎ 修改</button>
              <span class="tag tag-blue">${g.admin} +${g.members.length}人</span>
            </div>
          </div>
          
          <div class="space-y-3">
            <div class="flex items-center gap-3 p-3 bg-orange-50 rounded-lg">
              <div class="w-8 h-8 bg-orange-500 rounded-full flex items-center justify-center text-white text-xs font-semibold">${g.admin[0]}</div>
              <div class="flex-1">
                <div class="text-sm font-medium text-gray-800">${g.admin}</div>
                <div class="text-xs text-gray-500 mt-0.5">
                  <span class="inline-flex items-center gap-1 mr-3">📞 ${g.adminContact}</span>
                  <span class="inline-flex items-center gap-1">👤 ${g.adminAccount}</span>
                </div>
              </div>
              <span class="tag tag-yellow">负责人</span>
            </div>
            
            ${g.members.length > 0 ? g.members.map((m, i) => `
              <div class="flex items-center gap-3 p-3 hover:bg-gray-50 rounded-lg">
                <div class="w-8 h-8 bg-blue-500 rounded-full flex items-center justify-center text-white text-xs font-semibold">${m[0]}</div>
                <div class="flex-1">
                  <div class="text-sm font-medium text-gray-800">${m}</div>
              <div class="text-xs text-gray-500">
                <span>📞 ${g.memberContacts[i] || '—'}</span>
                <span class="mx-2">·</span>
                <span>👤 ${g.memberPinyin[i] || '—'}</span>
              </div>
                </div>
              </div>
            `).join('') : `<div class="text-xs text-gray-400 text-center py-2">暂无团队成员，点击修改添加</div>`}
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

// ---- 修改小组弹窗 ----
function renderEditGroupModal() {
  const g = TEAM_GROUPS.find(x => x.id === state.editGroupId);
  if (!g) return '';
  return `
    <div class="fixed inset-0 z-50 flex items-center justify-center modal-bg fade-in" data-close-modal>
      <div class="bg-white rounded-xl w-[560px] max-h-[80vh] p-6 shadow-xl flex flex-col" data-stop>
        <h3 class="font-semibold text-gray-900 text-lg mb-4">修改小组：${g.name}</h3>
        
        <div class="flex-1 overflow-auto space-y-4 scrollbar-thin pr-1">
          <!-- 基本信息 -->
          <div class="bg-gray-50 rounded-lg p-4 space-y-3">
            <div class="text-xs text-gray-500 font-medium uppercase tracking-wide">基本信息</div>
            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="text-xs text-gray-500 mb-1 block">小组名称</label>
                <input id="edit-name" value="${g.name}" class="w-full h-9 px-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-blue-400">
              </div>
              <div>
                <label class="text-xs text-gray-500 mb-1 block">所属区域</label>
                <input id="edit-region" value="${g.region}" class="w-full h-9 px-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-blue-400">
              </div>
            </div>
          </div>
          
          <!-- 负责人信息 -->
          <div class="bg-orange-50 rounded-lg p-4 space-y-3">
            <div class="text-xs text-orange-700 font-medium uppercase tracking-wide">负责人</div>
            <div class="grid grid-cols-3 gap-3">
              <div>
                <label class="text-xs text-gray-500 mb-1 block">姓名</label>
                <input id="edit-admin" value="${g.admin}" class="w-full h-9 px-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-blue-400">
              </div>
              <div>
                <label class="text-xs text-gray-500 mb-1 block">联系方式</label>
                <input id="edit-admin-contact" value="${g.adminContact}" class="w-full h-9 px-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-blue-400">
              </div>
              <div>
                <label class="text-xs text-gray-500 mb-1 block">账号</label>
                <input id="edit-admin-account" value="${g.adminAccount}" class="w-full h-9 px-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-blue-400">
              </div>
            </div>
          </div>
          
          <!-- 团队成员 -->
          <div class="bg-gray-50 rounded-lg p-4 space-y-3">
            <div class="flex items-center justify-between">
              <div class="text-xs text-gray-500 font-medium uppercase tracking-wide">团队成员（业务员）</div>
              <button class="text-xs text-blue-600 hover:text-blue-800" data-add-member-line>＋ 加一行</button>
            </div>
            <div id="edit-members" class="space-y-2">
              ${g.members.length > 0 ? g.members.map((m, i) => `
                <div class="flex items-center gap-2 member-row" data-idx="${i}">
                  <div class="w-7 h-7 bg-blue-500 rounded-full flex items-center justify-center text-white text-xs font-semibold flex-shrink-0">${m[0]}</div>
                  <input value="${m}" class="member-name flex-1 min-w-0 h-9 px-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-blue-400" placeholder="姓名">
                  <input value="${g.memberContacts[i] || ''}" class="member-contact w-[140px] h-9 px-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-blue-400" placeholder="联系方式">
                  <input value="${g.memberPinyin[i] || ''}" class="member-pinyin w-[130px] h-9 px-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-blue-400" placeholder="账号">
                  <button class="text-red-500 hover:text-red-700 text-sm px-2 remove-member flex-shrink-0" title="删除">✕</button>
                </div>
              `).join('') : `
                <div class="text-xs text-gray-400 text-center py-3 border border-dashed border-gray-200 rounded-lg">暂无成员，点击上方「＋ 加一行」添加</div>
              `}
            </div>
          </div>
        </div>
        
        <div class="flex justify-end gap-2 mt-5 pt-4 border-t border-gray-100">
          <button class="px-4 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50" data-close-modal>取消</button>
          <button class="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700" data-save-group>保存</button>
        </div>
      </div>
    </div>
  `;
}

// ---- 定时任务 ----

// ---- 数据来源管理 ----
function renderSources() {
  const sources = SOURCES_DATA;
  const enabled = sources.filter(s => s.enabled);
  const disabled = sources.filter(s => !s.enabled);
  const implemented = ['czggzy', 'ccgp', 'gdgpo'];
  const implCount = sources.filter(s => s.enabled && implemented.includes(s.sourceCode)).length;
  const genericCount = enabled.filter(s => s.sourceCode === 'generic').length;

  return `
    <div class="space-y-4">
      <!-- 概览卡 -->
      <div class="grid grid-cols-4 gap-4">
        <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
          <div class="text-xs text-gray-400 mb-1">总登记网站</div>
          <div class="text-2xl font-bold text-gray-900">${sources.length}</div>
        </div>
        <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
          <div class="text-xs text-gray-400 mb-1">启用中</div>
          <div class="text-2xl font-bold text-blue-600">${enabled.length}</div>
        </div>
        <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
          <div class="text-xs text-gray-400 mb-1">已实现采集器</div>
          <div class="text-2xl font-bold text-green-600">${implCount}</div>
        </div>
        <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
          <div class="text-xs text-gray-400 mb-1">待适配（generic）</div>
          <div class="text-2xl font-bold text-orange-500">${genericCount}</div>
        </div>
      </div>

      <!-- 表格 -->
      <div class="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div class="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <div>
            <h3 class="font-semibold text-gray-900">📋 数据源注册表</h3>
            <p class="text-xs text-gray-400 mt-1">定时任务（collect.py --source all）会基于此表中「启用」项自动采集；增删改不需要改代码</p>
          </div>
          <button class="px-3 py-1.5 text-xs text-blue-600 border border-blue-200 rounded-lg hover:bg-blue-50" id="btn-add-source">
            + 新增数据源
          </button>
        </div>

        <table class="w-full text-sm">
          <thead class="bg-gray-50 text-gray-500 text-xs">
            <tr>
              <th class="px-4 py-3 text-left font-medium w-10">#</th>
              <th class="px-4 py-3 text-left font-medium">网站名称</th>
              <th class="px-4 py-3 text-left font-medium">网址</th>
              <th class="px-4 py-3 text-left font-medium w-24">sourceCode</th>
              <th class="px-4 py-3 text-center font-medium w-20">适配器</th>
              <th class="px-4 py-3 text-center font-medium w-16">启用</th>
              <th class="px-4 py-3 text-center font-medium w-28">操作</th>
            </tr>
          </thead>
          <tbody>
            ${sources.map((s, i) => {
              const isImpl = implemented.includes(s.sourceCode);
              const statusDot = s.enabled
                ? (isImpl ? '<span class="tag tag-green">已实现</span>' : '<span class="tag tag-orange">待适配</span>')
                : '<span class="tag tag-gray">已停用</span>';
              return `
              <tr class="ann-row border-b border-gray-50">
                <td class="px-4 py-3 text-gray-400 text-xs">${i + 1}</td>
                <td class="px-4 py-3 font-medium text-gray-800">${s.name}</td>
                <td class="px-4 py-3 max-w-[280px]">
                  <a href="${s.url}" target="_blank" class="text-blue-600 hover:underline truncate block" title="${s.url}">${s.url}</a>
                </td>
                <td class="px-4 py-3">
                  <code class="text-xs bg-gray-100 px-1.5 py-0.5 rounded text-gray-600">${s.sourceCode}</code>
                </td>
                <td class="px-4 py-3 text-center">${statusDot}</td>
                <td class="px-4 py-3 text-center">
                  <label class="inline-flex items-center cursor-pointer">
                    <input type="checkbox" ${s.enabled ? 'checked' : ''} class="source-toggle w-4 h-4 text-blue-600" data-idx="${i}">
                  </label>
                </td>
                <td class="px-4 py-3 text-center">
                  <button class="text-xs text-gray-500 hover:text-blue-600 mr-2 source-edit" data-idx="${i}">编辑</button>
                  <button class="text-xs text-gray-500 hover:text-red-600 source-del" data-idx="${i}">删除</button>
                </td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>

      <!-- 说明卡片 -->
      <div class="bg-orange-50 border border-orange-100 rounded-xl p-4 text-xs text-orange-700 leading-relaxed">
        <div class="font-semibold mb-1">💡 关于 generic 待适配源</div>
        <div>列表中大部分网站标记为 generic，表示暂无专属采集适配器。定时任务执行时会自动跳过 generic 源（仅采集 czggzy / ccgp / gdgpo 已实现的三个）。后续新增一个网站若属于这三类，改 sourceCode 即可自动纳入；完全新类型的则在 SOURCE_DISPATCH 里注册实现函数。</div>
      </div>
    </div>
  `;
}



function renderKwDeleteModal() {
  return `
    <div class="fixed inset-0 z-50 flex items-center justify-center modal-bg fade-in" data-close-modal>
      <div class="bg-white rounded-xl w-[520px] p-6 shadow-xl" data-stop>
        <div class="flex items-center justify-between mb-4">
          <h3 class="font-semibold text-gray-900">🗑️ 选择要删除的关键词</h3>
          <button class="text-gray-400 hover:text-gray-600" data-close-modal>×</button>
        </div>

        <!-- 操作条 -->
        <div class="flex items-center gap-2 mb-3 text-xs">
          <button id="kw-del-all" class="px-2 py-1 border border-gray-200 rounded hover:bg-gray-50">全选</button>
          <button id="kw-del-none" class="px-2 py-1 border border-gray-200 rounded hover:bg-gray-50">全不选</button>
          <button id="kw-del-invert" class="px-2 py-1 border border-gray-200 rounded hover:bg-gray-50">反选</button>
          <span class="ml-auto text-gray-400">已选 <span id="kw-del-count" class="text-red-500 font-medium">0</span> 个</span>
        </div>

        <!-- 选择列表：横向 tag 风格 -->
        <div id="kw-del-list" class="max-h-80 overflow-y-auto scrollbar-thin border border-gray-100 rounded-lg p-4">
          <div class="flex flex-wrap gap-2">
            ${SCHEDULE_CONFIG.keywordList.map((k,i) => `
              <label class="kw-del-pill cursor-pointer">
                <input type="checkbox" class="kw-del-cb" data-kw="${i}">
                <span class="kw-del-label inline-block px-3 py-1.5 rounded-full text-xs font-medium bg-purple-100 text-purple-700 border border-purple-200 hover:bg-purple-200 transition-colors">
                  ${k}
                </span>
              </label>
            `).join('')}
          </div>
        </div>

        <div class="flex justify-end gap-2 mt-5">
          <button class="px-4 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50" data-close-modal>取消</button>
          <button id="kw-del-confirm" class="px-4 py-2 bg-red-500 text-white rounded-lg text-sm hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed" disabled>
            确认删除
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderSchedule() {
  const successSites = state.siteResults.filter(r => r.ok);
  const failSites = state.siteResults.filter(r => !r.ok);
  const siteOk = successSites.length;
  const total = state.siteResults.length;
  const successRate = total > 0 ? (siteOk / total * 100).toFixed(1) : 0;
  const totalMatched = successSites.reduce((s, r) => s + r.matched_links, 0);
  const totalFound = successSites.reduce((s, r) => s + r.found_links, 0);
  
  // 按匹配数排序 Top 站点
  const topSites = [...successSites].sort((a, b) => b.matched_links - a.matched_links).slice(0, 10);
  
  const lastCrawlTime = state.siteResults.length > 0 
    ? new Date().toLocaleString('zh-CN')
    : '—';

  return `
    <div class="grid grid-cols-4 gap-4 mb-6">
      <div class="bg-white rounded-xl border border-gray-100 p-5">
        <div class="text-xs text-gray-500 mb-1">运行状态</div>
        <div class="flex items-center gap-2 mt-1">
          <div class="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
          <div class="font-semibold text-green-600">${SCHEDULE_CONFIG.crawlStatus}</div>
        </div>
        <div class="text-xs text-gray-400 mt-1">上次运行：${lastCrawlTime}</div>
      </div>
      <div class="bg-white rounded-xl border border-gray-100 p-5">
        <div class="text-xs text-gray-500 mb-1">采集成功率</div>
        <div class="text-2xl font-bold text-gray-800">${successRate}<span class="text-sm text-gray-400 font-normal">%</span></div>
        <div class="text-xs text-gray-400 mt-1">成功 ${siteOk}/${total} 个网站</div>
      </div>
      <div class="bg-white rounded-xl border border-gray-100 p-5">
        <div class="text-xs text-gray-500 mb-1">公告总数</div>
        <div class="text-2xl font-bold text-blue-600">${state.announcements.length}</div>
        <div class="text-xs text-gray-400 mt-1">近 1 个月（真实采集 ${totalMatched} 条）</div>
      </div>
      <div class="bg-white rounded-xl border border-gray-100 p-5">
        <div class="text-xs text-gray-500 mb-1">采集间隔</div>
        <div class="text-2xl font-bold text-gray-800">2<span class="text-sm text-gray-400 font-normal">小时</span></div>
        <div class="text-xs text-gray-400 mt-1">定时任务1</div>
      </div>
    </div>

    <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-6 mb-4">
      <div class="flex items-center justify-between mb-4">
        <h3 class="font-semibold text-gray-900">🔑 定时任务1 - 关键词设定</h3>
        <div class="flex items-center gap-2">
          <span class="text-xs text-gray-400">共 ${SCHEDULE_CONFIG.keywordList.length} 个</span>
          <button id="kw-delete-open" class="px-3 py-1 text-xs border border-gray-200 text-gray-600 rounded hover:bg-red-50 hover:border-red-200 hover:text-red-500 transition-colors">批量删除</button>
        </div>
      </div>
      <div class="flex flex-wrap gap-2 items-center">
        ${SCHEDULE_CONFIG.keywordList.map((k, idx) => `
          <span class="px-3 py-1.5 rounded-full bg-purple-100 text-purple-700 text-xs font-medium border border-purple-200 hover:bg-purple-200 transition-colors">${k}</span>
        `).join('')}
        <button class="inline-flex items-center gap-1 px-3 py-1.5 rounded-full border border-dashed border-gray-300 text-gray-400 text-xs hover:border-blue-400 hover:text-blue-500 transition-colors" id="kw-add-btn">
          <span class="text-sm leading-none">+</span> 新增
        </button>
      </div>
    </div>

    <div class="grid grid-cols-2 gap-4 mb-4">
      <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <h3 class="font-semibold text-gray-900 mb-4">🏆 TOP10 采集量（匹配关键词）</h3>
        <div class="space-y-2 text-sm">
          ${topSites.map((r, i) => `
            <div class="flex items-center justify-between py-1.5 border-b border-gray-50">
              <div class="flex items-center gap-2">
                <span class="w-5 h-5 rounded-full ${i<3?'bg-orange-100 text-orange-600':'bg-gray-100 text-gray-500'} text-xs flex items-center justify-center font-semibold">${i+1}</span>
                <span class="text-gray-700">${r.name}</span>
              </div>
              <div class="flex items-center gap-3">
                <span class="text-xs text-gray-400">+${r.matched_links} 条</span>
                <span class="text-xs text-gray-400">${r.latency_ms}ms</span>
              </div>
            </div>
          `).join('')}
        </div>
      </div>

      <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <h3 class="font-semibold text-gray-900 mb-4">💥 采集失败站点（${failSites.length}）</h3>
        ${failSites.length === 0 ? `
          <div class="text-center text-gray-400 py-8">🎉 全部网站采集成功</div>
        ` : `
          <div class="space-y-3">
            ${failSites.map(r => `
              <div class="p-3 bg-red-50 rounded-lg border border-red-100">
                <div class="flex items-center gap-2 text-sm">
                  <span class="text-red-500">❌</span>
                  <span class="font-medium text-gray-800">${r.name}</span>
                  <span class="ml-auto text-xs text-red-600 font-mono">${r.status_msg}</span>
                </div>
                <div class="text-xs text-red-500 mt-1.5 pl-5">
                  原因：${r.error_detail || '未知错误'}
                </div>
                <a href="${r.url}" target="_blank" class="text-xs text-gray-400 hover:text-blue-600 pl-5 mt-1 inline-block break-all">${r.url}</a>
              </div>
            `).join('')}
          </div>
        `}
      </div>
    </div>

    <div class="grid grid-cols-2 gap-4">
      <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <h3 class="font-semibold text-gray-900 mb-4">⏱ 任务调度配置</h3>
        <div class="space-y-4 text-sm">
          <div class="flex justify-between">
            <span class="text-gray-500">定时任务1（抓取）</span>
            <span class="text-gray-800">${SCHEDULE_CONFIG.crawlInterval}</span>
          </div>
          <div class="flex justify-between">
            <span class="text-gray-500">定时任务2（解析落库）</span>
            <span class="text-gray-800">抓取后自动执行</span>
          </div>
          <div class="flex justify-between">
            <span class="text-gray-500">任务提醒</span>
            <span class="text-gray-800">${SCHEDULE_CONFIG.reminderInterval}</span>
          </div>
          <div class="flex justify-between">
            <span class="text-gray-500">全站抓取 / 解析</span>
            <span class="text-gray-800">实际耗时 ${state.siteResults.reduce((s, r) => s + r.latency_ms, 0)}ms · 提取 ${totalFound} 条候选 · 命中关键词 ${totalMatched} 条</span>
          </div>
        </div>
        <button class="mt-6 w-full px-4 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50">手动触发一次抓取</button>
      </div>

      <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <h3 class="font-semibold text-gray-900 mb-4">📡 全部采集状态（${total} 个）</h3>
        <div class="space-y-1.5 text-sm max-h-72 overflow-auto scrollbar-thin">
          ${state.siteResults.map(r => `
            <div class="flex justify-between items-center py-1.5 ${r.ok ? 'border-b border-gray-50' : 'bg-red-50 rounded px-2 py-2 -mx-2'}">
              <div class="flex items-center gap-2">
                <span class="${r.ok ? 'text-green-600' : 'text-red-500'}">${r.ok ? '●' : '○'}</span>
                <span class="text-gray-700">${r.name}</span>
              </div>
              <div class="text-xs flex items-center gap-2">
                ${r.ok ? `<span class="text-gray-400">${r.latency_ms}ms</span>${r.matched_links > 0 ? `<span class="text-green-600 font-medium">+${r.matched_links}条</span>` : ''}` : `<span class="text-red-500">${r.status_msg}</span>`}
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    </div>
  `;
}

// ============ Modal ============
function renderAssignModal() {
  const ann = state.announcements.find(a => a.id === state.assignAnnId);
  if (!ann) return '';
  return `
    <div class="fixed inset-0 z-50 flex items-center justify-center modal-bg fade-in" data-close-modal>
      <div class="bg-white rounded-xl w-[480px] p-6 shadow-xl" data-stop>
        <h3 class="font-semibold text-gray-900 text-lg mb-1">任务分配</h3>
        <p class="text-sm text-gray-400 mb-5 truncate">${ann.projectName || ann.title}</p>
        
        <div class="space-y-4">
          <div>
            <label class="text-sm text-gray-600 mb-1 block">分配给区域小组</label>
            <select id="assign-group" class="w-full h-10 px-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-blue-400">
              <option value="">请选择小组</option>
              ${TEAM_GROUPS.filter(g => g.name !== "集团客户部").map(g => `<option value="${g.name}">${g.name}（${g.region}）</option>`).join('')}
            </select>
          </div>
          <div>
            <label class="text-sm text-gray-600 mb-1 block">接收人</label>
            <select id="assign-receiver" class="w-full h-10 px-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-blue-400">
              <option value="">请选择接收人</option>
            </select>
          </div>
          <div>
            <label class="text-sm text-gray-600 mb-1 block">备注（可选）</label>
            <textarea id="assign-note" rows="2" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-blue-400 resize-none" placeholder="分配说明..."></textarea>
          </div>
        </div>
        
        <div class="flex justify-end gap-2 mt-6">
          <button class="px-4 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50" data-close-modal>取消</button>
          <button class="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700" data-confirm-assign>确认分配</button>
        </div>
      </div>
    </div>
  `;
}



function renderBatchAssignModal() {
  const ids = Array.from(state.selectedAnnIds);
  if (ids.length === 0) return '';
  const anns = state.announcements.filter(a => ids.includes(a.id));
  return `
    <div class="fixed inset-0 z-50 flex items-center justify-center modal-bg fade-in" data-close-modal>
      <div class="bg-white rounded-xl w-[560px] p-6 shadow-xl" data-stop>
        <h3 class="font-semibold text-gray-900 text-lg mb-1">批量分配任务</h3>
        <p class="text-sm text-gray-400 mb-4">共选中 ${ids.length} 条公告</p>
        
        <div class="max-h-40 overflow-y-auto scrollbar-thin border border-gray-100 rounded-lg p-2 mb-5 bg-gray-50">
          ${anns.map(a => `<div class="text-xs text-gray-600 py-1 truncate">${a.projectName || a.title}</div>`).join('')}
        </div>

        <div class="space-y-4">
          <div>
            <label class="text-sm text-gray-600 mb-1 block">分配给区域小组</label>
            <select id="batch-assign-group" class="w-full h-10 px-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-blue-400">
              <option value="">请选择小组</option>
              ${TEAM_GROUPS.filter(g => g.name !== "集团客户部").map(g => `<option value="${g.name}">${g.name}（${g.region}）</option>`).join('')}
            </select>
          </div>
          <div>
            <label class="text-sm text-gray-600 mb-1 block">接收人</label>
            <select id="batch-assign-receiver" class="w-full h-10 px-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-blue-400">
              <option value="">请选择接收人</option>
            </select>
          </div>
          <div>
            <label class="text-sm text-gray-600 mb-1 block">备注（可选）</label>
            <textarea id="batch-assign-note" rows="2" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-blue-400 resize-none" placeholder="分配说明..."></textarea>
          </div>
        </div>
        
        <div class="flex justify-end gap-2 mt-6">
          <button class="px-4 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50" data-close-modal>取消</button>
          <button class="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700" data-confirm-batch-assign>确认批量分配</button>
        </div>
      </div>
    </div>
  `;
}

// ---- 任务提醒页批量分配弹窗 ----
function renderReminderBatchAssignModal() {
  const targetAnnIds = [...state.selectedReminderIds]
    .map(rid => state.reminders.find(r => r.id === rid))
    .filter(Boolean)
    .map(r => r.targetId);
  const annSet = new Set();
  const targetAnns = [];
  for (const id of targetAnnIds) {
    if (annSet.has(id)) continue;
    annSet.add(id);
    const a = state.announcements.find(x => x.id === id);
    if (a) targetAnns.push(a);
  }
  if (targetAnns.length === 0) return '';

  return `
    <div class="fixed inset-0 z-50 flex items-center justify-center modal-bg fade-in" data-close-modal>
      <div class="bg-white rounded-xl w-[620px] max-h-[80vh] p-6 shadow-xl flex flex-col" data-stop>
        <h3 class="font-semibold text-gray-900 text-lg mb-1">批量任务分配</h3>
        <p class="text-sm text-gray-400 mb-4">
          共选中 <span class="font-semibold text-blue-600">${targetAnns.length}</span> 条公告，统一分配给同一小组/接收人
        </p>

        <!-- 待分配清单 -->
        <div class="bg-gray-50 rounded-lg p-3 mb-4 max-h-[200px] overflow-auto scrollbar-thin">
          <div class="text-xs text-gray-500 font-medium mb-2">📋 待分配清单</div>
          <div class="space-y-1.5">
            ${targetAnns.map(a => `
              <div class="flex items-center gap-2 text-sm text-gray-700">
                <span class="text-gray-400 text-xs font-mono w-16">${a.district || '-'}</span>
                <span class="text-gray-400 text-xs w-16">${a.progress || '-'}</span>
                <span class="truncate flex-1" title="${a.title}">${a.title}</span>
              </div>
            `).join('')}
          </div>
        </div>

        <div class="space-y-4 flex-1">
          <div>
            <label class="text-sm text-gray-600 mb-1 block">分配给区域小组</label>
            <select id="reminder-batch-group" class="w-full h-10 px-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-blue-400">
              <option value="">请选择小组</option>
              ${TEAM_GROUPS.filter(g => g.name !== "集团客户部").map(g => `<option value="${g.name}">${g.name}（${g.region}）</option>`).join('')}
            </select>
          </div>
          <div>
            <label class="text-sm text-gray-600 mb-1 block">接收人</label>
            <select id="reminder-batch-receiver" class="w-full h-10 px-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-blue-400">
              <option value="">请选择接收人</option>
            </select>
          </div>
          <div>
            <label class="text-sm text-gray-600 mb-1 block">备注（可选）</label>
            <textarea id="reminder-batch-note" rows="2" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-blue-400 resize-none" placeholder="分配说明..."></textarea>
          </div>
        </div>

        <div class="flex justify-end gap-2 mt-5 pt-4 border-t border-gray-100">
          <button class="px-4 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50" data-close-modal>取消</button>
          <button class="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700" data-confirm-reminder-batch-assign>确认批量分配</button>
        </div>
      </div>
    </div>
  `;
}

function renderProgressModal() {
  const ann = state.announcements.find(a => a.id === state.progressAnnId);
  if (!ann) return '';
  return `
    <div class="fixed inset-0 z-50 flex items-center justify-center modal-bg fade-in" data-close-modal>
      <div class="bg-white rounded-xl w-[480px] p-6 shadow-xl" data-stop>
        <h3 class="font-semibold text-gray-900 text-lg mb-1">更新进度</h3>
        <p class="text-sm text-gray-400 mb-5 truncate">${ann.projectName || ann.title}</p>
        
        <div class="space-y-4">
          <div>
            <label class="text-sm text-gray-600 mb-1 block">当前进度</label>
            <select id="progress-select" class="w-full h-10 px-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-blue-400">
              ${PROGRESS_OPTIONS.map(p => `<option value="${p}" ${ann.progress===p?'selected':''}>${p}</option>`).join('')}
            </select>
          </div>
          <div>
            <label class="text-sm text-gray-600 mb-1 block">跟进说明</label>
            <textarea id="progress-note" rows="3" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-blue-400 resize-none" placeholder="本次跟进情况..."></textarea>
          </div>
        </div>
        
        <div class="flex justify-end gap-2 mt-6">
          <button class="px-4 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50" data-close-modal>取消</button>
          <button class="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700" data-confirm-progress>确认更新</button>
        </div>
      </div>
    </div>
  `;
}

// ============ 事件绑定 ============
// ============ 辅助：绑定成员行删除按钮 ============
function bindMemberRow(row) {
  const del = row.querySelector('.remove-member');
  if (del) del.onclick = () => { row.remove(); };
}

// ============ 事件绑定 ============
function bindEvents() {
  // 侧边栏切换
  document.querySelectorAll('.sidebar-item').forEach(el => {
    el.onclick = () => {
      state.page = el.dataset.page;
      state.currentPage = 1;
      state.detailId = null;
      state.modal = null;
      render();
    };
  });

  // 返回列表
  document.querySelectorAll('[data-back]').forEach(el => {
    el.onclick = () => { state.detailId = null; render(); };
  });

  // 筛选
  document.querySelectorAll('[data-filter]').forEach(el => {
    el.oninput = el.onchange = () => {
      state.selectedAnnIds.clear();  // 筛选变化 → 清空批量选择
      state.filters[el.dataset.filter] = el.value;
      applyFilters();
      render();
    };
  });

  // 查看详情
  document.querySelectorAll('[data-detail]').forEach(el => {
    el.onclick = () => { state.detailId = el.dataset.detail; render(); };
  });

  // 分配按钮
  document.querySelectorAll('[data-assign]').forEach(el => {
    el.onclick = () => {
      state.assignAnnId = el.dataset.assign;
      state.progressAnnId = null;
      state.modal = 'assign';
      render();
    };
  });

  // 进度按钮
  document.querySelectorAll('[data-progress]').forEach(el => {
    el.onclick = () => {
      state.progressAnnId = el.dataset.progress;
      state.assignAnnId = null;
      state.modal = 'progress';
      render();
    };
  });
  // ---- 批量选择 ----
  const selectAll = document.getElementById('annSelectAll');
  const rowChecks = document.querySelectorAll('.ann-row-check');
  const batchBar = document.getElementById('batchBar');
  const batchCount = document.getElementById('batchCount');
  const ids = Array.from(state.selectedAnnIds);
  rowChecks.forEach(cb => { if (ids.includes(cb.dataset.id)) cb.checked = true; });
  if (selectAll) {
    const visibleIds = Array.from(rowChecks).map(cb => cb.dataset.id);
    selectAll.checked = visibleIds.length > 0 && visibleIds.every(id => ids.includes(id));
    selectAll.onchange = (e) => {
      rowChecks.forEach(cb => {
        cb.checked = e.target.checked;
        if (e.target.checked) state.selectedAnnIds.add(cb.dataset.id);
        else state.selectedAnnIds.delete(cb.dataset.id);
      });
      updateBatchBar();
    };
  }
  rowChecks.forEach(cb => {
    cb.onchange = () => {
      if (cb.checked) state.selectedAnnIds.add(cb.dataset.id);
      else state.selectedAnnIds.delete(cb.dataset.id);
      // sync selectAll
      const allCb = document.getElementById('annSelectAll');
      if (allCb) {
        const visibleIds = Array.from(rowChecks).map(c => c.dataset.id);
        allCb.checked = visibleIds.length > 0 && visibleIds.every(id => state.selectedAnnIds.has(id));
      }
      updateBatchBar();
    };
  });
  const uBar = document.getElementById('batchBar');
  if (uBar) uBar.innerHTML = uBar.innerHTML.replace('已选 0 条', '已选 ' + state.selectedAnnIds.size + ' 条');
  if (state.selectedAnnIds.size > 0) {
    const bBar = document.getElementById('batchBar');
    if (bBar) bBar.style.display = 'flex';
  }
  const clearBtn = document.getElementById('batchClearBtn');
  if (clearBtn) clearBtn.onclick = () => { state.selectedAnnIds.clear(); render(); };
  const batchAssign = document.getElementById('batchAssignBtn');
  if (batchAssign) batchAssign.onclick = () => { state.modal = 'batch-assign'; render(); };

  // ---- 批量分配弹窗内小组->人员联动 ----
  const bGroup = document.getElementById('batch-assign-group');
  const bReceiver = document.getElementById('batch-assign-receiver');
  if (bGroup && bReceiver) {
    bGroup.onchange = () => {
      const g = TEAM_GROUPS.find(x => x.name === bGroup.value);
      bReceiver.innerHTML = g ? 
        `<option value="${g.admin}">${g.admin}（管理员）</option>` + 
        g.members.map(m => `<option value="${m}">${m}</option>`).join('') :
        '<option value="">请选择接收人</option>';
    };
  }
  // ---- 批量确认分配 ----
  const bConfirm = document.querySelectorAll('[data-confirm-batch-assign]');
  bConfirm.forEach(el => el.onclick = () => {
    const group = document.getElementById('batch-assign-group').value;
    const receiver = document.getElementById('batch-assign-receiver').value;
    if (!group || !receiver) { alert('请选择小组和接收人'); return; }
    state.selectedAnnIds.forEach(id => {
      const ann = state.announcements.find(a => a.id === id);
      if (ann) {
        ann.currentHandler = receiver;
        ann.progress = '已分配';
        ann.progressRecords = ann.progressRecords || [];
        ann.progressRecords.push({ progress: '已分配', follower: '管理员', followDate: new Date().toISOString().slice(0,10), note: `批量分配给 ${group} - ${receiver}` });
      }
    });
    alert('已批量分配 ' + state.selectedAnnIds.size + ' 条给 ' + receiver);
    state.selectedAnnIds.clear();
    state.modal = null;
    state.reminders = generateReminders(state.announcements);
    render();
  });

  // ---- 批量操作条更新函数 ----
  function updateBatchBar() {
    const bar = document.getElementById('batchBar');
    const cnt = document.getElementById('batchCount');
    if (!bar || !cnt) return;
    const n = state.selectedAnnIds.size;
    bar.style.display = n > 0 ? 'flex' : 'none';
    cnt.textContent = '已选 ' + n + ' 条';
  }
  // ---- 关键词管理 ----  });
  document.querySelectorAll('#kw-add-btn').forEach(el => {
    el.onclick = () => {
      const v = prompt('新增关键词（多个用顿号、空格或逗号分隔）');
      if (v && v.trim()) {
        const parts = v.split(/[、,，\s]+/).filter(x => x.trim());
        parts.forEach(p => {
          if (p && !SCHEDULE_CONFIG.keywordList.includes(p)) SCHEDULE_CONFIG.keywordList.push(p);
        });
        render();
      }
    };
  });
  // ---- 关键词批量删除弹窗 ----
  document.querySelectorAll('#kw-delete-open').forEach(el => {
    el.onclick = () => { state.modal = 'kw-delete'; render(); };
  });
  document.querySelectorAll('#kw-del-all').forEach(el => el.onclick = () => {
    document.querySelectorAll('.kw-del-cb').forEach(cb => cb.checked = true);
    updateKwDelCount();
  });
  document.querySelectorAll('#kw-del-none').forEach(el => el.onclick = () => {
    document.querySelectorAll('.kw-del-cb').forEach(cb => cb.checked = false);
    updateKwDelCount();
  });
  document.querySelectorAll('#kw-del-invert').forEach(el => el.onclick = () => {
    document.querySelectorAll('.kw-del-cb').forEach(cb => cb.checked = !cb.checked);
    updateKwDelCount();
  });
  document.querySelectorAll('.kw-del-cb').forEach(cb => {
    cb.onchange = updateKwDelCount;
  });
  function updateKwDelCount() {
    const n = document.querySelectorAll('.kw-del-cb:checked').length;
    const c = document.getElementById('kw-del-count');
    const btn = document.getElementById('kw-del-confirm');
    if (c) c.textContent = n;
    if (btn) btn.disabled = n === 0;
  }
  document.querySelectorAll('#kw-del-confirm').forEach(el => {
    el.onclick = () => {
      const cbs = [...document.querySelectorAll('.kw-del-cb:checked')];
      const idxs = cbs.map(c => parseInt(c.dataset.kw)).sort((a,b)=>b-a);
      if (idxs.length === 0) return;
      if (!confirm('确认删除选中的 ' + idxs.length + ' 个关键词？')) return;
      idxs.forEach(i => SCHEDULE_CONFIG.keywordList.splice(i, 1));
      state.modal = null;
      render();
    };
  });
  // ---- 数据源管理事件 ----
  document.querySelectorAll('.source-toggle').forEach(el => {
    el.onchange = () => {
      SOURCES_DATA[parseInt(el.dataset.idx)].enabled = el.checked;
      render();
    };
  });
  document.querySelectorAll('.source-edit').forEach(el => {
    el.onclick = () => {
      const i = parseInt(el.dataset.idx);
      const s = SOURCES_DATA[i];
      const name = prompt('网站名称', s.name);
      if (name === null) return;
      const url = prompt('网址', s.url);
      if (url === null) return;
      const code = prompt('sourceCode (czggzy / ccgp / gdgpo / generic)', s.sourceCode);
      if (code === null) return;
      const u = new URL(url);
      SOURCES_DATA[i] = {
        ...s, name: name.trim(), url: url.trim(),
        domain: u.netloc.toLowerCase(), sourceCode: (code.trim() || 'generic')
      };
      render();
    };
  });
  document.querySelectorAll('.source-del').forEach(el => {
    el.onclick = () => {
      if (!confirm('确认删除该数据源？此操作仅影响 Demo 内存显示，不会改动 sources.json。')) return;
      SOURCES_DATA.splice(parseInt(el.dataset.idx), 1);
      render();
    };
  });
  document.querySelectorAll('#btn-add-source').forEach(el => {
    el.onclick = () => {
      const name = prompt('网站名称');
      if (!name) return;
      const url = prompt('网址');
      if (!url) return;
      const code = prompt('sourceCode (czggzy / ccgp / gdgpo / generic)', 'generic') || 'generic';
      try {
        const u = new URL(url);
        SOURCES_DATA.push({
          name: name.trim(), url: url.trim(), domain: u.netloc.toLowerCase(),
          sourceCode: (code.trim() || 'generic'), enabled: true
        });
        render();
      } catch(e) { alert('网址格式错误'); }
    };
  });

  // 刷新
  document.querySelectorAll('#btn-refresh').forEach(el => {
    el.onclick = () => {
      alert('模拟手动触发抓取：已启动定时任务1（真实环境会抓取 49 个网站）');
    };
  });

  // 退出登录
  document.querySelectorAll('#btn-logout').forEach(el => {
    el.onclick = () => doLogout();
  });

  // 商机管理 · 信息已确认
  document.querySelectorAll('#btn-confirm-opp').forEach(el => {
    el.onclick = () => confirmOpportunity();
  });

  // 商机管理表单 · 字段变更同步到 ann 对象
  bindOpportunityEvents();

  // 任务提醒页区县筛选
  const remDistrictFilter = document.getElementById('reminder-district-filter');
  if (remDistrictFilter) {
    remDistrictFilter.onchange = () => {
      state.reminderDistrictFilter = remDistrictFilter.value;
      state.currentPage = 1;
      render();
    };
  }
  const remDistrictClear = document.getElementById('reminder-district-clear');
  if (remDistrictClear) {
    remDistrictClear.onclick = () => {
      state.reminderDistrictFilter = '';
      state.currentPage = 1;
      render();
    };
  }

  // 翻页 - page size 切换
  document.querySelectorAll('[data-page-size]').forEach(el => {
    el.onchange = () => {
      state.pageSize = parseInt(el.value);
      state.currentPage = 1;
      render();
    };
  });

  // 翻页 - 页码按钮
  document.querySelectorAll('[data-page-btn]').forEach(el => {
    el.onclick = () => {
      const total = state.page === 'reminders' ? state.reminders.length : state.filteredList.length;
      const pageSize = state.pageSize === 0 ? total : state.pageSize;
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      const action = el.dataset.pageBtn;
      
      if (action === 'prev') {
        state.currentPage = Math.max(1, state.currentPage - 1);
      } else if (action === 'next') {
        state.currentPage = Math.min(totalPages, state.currentPage + 1);
      } else {
        state.currentPage = parseInt(action);
      }
      render();
    };
  });

  // 新增小组
  document.querySelectorAll('[data-add-group]').forEach(el => {
    el.onclick = () => {
      alert('Demo 模式：新增小组功能略过，数据写死在 data.js 中');
    };
  });

  // 打开修改小组弹窗
  document.querySelectorAll('[data-edit-group]').forEach(el => {
    el.onclick = () => {
      state.editGroupId = parseInt(el.dataset.editGroup);
      state.modal = 'edit-group';
      render();
    };
  });

  // 修改弹窗内：加一行成员
  const addMemberBtn = document.querySelector('[data-add-member-line]');
  if (addMemberBtn) {
    addMemberBtn.onclick = () => {
      const box = document.getElementById('edit-members');
      if (!box) return;
      const div = document.createElement('div');
      div.className = 'flex items-center gap-2 member-row';
      div.innerHTML = `
        <div class="w-7 h-7 bg-blue-500 rounded-full flex items-center justify-center text-white text-xs font-semibold flex-shrink-0">?</div>
        <input class="member-name flex-1 min-w-0 h-9 px-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-blue-400" placeholder="姓名">
        <input class="member-contact w-[140px] h-9 px-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-blue-400" placeholder="联系方式">
        <input class="member-pinyin w-[130px] h-9 px-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-blue-400" placeholder="账号">
        <button class="text-red-500 hover:text-red-700 text-sm px-2 remove-member" title="删除">✕</button>
      `;
      box.appendChild(div);
      bindMemberRow(div);
    };
  }

  // 保存修改
  document.querySelectorAll('[data-save-group]').forEach(el => {
    el.onclick = () => {
      const g = TEAM_GROUPS.find(x => x.id === state.editGroupId);
      if (!g) return;
      g.name = document.getElementById('edit-name').value.trim() || g.name;
      g.region = document.getElementById('edit-region').value.trim() || g.region;
      g.admin = document.getElementById('edit-admin').value.trim() || g.admin;
      g.adminContact = document.getElementById('edit-admin-contact').value.trim() || g.adminContact;
      g.adminAccount = document.getElementById('edit-admin-account').value.trim() || g.adminAccount;
      const rows = document.querySelectorAll('#edit-members .member-row');
      const newMembers = [];
      const newContacts = [];
      const newPinyin = [];
      rows.forEach(row => {
        const name = row.querySelector('.member-name').value.trim();
        const ct = row.querySelector('.member-contact').value.trim();
        const py = row.querySelector('.member-pinyin').value.trim();
        if (name) { newMembers.push(name); newContacts.push(ct); newPinyin.push(py); }
      });
      g.members = newMembers;
      g.memberContacts = newContacts;
      g.memberPinyin = newPinyin;
      state.modal = null;
      state.editGroupId = null;
      render();
    };
  });

  // Modal 关闭
  document.querySelectorAll('[data-close-modal]').forEach(el => {
    el.onclick = () => { state.modal = null; render(); };
  });
  document.querySelectorAll('[data-stop]').forEach(el => {
    el.onclick = (e) => e.stopPropagation();
  });

  // 分配时自动填充接收人列表
  const groupSel = document.getElementById('assign-group');
  const recvSel = document.getElementById('assign-receiver');
  if (groupSel && recvSel) {
    groupSel.onchange = () => {
      const g = TEAM_GROUPS.find(x => x.name === groupSel.value);
      recvSel.innerHTML = g ? 
        `<option value="${g.admin}">${g.admin}（管理员）</option>` + 
        g.members.map(m => `<option value="${m}">${m}</option>`).join('') :
        '<option value="">请选择接收人</option>';
    };
  }

  // 确认分配
  document.querySelectorAll('[data-confirm-assign]').forEach(el => {
    el.onclick = () => {
      const group = document.getElementById('assign-group').value;
      const receiver = document.getElementById('assign-receiver').value;
      if (!group || !receiver) { alert('请选择小组和接收人'); return; }
      const ann = state.announcements.find(a => a.id === state.assignAnnId);
      ann.currentHandler = receiver;
      ann.progress = '已分配';
      ann.progressRecords = ann.progressRecords || [];
      ann.progressRecords.push({
        progress: '已分配',
        follower: '管理员',
        followDate: new Date().toISOString().slice(0,10),
        note: `已分配给 ${group} - ${receiver}`
      });
      state.modal = null;
      state.assignAnnId = null;
      state.reminders = generateReminders(state.announcements);
      render();
    };
  });

  // 确认进度更新
  document.querySelectorAll('[data-confirm-progress]').forEach(el => {
    el.onclick = () => {
      const progress = document.getElementById('progress-select').value;
      const note = document.getElementById('progress-note').value;
      const next = document.getElementById('progress-next').value;
      const ann = state.announcements.find(a => a.id === state.progressAnnId);
      ann.progress = progress;
      ann.nextFollowUp = next;
      ann.progressRecords = ann.progressRecords || [];
      ann.progressRecords.push({
        progress: progress,
        follower: ann.currentHandler || '当前用户',
        followDate: new Date().toISOString().slice(0,10),
        note: note || '更新进度'
      });
      state.modal = null;
      state.progressAnnId = null;
      state.reminders = generateReminders(state.announcements);
      render();
    };
  });


  // ========== 任务提醒页 · 选中集 / 批量分配 ==========
  // 全选
  const raBox = document.getElementById('reminderSelectAll');
  if (raBox) {
    raBox.onchange = () => {
      // 区县筛选 + 翻页后的当前页所有 id
      const filtered = getFilteredReminders();
      const pageSize = state.pageSize === 0 ? filtered.length : state.pageSize;
      const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
      const currentPage = Math.min(state.currentPage, totalPages);
      const startIdx = (currentPage - 1) * pageSize;
      const pageIds = (state.pageSize === 0 ? filtered : filtered.slice(startIdx, startIdx + pageSize)).map(r => r.id);
      if (raBox.checked) {
        pageIds.forEach(id => state.selectedReminderIds.add(id));
      } else {
        pageIds.forEach(id => state.selectedReminderIds.delete(id));
      }
      render();
    };
  }
  // 单行勾选
  document.querySelectorAll('.reminder-row-check').forEach(cb => {
    cb.onchange = () => {
      const id = parseInt(cb.dataset.id);
      if (cb.checked) state.selectedReminderIds.add(id);
      else state.selectedReminderIds.delete(id);
      render();
    };
  });
  // 清除选择
  const reminderClearBtn = document.getElementById('reminder-clear-selection');
  if (reminderClearBtn) reminderClearBtn.onclick = () => {
    state.selectedReminderIds.clear();
    render();
  };
  // 打开批量分配弹窗
  const batchAssignBtn = document.getElementById('reminder-batch-assign');
  if (batchAssignBtn) batchAssignBtn.onclick = () => {
    if (state.selectedReminderIds.size === 0) return;
    state.modal = 'reminder-batch-assign';
    render();
  };

  // 批量分配弹窗：小组 → 接收人 联动
  const reminderBatchGroupSel = document.getElementById('reminder-batch-group');
  const reminderBatchRecvSel = document.getElementById('reminder-batch-receiver');
  if (reminderBatchGroupSel && reminderBatchRecvSel) {
    reminderBatchGroupSel.onchange = () => {
      const g = TEAM_GROUPS.find(x => x.name === reminderBatchGroupSel.value);
      reminderBatchRecvSel.innerHTML = g ?
        `<option value="${g.admin}">${g.admin}（管理员）</option>` +
        g.members.map(m => `<option value="${m}">${m}</option>`).join('') :
        '<option value="">请选择接收人</option>';
    };
  }

  // 确认批量分配
  document.querySelectorAll('[data-confirm-reminder-batch-assign]').forEach(el => {
    el.onclick = () => {
      const group = document.getElementById('reminder-batch-group').value;
      const receiver = document.getElementById('reminder-batch-receiver').value;
      const noteEl = document.getElementById('reminder-batch-note');
      const note = noteEl ? noteEl.value : '';
      if (!group || !receiver) { alert('请选择小组和接收人'); return; }

      const filteredRems = getFilteredReminders();
      const annIds = [...state.selectedReminderIds]
        .map(rid => filteredRems.find(r => r.id === rid))
        .filter(Boolean)
        .map(r => r.targetId);
      const uniqueAnnIds = [...new Set(annIds)];
      let updatedCount = 0;
      for (const id of uniqueAnnIds) {
        const a = state.announcements.find(x => x.id === id);
        if (!a) continue;
        a.currentHandler = receiver;
        a.progress = '已分配';
        a.progressRecords = a.progressRecords || [];
        a.progressRecords.push({
          progress: '已分配',
          follower: '管理员',
          followDate: new Date().toISOString().slice(0,10),
          note: `批量分配 · ${group} - ${receiver}${note ? '：' + note : ''}`
        });
        updatedCount++;
      }
      state.selectedReminderIds.clear();
      state.modal = null;
      alert(`✅ 批量分配成功：共更新 ${updatedCount} 条公告的分配状态`);
      state.reminders = generateReminders(state.announcements);
      render();
    };
  });

  // 收尾：修正全选框 indeterminate 状态
  patchReminderCheckboxIndeterminate();
  // 修改弹窗内：初始成员行绑定删除按钮
  document.querySelectorAll('#edit-members .member-row').forEach(row => bindMemberRow(row));
}


init();
