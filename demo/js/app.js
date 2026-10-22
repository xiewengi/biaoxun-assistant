// 标讯助手 Demo - 主应用逻辑
let state = {
  page: 'announcements',
  announcements: [],
  siteResults: [],        // 真实站点采集结果
  filteredList: [],
  reminders: [],
  filters: { keyword: '', region: '', district: '', progress: '', businessTag: '' },
  detailId: null,
  modal: null, // 'assign' | 'progress' | 'add-group' | null
  assignAnnId: null,
  progressAnnId: null,
  // 翻页
  pageSize: 10,           // 10 / 50 / 100 / 0(全部)
  currentPage: 1,
};

// ============ 初始化 ============
async function init() {
  state.announcements = await loadAnnouncements();
  state.siteResults = await loadSiteResults();
  state.reminders = generateReminders(state.announcements);
  applyFilters();
  render();
}

// ============ 筛选逻辑 ============
function applyFilters() {
  const f = state.filters;
  state.filteredList = state.announcements.filter(a => {
    if (f.keyword) {
      const kw = f.keyword.toLowerCase();
      if (!a.title.toLowerCase().includes(kw) && !a.buyer.toLowerCase().includes(kw) && !a.matchedKeywords.some(k => k.toLowerCase().includes(kw)))
        return false;
    }
    if (f.region && a.region !== f.region) return false;
    if (f.district && a.district !== f.district) return false;
    if (f.progress && a.progress !== f.progress) return false;
    if (f.businessTag && a.businessTag !== f.businessTag) return false;
    return true;
  });
  state.filteredList.sort((a, b) => b.pubDate.localeCompare(a.pubDate));
  state.currentPage = 1;  // 筛选变化时回到第一页
}

