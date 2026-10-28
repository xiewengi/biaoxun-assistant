// ===== 主应用逻辑 =====

// --- script[2] ---
// 标讯助手 Demo - 主应用逻辑

// 登录态由后端会话（localStorage: bx_token）维持，currentUser 来自 /api/auth/me
let state = {
  currentUser: null,      // { account, name, phone, group, groupId }
  page: 'announcements',
  announcements: [],
  siteResults: [],        // 真实站点采集结果
  latestRun: null,        // 最近一次采集运行（GET /api/collect/runs）
  filteredList: [],
  reminders: [],
  selectedReminderIds: new Set(),
  filters: { keyword: '', region: '', district: '', progress: '', bidStatus: '', businessTag: '' },
  detailId: null,
  modal: null, // 'assign' | 'batch-assign' | 'reminder-batch-assign' | 'progress' | 'add-group' | 'edit-group' | 'kw-delete' | 'ann-form' | 'ann-import' | null
  formAnnId: null,  // ann-form 模式下：null=新增，非 null=编辑
  assignAnnId: null,
  progressAnnId: null,
  editGroupId: null,
  users: [],
  usersForSelect: [],  // 轻量用户列表，供团队成员选择用
  editingUser: null,
  selectedAnnIds: new Set(),
  // 翻页
  pageSize: 10,           // 10 / 50 / 100 / 0(全部)
  currentPage: 1,
  reminderDistrictFilter: '',  // 任务提醒页专属区县筛选
  // 采购人-区县基础资料
  buyerDistrictList: [],
  buyerDistrictTotal: 0,
  buyerDistrictPage: 1,
  buyerDistrictPageSize: 50,
  buyerDistrictKeyword: '',
  buyerDistrictEditId: null,   // 编辑时存 id
  _bdEditing: null,             // { buyer, district, remark }
};

// ============ RBAC 权限检查 ============
function hasPerm(code) {
  const u = state.currentUser;
  if (!u) return false;
  // super_admin + jitubu_admin 全量放行
  if (u.role === 'super_admin' || u.role === 'jitubu_admin') return true;
  return (u.permissions || []).includes(code);
}

function _roleTag(role) {
  const map = {
    super_admin: ['bg-red-50 text-red-700', '超级管理员'],
    jitubu_admin: ['bg-purple-50 text-purple-700', '集团管理员'],
    group_admin: ['bg-blue-50 text-blue-700', '小组管理员'],
    member: ['bg-green-50 text-green-700', '业务员'],
    admin: ['bg-blue-50 text-blue-700', '负责人'],  // 兼容老值
  };
  const [cls, label] = map[role] || ['bg-gray-50 text-gray-600', role || '未知'];
  return `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded ${cls} text-xs">${label}</span>`;
}

// ============ 初始化 / 登录态 ============
// 商机字段：本地即时更新 + 防抖 PATCH 持久化
const oppPatchTimers = new Map();
const oppPendingPatches = new Map();

function scheduleOppPatch(annId, field, value) {
  const key = annId + '|' + field;
  if (oppPatchTimers.has(key)) clearTimeout(oppPatchTimers.get(key));
  oppPendingPatches.set(key, { annId, field, value });
  const timer = setTimeout(() => {
    oppPatchTimers.delete(key);
    const pending = oppPendingPatches.get(key);
    oppPendingPatches.delete(key);
    if (!pending) return;
    API.patchAnnouncement(pending.annId, { [pending.field]: pending.value }).catch(e => {
      alert(e.message || '商机信息保存失败');
    });
  }, 500);
  oppPatchTimers.set(key, timer);
}

function cancelOppPatches(annId) {
  for (const key of Array.from(oppPatchTimers.keys())) {
    if (annId === undefined || key.indexOf(annId + '|') === 0) {
      clearTimeout(oppPatchTimers.get(key));
      oppPatchTimers.delete(key);
    }
  }
  for (const key of Array.from(oppPendingPatches.keys())) {
    if (annId === undefined || key.indexOf(annId + '|') === 0) oppPendingPatches.delete(key);
  }
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
      scheduleOppPatch(annId, field, el.value);
    });
  });
}

// 把后端返回的单条公告合并回列表（保留当前页码）
function mergeAnnouncement(updated) {
  if (!updated || !updated.id) return;
  const idx = state.announcements.findIndex(a => a.id === updated.id);
  if (idx >= 0) state.announcements[idx] = Object.assign({}, state.announcements[idx], updated);
  else state.announcements.unshift(updated);
  const page = state.currentPage;
  applyFilters();
  state.currentPage = page;
}

async function reloadReminders() {
  const data = await API.listReminders({ scope: 'me' });
  state.reminders = (data && data.items) || [];
}

// 写操作成功后刷新公告 + 提醒（保留当前页码）
async function refreshAfterMutation() {
  const page = state.currentPage;
  const [anns, reminders] = await Promise.all([
    loadAnnouncements(),
    API.listReminders({ scope: 'me' }),
  ]);
  state.announcements = anns;
  state.reminders = (reminders && reminders.items) || [];
  applyFilters();
  state.currentPage = page;
}

// 首屏数据：公告 / 提醒 / 小组 / 数据源 / 定时配置 并发加载
async function loadInitialData() {
  const [anns, reminders, runs, usersForSelect] = await Promise.all([
    loadAnnouncements(),
    API.listReminders({ scope: 'me' }),
    API.collectRuns(1).catch(e => { alert(e.message || '采集记录加载失败'); return null; }),
    loadGroups(),
    loadSources(),
    loadSchedule(),
    API.listUsersForSelect().catch(() => ({ items: [] })),
  ]);
  state.announcements = anns;
  state.reminders = (reminders && reminders.items) || [];
  state.siteResults = SOURCES_DATA.map(mapSourceToSiteResult);
  state.latestRun = (runs && runs.items && runs.items[0]) || null;
  state.usersForSelect = (usersForSelect && usersForSelect.items) || [];
}

function handleUnauthorized() {
  state.currentUser = null;
  state.detailId = null;
  state.modal = null;
  state.selectedAnnIds.clear();
  state.selectedReminderIds.clear();
  render();
}

// 打开公告详情：列表接口不带进度记录，详情单独拉取
async function openAnnouncementDetail(id) {
  state.detailId = id;
  state.modal = null;
  render();
  try {
    const detail = await API.getAnnouncement(id);
    if (state.detailId !== id) return;
    mergeAnnouncement(detail);
    render();
  } catch (e) {
    if (state.detailId === id) {
      alert(e.message || '公告详情加载失败');
      state.detailId = null;
      render();
    }
  }
}

// 数据来源 + 站点状态
async function reloadSourcesAndStatus() {
  const [, siteResults] = await Promise.all([loadSources(), loadSiteResults()]);
  state.siteResults = siteResults;
}

// 触发采集 → 提示已启动 → 轮询 collectRuns → 完成后刷新数据
async function triggerCollect() {
  let result;
  try {
    result = await API.collect();
  } catch (e) {
    alert(e.message || '启动采集失败');
    return;
  }
  alert('已启动采集任务，完成后会自动刷新数据');
  pollCollect(result && result.runId);
}

async function pollCollect(runId) {
  let attempts = 0;
  while (attempts < 40) {
    await new Promise(resolve => setTimeout(resolve, 3000));
    attempts++;
    let data;
    try {
      data = await API.collectRuns(5);
    } catch (e) {
      alert(e.message || '采集状态查询失败');
      try {
        await refreshAfterMutation();
        await reloadSourcesAndStatus();
        render();
      } catch (e2) {
        alert(e2.message || '数据刷新失败');
      }
      return;
    }
    const items = (data && data.items) || [];
    const current = runId
      ? items.find(x => String(x.id) === String(runId))
      : items[0];
    if (current) state.latestRun = current;
    if (!current || current.status !== 'running') {
      try {
        await refreshAfterMutation();
        await reloadSourcesAndStatus();
        render();
      } catch (e) {
        alert(e.message || '数据刷新失败');
      }
      return;
    }
  }
  try {
    await refreshAfterMutation();
    await reloadSourcesAndStatus();
    render();
  } catch (e) {
    alert(e.message || '数据刷新失败');
  }
}

async function init() {
  API.onUnauthorized(handleUnauthorized);
  if (!API.hasToken()) {
    state.currentUser = null;
    render();
    return;
  }
  try {
    state.currentUser = await API.me();
    await loadInitialData();
    applyFilters();
    render();
  } catch (e) {
    alert(e.message || '数据加载失败');
    render();
  }
}

