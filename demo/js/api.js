// ===== API 层（真实后端 FastAPI）=====
// 统一处理：Bearer Token、JSON 解析、错误 detail、401 清 token 并回到登录页。
// 契约见 docs/api-contract.md
(function (global) {
  'use strict';

  var TOKEN_KEY = 'bx_token';

  // API 根路径：支持部署在子路径下（例如 Caddy 的 /biaoxun/）。
  // 优先级：页面 <meta name="bx-api-base"> > window.BX_API_BASE > 当前目录自动推导。
  function resolveApiBase() {
    var meta = document.querySelector('meta[name="bx-api-base"]');
    if (meta && meta.content && meta.content.trim()) {
      return meta.content.trim().replace(/\/$/, '');
    }
    if (typeof global.BX_API_BASE === 'string' && global.BX_API_BASE) {
      return global.BX_API_BASE.replace(/\/$/, '');
    }
    var path = window.location.pathname || '/';
    var dir = path.slice(0, path.lastIndexOf('/') + 1) || '/';
    dir = dir.replace(/\/$/, '');
    return dir + '/api';
  }

  var API_BASE = resolveApiBase();
  var unauthorizedHandler = null;

  function getToken() {
    try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
  }

  function setToken(token) {
    try {
      if (token) localStorage.setItem(TOKEN_KEY, token);
      else localStorage.removeItem(TOKEN_KEY);
    } catch (e) { /* 隐私模式等场景忽略 */ }
  }

  function clearToken() { setToken(''); }

  function hasToken() { return !!getToken(); }

  function onUnauthorized(fn) { unauthorizedHandler = fn; }

  function notifyUnauthorized(detail) {
    clearToken();
    if (typeof unauthorizedHandler === 'function') {
      try { unauthorizedHandler(detail); } catch (e) { /* 渲染失败不阻断错误抛出 */ }
    }
  }

  function buildUrl(path, params) {
    var url = API_BASE + path;
    if (!params) return url;
    var qs = new URLSearchParams();
    Object.keys(params).forEach(function (key) {
      var value = params[key];
      if (value === undefined || value === null || value === '') return; // page_size=0 需要保留
      qs.append(key, String(value));
    });
    var query = qs.toString();
    return query ? url + '?' + query : url;
  }

  function normalizeDetail(data, status) {
    var detail = data && data.detail;
    if (Array.isArray(detail)) {
      detail = detail.map(function (item) {
        if (item && typeof item === 'object') return item.msg || item.message || JSON.stringify(item);
        return String(item);
      }).join('；');
    } else if (detail && typeof detail === 'object') {
      detail = JSON.stringify(detail);
    }
    return detail || ('请求失败（' + status + '）');
  }

  async function request(path, options) {
    options = options || {};
    var method = options.method || 'GET';
    var headers = {};
    var token = getToken();
    if (token) headers.Authorization = 'Bearer ' + token;

    var init = { method: method, headers: headers };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }

    var res;
    try {
      res = await fetch(buildUrl(path, options.params), init);
    } catch (e) {
      throw new Error('网络异常，请检查后端服务是否已启动');
    }

    var data = null;
    if (res.status !== 204) {
      var contentType = res.headers.get('content-type') || '';
      if (contentType.indexOf('application/json') >= 0) {
        try { data = await res.json(); } catch (e) { data = null; }
      } else {
        var text = '';
        try { text = await res.text(); } catch (e) { text = ''; }
        data = text ? { detail: text } : null;
      }
    }

    if (!res.ok) {
      var detail = normalizeDetail(data, res.status);
      if (res.status === 401 && !options.skipAuthHandler) notifyUnauthorized(detail);
      throw new Error(detail);
    }
    return data;
  }

  // ---------- 认证 ----------
  async function login(account, password) {
    var data;
    try {
      data = await request('/auth/login', {
        method: 'POST',
        body: { account: account, password: password },
        skipAuthHandler: true, // 登录失败是账号密码错误，不触发“会话失效”重渲染
      });
    } catch (e) {
      clearToken(); // 登录失败也清掉可能残留的旧 token
      throw e;
    }
    if (data && data.token) setToken(data.token);
    return data;
  }

  async function logout() {
    try {
      await request('/auth/logout', { method: 'POST' });
    } finally {
      clearToken();
    }
    return { ok: true };
  }

  function me() { return request('/auth/me'); }

  // ---------- 公告 ----------
  function listAnnouncements(params) { return request('/announcements', { params: params || {} }); }
  function getAnnouncement(id) { return request('/announcements/' + encodeURIComponent(id)); }
  function createAnnouncement(body) {
    return request('/announcements', { method: 'POST', body: body || {} });
  }
  function updateAnnouncement(id, body) {
    return request('/announcements/' + encodeURIComponent(id), { method: 'PUT', body: body || {} });
  }
  function deleteAnnouncement(id) {
    return request('/announcements/' + encodeURIComponent(id), { method: 'DELETE' });
  }
  function patchAnnouncement(id, body) {
    return request('/announcements/' + encodeURIComponent(id), { method: 'PATCH', body: body || {} });
  }
  function confirmAnnouncement(id) {
    return request('/announcements/' + encodeURIComponent(id) + '/confirm', { method: 'POST', body: {} });
  }
  function setProgress(id, progress, note) {
    var body = { progress: progress };
    if (note !== undefined && note !== null && String(note).trim() !== '') body.note = note;
    return request('/announcements/' + encodeURIComponent(id) + '/progress', { method: 'POST', body: body });
  }
  function assign(id, group, receiver) {
    return request('/announcements/' + encodeURIComponent(id) + '/assign', { method: 'POST', body: { group: group, receiver: receiver || '' } });
  }
  function batchAssign(ids, group, receiver) {
    return request('/announcements/batch-assign', { method: 'POST', body: { ids: ids, group: group, receiver: receiver || '' } });
  }
  function getRecords(id) {
    return request('/announcements/' + encodeURIComponent(id) + '/records');
  }

  // ---------- 任务提醒 ----------
  function listReminders(params) { return request('/reminders', { params: params || {} }); }
  function batchAssignReminders(ids, group) {
    return request('/reminders/batch-assign', { method: 'POST', body: { ids: ids, group: group } });
  }

  // ---------- 团队 ----------
  function listGroups() { return request('/groups'); }
  function createGroup(body) { return request('/groups', { method: 'POST', body: body || {} }); }
  function updateGroup(id, body) {
    return request('/groups/' + encodeURIComponent(id), { method: 'PUT', body: body || {} });
  }
  function deleteGroup(id) {
    return request('/groups/' + encodeURIComponent(id), { method: 'DELETE' });
  }

  // ---------- 数据来源 ----------
  function listSources() { return request('/sources'); }
  function createSource(body) { return request('/sources', { method: 'POST', body: body || {} }); }
  function patchSource(id, body) {
    return request('/sources/' + encodeURIComponent(id), { method: 'PATCH', body: body || {} });
  }
  function deleteSource(id) {
    return request('/sources/' + encodeURIComponent(id), { method: 'DELETE' });
  }
  function refreshSource(id) {
    return request('/sources/' + encodeURIComponent(id) + '/refresh', { method: 'POST', body: {} });
  }
  function collect() { return request('/collect', { method: 'POST', body: {} }); }
  function collectRuns(limit) {
    return request('/collect/runs', { params: { limit: limit === undefined ? 10 : limit } });
  }

  // ---------- 用户管理 ----------
  function listUsers() { return request('/users'); }
  function createUser(body) { return request('/users', { method: 'POST', body: body || {} }); }
  function updateUser(id, body) {
    return request('/users/' + encodeURIComponent(id), { method: 'PUT', body: body || {} });
  }
  function deleteUser(id) {
    return request('/users/' + encodeURIComponent(id), { method: 'DELETE' });
  }
  function resetUserPassword(id, password) {
    return request('/users/' + encodeURIComponent(id) + '/reset-password', {
      method: 'POST', body: { password: password || '' },
    });
  }

  // ---------- 定时任务 ----------
  function getSchedule() { return request('/schedule'); }
  function updateSchedule(body) { return request('/schedule', { method: 'PUT', body: body || {} }); }

  // ---------- 采购人-区县基础资料 ----------
  function listBuyerDistricts(params) { return request('/buyer-districts', { params: params || {} }); }
  function createBuyerDistrict(body) { return request('/buyer-districts', { method: 'POST', body: body || {} }); }
  function updateBuyerDistrict(id, body) { return request('/buyer-districts/' + encodeURIComponent(id), { method: 'PUT', body: body || {} }); }
  function deleteBuyerDistrict(id) { return request('/buyer-districts/' + encodeURIComponent(id), { method: 'DELETE' }); }

  // FormData 上传 Excel（不走通用 request 函数，单独处理 Content-Type）
  async function importBuyerDistrictExcel(file, skipDuplicates) {
    var fd = new FormData();
    fd.append('file', file);
    fd.append('skip_duplicates', skipDuplicates !== false ? 'true' : 'false');
    var token = getToken();
    var headers = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    var res = await fetch(buildUrl('/buyer-districts/import-excel'), {
      method: 'POST',
      headers: headers,
      body: fd,
    });
    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) {
      var detail = (data && data.detail) || ('请求失败（' + res.status + '）');
      if (res.status === 401) notifyUnauthorized(detail);
      throw new Error(detail);
    }
    return data;
  }

  global.API = {
    TOKEN_KEY: TOKEN_KEY,
    getToken: getToken,
    setToken: setToken,
    clearToken: clearToken,
    hasToken: hasToken,
    onUnauthorized: onUnauthorized,
    request: request,

    login: login,
    logout: logout,
    me: me,

    listAnnouncements: listAnnouncements,
    getAnnouncement: getAnnouncement,
    createAnnouncement: createAnnouncement,
    updateAnnouncement: updateAnnouncement,
    deleteAnnouncement: deleteAnnouncement,
    patchAnnouncement: patchAnnouncement,
    confirmAnnouncement: confirmAnnouncement,
    setProgress: setProgress,
    assign: assign,
    batchAssign: batchAssign,
    getRecords: getRecords,

    listReminders: listReminders,
    batchAssignReminders: batchAssignReminders,

    listGroups: listGroups,
    createGroup: createGroup,
    updateGroup: updateGroup,
    deleteGroup: deleteGroup,

    listUsers: listUsers,
    createUser: createUser,
    updateUser: updateUser,
    deleteUser: deleteUser,
    resetUserPassword: resetUserPassword,

    listSources: listSources,
    createSource: createSource,
    patchSource: patchSource,
    deleteSource: deleteSource,
    refreshSource: refreshSource,
    collect: collect,
    collectRuns: collectRuns,

    getSchedule: getSchedule,
    updateSchedule: updateSchedule,

    listBuyerDistricts: listBuyerDistricts,
    createBuyerDistrict: createBuyerDistrict,
    updateBuyerDistrict: updateBuyerDistrict,
    deleteBuyerDistrict: deleteBuyerDistrict,
    importBuyerDistrictExcel: importBuyerDistrictExcel,
  };
})(window);
