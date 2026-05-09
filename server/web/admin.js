/* SayIt Admin v4 */
;(function () {
'use strict'
const $ = (s, c) => (c || document).querySelector(s)
const $$ = (s, c) => [...(c || document).querySelectorAll(s)]
function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML }
function fmtDuration(ms) {
  if (!ms && ms !== 0) return '-'
  const sec = ms / 1000
  if (sec < 60) return `${sec.toFixed(1)}s`
  const min = sec / 60
  if (min < 60) return `${Math.floor(min)}m${Math.round(sec % 60)}s`
  return `${Math.floor(min / 60)}h${Math.round(min % 60)}m`
}
function fmtMs(ms) { if (!ms && ms !== 0) return '-'; return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms` }
function fmtTime(ts) { if (!ts) return '-'; return new Date(ts).toLocaleString('zh-CN', { hour12: false }) }
function pct(v) { return `${((v || 0) * 100).toFixed(1)}%` }
function shortModel(m) { if (!m) return '-'; const p = m.split('/'); return p[p.length - 1] }
function cmp(cur, prev, key) {
  if (!prev || !prev[key]) return ''
  const diff = cur[key] - prev[key]
  if (diff === 0) return ''
  const p = prev[key] ? Math.round(Math.abs(diff) / prev[key] * 100) : 0
  return diff > 0 ? ` <span style="color:hsl(var(--success));font-size:11px" title="较上一同等时段">↑${p}%</span>` : ` <span style="color:hsl(var(--destructive));font-size:11px" title="较上一同等时段">↓${p}%</span>`
}
const LOADING = '<div class="loading-msg"><span class="spinner"></span>加载中…</div>'
const EMPTY = (msg, hint) => `<div class="empty-state">${msg}${hint ? `<div class="hint">${hint}</div>` : ''}</div>`

/* Auth */
let _auth = sessionStorage.getItem('sayit-admin-auth') || localStorage.getItem('sayit-admin-auth') || ''
async function api(path, params) {
  if (!_auth) throw new Error('未登录')
  const qs = new URLSearchParams()
  if (params) Object.entries(params).forEach(([k, v]) => { if (v != null && v !== '') qs.set(k, String(v)) })
  const q = qs.toString(); const url = q ? `${path}?${q}` : path
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 15000)
  let res
  try {
    res = await fetch(url, { headers: { Accept: 'application/json', Authorization: _auth }, signal: ctrl.signal })
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('请求超时，请检查网络连接')
    throw new Error('网络连接失败，请检查服务器状态')
  } finally { clearTimeout(timer) }
  if (res.status === 401) { sessionStorage.removeItem('sayit-admin-auth'); localStorage.removeItem('sayit-admin-auth'); _auth = ''; showLogin('会话已过期，请重新登录'); throw new Error('401') }
  if (!res.ok) throw new Error(`请求失败 (${res.status})，请稍后重试`)
  return res.json()
}
function statusBadge(s) {
  const c = s === 'success' ? 'badge-success' : (s === 'failed' ? 'badge-error' : 'badge-warning')
  return `<span class="badge ${c}">${s}</span>`
}
/* CSV export helper */
function downloadCSV(filename, headers, rows) {
  const escape = v => { const s = String(v ?? ''); return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s }
  const lines = [headers.map(escape).join(','), ...rows.map(r => r.map(escape).join(','))]
  const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8' })
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; a.click()
  URL.revokeObjectURL(a.href)
}

/* Theme */
const THEMES = [{id:'light',label:'浅色'},{id:'dark',label:'深色'},{id:'claude',label:'暖色'}]
function applyTheme(id) {
  document.documentElement.dataset.theme = id
  localStorage.setItem('sayit-admin-theme', id)
  $$('.theme-btn').forEach(b => b.classList.toggle('active', b.dataset.theme === id))
}

/* Time presets */
const TIME_PRESETS = [
  { label: '1小时', hours: 1 }, { label: '6小时', hours: 6 },
  { label: '今天', hours: -1 }, { label: '7天', hours: 168 },
  { label: '15天', hours: 360 }, { label: '全部', hours: 0 },
]
function timePresetHTML(prefix) {
  return `<div class="time-presets" id="${prefix}-presets">${TIME_PRESETS.map((p, i) =>
    `<button class="btn btn-outline${i === 3 ? ' active' : ''}" data-hours="${p.hours}">${p.label}</button>`
  ).join('')}</div><label class="field"><span>开始</span><input id="${prefix}-from" type="datetime-local"></label><label class="field"><span>结束</span><input id="${prefix}-to" type="datetime-local"></label>`
}
function bindTimePresets(prefix, cb) {
  const c = $(`#${prefix}-presets`); if (!c) return
  c.addEventListener('click', e => {
    const btn = e.target.closest('button'); if (!btn) return
    $$('button', c).forEach(b => b.classList.remove('active')); btn.classList.add('active')
    const h = Number(btn.dataset.hours), range = presetToRange(h)
    const f = $(`#${prefix}-from`), t = $(`#${prefix}-to`)
    if (f) f.value = range.from ? toLocal(range.from) : ''; if (t) t.value = ''
    cb()
  })
  const clearActive = () => $$('button', c).forEach(b => b.classList.remove('active'))
  $(`#${prefix}-from`)?.addEventListener('input', clearActive)
  $(`#${prefix}-to`)?.addEventListener('input', clearActive)
}
function presetToRange(h) {
  if (h === 0) return {}
  const now = new Date()
  if (h === -1) return { from: new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString() }
  return { from: new Date(now.getTime() - h * 3600000).toISOString() }
}
function toLocal(iso) { return iso ? new Date(new Date(iso).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '' }
function getTimeRange(prefix) {
  const p = {}
  const f = $(`#${prefix}-from`)?.value; if (f) p.from = new Date(f).toISOString()
  const t = $(`#${prefix}-to`)?.value; if (t) p.to = new Date(t).toISOString()
  return p
}

/* URL hash state (#/sessions?status=failed&user_id=xxx) */
function hashParams() {
  const idx = location.hash.indexOf('?')
  if (idx < 0) return {}
  return Object.fromEntries(new URLSearchParams(location.hash.slice(idx + 1)))
}
function setHashParams(params) {
  const h = location.hash.replace(/\?.*$/, '')
  const qs = new URLSearchParams()
  Object.entries(params).forEach(([k, v]) => { if (v != null && v !== '') qs.set(k, v) })
  const s = qs.toString()
  history.replaceState(null, '', s ? `${h}?${s}` : h)
}
function restoreField(id, key, params) {
  const el = $(`#${id}`); if (el && params[key]) el.value = params[key]
}

/* Icons */
const IC = {
  dashboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/></svg>',
  sessions: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4z"/></svg>',
  analytics: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>',
  logs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
  feedback: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>',
  system: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>',
}

/* Router */
const ROUTES = [
  { hash: '', label: '仪表盘', icon: 'dashboard', render: renderDashboard },
  { hash: 'sessions', label: '会话管理', icon: 'sessions', render: renderSessions },
  { hash: 'analytics', label: '统计分析', icon: 'analytics', render: renderAnalytics },
  { hash: 'feedback', label: '用户反馈', icon: 'feedback', render: renderFeedback },
  { hash: 'logs', label: '服务日志', icon: 'logs', render: renderLogs },
  { hash: 'system', label: '系统信息', icon: 'system', render: renderSystem },
]
let _autoRefreshTimer = null
let _logTailTimer = null
function _clearTimers() { clearInterval(_autoRefreshTimer); _autoRefreshTimer = null; clearInterval(_logTailTimer); _logTailTimer = null }
function navigate() {
  if (!_auth) return
  _clearTimers()
  const h = location.hash.replace(/^#\/?/, '').replace(/\?.*$/, '')
  const route = ROUTES.find(r => r.hash === h) || ROUTES[0]
  $$('.sidebar-nav a').forEach(a => a.classList.toggle('active', a.dataset.route === route.hash))
  const main = $('.main'); main.innerHTML = LOADING
  route.render(main).catch(err => {
    if (String(err) === 'Error: 401') return
    main.innerHTML = `<div class="notice error" style="display:block">${esc(String(err))}</div>`
  })
}

/* Login */
function showLogin(msg) {
  let m = $('.login-mask')
  if (!m) {
    m = document.createElement('div'); m.className = 'login-mask'
    m.innerHTML = `<div class="login-box"><h2 style="font-family:'Nunito',sans-serif;font-weight:800">SayIt Admin</h2><div class="err" id="login-err"></div><div class="field"><span>用户名</span><input id="login-user" autocomplete="username"></div><div class="field"><span>密码</span><input id="login-pass" type="password" autocomplete="current-password"></div><button class="btn btn-primary" style="width:100%;margin-top:20px" id="login-btn">登录</button></div>`
    document.body.appendChild(m)
    $('#login-btn').addEventListener('click', doLogin)
    $('#login-pass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin() })
    $('#login-user').addEventListener('keydown', e => { if (e.key === 'Enter') $('#login-pass').focus() })
  }
  m.classList.remove('hidden')
  if (msg) $('#login-err').textContent = msg
  setTimeout(() => $('#login-user')?.focus(), 50)
}
async function doLogin() {
  const u = $('#login-user').value.trim(), p = $('#login-pass').value
  if (!u || !p) { $('#login-err').textContent = '请输入用户名和密码'; return }
  const h = 'Basic ' + btoa(u + ':' + p)
  try {
    const res = await fetch('/admin/api/overview', { headers: { Accept: 'application/json', Authorization: h } })
    if (res.status === 401) { $('#login-err').textContent = '用户名或密码错误'; return }
    if (!res.ok) { $('#login-err').textContent = '无法连接服务器'; return }
  } catch (e) { $('#login-err').textContent = '网络连接失败，请检查服务器状态'; return }
  _auth = h; sessionStorage.setItem('sayit-admin-auth', h); localStorage.setItem('sayit-admin-auth', h)
  $('.login-mask').classList.add('hidden'); navigate()
}

/* Boot */
function boot() {
  applyTheme(localStorage.getItem('sayit-admin-theme') || 'light')
  $('.sidebar-nav').innerHTML = ROUTES.map(r =>
    `<a href="#/${r.hash}" data-route="${r.hash}">${IC[r.icon]}<span>${r.label}</span></a>`
  ).join('')
  $('.sidebar-footer').innerHTML = THEMES.map(t =>
    `<button class="theme-btn" data-theme="${t.id}">${t.label}</button>`
  ).join('')
  $$('.theme-btn').forEach(b => b.addEventListener('click', () => applyTheme(b.dataset.theme)))
  // 退出按钮插入到 sidebar 底部
  const logoutDiv = document.createElement('div')
  logoutDiv.style.cssText = 'padding:8px 12px 0'
  logoutDiv.innerHTML = '<button class="btn btn-outline" style="width:100%;font-size:12px;height:28px" id="logout-btn">退出登录</button>'
  $('#sidebar').appendChild(logoutDiv)
  $('#logout-btn').addEventListener('click', () => { sessionStorage.removeItem('sayit-admin-auth'); localStorage.removeItem('sayit-admin-auth'); _auth = ''; showLogin() })
  applyTheme(localStorage.getItem('sayit-admin-theme') || 'light')
  /* 移动端汉堡菜单 */
  const sidebar = $('#sidebar'), overlay = $('#sidebar-overlay')
  const closeSidebar = () => { sidebar.classList.remove('open'); overlay.classList.remove('open') }
  $('#menu-btn')?.addEventListener('click', () => { sidebar.classList.toggle('open'); overlay.classList.toggle('open') })
  overlay?.addEventListener('click', closeSidebar)
  $('.sidebar-nav').addEventListener('click', () => { if (window.innerWidth <= 768) closeSidebar() })
  window.addEventListener('hashchange', navigate)
  if (!_auth) { showLogin(); return }
  navigate()
}
document.addEventListener('DOMContentLoaded', boot)

/* === Dashboard === */
async function renderDashboard(el) {
  el.innerHTML = `<div class="page-header"><h1>仪表盘</h1></div><div class="page-body">
    <div id="d-status" class="dash-status"></div>
    <div class="toolbar">${timePresetHTML('d')}<div class="toolbar-actions"><label class="field" style="flex-direction:row;align-items:center;gap:6px"><span>自动刷新</span><select id="d-auto" style="width:80px"><option value="0">关闭</option><option value="30">30s</option><option value="60" selected>60s</option></select></label><button class="btn btn-outline" id="d-apply">查询</button></div></div>
    <div id="d-metrics" class="dash-metrics" style="margin-top:16px"></div>
    <div class="dash-bottom"><div class="card"><h3>趋势</h3><div id="d-trend"></div></div><div class="card"><h3>最近异常</h3><ul class="top-list" id="d-errors"></ul></div></div>
  </div>`
  const loadData = async () => {
    const range = getTimeRange('d')
    const ov = await api('/admin/api/overview', range)
    let prevOv = null
    if (range.from) {
      const fromDate = new Date(range.from), dur = Date.now() - fromDate.getTime()
      try { prevOv = await api('/admin/api/overview', { from: new Date(fromDate.getTime() - dur).toISOString(), to: range.from }) } catch(e) {}
    }
    $('#d-metrics').innerHTML = [
      metricCard('会话数', ov.total_sessions + cmp(ov, prevOv, 'total_sessions')),
      metricCard('总音频', fmtDuration(ov.total_audio_ms) + cmp(ov, prevOv, 'total_audio_ms')),
      metricCard('总按住', fmtDuration(ov.total_hold_ms)),
      metricCard('平均 ASR', fmtMs(ov.avg_asr_ms)),
      metricCard('平均 LLM', fmtMs(ov.avg_llm_ms)),
      metricCard('空结果率', pct(ov.empty_result_rate)), metricCard('错误率', pct(ov.error_rate)),
    ].join('')
    /* 最近异常会话 */
    try {
      const errData = await api('/admin/api/sessions', { ...range, status: 'failed', limit: 5, offset: 0 })
      const items = errData.items || []
      $('#d-errors').innerHTML = items.length ? items.map(i =>
        `<li class="clickable" data-sid="${i.session_id}"><span>${fmtTime(i.started_at)} · ${esc(i.error_code || i.status)}</span><span>${esc(i.process_name || '-')}</span></li>`
      ).join('') : EMPTY('暂无异常', '一切正常运行中')
      $$('li.clickable', $('#d-errors')).forEach(li => li.addEventListener('click', () => {
        location.hash = `#/sessions?status=failed`
      }))
    } catch(e) { $('#d-errors').innerHTML = EMPTY('加载失败') }
    await loadTrend()
  }
  /* 趋势图跟随时间过滤器 */
  const loadTrend = async () => {
    const range = getTimeRange('d')
    const from = range.from ? new Date(range.from) : new Date(Date.now() - 15 * 86400000)
    const spanH = (Date.now() - from.getTime()) / 3600000
    const bucket = spanH <= 72 ? 'hour' : 'day'
    const tl = await api('/admin/api/metrics/timeline', { bucket, from: from.toISOString(), to: range.to || undefined })
    renderBarChart($('#d-trend'), tl)
  }
  await loadTrend()
  const [health, sys] = await Promise.all([api('/admin/api/healthz-details'), api('/admin/api/system-info')])
  const llm = sys.llm || {}, wd = health.web_demo || {}, res = sys.resources || {}
  const gpuCard = (res.gpus || []).length ? statusCard('GPU', true, `${res.gpus[0].util_percent}% · ${res.gpus[0].mem_used_mb}/${res.gpus[0].mem_total_mb}MB · ${res.gpus[0].temp_c}°C`) : ''
  $('#d-status').innerHTML = [
    statusCard('ASR', health.asr, shortModel(health.asr_model)),
    statusCard('LLM', health.llm, llm.provider ? `${llm.provider} / ${llm.model || '-'}` : ''),
    statusCard('WebSocket', true, `${health.active_connections || 0} 个活跃连接`),
    statusCard('CPU/内存', true, `CPU ${res.cpu_percent ?? '-'}% · 内存 ${res.mem_percent ?? '-'}%`),
    gpuCard,
  ].filter(Boolean).join('')
  bindTimePresets('d', loadData)
  $('#d-apply')?.addEventListener('click', loadData)
  /* 自动刷新 */
  const setupAutoRefresh = () => {
    clearInterval(_autoRefreshTimer); _autoRefreshTimer = null
    const sec = Number($('#d-auto')?.value || 0)
    if (sec > 0) _autoRefreshTimer = setInterval(loadData, sec * 1000)
  }
  $('#d-auto')?.addEventListener('change', setupAutoRefresh)
  setupAutoRefresh()
  await loadData()
}
function statusCard(name, ok, detail) {
  return `<div class="status-card"><div class="dot ${ok ? 'ok' : 'off'}"></div><div class="info"><div class="name">${name}</div>${detail ? `<div class="detail" title="${esc(detail)}">${esc(detail)}</div>` : ''}</div></div>`
}
function metricCard(label, value) {
  return `<div class="metric-card"><div class="label">${label}</div><div class="value">${value}</div></div>`
}
function renderBarChart(el, data) {
  if (!data || !data.length) { el.innerHTML = EMPTY('暂无趋势数据', '选择更大的时间范围查看'); return }
  const max = Math.max(...data.map(d => d.sessions), 1)
  el.innerHTML = `<div class="bar-chart">${data.map(d => {
    const h = Math.max(4, (d.sessions / max) * 100), lbl = (d.bucket || '').slice(5)
    return `<div class="bar" style="height:${h}%" title="${d.bucket}: ${d.sessions} 会话"><span class="bar-top">${d.sessions}</span><span class="bar-label">${lbl}</span></div>`
  }).join('')}</div>`
}

/* === Sessions === */
let SS = { offset: 0, limit: 30, sel: null, sort: 'time_desc' }
async function renderSessions(el) {
  SS = { offset: 0, limit: 30, sel: null, sort: 'time_desc' }
  el.innerHTML = `<div class="page-header"><h1>会话管理</h1></div><div class="page-body">
    <div class="toolbar">${timePresetHTML('s')}</div>
    <div class="toolbar">
      <label class="field"><span>用户</span><input id="s-user" placeholder="user id" style="width:110px"></label>
      <label class="field"><span>应用</span><input id="s-app" placeholder="process" style="width:110px"></label>
      <label class="field"><span>状态</span><select id="s-status" style="width:110px"><option value="">全部</option><option value="success">success</option><option value="empty_result">empty_result</option><option value="failed">failed</option><option value="disconnected">disconnected</option><option value="short_audio">short_audio</option><option value="empty_audio">empty_audio</option></select></label>
      <label class="field"><span>AI</span><select id="s-ai" style="width:80px"><option value="">全部</option><option value="true">启用</option><option value="false">未启用</option></select></label>
      <label class="field"><span>来源</span><select id="s-source" style="width:100px"><option value="">全部</option><option value="live">实时录音</option><option value="history_reprocess">重新识别</option></select></label>
      <div class="toolbar-actions"><button class="btn btn-outline" id="s-export">导出 CSV</button><button class="btn btn-outline" id="s-apply">查询</button></div>
    </div>
    <div class="split">
      <div><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><span class="section-title" style="margin:0">会话列表</span><span id="s-count" style="font-size:12px;color:hsl(var(--muted-foreground))"></span></div><div id="s-table"></div><div class="pagination" id="s-pager"></div></div>
      <div class="card"><h3>会话详情</h3><div id="s-detail">${EMPTY('选择左侧会话查看详情')}</div></div>
    </div>
  </div>`
  /* Restore filters from URL hash */
  const hp = hashParams()
  restoreField('s-user', 'user_id', hp)
  restoreField('s-app', 'app', hp)
  restoreField('s-status', 'status', hp)
  restoreField('s-ai', 'ai_enabled', hp)
  restoreField('s-source', 'source', hp)
  $('#s-apply').addEventListener('click', () => { SS.offset = 0; loadSessions() })
  $('#s-export').addEventListener('click', exportSessions)
  bindTimePresets('s', () => { SS.offset = 0; loadSessions() })
  await loadSessions()
}
function sessFilters() {
  const p = getTimeRange('s')
  const u = $('#s-user')?.value; if (u) p.user_id = u
  const a = $('#s-app')?.value; if (a) p.app = a
  const s = $('#s-status')?.value; if (s) p.status = s
  const ai = $('#s-ai')?.value; if (ai) p.ai_enabled = ai
  const src = $('#s-source')?.value; if (src) p.source = src
  /* Persist to URL */
  setHashParams({ user_id: u, app: a, status: s, ai_enabled: ai, source: src })
  return p
}
async function exportSessions() {
  try {
    const data = await api('/admin/api/sessions', { ...sessFilters(), limit: 200, offset: 0 })
    const items = data.items || []
    if (!items.length) return
    const headers = ['时间','用户','IP','应用','按住(ms)','音频(ms)','ASR(ms)','LLM(ms)','状态','来源']
    const rows = items.map(i => [fmtTime(i.started_at), i.user_name||i.user_id||'web', i.forwarded_for||i.client_ip||'', i.process_name||'', i.ptt_hold_ms||'', i.audio_duration_ms||'', i.asr_ms||'', i.llm_ms||'', i.status, i.source||'live'])
    downloadCSV('sessions.csv', headers, rows)
  } catch(e) {}
}
async function loadSessions() {
  const data = await api('/admin/api/sessions', { ...sessFilters(), limit: SS.limit, offset: SS.offset, sort: SS.sort })
  const items = data.items || [], total = data.total || 0
  $('#s-count').textContent = `${total} 条`
  const sortIcon = (col) => { if (!SS.sort.startsWith(col)) return ''; return SS.sort.endsWith('_desc') ? ' ↓' : ' ↑' }
  if (items.length) {
    $('#s-table').innerHTML = `<div class="table-scroll"><table><thead><tr><th class="sortable" data-col="time">时间${sortIcon('time')}</th><th>用户</th><th>IP</th><th>应用</th><th class="sortable" data-col="audio">按住/音频${sortIcon('audio')}</th><th class="sortable" data-col="asr">ASR/LLM${sortIcon('asr')}</th><th>状态</th></tr></thead><tbody>${items.map(i => {
      const ip = i.forwarded_for || i.client_ip || '-'
      const user = i.user_name || i.user_id || '<span style="color:hsl(var(--muted-foreground))">web</span>'
      const srcTag = i.source === 'history_reprocess' ? ' <span class="badge badge-muted" style="font-size:10px;padding:1px 5px">重识</span>' : ''
      return `<tr class="clickable${SS.sel === i.session_id ? ' active' : ''}" data-sid="${i.session_id}"><td>${fmtTime(i.started_at)}</td><td>${user}</td><td>${esc(ip)}</td><td>${esc(i.process_name || '-')}</td><td>${fmtDuration(i.ptt_hold_ms)} / ${fmtDuration(i.audio_duration_ms)}</td><td>${fmtMs(i.asr_ms)} / ${i.llm_enabled ? fmtMs(i.llm_ms) : '-'}</td><td>${statusBadge(i.status)}${srcTag}</td></tr>`
    }).join('')}</tbody></table></div>`
  } else { $('#s-table').innerHTML = EMPTY('当前筛选条件下暂无会话', '尝试调整时间范围或筛选条件') }
  /* Pagination with page numbers (#12) */
  const tp = Math.ceil(total / SS.limit), cp = Math.floor(SS.offset / SS.limit) + 1
  if (tp > 1) {
    let pages = ''
    const addPage = (n) => { pages += `<button class="pg ${n===cp?'active':''}" data-page="${n}">${n}</button>` }
    addPage(1)
    if (cp > 3) pages += '<span>…</span>'
    for (let i = Math.max(2, cp - 1); i <= Math.min(tp - 1, cp + 1); i++) addPage(i)
    if (cp < tp - 2) pages += '<span>…</span>'
    if (tp > 1) addPage(tp)
    $('#s-pager').innerHTML = `<button ${cp<=1?'disabled':''} id="s-prev">上一页</button>${pages}<button ${cp>=tp?'disabled':''} id="s-next">下一页</button>`
    $$('.pg', $('#s-pager')).forEach(b => b.addEventListener('click', () => { SS.offset = (Number(b.dataset.page) - 1) * SS.limit; loadSessions() }))
  } else { $('#s-pager').innerHTML = '' }
  $('#s-prev')?.addEventListener('click', () => { SS.offset = Math.max(0, SS.offset - SS.limit); loadSessions() })
  $('#s-next')?.addEventListener('click', () => { SS.offset += SS.limit; loadSessions() })
  $$('tr.clickable', $('#s-table')).forEach(tr => tr.addEventListener('click', () => loadDetail(tr.dataset.sid)))
  /* Sort by clicking column headers */
  $$('th.sortable', $('#s-table')).forEach(th => th.addEventListener('click', () => {
    const col = th.dataset.col
    SS.sort = SS.sort === `${col}_desc` ? `${col}_asc` : `${col}_desc`
    SS.offset = 0; loadSessions()
  }))
  if (items.length && !SS.sel) loadDetail(items[0].session_id)
}
async function loadDetail(sid) {
  SS.sel = sid
  $$('tr.clickable', $('#s-table')).forEach(tr => tr.classList.toggle('active', tr.dataset.sid === sid))
  const d = await api(`/admin/api/sessions/${sid}`)
  const ip = d.forwarded_for || d.client_ip || '-'
  const startEvt = (d.events || []).find(e => e.event_type === 'session_started')
  const cm = (startEvt && startEvt.payload && startEvt.payload.client_meta) || {}
  /* #5 — Grouped detail sections */
  const userInfo = [['用户', d.user_name || d.user_id || '-'],['设备', d.hostname || '-'],['设备 ID', d.device_id || '-'],['客户端', `${d.client_version || '-'} / ${d.platform || '-'}`],['系统', cm.os_version || '-'],['语言', cm.system_locale || '-']]
  const netInfo = [['公网 IP', ip],['内网 IP', d.local_ip || '-']]
  const sessInfo = [['来源', d.source === 'history_reprocess' ? '重新识别' : '实时录音'],['应用', d.process_name || '-'],['窗口', d.window_title || '-'],['模型', `${shortModel(d.asr_model)} / ${d.llm_model || '-'}`],['节点', d.node_id || '-'],['状态', d.status || '-'],['错误', d.error_code ? `${d.error_code}: ${d.error_message || ''}` : '-']]
  const timing = [['PTT', fmtMs(d.ptt_hold_ms)],['音频', fmtMs(d.audio_duration_ms)],['VAD', fmtMs(d.vad_ms)],['排队', fmtMs(d.queue_wait_ms)],['ASR推理', fmtMs(d.infer_ms)],['Batch', fmtMs(d.batch_exec_ms)],['ASR总', fmtMs(d.asr_ms)],['LLM总', d.llm_enabled ? fmtMs(d.llm_ms) : '-']]
  const detailGroup = (title, pairs) => `<div class="section-title" style="margin-top:14px">${title}</div><div class="detail-grid">${pairs.map(([k, v]) => `<div class="detail-item"><div class="k">${k}</div><div class="v">${esc(String(v))}</div></div>`).join('')}</div>`
  /* #2 — Structured event timeline */
  const LABELS = {session_started:'会话开始',session_stopped:'录音停止',asr_completed:'ASR 完成',llm_completed:'LLM 完成',session_finished:'会话结束',session_failed:'会话失败',session_status:'状态变更',ws_connected:'连接建立',ws_disconnected:'连接断开',audio_saved:'音频保存'}
  const eventsHTML = (d.events || []).map(e => {
    const p = e.payload || {}, label = LABELS[e.event_type] || e.event_type
    const isErr = e.event_type === 'session_failed'
    const details = Object.keys(p).length ? Object.entries(p).map(([k,v]) => `<span class="tl-kv"><span class="k">${esc(k)}</span> ${esc(typeof v === 'object' ? JSON.stringify(v) : String(v))}</span>`).join('') : ''
    return `<div class="tl-item${isErr ? ' tl-error' : ''}"><div class="tl-dot"></div><div class="tl-body"><div class="tl-head"><span class="tl-label">${label}</span><span class="tl-time">${fmtTime(e.event_time)}</span></div>${details ? `<div class="tl-details">${details}</div>` : ''}</div></div>`
  }).join('') || EMPTY('暂无事件')
  $('#s-detail').innerHTML = `
    ${detailGroup('用户信息', userInfo)}
    ${detailGroup('网络信息', netInfo)}
    ${detailGroup('会话信息', sessInfo)}
    ${detailGroup('耗时拆解', timing)}
    <div class="section-title" style="margin-top:14px">事件时间线</div>
    <div class="timeline-v">${eventsHTML}</div>`
}

/* === Analytics === */
async function renderAnalytics(el) {
  el.innerHTML = `<div class="page-header"><h1>统计分析</h1></div><div class="page-body">
    <div class="toolbar">${timePresetHTML('a')}<div class="toolbar-actions"><button class="btn btn-outline" id="a-apply">查询</button></div></div>
    <div id="a-content">${LOADING}</div></div>`
  const load = async () => {
    const r = getTimeRange('a')
    const [byApp, byUser, byModel, durDist] = await Promise.all([api('/admin/api/metrics/by-app', r), api('/admin/api/metrics/by-user', r), api('/admin/api/metrics/by-model', r), api('/admin/api/metrics/duration-distribution', r)])
    $('#a-content').innerHTML = aDurDist(durDist) + aBarChart(byApp) + aTable('按应用', byApp, 'app') + aTable('按用户', byUser, 'user_id') + aTable('按 ASR 模型', byModel.asr || []) + aTable('按 LLM 模型', byModel.llm || []) + await aPerfSection(r)
    /* #7 drill-down: click row to jump to sessions */
    $$('tr.drill', $('#a-content')).forEach(tr => tr.addEventListener('click', () => {
      const key = tr.dataset.drillKey, val = tr.dataset.drillVal
      if (key && val) location.hash = `#/sessions?${key}=${encodeURIComponent(val)}`
    }))
  }
  $('#a-apply').addEventListener('click', load); bindTimePresets('a', load); await load()
}
function aDurDist(rows) {
  if (!rows || !rows.length) return ''
  const total = rows.reduce((s, r) => s + r.count, 0)
  if (!total) return ''
  const max = Math.max(...rows.map(r => r.count), 1)
  return `<div class="analytics-section"><h2>音频时长分布</h2><div class="card" style="padding:20px 18px 12px"><div class="bar-chart" style="height:80px">${rows.map(r => {
    const h = Math.max(3, (r.count / max) * 100)
    const p = Math.round(r.count / total * 100)
    return `<div class="bar" style="height:${h}%" title="${r.label}: ${r.count} 条 (${p}%)"><span class="bar-top">${r.count}</span><span class="bar-label">${r.label}</span></div>`
  }).join('')}</div><div style="text-align:center;margin-top:24px;font-size:12px;color:hsl(var(--muted-foreground))">共 ${total} 条会话</div></div></div>`
}
async function aPerfSection(range) {
  try {
    const d = await api('/admin/api/metrics/percentiles', range)
    if (!d || !d.asr_p50) return ''
    return `<div class="analytics-section"><h2>性能分位数</h2><table><thead><tr><th>指标</th><th>P50</th><th>P95</th><th>P99</th></tr></thead><tbody><tr><td>ASR 耗时</td><td>${fmtMs(d.asr_p50)}</td><td>${fmtMs(d.asr_p95)}</td><td>${fmtMs(d.asr_p99)}</td></tr><tr><td>LLM 耗时</td><td>${fmtMs(d.llm_p50)}</td><td>${fmtMs(d.llm_p95)}</td><td>${fmtMs(d.llm_p99)}</td></tr></tbody></table></div>`
  } catch(e) { return '' }
}
function aBarChart(rows) {
  if (!rows || !rows.length) return ''
  const max = Math.max(...rows.map(r => r.sessions), 1)
  return `<div class="analytics-section"><h2>应用分布</h2><div class="card" style="padding:20px 18px 12px"><div class="bar-chart" style="height:80px">${rows.slice(0, 10).map(r => {
    const h = Math.max(3, (r.sessions / max) * 100)
    return `<div class="bar" style="height:${h}%" title="${esc(r.label)}: ${r.sessions} 会话"><span class="bar-top">${r.sessions}</span><span class="bar-label">${esc(r.label).slice(0, 10)}</span></div>`
  }).join('')}</div></div></div>`
}
function aTable(title, rows, drillKey) {
  if (!rows || !rows.length) return `<div class="analytics-section"><h2>${title}</h2>${EMPTY('暂无数据')}</div>`
  return `<div class="analytics-section"><h2>${title}</h2><table><thead><tr><th>名称</th><th>会话</th><th>总音频</th><th>平均ASR</th><th>平均LLM</th><th>失败</th></tr></thead><tbody>${rows.map(r =>
    `<tr${drillKey ? ` class="drill clickable" data-drill-key="${drillKey}" data-drill-val="${esc(r.label || '')}"` : ''}><td>${esc(r.label || '-')}</td><td>${r.sessions}</td><td>${fmtDuration(r.total_audio_ms)}</td><td>${fmtMs(r.avg_asr_ms)}</td><td>${fmtMs(r.avg_llm_ms)}</td><td>${r.failed_sessions || 0}</td></tr>`
  ).join('')}</tbody></table></div>`
}

/* === Feedback === */
async function renderFeedback(el) {
  el.innerHTML = `<div class="page-header"><h1>用户反馈</h1></div><div class="page-body">
    <div class="toolbar"><div class="toolbar-actions"><button class="btn btn-outline" id="fb-refresh">刷新</button></div></div>
    <div id="fb-list">${LOADING}</div>
    <div id="fb-detail" class="card" style="display:none;margin-top:16px;overflow:hidden"></div></div>`
  let _page = 0, _limit = 20
  const load = async () => {
    const data = await api('/admin/api/feedback', { limit: _limit, offset: _page * _limit })
    const items = data.items || [], total = data.total || 0
    if (!items.length) { $('#fb-list').innerHTML = EMPTY('暂无反馈'); return }
    const rows = items.map(i => {
      const t = new Date(i.created_at).toLocaleString('zh-CN', { hour12: false })
      const tr = i.transcript_json
      const hasTranscript = tr && (tr.asr_text || tr.ai_text)
      return `<tr class="clickable" data-id="${i.id}"><td>${t}</td><td>${esc(i.machine_id).slice(0,16)}</td><td>${esc(i.app_version || '-')}</td><td>${esc(i.feedback_text).slice(0,80)}</td><td>${hasTranscript ? '有' : '-'}</td><td>${esc(i.client_ip || '-')}</td></tr>`
    }).join('')
    const pages = Math.ceil(total / _limit)
    $('#fb-list').innerHTML = `<div class="table-wrap"><table><thead><tr><th>时间</th><th>设备</th><th>版本</th><th>反馈内容</th><th>转录</th><th>IP</th></tr></thead><tbody>${rows}</tbody></table></div>
      <div class="pagination"><span>共 ${total} 条</span>${pages > 1 ? Array.from({length: pages}, (_, i) => `<button class="btn btn-outline btn-sm ${i === _page ? 'active' : ''}" data-p="${i}">${i+1}</button>`).join('') : ''}</div>`
    $$('#fb-list tr.clickable').forEach(tr => tr.addEventListener('click', () => showDetail(items.find(i => String(i.id) === tr.dataset.id))))
    $$('#fb-list .pagination button').forEach(b => b.addEventListener('click', () => { _page = Number(b.dataset.p); load() }))
  }
  const showDetail = (item) => {
    if (!item) return
    const d = $('#fb-detail'); d.style.display = 'block'
    const tr = item.transcript_json, ctx = item.context_json
    const t = new Date(item.created_at).toLocaleString('zh-CN', { hour12: false })
    const metaItems = [
      ['设备', item.machine_id], ['版本', item.app_version || '-'], ['IP', item.client_ip || '-'], ['时间', t],
    ]
    if (ctx) {
      metaItems.push(['模式', ctx.work_mode || '-'])
      metaItems.push(['ASR', `${ctx.asr_provider || '-'} / ${ctx.asr_model || '-'}`])
      if (ctx.ai_enabled) metaItems.push(['AI', `${ctx.ai_provider || '-'} / ${ctx.ai_model || '-'}`])
      if (ctx.ai_preset_name) metaItems.push(['润色', ctx.ai_preset_name])
    }
    if (tr && tr.duration_sec) metaItems.push(['时长', tr.duration_sec.toFixed(1) + 's'])
    let html = `<div class="fb-meta">${metaItems.map(([k, v]) => `<span class="fb-tag"><span class="k">${esc(k)}</span>${esc(v)}</span>`).join('')}</div>`
    html += `<div class="fb-section"><div class="fb-label">反馈内容</div><div class="fb-body">${esc(item.feedback_text)}</div></div>`
    if (tr && tr.asr_text) html += `<div class="fb-section"><div class="fb-label">ASR 原文</div><div class="fb-body fb-scroll">${esc(tr.asr_text)}</div></div>`
    if (tr && tr.ai_text) html += `<div class="fb-section"><div class="fb-label">AI 润色</div><div class="fb-body fb-scroll">${esc(tr.ai_text)}</div></div>`
    if (ctx && ctx.ai_system_prompt) html += `<div class="fb-section"><div class="fb-label">System Prompt</div><div class="fb-body fb-scroll fb-mono">${esc(ctx.ai_system_prompt)}</div></div>`
    d.innerHTML = html
    d.scrollIntoView({ behavior: 'smooth' })
  }
  $('#fb-refresh').addEventListener('click', () => { _page = 0; load() })
  await load()
}

/* === Logs === */
async function renderLogs(el) {
  el.innerHTML = `<div class="page-header"><h1>服务日志</h1></div><div class="page-body">
    <div class="toolbar">${timePresetHTML('l')}<label class="field"><span>级别</span><select id="l-level" style="width:100px"><option value="">全部</option><option value="ERROR">ERROR</option><option value="WARNING">WARNING</option><option value="INFO">INFO</option></select></label><label class="field"><span>搜索</span><input id="l-search" placeholder="关键词" style="width:120px"></label><label class="field"><span>条数</span><select id="l-limit" style="width:70px"><option value="50">50</option><option value="100">100</option><option value="200">200</option></select></label><div class="toolbar-actions"><button class="btn btn-outline" id="l-tail">实时</button><button class="btn btn-outline" id="l-export">导出</button><button class="btn btn-outline" id="l-refresh">刷新</button></div></div>
    <div id="l-list">${LOADING}</div></div>`
  let _tailing = false
  const load = async () => {
    const p = { limit: $('#l-limit').value }; const lv = $('#l-level').value; if (lv) p.level = lv
    const lr = getTimeRange('l'); if (lr.from) p.from = lr.from; if (lr.to) p.to = lr.to
    const lq = $('#l-search')?.value?.trim(); if (lq) p.q = lq
    const data = await api('/admin/api/service-logs', p)
    $('#l-list').innerHTML = (data || []).map(i =>
      `<div class="log-item ${i.level === "ERROR" ? "log-error" : i.level === "WARNING" ? "log-warn" : ""}"><div class="meta">${fmtTime(i.created_at)} · ${esc(i.level)} · ${esc(i.logger_name || '')}</div><div class="msg">${esc(i.message || '-')}</div></div>`
    ).join('') || EMPTY('暂无日志', '服务运行后将自动记录')
    return data
  }
  const toggleTail = () => {
    _tailing = !_tailing
    const btn = $('#l-tail')
    if (_tailing) {
      btn.classList.add('btn-primary'); btn.classList.remove('btn-outline'); btn.textContent = '停止'
      _logTailTimer = setInterval(load, 5000)
    } else {
      btn.classList.remove('btn-primary'); btn.classList.add('btn-outline'); btn.textContent = '实时'
      clearInterval(_logTailTimer); _logTailTimer = null
    }
  }
  const exportLogs = async () => {
    try {
      const data = await api('/admin/api/service-logs', { limit: 200 })
      if (!data?.length) return
      downloadCSV('logs.csv', ['时间','级别','来源','消息'], data.map(i => [fmtTime(i.created_at), i.level, i.logger_name||'', i.message||'']))
    } catch(e) {}
  }
  $('#l-refresh').addEventListener('click', load); $('#l-level').addEventListener('change', load)
  $('#l-tail').addEventListener('click', toggleTail)
  $('#l-export').addEventListener('click', exportLogs)
  bindTimePresets('l', load); await load()
}

/* === System === */
async function renderSystem(el) {
  el.innerHTML = `<div class="page-header"><h1>系统信息</h1></div><div class="page-body"><div class="info-grid" id="sys-grid">${LOADING}</div></div>`
  const [h, s] = await Promise.all([api('/admin/api/healthz-details'), api('/admin/api/system-info')])
  const wd = s.web_demo || {}, llm = s.llm || {}, wllm = s.web_demo_llm || {}, tel = h.telemetry || {}, res = s.resources || {}
  const gpus = res.gpus || []
  const uptimeStr = res.uptime_sec ? fmtDuration(res.uptime_sec * 1000) : '-'
  const cards = [
    infoCard('ASR 引擎', [['状态', h.asr ? '已加载' : '未加载'],['引擎', s.asr_engine || '-'],['模型', shortModel(s.asr_model)]]),
    infoCard('LLM 引擎', [['状态', llm.enabled ? '已启用' : '未启用'],['Provider', llm.provider || '-'],['模型', llm.model || '-']]),
    infoCard('Web Demo', [['启用', wd.enabled ? '是' : '否'],['LLM', wllm.enabled ? `${wllm.provider} / ${wllm.model}` : '未启用'],['最大时长', `${wd.max_duration_sec || '-'}s`],['单IP并发', wd.max_concurrency_per_ip || '-']]),
    infoCard('部署信息', [['节点', s.node_id || '-'],['模式', s.deployment_mode || '-'],['运行时间', uptimeStr],['遥测', tel.enabled ? '已启用' : '未启用'],['数据库', shortPath(tel.db_path)],['日志', shortPath(tel.log_file)]]),
    infoCard('CPU / 内存', [['CPU 使用率', `${res.cpu_percent ?? '-'}%`],['CPU 核心', res.cpu_count || '-'],['内存', `${res.mem_used_gb ?? '-'} / ${res.mem_total_gb ?? '-'} GB (${res.mem_percent ?? '-'}%)`],['磁盘', `${res.disk_used_gb ?? '-'} / ${res.disk_total_gb ?? '-'} GB (${res.disk_percent ?? '-'}%)`]]),
  ]
  gpus.forEach(g => {
    cards.push(infoCard(`GPU ${g.index} — ${g.name}`, [['利用率', `${g.util_percent}%`],['显存', `${g.mem_used_mb} / ${g.mem_total_mb} MB`],['温度', `${g.temp_c}°C`]]))
  })
  $('#sys-grid').innerHTML = cards.join('')
}
function shortPath(p) { if (!p) return '-'; const parts = p.split('/'); return parts.length > 3 ? '…/' + parts.slice(-2).join('/') : p }
function infoCard(title, rows) {
  return `<div class="info-card"><h3>${title}</h3>${rows.map(([k, v]) =>
    `<div class="info-row"><span class="k">${k}</span><span class="v" title="${esc(String(v))}">${esc(String(v))}</span></div>`
  ).join('')}</div>`
}

})()