// ============ 渲染主框架 ============
function render() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="flex h-screen overflow-hidden">
      ${renderSidebar()}
      <div class="flex-1 flex flex-col overflow-hidden">
        ${renderHeader()}
        <main class="flex-1 overflow-auto scrollbar-thin p-6">
          ${renderPage()}
        </main>
      </div>
    </div>
    ${state.modal === 'assign' ? renderAssignModal() : ''}
    ${state.modal === 'progress' ? renderProgressModal() : ''}
    ${state.modal === 'add-group' ? renderAddGroupModal() : ''}
  `;
  bindEvents();
}

function renderSidebar() {
  const items = [
    { key: 'announcements', label: '招标公告', icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01' },
    { key: 'reminders', label: '任务提醒', icon: 'M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9' },
    { key: 'team', label: '团队管理', icon: 'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z' },
    { key: 'schedule', label: '定时任务', icon: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z' },
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
            ${i.key === 'reminders' && state.reminders.filter(r => r.level === 'urgent').length > 0 ? `<span class="ml-auto bg-red-500 text-white text-xs px-1.5 py-0.5 rounded-full">${state.reminders.filter(r => r.level === 'urgent').length}</span>` : ''}
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
  const pageTitle = { announcements: '招标公告', reminders: '任务提醒', team: '团队管理', schedule: '定时任务配置' }[state.page];
  const stats = getStats();
  const siteOk = state.siteResults.filter(r => r.ok).length;
  const lastCrawl = state.siteResults.length > 0 
    ? new Date(Math.max(...state.siteResults.map(r => 0))).toLocaleString('zh-CN') 
    : '—';
  return `
    <header class="h-16 bg-white border-b border-gray-200 flex items-center px-6 gap-6">
      <div>
        <h1 class="text-lg font-semibold text-gray-900">${pageTitle}</h1>
        <p class="text-xs text-gray-400">当前共 ${state.filteredList.length} 条公告 · 数据来源 ${siteOk}/${SCHEDULE_CONFIG.totalSites} 个网站</p>
      </div>
      ${state.page === 'announcements' ? `
        <div class="ml-auto flex items-center gap-2">
          <div class="text-sm text-gray-500">
            <span class="font-semibold text-gray-700">${stats.todayCount}</span> 今日新增 · 
            <span class="font-semibold text-orange-600">${stats.unassignedCount}</span> 待分配 · 
            <span class="font-semibold text-blue-600">${stats.inProgressCount}</span> 跟进中
          </div>
          <button class="text-xs text-gray-400 hover:text-blue-600 px-3 py-1.5 border border-gray-200 rounded-lg" id="btn-refresh">
            🔄 刷新抓取
          </button>
        </div>
      ` : `<div class="ml-auto text-sm text-gray-500">管理员：王经理</div>`}
    </header>
  `;
}

function getStats() {
  const today = new Date().toISOString().slice(0, 10);
  return {
    todayCount: state.announcements.filter(a => a.pubDate === today).length,
    unassignedCount: state.announcements.filter(a => a.progress === '待分配' || !a.currentHandler).length,
    inProgressCount: state.announcements.filter(a => a.progress === '待跟进' || a.progress === '跟进中').length,
  };
}

// ============ 页面渲染 ============
function renderPage() {
  if (state.detailId) return renderAnnouncementDetail();
  switch (state.page) {
    case 'announcements': return renderAnnouncementList();
    case 'reminders': return renderReminders();
    case 'team': return renderTeam();
    case 'schedule': return renderSchedule();
  }
}

// ---- 招标公告列表 ----
function renderAnnouncementList() {
  const districts = [...new Set(state.announcements.map(a => a.district))].sort();
  const tags = [...new Set(state.announcements.map(a => a.businessTag))].sort();
  const progresses = ['待分配', '待跟进', '跟进中', '有意向', '已投标', '已中标', '已完成', '放弃'];

  // 翻页逻辑
  const total = state.filteredList.length;
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
    <!-- 筛选区 -->
    <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-4 mb-4">
      <div class="flex flex-wrap items-center gap-3">
        <input type="text" placeholder="搜索公告标题 / 采购人 / 关键词..." 
               class="flex-1 min-w-[280px] h-10 px-4 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-blue-400" 
               value="${state.filters.keyword}" data-filter="keyword">
        <select class="h-10 px-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-blue-400" data-filter="district">
          <option value="">全部区县</option>
          ${districts.map(d => `<option value="${d}" ${state.filters.district===d?'selected':''}>${d}</option>`).join('')}
        </select>
        <select class="h-10 px-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-blue-400" data-filter="businessTag">
          <option value="">全部业务标签</option>
          ${tags.map(t => `<option value="${t}" ${state.filters.businessTag===t?'selected':''}>${t}</option>`).join('')}
        </select>
        <select class="h-10 px-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-blue-400" data-filter="progress">
          <option value="">全部进度</option>
          ${progresses.map(p => `<option value="${p}" ${state.filters.progress===p?'selected':''}>${p}</option>`).join('')}
        </select>
      </div>
    </div>

    <!-- 翻页工具栏 -->
    <div class="flex items-center justify-between mb-3 text-sm text-gray-500">
      <div>共 <span class="font-semibold text-gray-700">${total}</span> 条 · 
          显示第 <span class="font-semibold text-gray-700">${total === 0 ? 0 : startIdx + 1}</span> - ${Math.min(startIdx + pageSize, total)} 条
      </div>
      <div class="flex items-center gap-4">
        <div class="flex items-center gap-2">
          每页：
          <select class="h-8 px-2 border border-gray-200 rounded text-sm" data-page-size>
            <option value="10" ${state.pageSize===10?'selected':''}>10</option>
            <option value="50" ${state.pageSize===50?'selected':''}>50</option>
            <option value="100" ${state.pageSize===100?'selected':''}>100</option>
            <option value="0" ${state.pageSize===0?'selected':''}>全部</option>
          </select>
          条
        </div>
      </div>
    </div>

    <!-- 公告表格 -->
    <div class="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
      <table class="w-full text-sm">
        <thead class="bg-gray-50 text-gray-500 text-xs">
          <tr>
            <th class="px-4 py-3 text-left font-medium min-w-[300px]">公告标题 / 项目编码</th>
            <th class="px-3 py-3 text-left font-medium">采购人</th>
            <th class="px-3 py-3 text-left font-medium">代理机构</th>
            <th class="px-3 py-3 text-left font-medium">预算</th>
            <th class="px-3 py-3 text-left font-medium">区县</th>
            <th class="px-3 py-3 text-left font-medium">业务标签</th>
            <th class="px-3 py-3 text-left font-medium">发布日期</th>
            <th class="px-3 py-3 text-left font-medium">报名截止</th>
            <th class="px-3 py-3 text-left font-medium">处理人</th>
            <th class="px-3 py-3 text-left font-medium">进度</th>
            <th class="px-4 py-3 text-center font-medium">操作</th>
          </tr>
        </thead>
        <tbody>
          ${pageData.length === 0 ? `
            <tr><td colspan="12" class="py-16 text-center text-gray-400">暂无符合条件的公告</td></tr>
          ` : pageData.map(a => `
            <tr class="ann-row border-t border-gray-50" data-id="${a.id}">
              <td class="px-4 py-3">
                <div class="font-medium text-gray-800 max-w-[400px] truncate cursor-pointer hover:text-blue-600" data-detail="${a.id}">${a.title}</div>
                <div class="flex items-center gap-2 mt-1">
                  <span class="text-xs text-gray-400 font-mono">${a.projectCode}</span>
                  <span class="text-gray-300">|</span>
                  <div class="flex flex-wrap gap-1">
                    ${a.matchedKeywords.slice(0, 3).map(k => `<span class="tag tag-purple">${k}</span>`).join('')}
                    ${a.matchedKeywords.length > 3 ? `<span class="tag tag-gray">+${a.matchedKeywords.length-3}</span>` : ''}
                  </div>
                </div>
              </td>
              <td class="px-3 py-3 text-gray-600 max-w-[180px] truncate" title="${a.buyer}">${a.buyer}</td>
              <td class="px-3 py-3 text-gray-500 max-w-[150px] truncate" title="${a.agency}">${a.agency}</td>
              <td class="px-3 py-3 font-semibold text-orange-600 whitespace-nowrap">${a.budget}</td>
              <td class="px-3 py-3"><span class="tag tag-blue">${a.district}</span></td>
              <td class="px-3 py-3"><span class="tag tag-green">${a.businessTag}</span></td>
              <td class="px-3 py-3 text-gray-500 whitespace-nowrap">${a.pubDate}</td>
              <td class="px-3 py-3 text-gray-500 whitespace-nowrap">${a.deadline}</td>
              <td class="px-3 py-3 text-gray-700 whitespace-nowrap">${a.currentHandler || '-'}</td>
              <td class="px-3 py-3 whitespace-nowrap">${renderProgressTag(a.progress)}</td>
              <td class="px-4 py-3 text-center whitespace-nowrap">
                ${a.progress === '待分配' || !a.currentHandler ? 
                  `<button class="text-blue-600 hover:underline text-xs mr-2" data-assign="${a.id}">分配</button>` : ''}
                <button class="text-blue-600 hover:underline text-xs" data-detail="${a.id}">详情</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>

    <!-- 分页 -->
    ${totalPages > 1 ? `
    <div class="flex items-center justify-center gap-1 mt-4">
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
      <span class="ml-3 text-xs text-gray-400">共 ${totalPages} 页</span>
    </div>
    ` : ''}
  `;
}

function renderProgressTag(p) {
  const map = {
    '待分配': 'tag-red',
    '待跟进': 'tag-yellow',
    '跟进中': 'tag-blue',
    '有意向': 'tag-purple',
    '已投标': 'tag-yellow',
    '已中标': 'tag-green',
    '已完成': 'tag-gray',
    '放弃': 'tag-gray',
  };
  return `<span class="tag ${map[p] || 'tag-gray'}">${p}</span>`;
}

// ---- 公告详情 ----
function renderAnnouncementDetail() {
  const a = state.announcements.find(x => x.id === state.detailId);
  if (!a) { state.detailId = null; return renderAnnouncementList(); }
  
  return `
    <div class="max-w-5xl mx-auto">
      <button class="text-gray-500 hover:text-blue-600 text-sm mb-4" data-back>← 返回列表</button>
      
      <div class="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden mb-4">
        <div class="p-6 border-b border-gray-100">
          <div class="flex items-start gap-3">
            <div class="flex-1">
              <h2 class="text-xl font-semibold text-gray-900 leading-snug mb-2">${a.title}</h2>
              <div class="flex flex-wrap gap-1.5">
                ${a.matchedKeywords.map(k => `<span class="tag tag-purple">🔑 ${k}</span>`).join('')}
                <span class="tag tag-green">业务标签：${a.businessTag}</span>
                <span class="tag tag-blue">${a.district}</span>
                ${renderProgressTag(a.progress)}
              </div>
            </div>
            <div class="flex gap-2">
              <button class="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700" data-assign="${a.id}">任务分配</button>
              <button class="px-4 py-2 border border-gray-200 rounded-lg text-sm hover:bg-gray-50" data-progress="${a.id}">进度更新</button>
            </div>
          </div>
        </div>
        
        <div class="p-6">
          <div class="grid grid-cols-2 gap-x-10 gap-y-4 text-sm">
            <div><span class="text-gray-400">项目编码：</span><span class="font-mono text-gray-700">${a.projectCode}</span></div>
            <div><span class="text-gray-400">公告类型：</span><span class="text-gray-700">${a.annType}</span></div>
            <div><span class="text-gray-400">采购人：</span><span class="text-gray-700">${a.buyer}</span></div>
            <div><span class="text-gray-400">代理机构：</span><span class="text-gray-700">${a.agency}</span></div>
            <div><span class="text-gray-400">预算金额：</span><span class="text-orange-600 font-semibold">${a.budget}</span></div>
            <div><span class="text-gray-400">资金来源：</span><span class="text-gray-700">${a.fundSource}</span></div>
            <div><span class="text-gray-400">所属区县：</span><span class="text-gray-700">${a.district}</span></div>
            <div><span class="text-gray-400">所属区域：</span><span class="text-gray-700">${a.region}</span></div>
            <div><span class="text-gray-400">发布日期：</span><span class="text-gray-700">${a.pubDate}</span></div>
            <div><span class="text-gray-400">报名截止：</span><span class="text-gray-700">${a.deadline}</span></div>
            <div><span class="text-gray-400">开标日期：</span><span class="text-gray-700">${a.bidOpenDate}</span></div>
            <div><span class="text-gray-400">创建时间：</span><span class="text-gray-700">${a.createdAt}</span></div>
            <div><span class="text-gray-400">当前处理人：</span><span class="text-gray-700">${a.currentHandler || '未分配'}</span></div>
            <div><span class="text-gray-400">下次跟进：</span><span class="text-gray-700">${a.nextFollowUp}</span></div>
            <div class="col-span-2"><span class="text-gray-400">命中关键词：</span><span class="text-gray-700">${a.matchedKeywords.map(k => `<span class="tag tag-purple mr-1">${k}</span>`).join('')}</span></div>
            <div class="col-span-2"><span class="text-gray-400">业务标签：</span><span class="text-gray-700"><span class="tag tag-green">${a.businessTag}</span></span></div>
          </div>

          <div class="mt-6 pt-4 border-t border-gray-100">
            <div class="text-gray-400 text-sm mb-2">联系方式</div>
            <div class="text-gray-700 text-sm">${a.contact}</div>
          </div>
          
          <div class="mt-4 pt-4 border-t border-gray-100">
            <div class="text-gray-400 text-sm mb-2">原始链接</div>
            <a href="${a.sourceUrl}" target="_blank" class="text-blue-600 hover:underline text-sm break-all">${a.sourceUrl}</a>
          </div>

          <div class="mt-4 pt-4 border-t border-gray-100">
            <div class="text-gray-400 text-sm mb-2">项目概况全文</div>
            <div class="text-gray-700 text-sm leading-relaxed whitespace-pre-wrap bg-gray-50 rounded-lg p-4">${a.summary}</div>
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
function renderReminders() {
  const urgent = state.reminders.filter(r => r.level === 'urgent');
  const warn = state.reminders.filter(r => r.level === 'warn');
  const info = state.reminders.filter(r => r.level === 'info');
  
  return `
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

    <div class="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
      <table class="w-full text-sm">
        <thead class="bg-gray-50 text-gray-500 text-xs">
          <tr>
            <th class="px-4 py-3 text-left font-medium">级别</th>
            <th class="px-4 py-3 text-left font-medium">任务类型</th>
            <th class="px-4 py-3 text-left font-medium">提醒内容</th>
            <th class="px-4 py-3 text-left font-medium">时间</th>
            <th class="px-4 py-3 text-center font-medium">操作</th>
          </tr>
        </thead>
        <tbody>
          ${state.reminders.map(r => `
            <tr class="border-t border-gray-50 hover:bg-gray-50">
              <td class="px-4 py-3">
                ${r.level === 'urgent' ? '<span class="tag tag-red">紧急</span>' : r.level === 'warn' ? '<span class="tag tag-yellow">关注</span>' : '<span class="tag tag-blue">一般</span>'}
              </td>
              <td class="px-4 py-3 text-gray-600">${r.label}</td>
              <td class="px-4 py-3 text-gray-800">${r.title}</td>
              <td class="px-4 py-3 text-gray-500">${r.time}</td>
              <td class="px-4 py-3 text-center">
                <button class="text-blue-600 hover:underline text-xs" data-detail="${r.targetId}">查看公告</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
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
        <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
          <div class="flex items-start justify-between mb-4">
            <div>
              <h3 class="font-semibold text-gray-900 text-lg">${g.name}</h3>
              <div class="text-xs text-gray-400 mt-1">区域：${g.region} · 创建于 ${g.createdAt}</div>
            </div>
            <span class="tag tag-blue">${g.members.length + 1} 人</span>
          </div>
          
          <div class="space-y-3">
            <div class="flex items-center gap-3 p-3 bg-orange-50 rounded-lg">
              <div class="w-8 h-8 bg-orange-500 rounded-full flex items-center justify-center text-white text-xs font-semibold">${g.admin[0]}</div>
              <div class="flex-1">
                <div class="text-sm font-medium text-gray-800">${g.admin}</div>
                <div class="text-xs text-gray-500">管理员 · ${g.adminPinyin}</div>
              </div>
              <span class="tag tag-yellow">管理员</span>
            </div>
            
            ${g.members.map((m, i) => `
              <div class="flex items-center gap-3 p-3 hover:bg-gray-50 rounded-lg">
                <div class="w-8 h-8 bg-blue-500 rounded-full flex items-center justify-center text-white text-xs font-semibold">${m[0]}</div>
                <div class="flex-1">
                  <div class="text-sm font-medium text-gray-800">${m}</div>
                  <div class="text-xs text-gray-500">${g.position} · ${g.memberPinyin[i]}</div>
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

// ---- 定时任务 ----
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
      <h3 class="font-semibold text-gray-900 mb-4">🔑 定时任务1 - 关键词设定</h3>
      <div class="flex flex-wrap gap-2">
        ${SCHEDULE_CONFIG.keywordList.split('、').map(k => `<span class="tag tag-purple">${k}</span>`).join('')}
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
        <p class="text-sm text-gray-400 mb-5 truncate">${ann.title}</p>
        
        <div class="space-y-4">
          <div>
            <label class="text-sm text-gray-600 mb-1 block">分配给区域小组</label>
            <select id="assign-group" class="w-full h-10 px-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-blue-400">
              <option value="">请选择小组</option>
              ${TEAM_GROUPS.map(g => `<option value="${g.name}">${g.name}（${g.region}）</option>`).join('')}
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

function renderProgressModal() {
  const ann = state.announcements.find(a => a.id === state.progressAnnId);
  if (!ann) return '';
  return `
    <div class="fixed inset-0 z-50 flex items-center justify-center modal-bg fade-in" data-close-modal>
      <div class="bg-white rounded-xl w-[480px] p-6 shadow-xl" data-stop>
        <h3 class="font-semibold text-gray-900 text-lg mb-1">更新进度</h3>
        <p class="text-sm text-gray-400 mb-5 truncate">${ann.title}</p>
        
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
          <div>
            <label class="text-sm text-gray-600 mb-1 block">下次跟进时间</label>
            <input id="progress-next" type="date" class="w-full h-10 px-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-blue-400" value="${ann.nextFollowUp}">
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
function bindEvents() {
  // 侧边栏切换
  document.querySelectorAll('.sidebar-item').forEach(el => {
    el.onclick = () => {
      state.page = el.dataset.page;
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

  // 刷新
  document.querySelectorAll('#btn-refresh').forEach(el => {
    el.onclick = () => {
      alert('模拟手动触发抓取：已启动定时任务1（真实环境会抓取 49 个网站）');
    };
  });

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
      const total = state.filteredList.length;
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
      ann.progress = '待跟进';
      ann.progressRecords = ann.progressRecords || [];
      ann.progressRecords.push({
        progress: '已分配',
        follower: '管理员',
        followDate: new Date().toISOString().slice(0,10),
        note: `已分配给 ${group} - ${receiver}`
      });
      state.modal = null;
      state.assignAnnId = null;
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
      render();
    };
  });
}

init();