// ============ 商机管理 · 信息已确认（后端校验必填项） ============
async function confirmOpportunity() {
  const annId = state.detailId;
  if (!annId) return;
  const ann = state.announcements.find(x => x.id === annId);
  if (!ann) return;

  // 先从 DOM 同步商机字段到 ann 对象，再统一持久化（防止防抖未触发）
  const fields = {};
  document.querySelectorAll('[data-opp-field]').forEach(el => {
    const field = el.dataset.oppField;
    ann[field] = el.value;
    fields[field] = el.value;
  });
  cancelOppPatches(annId);

  try {
    if (Object.keys(fields).length > 0) await API.patchAnnouncement(annId, fields);
    const updated = await API.confirmAnnouncement(annId);
    mergeAnnouncement(updated);
    try {
      await reloadReminders();
    } catch (e) {
      alert(e.message || '提醒刷新失败');
    }
    render();
    alert('✅ 商机信息已确认！');
  } catch (e) {
    alert(e.message || '确认失败');
  }
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
    ${state.modal === 'ann-form' ? renderAnnFormModal() : ''}
    ${state.modal === 'user-form' ? renderUserFormModal(state.editingUser) : ''}
    ${state.modal === 'ann-import' ? renderAnnouncementImportModal() : ''}
    ${state.modal === 'bd-form' ? renderBuyerDistrictFormModal() : ''}
    ${state.modal === 'bd-import' ? renderBuyerDistrictImportModal() : ''}
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

async function doLogin() {
  const account = document.getElementById('login-account').value.trim();
  const password = document.getElementById('login-password').value.trim();
  if (!account || !password) { alert('请输入账号和密码'); return; }
  let data;
  try {
    data = await API.login(account, password);
  } catch (e) {
    alert(e.message || '账号或密码错误');
    return;
  }
  state.currentUser = data.user;
  state.detailId = null;
  state.modal = null;
  try {
    await loadInitialData();
  } catch (e) {
    alert(e.message || '数据加载失败');
  }
  applyFilters();
  render();
}

async function doLogout() {
  if (!confirm('确认退出登录？')) return;
  try {
    await API.logout();
  } catch (e) {
    alert(e.message || '退出登录失败');
  }
  state.currentUser = null;
  state.selectedReminderIds.clear();
  state.selectedAnnIds.clear();
  state.detailId = null;
  state.modal = null;
  render();
}

function renderSidebar() {
  // --- 状态数据 ---
  const reminderCnt = getFilteredReminders().length;
  const stats = getStats();
  const unassignedCnt = stats.unassignedCount;
  const totalSources = SOURCES_DATA.length;
  const okSources = SOURCES_DATA.filter(s => s.enabled).length;

  // --- 业务中心 ---
  const bizItems = [
    { key: 'announcements', label: '招标公告', icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01', badge: null },
    { key: 'reminders', label: '任务提醒', icon: 'M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9', badge: reminderCnt > 0 ? { text: reminderCnt, cls: 'bg-red-500 text-white animate-pulse' } : null },
    { key: 'dashboard', label: '数据看板', icon: 'M3 3v18h18M7 14l4-4 4 4 5-5', badge: null, disabled: true },
  ];

  // --- 管理与配置 ---
  const adminItems = [
    { key: 'team', label: '团队管理', icon: 'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z', badge: null, requirePerm: 'groups:read' },
    { key: 'users', label: '用户管理', icon: 'M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z', badge: null, requirePerm: 'users:read' },
    { key: 'schedule', label: '定时任务', icon: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z', badge: null, requirePerm: 'schedule:read' },
    { key: 'buyer-districts', label: '区县映射', icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z', badge: null, requirePerm: 'buyer-districts:read' },
    { key: 'sources', label: '数据来源', icon: 'M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z', badge: { text: okSources + '/' + totalSources, cls: okSources === totalSources ? 'bg-green-100 text-green-600' : 'bg-yellow-100 text-yellow-600' }, requirePerm: 'sources:read' },
  ].filter(i => !i.requirePerm || hasPerm(i.requirePerm));

  const iconBox = (icon) => `
    <svg class="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.8">
      <path stroke-linecap="round" stroke-linejoin="round" d="${icon}"></path>
    </svg>
  `;

  const menuItem = (item) => `
    <div class="sidebar-item ${state.page === item.key ? 'active' : ''} ${item.disabled ? 'opacity-40 cursor-not-allowed' : ''} flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer text-sm text-gray-600" ${item.disabled ? '' : `data-page="${item.key}"`}>
      ${iconBox(item.icon)}
      <span class="flex-1">${item.label}</span>
      ${item.badge ? `<span class="sidebar-badge ${item.badge.cls}">${item.badge.text}</span>` : ''}
    </div>
  `;

  return `
    <aside class="w-60 bg-white border-r border-gray-200 flex flex-col">
      <!-- Logo -->
      <div class="h-16 flex items-center gap-3 px-4 border-b border-gray-200">
        <div class="w-9 h-9 bg-gradient-to-br from-blue-500 to-blue-700 rounded-lg flex items-center justify-center text-white font-bold text-sm flex-shrink-0">标</div>
        <div class="min-w-0">
          <div class="font-semibold text-gray-900 truncate">标讯助手</div>
          <div class="text-xs text-gray-400">v1.5</div>
        </div>
      </div>

      <!-- 搜索 -->
      <div class="px-3 pt-3 pb-2">
        <div class="flex items-center gap-2 px-3 py-2 rounded-lg bg-gray-50 text-gray-400 text-sm cursor-text hover:bg-gray-100 transition-colors" id="sidebar-search-trigger">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>
          <span class="flex-1">搜索公告/任务…</span>
          <kbd class="text-[10px] px-1 py-0.5 bg-white border border-gray-200 rounded text-gray-400">⌘K</kbd>
        </div>
      </div>

      <div class="flex-1 overflow-y-auto">
        <!-- 业务中心 -->
        <div class="sidebar-group-title">📁 业务中心</div>
        <nav class="px-2 space-y-1">
          ${bizItems.map(menuItem).join('')}
        </nav>

        <div class="sidebar-divider"></div>

        <!-- 管理与配置 -->
        <div class="sidebar-group-title">⚙️ 管理与配置</div>
        <nav class="px-2 space-y-1">
          ${adminItems.map(menuItem).join('')}
        </nav>
      </div>

      <!-- 用户区 -->
      <div class="border-t border-gray-200 px-3 py-3">
        <div class="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-gray-50 cursor-pointer" id="sidebar-user-menu">
          <div class="w-8 h-8 bg-gradient-to-br from-blue-400 to-purple-500 rounded-full flex items-center justify-center text-white text-xs font-semibold flex-shrink-0">
            ${state.currentUser ? state.currentUser.name.charAt(0) : '?'}
          </div>
          <div class="min-w-0 flex-1">
            <div class="text-sm font-medium text-gray-800 truncate">${state.currentUser ? state.currentUser.name : '未登录'}</div>
            <div class="text-xs text-gray-400 truncate">${state.currentUser ? state.currentUser.group : ''}</div>
          </div>
          <button id="btn-logout" class="text-xs text-gray-400 hover:text-red-500 px-2 py-1 rounded hover:bg-red-50 transition-colors" title="退出登录">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/></svg>
          </button>
        </div>
      </div>
    </aside>
  `;
}

function renderHeader() {
  const pageTitle = { announcements: '招标公告', sources: '数据来源', reminders: '任务提醒', team: '团队管理', users: '用户管理', schedule: '定时任务配置', 'buyer-districts': '区县映射', dashboard: '数据看板', help: '帮助反馈' }[state.page] || '标讯助手';
  const stats = getStats();
  const siteOk = state.siteResults.filter(r => r.ok).length;
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
        </div>
      ` : ''}
    </header>
  `;
}

function getStats() {
  const today = new Date().toISOString().slice(0, 10);
  return {
    todayCount: state.announcements.filter(a => a.pubDate === today).length,
    unassignedCount: state.announcements.filter(a => a.progress === '待分配' || !a.currentHandler).length,
    inProgressCount: state.announcements.filter(a => a.progress === '已分配' || a.progress === '已确认').length,
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
    case 'users': return renderUsers();
    case 'schedule': return renderSchedule();
    case 'buyer-districts': return renderBuyerDistricts();
    case 'dashboard': return renderDashboard();
    case 'help': return renderHelp();
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
          ${hasPerm('announcements:assign')
          ? `<button class="px-3 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700" id="batchAssignBtn">批量分配</button>`
          : `<button class="px-3 py-1 text-xs bg-gray-300 text-white rounded cursor-not-allowed" id="batchAssignBtn" disabled title="无分配权限">批量分配</button>`}
          <button class="px-3 py-1 text-xs border border-gray-200 text-gray-600 rounded hover:bg-gray-50" id="batchClearBtn">清空选择</button>
        </div>

        ${hasPerm('announcements:import') || hasPerm('announcements:create') || hasPerm('announcements:update') || hasPerm('announcements:delete')
        ? `<div class="flex items-center gap-1.5 ml-auto" id="annCrudBar">
             ${hasPerm('announcements:import') ? `<button class="px-3 py-1 text-xs border border-green-500 text-green-600 rounded hover:bg-green-50" id="annImportBtn">📥 批量导入</button>` : ''}
             ${hasPerm('announcements:create') ? `<button class="px-3 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700" id="annAddBtn">+ 新增公告</button>` : ''}
             ${hasPerm('announcements:update') ? `<button class="px-3 py-1 text-xs border border-gray-200 text-gray-600 rounded hover:bg-blue-50" id="annEditBtn">修改</button>` : ''}
             ${hasPerm('announcements:delete') ? `<button class="px-3 py-1 text-xs border border-gray-200 text-red-500 rounded hover:bg-red-50 hover:border-red-200" id="annDeleteBtn">删除</button>` : ''}
           </div>`
        : ''}
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
                      (hasPerm('announcements:assign')
                        ? `<button class="text-blue-600 hover:underline text-xs mr-2" data-assign="${a.id}">分配</button>`
                        : `<button class="text-gray-300 text-xs cursor-not-allowed mr-2" disabled title="无分配权限">分配</button>`)
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
                ${(a.businessTags || []).map(t => `<span class="tag tag-green">${t}</span>`).join('')}
                <span class="tag tag-blue">${a.district}</span>
                ${renderProgressTag(a.progress)}
                ${renderBidStatusTag(a)}
              </div>
            </div>
            <div class="flex gap-2">
              <!-- 编辑公告暂时隐藏，后续开放 -->
              ${false && hasPerm('announcements:update')
                ? `<button class="px-4 py-2 border border-gray-200 text-gray-700 rounded-lg text-sm hover:border-blue-400 hover:text-blue-600 hover:bg-blue-50" data-edit-ann="${a.id}">✎ 编辑公告</button>`
                : ''}
              ${isConfirmed
                ? `<button class="px-4 py-2 bg-gray-300 text-white rounded-lg text-sm cursor-not-allowed" disabled title="商机已确认, 不可分配">任务分配</button>`
                : (hasPerm('announcements:assign')
                  ? `<button class="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700" data-assign="${a.id}">任务分配</button>`
                  : `<button class="px-4 py-2 bg-gray-300 text-white rounded-lg text-sm cursor-not-allowed" disabled title="无分配权限">任务分配</button>`)}
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
            <div class="col-span-2"><span class="text-gray-400">业务标签：</span><span class="text-gray-700">${(a.businessTags || []).map(t => `<span class="tag tag-green mr-1">${t}</span>`).join('') || '<span class="text-gray-400">—</span>'}</span></div>
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
                <textarea data-opp-field="opportunityStatus" ${disabledAttr} rows="4" class="w-full px-3 py-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-blue-400 resize-none h-28" placeholder="由用户自由填写">${a.opportunityStatus || ""}</textarea>
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
  // 提醒数据由后端按 scope=me 计算，前端不再做权限 / 进度过滤
  return state.reminders.filter(r => {
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
      ${hasPerm('announcements:assign')
              ? `<button id="reminder-batch-assign"
                  class="px-4 py-1.5 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
                  ${selectedCount === 0 ? 'disabled' : ''}>
                  📋 批量分配（${selectedCount}）
                </button>`
              : `<button id="reminder-batch-assign" disabled title="无分配权限"
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
                      (hasPerm('announcements:assign')
                        ? `<button class="text-blue-600 hover:underline text-xs" data-assign="${r.targetId}">分配</button>`
                        : `<button class="text-gray-300 text-xs cursor-not-allowed" disabled title="无分配权限">分配</button>`)
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
              <span class="tag tag-blue">${g.admin} +${(g.memberDetails || g.members || []).length}人</span>
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
            
            ${g.memberDetails && g.memberDetails.length > 0 ? g.memberDetails.map(m => `
              <div class="flex items-center gap-3 p-3 hover:bg-gray-50 rounded-lg">
                <div class="w-8 h-8 bg-blue-500 rounded-full flex items-center justify-center text-white text-xs font-semibold">${(m.name || '?')[0]}</div>
                <div class="flex-1">
                  <div class="text-sm font-medium text-gray-800">${m.name}</div>
              <div class="text-xs text-gray-500">
                <span>📞 ${m.contact || '—'}</span>
                <span class="mx-2">·</span>
                <span>👤 ${m.namePinyin || '—'}</span>
              </div>
                </div>
                <span class="tag tag-blue">${m.position || '成员'}</span>
              </div>
            `).join('') : `<div class="text-xs text-gray-400 text-center py-2">暂无团队成员，点击修改添加</div>`}
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

// ---- 新增小组弹窗 ----
function renderAddGroupModal() {
  const allUsers = state.usersForSelect || [];
  return `
    <div class="fixed inset-0 z-50 flex items-center justify-center modal-bg fade-in" data-close-modal>
      <div class="bg-white rounded-xl w-[560px] max-h-[80vh] p-6 shadow-xl flex flex-col" data-stop>
        <h3 class="font-semibold text-gray-900 text-lg mb-4">新增小组</h3>
        
        <div class="flex-1 overflow-auto space-y-4 scrollbar-thin pr-1">
          <!-- 基本信息 -->
          <div class="bg-gray-50 rounded-lg p-4 space-y-3">
            <div class="text-xs text-gray-500 font-medium uppercase tracking-wide">基本信息</div>
            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="text-xs text-gray-500 mb-1 block">小组名称 *</label>
                <input id="add-name" class="w-full h-9 px-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-blue-400" placeholder="例：潮安">
              </div>
              <div>
                <label class="text-xs text-gray-500 mb-1 block">所属区域 *</label>
                <input id="add-region" class="w-full h-9 px-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-blue-400" placeholder="例：潮安">
              </div>
            </div>
          </div>
          
          <!-- 负责人：从用户列表选 -->
          <div class="bg-orange-50 rounded-lg p-4 space-y-3">
            <div class="text-xs text-orange-700 font-medium uppercase tracking-wide">负责人</div>
            <div>
              <label class="text-xs text-gray-500 mb-1 block">选择负责人（从用户列表选）</label>
              <select id="add-admin-user" class="w-full h-10 px-3 border border-orange-200 rounded-lg text-sm focus:outline-none focus:border-orange-400 bg-white">
                ${renderUserSelectOptions(null, new Set(), '— 选择负责人 —')}
              </select>
            </div>
            <div class="grid grid-cols-3 gap-3">
              <div>
                <label class="text-xs text-gray-500 mb-1 block">姓名</label>
                <input id="add-admin" class="w-full h-9 px-3 border border-gray-200 rounded-lg text-sm bg-gray-50" readonly placeholder="选人后自动填充">
              </div>
              <div>
                <label class="text-xs text-gray-500 mb-1 block">联系方式</label>
                <input id="add-admin-contact" class="w-full h-9 px-3 border border-gray-200 rounded-lg text-sm bg-gray-50" readonly placeholder="选人后自动填充">
              </div>
              <div>
                <label class="text-xs text-gray-500 mb-1 block">账号</label>
                <input id="add-admin-account" class="w-full h-9 px-3 border border-gray-200 rounded-lg text-sm bg-gray-50" readonly placeholder="选人后自动填充">
              </div>
            </div>
            <div>
              <label class="text-xs text-gray-500 mb-1 block">初始密码（留空使用系统默认密码 123456）</label>
              <input id="add-password" type="text" class="w-full h-9 px-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-blue-400" placeholder="留空 = 默认密码 123456">
            </div>
          </div>
          
          <!-- 团队成员：从用户列表选 -->
          <div class="bg-gray-50 rounded-lg p-4 space-y-3">
            <div class="flex items-center justify-between">
              <div class="text-xs text-gray-500 font-medium uppercase tracking-wide">团队成员（业务员）</div>
              <button class="text-xs text-blue-600 hover:text-blue-800" data-add-member-line>＋ 添加成员</button>
            </div>
            <div id="edit-members" class="space-y-2">
              <div class="text-xs text-gray-400 text-center py-3 border border-dashed border-gray-200 rounded-lg">暂无成员，点击上方「＋ 添加成员」</div>
            </div>
          </div>
        </div>
        
        <div class="flex justify-end gap-2 mt-5 pt-4 border-t border-gray-100">
          <button class="px-4 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50" data-close-modal>取消</button>
          <button class="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700" data-save-new-group>创建小组</button>
        </div>
      </div>
    </div>
  `;
}

// ---- 生成用户下拉选项（供团队成员选择） ----
function renderUserSelectOptions(selectedUserId, excludeUserIds, placeholder) {
  // selectedUserId: 当前已选的用户 id（用于回显）
  // excludeUserIds: 需要排除的用户 id 集合（已选的其他成员 + 负责人）
  const allUsers = state.usersForSelect || [];
  const available = allUsers.filter(u => !excludeUserIds.has(u.id) || u.id === selectedUserId);
  let html = `<option value="">${placeholder || '— 选择用户 —'}</option>`;
  for (const u of available) {
    const groupLabel = u.group ? `（${u.group}）` : '（未分组）';
    const sel = u.id === selectedUserId ? ' selected' : '';
    html += `<option value="${u.id}"${sel}>${u.name} / ${u.account}${groupLabel}</option>`;
  }
  return html;
}

// ---- 修改小组弹窗 ----
function renderEditGroupModal() {
  const g = TEAM_GROUPS.find(x => x.id === state.editGroupId);
  if (!g) return '';
  const memberDetails = (Array.isArray(g.memberDetails) && g.memberDetails.length > 0)
    ? g.memberDetails
    : (g.members || []).map((name, i) => ({
        userId: null,
        name: name,
        contact: (g.memberContacts || [])[i] || '',
        namePinyin: (g.memberPinyin || [])[i] || '',
        position: '成员',
      }));

  // 负责人信息：从 users 表找到对应的 user
  const adminUser = (state.usersForSelect || []).find(u => u.account === g.adminAccount);
  const adminUserId = adminUser ? adminUser.id : '';

  // 计算已选成员的 userId 集合（用于下拉排除）
  const memberUserIds = new Set(memberDetails.filter(m => m.userId).map(m => m.userId));

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
          
          <!-- 负责人：从用户列表选择 -->
          <div class="bg-orange-50 rounded-lg p-4 space-y-3">
            <div class="text-xs text-orange-700 font-medium uppercase tracking-wide">负责人</div>
            <div>
              <label class="text-xs text-gray-500 mb-1 block">选择负责人（从用户列表选）</label>
              <select id="edit-admin-user" class="w-full h-10 px-3 border border-orange-200 rounded-lg text-sm focus:outline-none focus:border-orange-400 bg-white">
                ${renderUserSelectOptions(adminUserId, memberUserIds, '— 选择负责人 —')}
              </select>
            </div>
            <div class="grid grid-cols-3 gap-3">
              <div>
                <label class="text-xs text-gray-500 mb-1 block">姓名</label>
                <input id="edit-admin" value="${g.admin}" class="w-full h-9 px-3 border border-gray-200 rounded-lg text-sm bg-gray-50" readonly>
              </div>
              <div>
                <label class="text-xs text-gray-500 mb-1 block">联系方式</label>
                <input id="edit-admin-contact" value="${g.adminContact}" class="w-full h-9 px-3 border border-gray-200 rounded-lg text-sm bg-gray-50" readonly>
              </div>
              <div>
                <label class="text-xs text-gray-500 mb-1 block">账号</label>
                <input id="edit-admin-account" value="${g.adminAccount}" class="w-full h-9 px-3 border border-gray-200 rounded-lg text-sm bg-gray-50" readonly>
              </div>
            </div>
          </div>
          
          <!-- 团队成员：从用户列表选择 -->
          <div class="bg-gray-50 rounded-lg p-4 space-y-3">
            <div class="flex items-center justify-between">
              <div class="text-xs text-gray-500 font-medium uppercase tracking-wide">团队成员（业务员）</div>
              <button class="text-xs text-blue-600 hover:text-blue-800" data-add-member-line>＋ 添加成员</button>
            </div>
            <div id="edit-members" class="space-y-2">
              ${memberDetails.length > 0 ? memberDetails.map((m, i) => {
                // 计算本行的排除集合：其他成员的 userId + 负责人
                const excludeIds = new Set(memberUserIds);
                if (adminUserId) excludeIds.add(adminUserId);
                return `
                <div class="flex items-center gap-2 member-row" data-idx="${i}" data-position="${m.position || '成员'}">
                  <div class="w-7 h-7 bg-blue-500 rounded-full flex items-center justify-center text-white text-xs font-semibold flex-shrink-0">${(m.name || '?')[0]}</div>
                  <select class="member-user-select flex-1 min-w-0 h-9 px-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-blue-400 bg-white" data-user-id="${m.userId || ''}">
                    ${renderUserSelectOptions(m.userId || null, excludeIds, '— 选择用户 —')}
                  </select>
                  <span class="member-name-hidden hidden">${m.name || ''}</span>
                  <span class="member-contact-hidden hidden">${m.contact || ''}</span>
                  <button class="text-red-500 hover:text-red-700 text-sm px-2 remove-member flex-shrink-0" title="删除">✕</button>
                </div>
              `}).join('') : `
                <div class="text-xs text-gray-400 text-center py-3 border border-dashed border-gray-200 rounded-lg">暂无成员，点击上方「＋ 添加成员」</div>
              `}
            </div>
          </div>
        </div>
        
        <div class="flex items-center justify-between mt-5 pt-4 border-t border-gray-100">
          <div>
            ${g.name !== '集团客户部' ? `<button class="px-3 py-2 text-sm text-red-500 hover:text-red-700" data-delete-group="${g.id}">删除小组</button>` : ''}
          </div>
          <div class="flex justify-end gap-2">
            <button class="px-4 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50" data-close-modal>取消</button>
            <button class="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700" data-save-group>保存</button>
          </div>
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
              <th class="px-4 py-3 text-center font-medium w-20 whitespace-nowrap">适配器</th>
              <th class="px-4 py-3 text-center font-medium w-16 whitespace-nowrap">启用</th>
              <th class="px-4 py-3 text-center font-medium w-36 whitespace-nowrap">操作</th>
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
                <td class="px-4 py-3 text-center whitespace-nowrap">${statusDot}</td>
                <td class="px-4 py-3 text-center">
                  <label class="inline-flex items-center cursor-pointer">
                    <input type="checkbox" ${s.enabled ? 'checked' : ''} class="source-toggle w-4 h-4 text-blue-600" data-idx="${i}">
                  </label>
                </td>
                <td class="px-4 py-3 text-center whitespace-nowrap">
                  <button class="text-xs text-gray-500 hover:text-blue-600 mr-2 source-refresh" data-idx="${i}">刷新</button>
                  <button class="text-xs text-gray-500 hover:text-blue-600 mr-2 source-edit" data-idx="${i}">编辑</button>
                  <button class="text-xs text-gray-500 hover:text-red-600 source-del" data-idx="${i}">删除</button>
                </td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
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
            ${(SCHEDULE_CONFIG.keywordList || []).map((k,i) => `
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

function parseScheduleInterval(text) {
  const m = String(text || '').match(/(\d+(?:\.\d+)?)\s*(小时|分钟|天)/);
  if (m) return { value: m[1], unit: m[2] };
  return { value: text || '—', unit: '' };
}

function renderSchedule() {
  const successSites = state.siteResults.filter(r => r.ok);
  const failSites = state.siteResults.filter(r => !r.ok);
  const siteOk = successSites.length;
  const total = state.siteResults.length;
  const successRate = total > 0 ? (siteOk / total * 100).toFixed(1) : 0;
  const totalMatched = successSites.reduce((s, r) => s + r.matched_links, 0);
  const totalFound = successSites.reduce((s, r) => s + r.found_links, 0);
  const interval = parseScheduleInterval(SCHEDULE_CONFIG.crawlInterval);
  const isRunning = SCHEDULE_CONFIG.crawlStatus !== '已暂停';
  
  // 按匹配数排序 Top 站点
  const topSites = [...successSites].sort((a, b) => b.matched_links - a.matched_links).slice(0, 10);
  
  const lastCrawlTime = state.latestRun
    ? (state.latestRun.finishedAt || state.latestRun.startedAt || '—')
    : '—';

  return `
    <div class="grid grid-cols-4 gap-4 mb-6">
      <div class="bg-white rounded-xl border border-gray-100 p-5">
        <div class="text-xs text-gray-500 mb-1">运行状态</div>
        <div class="flex items-center gap-2 mt-1">
          <div class="w-2 h-2 ${isRunning ? 'bg-green-500 animate-pulse' : 'bg-gray-400'} rounded-full"></div>
          <button type="button" class="font-semibold ${isRunning ? 'text-green-600' : 'text-gray-500'}" style="background:none;border:none;padding:0;cursor:pointer" data-schedule-toggle="crawlStatus" title="点击启用 / 暂停">${SCHEDULE_CONFIG.crawlStatus || '—'}</button>
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
        <div class="text-2xl font-bold text-gray-800">${interval.value}<span class="text-sm text-gray-400 font-normal">${interval.unit}</span></div>
        <div class="text-xs text-gray-400 mt-1">定时任务1</div>
      </div>
    </div>

    <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-6 mb-4">
      <div class="flex items-center justify-between mb-4">
        <h3 class="font-semibold text-gray-900">🔑 定时任务1 - 关键词设定</h3>
        <div class="flex items-center gap-2">
          <span class="text-xs text-gray-400">共 ${(SCHEDULE_CONFIG.keywordList || []).length} 个</span>
          <button id="kw-delete-open" class="px-3 py-1 text-xs border border-gray-200 text-gray-600 rounded hover:bg-red-50 hover:border-red-200 hover:text-red-500 transition-colors">批量删除</button>
        </div>
      </div>
      <div class="flex flex-wrap gap-2 items-center">
        ${(SCHEDULE_CONFIG.keywordList || []).map((k, idx) => `
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
        <button id="btn-manual-collect" class="mt-6 w-full px-4 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50">手动触发一次抓取</button>
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
// ========== 公告 · 新增 / 编辑 共用表单弹窗 ==========
// 保存时不做强校验，但空字段超过 0 个时给确认提示。
// 字段按详情页顺序排，尽量不跟后端 schema 强耦合（JSON/contact 这种嵌套先做最简版）。
const ANN_FORM_FIELDS = [
  { section: '基本信息', wide: true, rows: [
    [{ key: 'title', label: '公告标题', width: 'col-span-3', type: 'text' }],
    [{ key: 'projectName', label: '项目名称', width: 'col-span-2', type: 'text' },
     { key: 'projectCode', label: '项目编码', width: 'col-span-1', type: 'text' }],
    [{ key: 'annType', label: '公告类型', width: 'col-span-1', type: 'select',
       options: ['招标公告','中标公告','单一来源公示','询价公告','竞争性谈判','意向公开','资格预审','更正公告'] },
     { key: 'purchaseMethod', label: '采购方式', width: 'col-span-1', type: 'select',
       options: ['公开招标','邀请招标','竞争性谈判','竞争性磋商','询价','单一来源','框架协议','协议供货'] },
     { key: 'summary', label: '项目概况', width: 'col-span-3', type: 'textarea', rows: 2 }],
  ]},
  { section: '采购方 / 预算', rows: [
    [{ key: 'buyer', label: '采购人', width: 'col-span-1', type: 'text' },
     { key: 'agency', label: '代理机构', width: 'col-span-1', type: 'text' },
     { key: 'contact', label: '联系电话', width: 'col-span-1', type: 'text' }],
    [{ key: 'budget', label: '预算金额', width: 'col-span-1', type: 'text', placeholder: '如 120万元' },
     { key: 'fundSource', label: '资金来源', width: 'col-span-1', type: 'text', placeholder: '如 财政资金' },
     { key: 'sourceUrl', label: '来源链接', width: 'col-span-3', type: 'text', placeholder: 'https://...' }],
  ]},
  { section: '区域 / 时间', rows: [
    [{ key: 'region', label: '所属区域', width: 'col-span-1', type: 'text' },
     { key: 'district', label: '所属区县', width: 'col-span-1', type: 'text' },
     { key: 'pubDate', label: '发布日期', width: 'col-span-1', type: 'date' }],
    [{ key: 'deadline', label: '报名截止', width: 'col-span-1', type: 'date' },
     { key: 'bidOpenDate', label: '开标日期', width: 'col-span-1', type: 'date' }],
  ]},
  { section: '商机管理', wide: true, rows: [
    [{ key: 'isValidOpportunity', label: '有效商机', width: 'col-span-1', type: 'select',
       options: ['', '是', '否'], optionLabels: { '': '请选择', '是': '是', '否': '否' } },
     { key: 'hasOperatorInvolvement', label: '运营商参与', width: 'col-span-1', type: 'select',
       options: ['', '是', '否'], optionLabels: { '': '请选择', '是': '是', '否': '否' } },
     { key: 'willBid', label: '是否应标', width: 'col-span-1', type: 'select',
       options: ['', '准备应标', '已经应标', '弃标'], optionLabels: { '': '请选择', '准备应标': '准备应标', '已经应标': '已经应标', '弃标': '弃标' } }],
    [{ key: 'opportunityCode', label: '商机编码', width: 'col-span-1', type: 'text' },
     { key: 'treePlacement', label: '挂树选择', width: 'col-span-1', type: 'text' },
     { key: 'progress', label: '进度', width: 'col-span-1', type: 'select',
       options: ['待分配', '已分配', '已确认'] }],
    [{ key: 'handlerGroup', label: '负责小组', width: 'col-span-1', type: 'text', placeholder: '可留空' },
     { key: 'currentHandler', label: '当前处理人', width: 'col-span-1', type: 'text', placeholder: '可留空' },
     { key: 'nextFollowUp', label: '下次跟进', width: 'col-span-1', type: 'date' }],
    [{ key: 'opportunityStatus', label: '商机了解情况', width: 'col-span-3', type: 'textarea', rows: 2 }],
  ]},
];
function renderAnnFormModal() {
  const isEdit = !!state.formAnnId;
  const ann = isEdit ? state.announcements.find(a => a.id === state.formAnnId) || {} : {};
  const title = isEdit ? '修改招标公告' : '新增招标公告';

  function renderField(field) {
    const val = ann[field.key] !== undefined ? ann[field.key] : '';
    const valueAttr = String(val).replace(/"/g, '&quot;');
    const labelHtml = `<label class="text-sm text-gray-700 mb-2 block font-medium">${field.label}</label>`;
    if (field.type === 'textarea') {
      return `
        <div class="${field.width || 'col-span-1'}">
          ${labelHtml}
          <textarea name="${field.key}" rows="${field.rows || 3}"
            class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 transition resize-none leading-relaxed"
            placeholder="${field.placeholder || ''}">${val}</textarea>
        </div>`;
    }
    if (field.type === 'select') {
      const labels = field.optionLabels || {};
      const opts = (field.options || []).map(o => {
        const label = labels[o] !== undefined ? labels[o] : o;
        return `<option value="${o}" ${valueAttr == o ? 'selected' : ''}>${label}</option>`;
      }).join('');
      return `
        <div class="${field.width || 'col-span-1'}">
          ${labelHtml}
          <select name="${field.key}"
            class="w-full h-10 px-3 border border-gray-300 rounded-md text-sm focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 transition bg-white">
            ${opts}
          </select>
        </div>`;
    }
    const inputType = field.type === 'date' ? 'date' : 'text';
    return `
      <div class="${field.width || 'col-span-1'}">
        ${labelHtml}
        <input type="${inputType}" name="${field.key}" value="${valueAttr}"
          class="w-full h-10 px-3 border border-gray-300 rounded-md text-sm focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 transition"
          placeholder="${field.placeholder || ''}">
      </div>`;
  }

  function renderSection(section) {
    const rowsHtml = section.rows.map(row => {
      return `<div class="grid grid-cols-3 gap-x-6 gap-y-5">${row.map(renderField).join('')}</div>`;
    }).join('');
    return `
      <div class="mb-6">
        <div class="text-base font-semibold text-gray-800 mb-4 flex items-center gap-2">
          <span class="w-0.5 h-3.5 bg-blue-500 rounded-sm"></span>
          ${section.section}
        </div>
        ${rowsHtml}
      </div>`;
  }

  const sectionsHtml = ANN_FORM_FIELDS.map(renderSection).join('');

  return `
    <div id="annFormModal" class="fixed inset-0 z-50 flex items-center justify-center modal-bg fade-in" data-close-modal>
      <div class="bg-white rounded-lg w-[860px] max-h-[92vh] flex flex-col shadow-2xl" data-stop>
        <div class="px-6 py-4 border-b border-gray-100 shrink-0 flex items-center justify-between">
          <h3 class="font-semibold text-gray-900 text-base leading-none">${title}</h3>
          <button data-close-modal class="text-gray-400 hover:text-gray-600 transition w-6 h-6 flex items-center justify-center rounded hover:bg-gray-100 text-lg leading-none">✕</button>
        </div>
        <div class="overflow-y-auto scrollbar-thin flex-1 min-h-0 px-8 py-6">
          ${sectionsHtml}
        </div>
        <div class="px-6 py-3 border-t border-gray-100 shrink-0 flex justify-end gap-2 bg-gray-50 rounded-lg">
          <button id="annFormCancel"
            class="px-5 py-2 border border-gray-300 rounded-md text-sm text-gray-700 hover:border-blue-500 hover:text-blue-500 hover:bg-blue-50 transition">取消</button>
          <button id="annFormSave"
            class="px-5 py-2 bg-blue-600 text-white rounded-md text-sm hover:bg-blue-700 active:bg-blue-800 transition shadow-sm">保存</button>
        </div>
      </div>
    </div>
  `;
}

function collectAnnFormData() {
  const body = {};
  document.querySelectorAll('#annFormModal [name]').forEach(el => {
    body[el.name] = el.value;
  });
  body.matchedKeywords = [];
  body.businessTags = [];
  body.contacts = {};
  return body;
}

function annFormMissingFields(body) {
  const skipEmpty = new Set(['summary', 'matchedKeywords', 'businessTags', 'contacts']);
  const missing = [];
  for (const section of ANN_FORM_FIELDS) {
    for (const row of section.rows) {
      for (const f of row) {
        if (skipEmpty.has(f.key)) continue;
        const v = body[f.key];
        if (v === undefined || v === null || String(v).trim() === '') missing.push(f.label);
      }
    }
  }
  return missing;
}


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

// ============ 基础资料 · 采购人-区县 ============
async function loadBuyerDistricts() {
  try {
    const data = await API.listBuyerDistricts({
      keyword: state.buyerDistrictKeyword,
      page: state.buyerDistrictPage,
      page_size: state.buyerDistrictPageSize,
    });
    state.buyerDistrictList = data.items || [];
    state.buyerDistrictTotal = data.total || 0;
  } catch (e) {
    alert(e.message || '加载基础资料失败');
  }
}

function renderBuyerDistricts() {
  const totalPages = Math.max(1, Math.ceil(state.buyerDistrictTotal / state.buyerDistrictPageSize));
  const pages = [];
  for (let i = 1; i <= totalPages; i++) pages.push(i);

  return `
    <div class="space-y-4">
      <!-- 工具条 -->
      <div class="bg-white rounded-xl border border-gray-200 px-4 py-3 flex items-center gap-3">
        <input id="bd-search" type="text" placeholder="搜索区县 / 备注...（采购人加密存储，暂不支持模糊搜索）"
          value="${state.buyerDistrictKeyword}"
          class="h-9 px-3 border border-gray-200 rounded text-sm focus:outline-none focus:border-blue-400 min-w-[240px]" />
        <span class="text-sm text-gray-400">共 ${state.buyerDistrictTotal} 条</span>
        <div class="ml-auto flex items-center gap-2">
          <button id="btn-bd-import" class="text-sm px-3 py-2 border border-green-500 text-green-600 rounded-lg hover:bg-green-50 flex items-center gap-1">
            📥 批量导入 Excel
          </button>
          <button id="btn-bd-add" class="text-sm px-3 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 flex items-center gap-1">
            + 新增
          </button>
        </div>
      </div>

      <!-- 表格 -->
      <div class="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <table class="w-full text-sm">
          <thead class="bg-gray-50 border-b border-gray-200">
            <tr>
              <th class="px-4 py-3 text-left font-medium text-gray-600 w-16">#</th>
              <th class="px-4 py-3 text-left font-medium text-gray-600">采购人</th>
              <th class="px-4 py-3 text-left font-medium text-gray-600 w-24">区县</th>
              <th class="px-4 py-3 text-left font-medium text-gray-600">备注</th>
              <th class="px-4 py-3 text-left font-medium text-gray-600 w-36">更新时间</th>
              <th class="px-4 py-3 text-right font-medium text-gray-600 w-32">操作</th>
            </tr>
          </thead>
          <tbody>
            ${state.buyerDistrictList.length === 0 ? `
              <tr><td colspan="6" class="px-4 py-16 text-center text-gray-400">暂无数据，点右上角 <b class="text-green-600">批量导入 Excel</b> 或 <b class="text-blue-600">+ 新增</b> 开始</td></tr>
            ` : state.buyerDistrictList.map((r, idx) => `
              <tr class="border-b border-gray-100 hover:bg-gray-50">
                <td class="px-4 py-3 text-gray-400">${(state.buyerDistrictPage - 1) * state.buyerDistrictPageSize + idx + 1}</td>
                <td class="px-4 py-3 text-gray-800 font-medium">${r.buyer}</td>
                <td class="px-4 py-3">${r.district ? `<span class="tag tag-blue">${r.district}</span>` : '<span class="text-gray-300">-</span>'}</td>
                <td class="px-4 py-3 text-gray-500">${r.remark || ''}</td>
                <td class="px-4 py-3 text-gray-400 text-xs">${r.updatedAt || r.createdAt || ''}</td>
                <td class="px-4 py-3 text-right">
                  <button class="bd-edit text-blue-600 hover:underline mr-3" data-id="${r.id}">编辑</button>
                  <button class="bd-del text-red-500 hover:underline" data-id="${r.id}" data-name="${r.buyer}">删除</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>

      <!-- 分页 -->
      ${totalPages > 1 ? `
        <div class="flex items-center justify-end gap-2 text-sm">
          ${pages.map(p => `
            <button class="bd-page-btn h-8 px-3 rounded border ${p === state.buyerDistrictPage ? 'bg-blue-600 text-white border-blue-600' : 'border-gray-200 hover:bg-gray-50'}" data-page="${p}">${p}</button>
          `).join('')}
        </div>
      ` : ''}
    </div>
  `;
}

// ---- 基础资料：新增/编辑 Modal ----
function renderBuyerDistrictFormModal() {
  const isEdit = !!state.buyerDistrictEditId;
  const data = state._bdEditing || {};
  return `
    <div class="fixed inset-0 z-50 bg-black/40 flex items-center justify-center" id="bd-form-modal">
      <div class="bg-white rounded-xl shadow-2xl w-[480px] max-h-[90vh] overflow-hidden">
        <div class="px-5 py-4 border-b border-gray-200 flex items-center">
          <h3 class="font-semibold text-gray-800">${isEdit ? '编辑' : '新增'}采购人-区县</h3>
          <button class="ml-auto text-gray-400 hover:text-gray-600" id="bd-form-close">✕</button>
        </div>
        <div class="p-5 space-y-4">
          <div>
            <label class="block text-xs text-gray-500 mb-1">采购人 <span class="text-red-500">*</span></label>
            <input id="bd-f-buyer" type="text" value="${data.buyer || ''}" placeholder="例如：XX市政府采购中心"
              class="w-full h-9 px-3 border border-gray-200 rounded text-sm focus:outline-none focus:border-blue-400" />
          </div>
          <div>
            <label class="block text-xs text-gray-500 mb-1">区县</label>
            <input id="bd-f-district" type="text" value="${data.district || ''}" placeholder="例如：朝阳区 / 海淀区"
              class="w-full h-9 px-3 border border-gray-200 rounded text-sm focus:outline-none focus:border-blue-400" />
          </div>
          <div>
            <label class="block text-xs text-gray-500 mb-1">备注</label>
            <input id="bd-f-remark" type="text" value="${data.remark || ''}" placeholder="选填"
              class="w-full h-9 px-3 border border-gray-200 rounded text-sm focus:outline-none focus:border-blue-400" />
          </div>
        </div>
        <div class="px-5 py-3 border-t border-gray-200 flex justify-end gap-2">
          <button id="bd-form-cancel" class="px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">取消</button>
          <button id="bd-form-save" class="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">保存</button>
        </div>
      </div>
    </div>
  `;
}

// ---- 基础资料：Excel 导入 Modal ----
function renderBuyerDistrictImportModal() {
  return `
    <div class="fixed inset-0 z-50 bg-black/40 flex items-center justify-center" id="bd-import-modal">
      <div class="bg-white rounded-xl shadow-2xl w-[560px] max-h-[90vh] overflow-hidden">
        <div class="px-5 py-4 border-b border-gray-200 flex items-center">
          <h3 class="font-semibold text-gray-800">📥 批量导入 Excel</h3>
          <button class="ml-auto text-gray-400 hover:text-gray-600" id="bd-import-close">✕</button>
        </div>
        <div class="p-5 space-y-4">
          <!-- 模板说明 -->
          <div class="bg-gray-50 rounded-lg p-4 text-sm">
            <div class="font-medium text-gray-700 mb-2">Excel 模板要求</div>
            <div class="text-gray-500 text-xs leading-relaxed">
              - 第一行为表头，必须包含「<b class="text-gray-700">采购人</b>」列<br/>
              - 可选列：「区县」「备注」<br/>
              - 采购人作为唯一键，重复时按下方选项处理<br/>
              - 支持 .xlsx / .xls 格式
            </div>
          </div>

          <!-- 上传区 -->
          <div>
            <label class="block text-xs text-gray-500 mb-1">选择文件</label>
            <input id="bd-import-file" type="file" accept=".xlsx,.xls"
              class="w-full text-sm text-gray-600 file:mr-3 file:px-3 file:py-1.5 file:text-sm file:border-0 file:bg-blue-50 file:text-blue-600 file:rounded hover:file:bg-blue-100" />
          </div>

          <!-- 覆盖策略 -->
          <div class="flex items-center gap-2 text-sm">
            <label class="flex items-center gap-2 cursor-pointer">
              <input type="radio" name="bd-import-mode" value="skip" checked />
              <span>跳过已存在的采购人（推荐，安全）</span>
            </label>
            <label class="flex items-center gap-2 cursor-pointer">
              <input type="radio" name="bd-import-mode" value="overwrite" />
              <span>覆盖已存在的采购人（以 Excel 为准）</span>
            </label>
          </div>

          <!-- 结果展示区 -->
          <div id="bd-import-result" class="hidden bg-green-50 border border-green-100 rounded-lg p-4 text-sm text-green-700">
            <div id="bd-import-result-text"></div>
          </div>
          <div id="bd-import-error" class="hidden bg-red-50 border border-red-100 rounded-lg p-4 text-sm text-red-700"></div>
        </div>
        <div class="px-5 py-3 border-t border-gray-200 flex justify-end gap-2">
          <button id="bd-import-cancel" class="px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">关闭</button>
          <button id="bd-import-submit" class="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">开始导入</button>
        </div>
      </div>
    </div>
  `;
}

// ---- 招标公告：Excel 批量导入 Modal ----
function renderAnnouncementImportModal() {
  const templateUrl = API.getAnnouncementImportTemplateUrl();
  const token = API.getToken();
  const fullUrl = token
    ? templateUrl + (templateUrl.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(token)
    : templateUrl;
  return `
    <div class="fixed inset-0 z-50 bg-black/40 flex items-center justify-center" id="ann-import-modal">
      <div class="bg-white rounded-xl shadow-2xl w-[600px] max-h-[90vh] overflow-hidden">
        <div class="px-5 py-4 border-b border-gray-200 flex items-center">
          <h3 class="font-semibold text-gray-800">📥 批量导入招标公告</h3>
          <button class="ml-auto text-gray-400 hover:text-gray-600" id="ann-import-close">✕</button>
        </div>
        <div class="p-5 space-y-4">
          <!-- 模板下载 + 说明 -->
          <div class="bg-gray-50 rounded-lg p-4 text-sm">
            <div class="flex items-center justify-between mb-2">
              <div class="font-medium text-gray-700">第一步：下载官方导入模板</div>
              <a href="${fullUrl}"
                 class="text-xs px-3 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700 inline-flex items-center gap-1"
                 title="下载公告导入模板">
                ⬇ 下载模板
              </a>
            </div>
            <div class="text-gray-500 text-xs leading-relaxed space-y-1">
              <div>• <b class="text-red-500">请勿自行编造表头</b>，必须使用上面下载的模板，否则系统会拒绝导入</div>
              <div>• 必填列：<b>项目名称</b>、<b>公告标题</b>（两列可互代，但不能同时为空）</div>
              <div>• 日期列统一写成 YYYY-MM-DD（如 2026-10-27）；Excel date 格式也会被自动识别</div>
              <div>• 二值字段（是否有效商机 / 是否运营商参与 / 是否应标）：填 是 / 否</div>
              <div>• 查重键：项目编号 + 公告链接，或 公告标题 + 采购人 + 发布日期</div>
              <div>• 支持 .xlsx / .xls，单次建议 500 行以内（浏览器稳定性）</div>
            </div>
          </div>

          <!-- 上传区 -->
          <div>
            <label class="block text-xs text-gray-500 mb-1">第二步：填好数据后选择文件上传</label>
            <input id="ann-import-file" type="file" accept=".xlsx,.xls"
              class="w-full text-sm text-gray-600 file:mr-3 file:px-3 file:py-1.5 file:text-sm file:border-0 file:bg-green-50 file:text-green-600 file:rounded hover:file:bg-green-100" />
          </div>

          <!-- 覆盖策略 -->
          <div class="flex items-center gap-2 text-sm">
            <label class="flex items-center gap-2 cursor-pointer">
              <input type="radio" name="ann-import-mode" value="skip" checked />
              <span>跳过已存在的公告（推荐，安全）</span>
            </label>
            <label class="flex items-center gap-2 cursor-pointer">
              <input type="radio" name="ann-import-mode" value="overwrite" />
              <span>覆盖已存在的公告（以 Excel 为准）</span>
            </label>
          </div>

          <!-- 结果展示区 -->
          <div id="ann-import-result" class="hidden bg-green-50 border border-green-100 rounded-lg p-4 text-sm text-green-700">
            <div id="ann-import-result-text"></div>
          </div>
          <div id="ann-import-error" class="hidden bg-red-50 border border-red-100 rounded-lg p-4 text-sm text-red-700"></div>
        </div>
        <div class="px-5 py-3 border-t border-gray-200 flex justify-end gap-2">
          <button id="ann-import-cancel" class="px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">关闭</button>
          <button id="ann-import-submit" class="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">开始导入</button>
        </div>
      </div>
    </div>
  `;
}
function onEnterBuyerDistrictsPage() {
  state.buyerDistrictPage = 1;
  loadBuyerDistricts().then(() => { render(); });
}


function bindMemberRow(row) {
  const del = row.querySelector('.remove-member');
  if (del) del.onclick = () => { row.remove(); };
}


// ---- 用户管理 ----
function renderUsers() {
  if (state.users.length === 0) {
    API.listUsers().then(data => { state.users = data.items || []; render(); }).catch(e => alert(e.message || '加载用户失败'));
    return `<div class="text-center text-gray-400 py-12">加载中...</div>`;
  }
  const stats = {
    total: state.users.length,
    jitubu_admin: state.users.filter(u => u.role === 'jitubu_admin').length,
    group_admin: state.users.filter(u => u.role === 'group_admin').length,
    member: state.users.filter(u => u.role === 'member').length,
    nogroup: state.users.filter(u => !u.groupId).length,
  };
  const jitubu = hasPerm('users:update');
  return `
    <div class="space-y-4">
      <div class="flex gap-3">
        ${[
          ['总账号', stats.total, 'text-gray-900'],
          ['集团管理员', stats.jitubu_admin, 'text-purple-600'],
          ['小组管理员', stats.group_admin, 'text-blue-600'],
          ['业务员', stats.member, 'text-green-600'],
          ['未分组', stats.nogroup, 'text-orange-500'],
        ].map(([label, val, color]) => `
          <div class="flex-1 bg-white rounded-lg border border-gray-100 px-4 py-2.5 flex items-center justify-between">
            <span class="text-xs text-gray-500">${label}</span>
            <span class="text-lg font-bold ${color}">${val}</span>
          </div>
        `).join('')}
      </div>
      <div class="flex items-center justify-between">
        <div class="text-xs text-gray-400">统一由集团客户部维护账号；负责人在团队管理里可自由加减成员（从用户表选）</div>
        <div class="flex gap-2">
          <button class="px-3 py-1.5 text-xs text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50" id="btn-refresh-users">🔄 刷新</button>
          ${jitubu ? `<button class="px-3 py-1.5 text-xs text-blue-600 border border-blue-200 rounded-lg hover:bg-blue-50" id="btn-add-user">+ 新建账号</button>` : ''}
        </div>
      </div>
      <div class="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <table class="w-full text-sm">
          <thead class="bg-gray-50 text-gray-500 text-xs"><tr>
            <th class="px-4 py-3 text-left font-medium w-12">#</th>
            <th class="px-4 py-3 text-left font-medium">账号</th>
            <th class="px-4 py-3 text-left font-medium">姓名</th>
            <th class="px-4 py-3 text-left font-medium">联系方式</th>
            <th class="px-4 py-3 text-left font-medium">所属小组</th>
            <th class="px-4 py-3 text-center font-medium w-24">角色</th>
            <th class="px-4 py-3 text-left font-medium">创建时间</th>
            <th class="px-4 py-3 text-center font-medium w-44">操作</th>
          </tr></thead>
          <tbody>
            ${state.users.map((u, i) => `
              <tr class="border-b border-gray-50 hover:bg-gray-50/50">
                <td class="px-4 py-3 text-gray-400 text-xs">${i+1}</td>
                <td class="px-4 py-3 font-mono text-blue-600">${u.account}</td>
                <td class="px-4 py-3 font-medium text-gray-800">${u.name}</td>
                <td class="px-4 py-3 text-gray-500">${u.phone || '-'}</td>
                <td class="px-4 py-3">${u.group ? `<span class="tag tag-blue">${u.group}</span>` : `<span class="tag tag-gray">未分组</span>`}</td>
                <td class="px-4 py-3 text-center">${_roleTag(u.role)}</td>
                <td class="px-4 py-3 text-gray-400 text-xs">${u.createdAt || '-'}</td>
                <td class="px-4 py-3 text-center">${jitubu ? `
                  <button class="text-xs text-blue-600 hover:text-blue-800 mr-2 user-edit" data-id="${u.id}">编辑</button>
                  <button class="text-xs text-gray-500 hover:text-blue-600 mr-2 user-reset" data-id="${u.id}">重置密码</button>
                  <button class="text-xs text-red-500 hover:text-red-700 user-del" data-id="${u.id}">删除</button>
                ` : `<span class="text-gray-300 text-xs">仅管理员可操作</span>`}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderUserFormModal(user) {
  const isEdit = !!user;
  const groups = (state.groups && state.groups.items) ? state.groups.items : [];
  return `
    <div class="fixed inset-0 z-50 flex items-center justify-center modal-bg fade-in" data-close-modal>
      <div class="bg-white rounded-xl w-[520px] p-6 shadow-xl" data-stop>
        <div class="flex items-center justify-between mb-4">
          <h3 class="font-semibold text-gray-900">${isEdit ? '编辑账号：' + user.account : '新建账号'}</h3>
          <button class="text-gray-400 hover:text-gray-600" data-close-modal>×</button>
        </div>
        <div class="space-y-4">
          <div class="grid grid-cols-2 gap-3">
            <div><label class="text-xs text-gray-500 mb-1 block">登录账号 *</label>
              <input id="u-account" value="${user ? user.account : ''}" ${isEdit ? 'readonly class="w-full h-10 px-3 border border-gray-100 bg-gray-50 rounded-lg text-sm text-gray-400"' : 'class="w-full h-10 px-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-blue-400"'} placeholder="英文/数字，唯一"></div>
            <div><label class="text-xs text-gray-500 mb-1 block">姓名 *</label>
              <input id="u-name" value="${user ? user.name : ''}" class="w-full h-10 px-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-blue-400" placeholder="真实姓名"></div>
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div><label class="text-xs text-gray-500 mb-1 block">联系方式</label>
              <input id="u-phone" value="${user ? (user.phone || '') : ''}" class="w-full h-10 px-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-blue-400" placeholder="手机号"></div>
            <div><label class="text-xs text-gray-500 mb-1 block">角色</label>
              <select id="u-role" class="w-full h-10 px-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-blue-400">
                <option value="member"         ${(!user || user.role === 'member')         ? 'selected' : ''}>业务员（member）— 看公告/改自己任务</option>
                <option value="group_admin"    ${user && user.role === 'group_admin'      ? 'selected' : ''}>小组管理员（group_admin）— 管自己组</option>
                <option value="jitubu_admin"   ${user && user.role === 'jitubu_admin'     ? 'selected' : ''}>集团管理员（jitubu_admin）— 全局管理</option>
                ${hasPerm('users:update') && state.currentUser.role === 'super_admin'
                  ? `<option value="super_admin" ${user && user.role === 'super_admin' ? 'selected' : ''}>超级管理员（super_admin）— 全部权限 + 跳过数据过滤</option>`
                  : ''}
              </select></div>
          </div>
          <div><label class="text-xs text-gray-500 mb-1 block">归属小组</label>
            <select id="u-group" class="w-full h-10 px-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-blue-400">
              <option value="">— 先不分组 —</option>
              ${groups.map(g => `<option value="${g.id}" ${user && user.groupId === g.id ? 'selected' : ''}>${g.name}</option>`).join('')}
            </select>
          </div>
          <div><label class="text-xs text-gray-500 mb-1 block">${isEdit ? '重置密码（留空不改）' : '初始密码（留空使用默认 123456）'}</label>
            <input id="u-password" type="text" class="w-full h-10 px-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-blue-400" placeholder="${isEdit ? '留空则不修改密码' : '留空 = 默认密码 123456'}"></div>
        </div>
        <div class="flex justify-end gap-2 mt-6">
          <button class="px-4 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50" data-close-modal>取消</button>
          <button class="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700" id="u-save">保存</button>
        </div>
      </div>
    </div>
  `;
}

function bindUsersEvents() {
  const add = document.getElementById('btn-add-user');
  if (add) add.onclick = () => { state.editingUser = null; state.modal = 'user-form'; render(); };

  const refresh = document.getElementById('btn-refresh-users');
  if (refresh) refresh.onclick = async () => {
    try { const data = await API.listUsers(); state.users = data.items || []; render(); }
    catch (e) { alert(e.message || '刷新失败'); }
  };

  document.querySelectorAll('.user-edit').forEach(btn => {
    btn.onclick = () => {
      const id = parseInt(btn.dataset.id);
      state.editingUser = state.users.find(x => x.id === id);
      state.modal = 'user-form'; render();
    };
  });
  document.querySelectorAll('.user-reset').forEach(btn => {
    btn.onclick = async () => {
      const id = parseInt(btn.dataset.id);
      const u = state.users.find(x => x.id === id);
      if (!confirm('确定给账号 ' + u.account + ' 重置密码？留空使用默认密码 123456')) return;
      const pw = prompt('新密码（留空使用默认密码）') || '';
      try { await API.resetUserPassword(id, pw); alert('密码已重置'); }
      catch (e) { alert(e.message || '重置失败'); }
    };
  });
  document.querySelectorAll('.user-del').forEach(btn => {
    btn.onclick = async () => {
      const id = parseInt(btn.dataset.id);
      const u = state.users.find(x => x.id === id);
      if (!confirm('确定删除账号 ' + u.account + '（' + u.name + '）？该账号会立即无法登录。')) return;
      try {
        await API.deleteUser(id);
        state.users = state.users.filter(x => x.id !== id);
        state.usersForSelect = state.usersForSelect.filter(x => x.id !== id);
        render();
      }
      catch (e) { alert(e.message || '删除失败'); }
    };
  });

  const saveBtn = document.getElementById('u-save');
  if (saveBtn) saveBtn.onclick = async () => {
    const account = document.getElementById('u-account').value.trim();
    const name = document.getElementById('u-name').value.trim();
    const phone = document.getElementById('u-phone').value.trim();
    const role = document.getElementById('u-role').value;
    const gid_str = document.getElementById('u-group').value;
    const password = document.getElementById('u-password').value.trim();
    if (!account || !name) { alert('账号和姓名必填'); return; }
    const body = { account: account, name: name, phone: phone, role: role };
    if (gid_str) body.groupId = parseInt(gid_str);
    if (password) body.password = password;
    try {
      if (state.editingUser) await API.updateUser(state.editingUser.id, body);
      else await API.createUser(body);
      state.modal = null; state.editingUser = null;
      const data = await API.listUsers(); state.users = data.items || [];
      // 同步刷新用户选择列表
      try { const sd = await API.listUsersForSelect(); state.usersForSelect = (sd && sd.items) || []; } catch(e) {}
      render();
    } catch (e) { alert(e.message || '保存失败'); }
  };
}

// ============ 事件绑定 ============
function bindEvents() {
  bindUsersEvents();

  // 侧边栏切换
  document.querySelectorAll('.sidebar-item').forEach(el => {
    el.onclick = () => {
      state.page = el.dataset.page;
      state.currentPage = 1;
      state.detailId = null;
      state.modal = null;
      render();
      if (state.page === 'buyer-districts') onEnterBuyerDistrictsPage();
    };
  });

  // 返回列表
  document.querySelectorAll('[data-back]').forEach(el => {
    el.onclick = () => { state.detailId = null; render(); };
  });

  // ---- 集团客户部 · 批量导入 ----
  document.querySelectorAll('#annImportBtn').forEach(el => {
    el.onclick = () => { state.modal = 'ann-import'; render(); };
  });

  // ---- 集团客户部 · 新增 / 修改 / 删除 ----
  document.querySelectorAll('#annAddBtn').forEach(el => {
    el.onclick = () => {
      state.formAnnId = null;
      state.modal = 'ann-form';
      render();
    };
  });
  document.querySelectorAll('#annEditBtn').forEach(el => {
    el.onclick = () => {
      const ids = Array.from(state.selectedAnnIds);
      if (ids.length === 0) { alert('请先勾选一条公告再修改'); return; }
      if (ids.length > 1) { alert('修改只能选择单条，不能多选'); return; }
      state.formAnnId = ids[0];
      state.modal = 'ann-form';
      render();
    };
  });
  document.querySelectorAll('[data-edit-ann]').forEach(el => {
    el.onclick = (e) => {
      const id = e.currentTarget.dataset.editAnn;
      state.formAnnId = id;
      state.modal = 'ann-form';
      render();
    };
  });
  document.querySelectorAll('#annDeleteBtn').forEach(el => {
    el.onclick = async () => {
      const ids = Array.from(state.selectedAnnIds);
      if (ids.length === 0) { alert('请先勾选要删除的公告'); return; }
      const preview = state.announcements
        .filter(a => ids.includes(a.id))
        .map(a => '· ' + (a.projectName || a.title) + '（' + a.id + '）')
        .join('\n');
      if (!confirm('确认删除以下 ' + ids.length + ' 条公告？\n\n' + preview + '\n\n⚠ 删除后无法恢复（后台为逻辑删除）。')) return;
      let ok = 0, fail = [];
      for (const id of ids) {
        try {
          await API.deleteAnnouncement(id);
          ok++;
        } catch (e) {
          fail.push(id + '：' + (e.message || '删除失败'));
        }
      }
      state.selectedAnnIds.clear();
      try { await refreshAfterMutation(); } catch (e) { alert(e.message || '刷新失败'); }
      let msg = '删除成功 ' + ok + ' 条';
      if (fail.length) msg += '\n失败 ' + fail.length + ' 条：\n' + fail.join('\n');
      if (fail.length) alert(msg); else alert(msg);
      render();
    };
  });
  // ann-form 弹窗保存 / 取消
  document.querySelectorAll('#annFormCancel').forEach(el => {
    el.onclick = () => { state.modal = null; state.formAnnId = null; render(); };
  });
  document.querySelectorAll('#annFormSave').forEach(el => {
    el.onclick = async () => {
      const body = collectAnnFormData();
      const missing = annFormMissingFields(body);
      if (missing.length > 0) {
        const ok = confirm('以下 ' + missing.length + ' 个字段未填写：\n' + missing.map(m => '· ' + m).join('\n') + '\n\n确认仍然保存？');
        if (!ok) return;
      }
      try {
        let updated;
        if (state.formAnnId) {
          updated = await API.updateAnnouncement(state.formAnnId, body);
        } else {
          updated = await API.createAnnouncement(body);
        }
        state.modal = null;
        state.formAnnId = null;
        state.selectedAnnIds.clear();
        mergeAnnouncement(updated);
        await reloadReminders();
      } catch (e) {
        alert(e.message || '保存失败');
        return;
      }
      render();
    };
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
    el.onclick = () => { openAnnouncementDetail(el.dataset.detail); };
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
      const memberNames = (g && g.memberDetails && g.memberDetails.length > 0)
        ? g.memberDetails.map(m => m.name)
        : (g ? (g.members || []) : []);
      bReceiver.innerHTML = g ?
        `<option value="${g.admin}">${g.admin}（管理员）</option>` +
        memberNames.map(m => `<option value="${m}">${m}</option>`).join('') :
        '<option value="">请选择接收人</option>';
    };
  }
  // ---- 批量确认分配 ----
  const bConfirm = document.querySelectorAll('[data-confirm-batch-assign]');
  bConfirm.forEach(el => el.onclick = async () => {
    const group = document.getElementById('batch-assign-group').value;
    const receiver = document.getElementById('batch-assign-receiver').value;
    if (!group || !receiver) { alert('请选择小组和接收人'); return; }
    const ids = Array.from(state.selectedAnnIds);
    if (ids.length === 0) return;
    let res;
    try {
      res = await API.batchAssign(ids, group, receiver);
    } catch (e) {
      alert(e.message || '批量分配失败');
      return;
    }
    const updated = (res && typeof res.updated === 'number') ? res.updated : ids.length;
    let msg = '已批量分配 ' + updated + ' 条给 ' + group;
    if (res && Array.isArray(res.skipped) && res.skipped.length > 0) {
      msg += '\n跳过 ' + res.skipped.length + ' 条：' +
        res.skipped.map(s => `${s.id}（${s.reason || '不可分配'}）`).join('、');
    }
    alert(msg);
    state.selectedAnnIds.clear();
    state.modal = null;
    try {
      await refreshAfterMutation();
    } catch (e) {
      alert(e.message || '数据刷新失败');
    }
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
    el.onclick = async () => {
      const v = prompt('新增关键词（多个用顿号、空格或逗号分隔）');
      if (v && v.trim()) {
        const parts = v.split(/[、,，\s]+/).filter(x => x.trim());
        const list = Array.from(SCHEDULE_CONFIG.keywordList || []);
        parts.forEach(p => {
          if (p && !list.includes(p)) list.push(p);
        });
        try {
          SCHEDULE_CONFIG = await API.updateSchedule({ keywordList: list });
          render();
        } catch (e) {
          alert(e.message || '关键词保存失败');
        }
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
    el.onclick = async () => {
      const cbs = [...document.querySelectorAll('.kw-del-cb:checked')];
      const idxs = cbs.map(c => parseInt(c.dataset.kw)).sort((a,b)=>b-a);
      if (idxs.length === 0) return;
      if (!confirm('确认删除选中的 ' + idxs.length + ' 个关键词？')) return;
      const list = Array.from(SCHEDULE_CONFIG.keywordList || []);
      idxs.forEach(i => list.splice(i, 1));
      try {
        SCHEDULE_CONFIG = await API.updateSchedule({ keywordList: list });
        state.modal = null;
        render();
      } catch (e) {
        alert(e.message || '关键词删除失败');
      }
    };
  });
  // ---- 定时任务启用 / 暂停 ----
  document.querySelectorAll('[data-schedule-toggle]').forEach(el => {
    el.onclick = async () => {
      const field = el.dataset.scheduleToggle;
      const current = SCHEDULE_CONFIG[field];
      let next;
      if (field === 'crawlStatus') next = current === '已暂停' ? '运行中' : '已暂停';
      else next = current ? '' : '1';
      try {
        SCHEDULE_CONFIG = await API.updateSchedule({ [field]: next });
        render();
      } catch (e) {
        alert(e.message || '定时任务状态更新失败');
      }
    };
  });

  // ---- 数据源管理事件 ----
  document.querySelectorAll('.source-toggle').forEach(el => {
    el.onchange = async () => {
      const s = SOURCES_DATA[parseInt(el.dataset.idx)];
      if (!s) return;
      try {
        await API.patchSource(s.id, { enabled: el.checked });
        await reloadSourcesAndStatus();
        render();
      } catch (e) {
        el.checked = !el.checked;
        alert(e.message || '数据源状态更新失败');
      }
    };
  });
  document.querySelectorAll('.source-edit').forEach(el => {
    el.onclick = async () => {
      const i = parseInt(el.dataset.idx);
      const s = SOURCES_DATA[i];
      if (!s) return;
      const name = prompt('网站名称', s.name);
      if (name === null) return;
      const url = prompt('网址', s.url);
      if (url === null) return;
      const code = prompt('sourceCode (czggzy / ccgp / gdgpo / generic)', s.sourceCode);
      if (code === null) return;
      let domain;
      try {
        domain = new URL(url.trim()).hostname.toLowerCase();
      } catch (e) {
        alert('网址格式错误');
        return;
      }
      try {
        await API.patchSource(s.id, {
          name: name.trim(),
          url: url.trim(),
          domain: domain,
          sourceCode: (code.trim() || 'generic'),
        });
        await reloadSourcesAndStatus();
        render();
      } catch (e) {
        alert(e.message || '数据源保存失败');
      }
    };
  });
  document.querySelectorAll('.source-del').forEach(el => {
    el.onclick = async () => {
      const s = SOURCES_DATA[parseInt(el.dataset.idx)];
      if (!s) return;
      if (!confirm('确认删除该数据源？')) return;
      try {
        await API.deleteSource(s.id);
        await reloadSourcesAndStatus();
        render();
      } catch (e) {
        alert(e.message || '数据源删除失败');
      }
    };
  });
  document.querySelectorAll('.source-refresh').forEach(el => {
    el.onclick = async () => {
      const s = SOURCES_DATA[parseInt(el.dataset.idx)];
      if (!s) return;
      try {
        await API.refreshSource(s.id);
        await reloadSourcesAndStatus();
        render();
      } catch (e) {
        alert(e.message || '站点探活失败');
      }
    };
  });
  document.querySelectorAll('#btn-add-source').forEach(el => {
    el.onclick = async () => {
      const name = prompt('网站名称');
      if (!name) return;
      const url = prompt('网址');
      if (!url) return;
      const code = prompt('sourceCode (czggzy / ccgp / gdgpo / generic)', 'generic') || 'generic';
      let domain;
      try {
        domain = new URL(url.trim()).hostname.toLowerCase();
      } catch (e) {
        alert('网址格式错误');
        return;
      }
      try {
        await API.createSource({
          name: name.trim(),
          url: url.trim(),
          domain: domain,
          sourceCode: (code.trim() || 'generic'),
          enabled: true,
        });
        await reloadSourcesAndStatus();
        render();
      } catch (e) {
        alert(e.message || '数据源新增失败');
      }
    };
  });

  // 刷新抓取（公告页头部 / 定时任务页手动触发）
  document.querySelectorAll('#btn-refresh, #btn-manual-collect').forEach(el => {
    el.onclick = () => { triggerCollect(); };
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

  // 新增小组（弹窗方式，负责人从用户列表选）
  document.querySelectorAll('[data-add-group]').forEach(el => {
    el.onclick = async () => {
      // 每次打开弹窗都刷新用户选择列表
      try { const data = await API.listUsersForSelect(); state.usersForSelect = (data && data.items) || []; }
      catch (e) { /* 静默 */ }
      state.modal = 'add-group';
      render();
    };
  });

  // 打开修改小组弹窗
  document.querySelectorAll('[data-edit-group]').forEach(el => {
    el.onclick = async () => {
      // 每次打开弹窗都刷新用户选择列表
      try { const data = await API.listUsersForSelect(); state.usersForSelect = (data && data.items) || []; }
      catch (e) { /* 静默 */ }
      state.editGroupId = parseInt(el.dataset.editGroup);
      state.modal = 'edit-group';
      render();
    };
  });

  // 负责人下拉联动：选人后自动填充姓名/联系方式/账号（编辑弹窗）
  const adminUserSel = document.getElementById('edit-admin-user');
  if (adminUserSel) {
    adminUserSel.onchange = () => {
      const uid = parseInt(adminUserSel.value);
      const u = (state.usersForSelect || []).find(x => x.id === uid);
      const nameEl = document.getElementById('edit-admin');
      const contactEl = document.getElementById('edit-admin-contact');
      const accountEl = document.getElementById('edit-admin-account');
      if (u) {
        if (nameEl) nameEl.value = u.name;
        if (contactEl) contactEl.value = u.phone || '';
        if (accountEl) accountEl.value = u.account;
      } else {
        if (nameEl) nameEl.value = '';
        if (contactEl) contactEl.value = '';
        if (accountEl) accountEl.value = '';
      }
    };
  }

  // 负责人下拉联动：新增弹窗
  const addAdminUserSel = document.getElementById('add-admin-user');
  if (addAdminUserSel) {
    addAdminUserSel.onchange = () => {
      const uid = parseInt(addAdminUserSel.value);
      const u = (state.usersForSelect || []).find(x => x.id === uid);
      const nameEl = document.getElementById('add-admin');
      const contactEl = document.getElementById('add-admin-contact');
      const accountEl = document.getElementById('add-admin-account');
      if (u) {
        if (nameEl) nameEl.value = u.name;
        if (contactEl) contactEl.value = u.phone || '';
        if (accountEl) accountEl.value = u.account;
      } else {
        if (nameEl) nameEl.value = '';
        if (contactEl) contactEl.value = '';
        if (accountEl) accountEl.value = '';
      }
    };
  }

  // 创建小组按钮
  document.querySelectorAll('[data-save-new-group]').forEach(el => {
    el.onclick = async () => {
      const name = document.getElementById('add-name').value.trim();
      const region = document.getElementById('add-region').value.trim();
      if (!name) { alert('请填写小组名称'); return; }
      if (!region) { alert('请填写所属区域'); return; }
      const adminVal = document.getElementById('add-admin').value.trim();
      const adminAccountVal = document.getElementById('add-admin-account').value.trim();
      if (!adminVal || !adminAccountVal) { alert('请选择负责人'); return; }
      const body = {
        name: name,
        region: region,
        admin: adminVal,
        adminContact: document.getElementById('add-admin-contact').value.trim(),
        adminAccount: adminAccountVal,
        position: '负责人',
        members: [],
      };
      const pw = document.getElementById('add-password');
      if (pw && pw.value.trim()) body.password = pw.value.trim();
      // 收集成员
      document.querySelectorAll('#edit-members .member-row').forEach(row => {
        const sel = row.querySelector('.member-user-select');
        const userId = sel ? (parseInt(sel.value) || null) : null;
        const u = userId ? (state.usersForSelect || []).find(x => x.id === userId) : null;
        if (userId && u) {
          body.members.push({
            userId: userId,
            name: u.name,
            namePinyin: u.account,
            contact: u.phone || '',
            position: row.dataset.position || '成员',
          });
        }
      });
      try {
        await API.createGroup(body);
        await loadGroups();
        state.modal = null;
        render();
      } catch (e) {
        alert(e.message || '新增小组失败');
      }
    };
  });

  // 成员下拉联动：选人后更新头像
  document.querySelectorAll('.member-user-select').forEach(sel => {
    sel.onchange = () => {
      const uid = parseInt(sel.value);
      const u = (state.usersForSelect || []).find(x => x.id === uid);
      const row = sel.closest('.member-row');
      if (row) {
        const avatar = row.querySelector('.w-7');
        if (avatar) avatar.textContent = u ? u.name[0] : '?';
      }
    };
  });

  // 修改弹窗内：加一行成员（用户下拉选）
  const addMemberBtn = document.querySelector('[data-add-member-line]');
  if (addMemberBtn) {
    addMemberBtn.onclick = () => {
      const box = document.getElementById('edit-members');
      if (!box) return;
      // 计算已有成员的 userId 用于排除
      const existingIds = new Set();
      document.querySelectorAll('#edit-members .member-user-select').forEach(s => {
        if (s.value) existingIds.add(parseInt(s.value));
      });
      const adminSel = document.getElementById('edit-admin-user');
      if (adminSel && adminSel.value) existingIds.add(parseInt(adminSel.value));

      const div = document.createElement('div');
      div.className = 'flex items-center gap-2 member-row';
      div.dataset.position = '成员';
      div.innerHTML = `
        <div class="w-7 h-7 bg-blue-500 rounded-full flex items-center justify-center text-white text-xs font-semibold flex-shrink-0">?</div>
        <select class="member-user-select flex-1 min-w-0 h-9 px-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-blue-400 bg-white" data-user-id="">
          ${renderUserSelectOptions(null, existingIds, '— 选择用户 —')}
        </select>
        <button class="text-red-500 hover:text-red-700 text-sm px-2 remove-member" title="删除">✕</button>
      `;
      box.appendChild(div);
      bindMemberRow(div);
      // 绑定下拉联动
      const newSel = div.querySelector('.member-user-select');
      if (newSel) {
        newSel.onchange = () => {
          const uid = parseInt(newSel.value);
          const u = (state.usersForSelect || []).find(x => x.id === uid);
          const avatar = div.querySelector('.w-7');
          if (avatar) avatar.textContent = u ? u.name[0] : '?';
        };
      }
    };
  }

  // 保存修改
  document.querySelectorAll('[data-save-group]').forEach(el => {
    el.onclick = async () => {
      const g = TEAM_GROUPS.find(x => x.id === state.editGroupId);
      if (!g) return;
      const adminUserSel2 = document.getElementById('edit-admin-user');
      const adminUserIdVal = adminUserSel2 ? parseInt(adminUserSel2.value) || null : null;
      const body = {
        name: document.getElementById('edit-name').value.trim() || g.name,
        region: document.getElementById('edit-region').value.trim() || g.region,
        admin: document.getElementById('edit-admin').value.trim() || g.admin,
        adminContact: document.getElementById('edit-admin-contact').value.trim() || g.adminContact,
        adminAccount: document.getElementById('edit-admin-account').value.trim() || g.adminAccount,
        position: g.position || '负责人',
        members: [],
      };
      document.querySelectorAll('#edit-members .member-row').forEach(row => {
        const sel = row.querySelector('.member-user-select');
        const userId = sel ? (parseInt(sel.value) || null) : null;
        const u = userId ? (state.usersForSelect || []).find(x => x.id === userId) : null;
        if (userId && u) {
          body.members.push({
            userId: userId,
            name: u.name,
            namePinyin: u.account,
            contact: u.phone || '',
            position: row.dataset.position || '成员',
          });
        }
      });
      if (!body.admin || !body.adminAccount) {
        alert('请选择负责人');
        return;
      }
      try {
        await API.updateGroup(g.id, body);
        await loadGroups();
        state.modal = null;
        state.editGroupId = null;
        render();
      } catch (e) {
        alert(e.message || '小组保存失败');
      }
    };
  });

  // 删除小组（集团客户部由后端禁止删除）
  document.querySelectorAll('[data-delete-group]').forEach(el => {
    el.onclick = async () => {
      const id = parseInt(el.dataset.deleteGroup);
      const g = TEAM_GROUPS.find(x => x.id === id);
      if (!g) return;
      if (!confirm(`确认删除小组「${g.name}」？`)) return;
      try {
        await API.deleteGroup(id);
        await loadGroups();
        state.modal = null;
        state.editGroupId = null;
        render();
      } catch (e) {
        alert(e.message || '删除小组失败');
      }
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
  function buildReceiverOptions(g) {
    if (!g) return '<option value="">请选择接收人</option>';
    const memberNames = (g.memberDetails && g.memberDetails.length > 0)
      ? g.memberDetails.map(m => m.name)
      : (g.members || []);
    return `<option value="${g.admin}">${g.admin}（管理员）</option>` +
      memberNames.map(m => `<option value="${m}">${m}</option>`).join('');
  }
  const groupSel = document.getElementById('assign-group');
  const recvSel = document.getElementById('assign-receiver');
  if (groupSel && recvSel) {
    groupSel.onchange = () => {
      const g = TEAM_GROUPS.find(x => x.name === groupSel.value);
      recvSel.innerHTML = buildReceiverOptions(g);
    };
  }

  // 确认分配
  document.querySelectorAll('[data-confirm-assign]').forEach(el => {
    el.onclick = async () => {
      const group = document.getElementById('assign-group').value;
      const receiver = document.getElementById('assign-receiver').value;
      if (!group || !receiver) { alert('请选择小组和接收人'); return; }
      const id = state.assignAnnId;
      let updated;
      try {
        updated = await API.assign(id, group, receiver);
      } catch (e) {
        alert(e.message || '分配失败');
        return;
      }
      mergeAnnouncement(updated);
      state.modal = null;
      state.assignAnnId = null;
      try {
        await reloadReminders();
      } catch (e) {
        alert(e.message || '提醒刷新失败');
      }
      render();
    };
  });

  // 确认进度更新
  document.querySelectorAll('[data-confirm-progress]').forEach(el => {
    el.onclick = async () => {
      const progress = document.getElementById('progress-select').value;
      const note = document.getElementById('progress-note').value;
      const id = state.progressAnnId;
      let updated;
      try {
        updated = await API.setProgress(id, progress, note);
      } catch (e) {
        alert(e.message || '进度更新失败');
        return;
      }
      mergeAnnouncement(updated);
      state.modal = null;
      state.progressAnnId = null;
      try {
        await reloadReminders();
      } catch (e) {
        alert(e.message || '提醒刷新失败');
      }
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
      const id = cb.dataset.id;
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
      const memberNames = (g && g.memberDetails && g.memberDetails.length > 0)
        ? g.memberDetails.map(m => m.name)
        : (g ? (g.members || []) : []);
      reminderBatchRecvSel.innerHTML = g ?
        `<option value="${g.admin}">${g.admin}（管理员）</option>` +
        memberNames.map(m => `<option value="${m}">${m}</option>`).join('') :
        '<option value="">请选择接收人</option>';
    };
  }

  // 确认批量分配
  document.querySelectorAll('[data-confirm-reminder-batch-assign]').forEach(el => {
    el.onclick = async () => {
      const group = document.getElementById('reminder-batch-group').value;
      const receiver = document.getElementById('reminder-batch-receiver').value;
      if (!group || !receiver) { alert('请选择小组和接收人'); return; }

      const annIds = [...state.selectedReminderIds]
        .map(rid => state.reminders.find(r => String(r.id) === String(rid)))
        .filter(Boolean)
        .map(r => r.targetId);
      const uniqueAnnIds = [...new Set(annIds)];
      if (uniqueAnnIds.length === 0) return;

      let res;
      try {
        res = await API.batchAssignReminders(uniqueAnnIds, group);
      } catch (e) {
        alert(e.message || '批量分配失败');
        return;
      }
      const updated = (res && typeof res.updated === 'number') ? res.updated : uniqueAnnIds.length;
      state.selectedReminderIds.clear();
      state.modal = null;
      alert(`✅ 批量分配成功：共更新 ${updated} 条公告的分配状态`);
      try {
        await refreshAfterMutation();
      } catch (e) {
        alert(e.message || '数据刷新失败');
      }
      render();
    };
  });

  // 收尾：修正全选框 indeterminate 状态
  patchReminderCheckboxIndeterminate();
  // 修改弹窗内：初始成员行绑定删除按钮
  document.querySelectorAll('#edit-members .member-row').forEach(row => bindMemberRow(row));

  // ============ 基础资料 · 采购人-区县 事件 ============
  // 搜索
  const bdSearch = document.getElementById('bd-search');
  if (bdSearch) bdSearch.onkeydown = (e) => {
    if (e.key === 'Enter') {
      state.buyerDistrictKeyword = bdSearch.value.trim();
      state.buyerDistrictPage = 1;
      loadBuyerDistricts().then(() => { render(); });
    }
  };
  // 新增按钮
  document.querySelectorAll('#btn-bd-add').forEach(el => {
    el.onclick = () => {
      state.buyerDistrictEditId = null;
      state._bdEditing = { buyer: '', district: '', remark: '' };
      state.modal = 'bd-form';
      render();
    };
  });
  // 批量导入按钮
  document.querySelectorAll('#btn-bd-import').forEach(el => {
    el.onclick = () => { state.modal = 'bd-import'; render(); };
  });
  // 表格行：编辑
  document.querySelectorAll('.bd-edit').forEach(btn => {
    btn.onclick = () => {
      const id = parseInt(btn.dataset.id, 10);
      const row = state.buyerDistrictList.find(r => r.id === id);
      if (!row) return;
      state.buyerDistrictEditId = id;
      state._bdEditing = { buyer: row.buyer, district: row.district, remark: row.remark };
      state.modal = 'bd-form';
      render();
    };
  });
  // 表格行：删除
  document.querySelectorAll('.bd-del').forEach(btn => {
    btn.onclick = async () => {
      const id = parseInt(btn.dataset.id, 10);
      const name = btn.dataset.name;
      if (!confirm(`确认删除采购人「${name}」？`)) return;
      try {
        await API.deleteBuyerDistrict(id);
        await loadBuyerDistricts();
        render();
      } catch (e) { alert(e.message || '删除失败'); }
    };
  });
  // 分页
  document.querySelectorAll('.bd-page-btn').forEach(btn => {
    btn.onclick = () => {
      state.buyerDistrictPage = parseInt(btn.dataset.page, 10);
      loadBuyerDistricts().then(() => { render(); });
    };
  });

  // ---- 表单弹窗事件 ----
  if (document.getElementById('bd-form-modal')) {
    const close = () => { state.modal = null; state._bdEditing = null; state.buyerDistrictEditId = null; render(); };
    document.querySelectorAll('#bd-form-close, #bd-form-cancel').forEach(el => el.onclick = close);
    document.getElementById('bd-form-save').onclick = async () => {
      const buyer = document.getElementById('bd-f-buyer').value.trim();
      const district = document.getElementById('bd-f-district').value.trim();
      const remark = document.getElementById('bd-f-remark').value.trim();
      if (!buyer) { alert('采购人不能为空'); return; }
      try {
        if (state.buyerDistrictEditId) {
          await API.updateBuyerDistrict(state.buyerDistrictEditId, { buyer, district, remark });
        } else {
          await API.createBuyerDistrict({ buyer, district, remark });
        }
        state.modal = null;
        state._bdEditing = null;
        state.buyerDistrictEditId = null;
        await loadBuyerDistricts();
        render();
      } catch (e) { alert(e.message || '保存失败'); }
    };
  }

  // ---- 导入弹窗事件 ----
  if (document.getElementById('bd-import-modal')) {
    document.querySelectorAll('#bd-import-close, #bd-import-cancel').forEach(el => {
      el.onclick = () => { state.modal = null; render(); };
    });
    document.getElementById('bd-import-submit').onclick = async () => {
      const fileInput = document.getElementById('bd-import-file');
      const modeRadio = document.querySelector('input[name="bd-import-mode"]:checked');
      const skipDup = !modeRadio || modeRadio.value === 'skip';

      const errBox = document.getElementById('bd-import-error');
      const resBox = document.getElementById('bd-import-result');
      errBox.classList.add('hidden');
      resBox.classList.add('hidden');

      if (!fileInput.files || !fileInput.files[0]) {
        errBox.textContent = '请先选择 Excel 文件';
        errBox.classList.remove('hidden');
        return;
      }
      const file = fileInput.files[0];
      if (!/\.(xlsx|xls)$/i.test(file.name)) {
        errBox.textContent = '只支持 .xlsx / .xls 格式';
        errBox.classList.remove('hidden');
        return;
      }

      const submitBtn = document.getElementById('bd-import-submit');
      submitBtn.disabled = true; submitBtn.textContent = '导入中...';
      try {
        const res = await API.importBuyerDistrictExcel(file, skipDup);
        const errList = res.errors || [];
        let text = `✅ 导入完成：新增 ${res.created} 条，更新 ${res.updated} 条，跳过 ${res.skipped} 条`;
        if (errList.length > 0) {
          text += `\n⚠️ 异常 ${errList.length} 行：\n` + errList.slice(0, 10).map(e => `  第 ${e.line} 行：${e.reason}`).join('\n');
          if (errList.length > 10) text += `\n  ...还有 ${errList.length - 10} 行`;
        }
        document.getElementById('bd-import-result-text').textContent = text;
        resBox.classList.remove('hidden');
        await loadBuyerDistricts();
        // 刷新当前页展示
      } catch (e) {
        errBox.textContent = '❌ 导入失败：' + (e.message || '未知错误');
        errBox.classList.remove('hidden');
      } finally {
        submitBtn.disabled = false; submitBtn.textContent = '开始导入';
      }
    };
  }

  // ---- 招标公告导入弹窗事件 ----
  if (document.getElementById('ann-import-modal')) {
    document.querySelectorAll('#ann-import-close, #ann-import-cancel').forEach(el => {
      el.onclick = () => { state.modal = null; render(); };
    });
    document.getElementById('ann-import-submit').onclick = async () => {
      const fileInput = document.getElementById('ann-import-file');
      const modeRadio = document.querySelector('input[name="ann-import-mode"]:checked');
      const skipDup = !modeRadio || modeRadio.value === 'skip';

      const errBox = document.getElementById('ann-import-error');
      const resBox = document.getElementById('ann-import-result');
      errBox.classList.add('hidden');
      resBox.classList.add('hidden');

      if (!fileInput.files || !fileInput.files[0]) {
        errBox.textContent = '请先选择 Excel 文件';
        errBox.classList.remove('hidden');
        return;
      }
      const file = fileInput.files[0];
      if (!/\.(xlsx|xls)$/i.test(file.name)) {
        errBox.textContent = '只支持 .xlsx / .xls 格式';
        errBox.classList.remove('hidden');
        return;
      }

      const submitBtn = document.getElementById('ann-import-submit');
      submitBtn.disabled = true; submitBtn.textContent = '导入中...';
      try {
        const res = await API.importAnnouncementsExcel(file, skipDup);
        const errList = res.errors || [];
        let text = `✅ 导入完成：新增 ${res.created} 条，更新 ${res.updated} 条，跳过 ${res.skipped} 条`;
        if (errList.length > 0) {
          text += `\n⚠️ 异常 ${errList.length} 行：\n` + errList.slice(0, 10).map(e => `  第 ${e.line} 行：${e.reason}`).join('\n');
          if ((res.total_errors || errList.length) > 10) text += `\n  ...还有 ${(res.total_errors || errList.length) - 10} 行`;
        }
        document.getElementById('ann-import-result-text').textContent = text;
        resBox.classList.remove('hidden');
        // 刷新公告列表 state（复用现成的刷新函数，保留当前筛选/页码）
        // 不主动 render()，否则 Modal 里的结果框会被清掉；
        // 关闭 Modal 时会触发 render()，列表自然刷新
        await refreshAfterMutation();
      } catch (e) {
        errBox.textContent = '❌ 导入失败：' + (e.message || '未知错误');
        errBox.classList.remove('hidden');
      } finally {
        submitBtn.disabled = false; submitBtn.textContent = '开始导入';
      }
    };
  }
}


init();
