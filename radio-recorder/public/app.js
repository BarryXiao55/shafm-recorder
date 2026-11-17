'use strict';

const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));

let cfg = {}, st = {}, presets = [], mode = 'now';
let previewInfo = null, previewCmd = '', lastFilesKey = null, saveTimer = null;
let probeTimer = null;
/* v3.1.8：监听按下沉到「并行任务」的每个条目。全局只有一个 <audio>，放在 #jobList
 * 之外（否则 renderJobs() 的 innerHTML 重建会销毁正在播放的元素）；activeMonitorJobId
 * 记录唯一正在监听的任务，因此排他天然成立。monitorToken 用来丢弃过期的 play() 回调。 */
let activeMonitorJobId = '', monitorToken = 0, previewAudio = null;
/* v3.1.9：短试听与长试听共用一个临时 <audio>；previewEndAt 按墙钟判定到时，
 * 配合 1 秒 tick 校准，后台标签页被节流 / 系统休眠后也不会「说好 10 分钟放到半小时」。 */
let previewEndAt = 0, previewToken = 0, previewTimer = 0, previewTicker = 0;
let previewReconnect = 0, previewLabel = '', previewTotalSec = 0;
/* v3.1.11：回听播放器与文件列表解耦。单例 <audio> 位于 #fileList 之外，
 * renderFiles() 重建列表时它不会被销毁，currentTime / paused 自然保持。
 * activePlaybackName 是唯一正在回听的文件名，天然保证同一时刻只有一路回听。 */
let activePlaybackName = '', playbackToken = 0;
let planRules = [], editingPlanId = null, cleanCandidates = [], policyDirty = false;
let logView = 'live', historyText = '';
/* 「清空显示」基线：只作用于本页显示框，绝不改服务端 / 磁盘日志 */
let logCleared = false, logBaseSeq = 0, logBaseTail = '', logClearedAt = '';
/* v3 state */
let stationList = [], editingStationId = null, selectedFiles = new Set();
let epgData = null, epgLoading = false, alertsData = null, lastAlertUnread = 0;
let lastPlansKey = '', lastJobsKey = '', lastStationsKey = '', lastEpgKey = '', lastAlertKey = '';
let testData = null, serviceDown = false, downTick = 0;

/* 这些接口在服务端只接受 POST。旧版 api(path) 不带 body 会退化成 GET，
 * 服务端回 404 {"message":"未知接口"}，于是「停止主任务 / 全部停止 / 清空显示 /
 * 打开目录 / 重新检测 / 清空告警」全都看似点了没反应，右下角还弹出「未知接口」。
 * 统一在此兜底：命中这些路径时自动用 POST + 空 JSON 体。 */
const POST_ONLY = new Set([
  '/api/start', '/api/stop', '/api/stop-all', '/api/jobs/delete',
  '/api/stations/add', '/api/stations/update', '/api/stations/delete', '/api/stations/probe',
  '/api/epg/refresh', '/api/epg/to-plan',
  '/api/alerts/policy', '/api/alerts/read', '/api/alerts/clear', '/api/alerts/test',
  '/api/plans/add', '/api/plans/update', '/api/plans/toggle', '/api/plans/delete', '/api/plans/fire',
  '/api/cleanup/policy', '/api/cleanup/run',
  '/api/logs/clear', '/api/detect', '/api/probe', '/api/dry-run', '/api/preview',
  '/api/files/delete', '/api/files/merge', '/api/open-folder', '/api/browse/mkdir',
  '/api/selftest', '/api/selftest/record', '/api/selftest/clean', '/api/shutdown'
]);

async function api(path, body) {
  const p = String(path).split('?')[0];
  const isPost = (body !== undefined && body !== null) || POST_ONLY.has(p);
  const opt = isPost
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body == null ? {} : body), cache: 'no-store' }
    : { cache: 'no-store' };
  const r = await fetch(path, opt);
  return r.json();
}
/** 明确发 POST 的快捷方式（即使不传参数也不会退化成 GET）。 */
const post = (p, body) => api(p, body == null ? {} : body);

/* ---------------- 前缀跟随 / 目录浏览器 ---------------- */
let prefixFollow = true, dirBrowsePath = '', dirBrowseParent = '', dirShortcutCache = [];
function getPref(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } }
function setPref(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 预览面板可能禁用存储 */ } }
prefixFollow = getPref('fm990.prefixFollow', '1') !== '0';

/** FM 频率 → 前缀：FM 99.0 → FM990、FM 105.7 → FM1057、FM 94.7 → FM947。 */
function prefixFromFreq(freq) {
  const m = String(freq || '').match(/FM\s*(\d+(?:\.\d+)?)/i);
  return m ? 'FM' + m[1].replace(/\./g, '') : '';
}
/** 电台有效前缀：电台库显式配置优先（保留 AM990→FM990），否则按频率推导。 */
function stationPrefix(s) {
  if (!s) return '';
  const configured = String(s.prefix || '').trim();
  if (configured && configured !== 'REC') return configured.replace(/[\\/:*?"<>|%]/g, '_').slice(0, 24);
  return prefixFromFreq(s.freq) || configured || 'REC';
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* -------------------- in-page confirm / toast --------------------
 * Native window.confirm / alert / prompt are silently blocked in embedded
 * preview panels (sandboxed iframes without allow-modals), which made every
 * "delete" button look dead. These helpers live inside the page instead, so
 * the same UI works in a normal browser, --app desktop window and preview.
 */
let _dlgResolve = null, _toastTimer = null;

function uiRoot() {
  let box = document.getElementById('uiModal');
  if (box) return box;
  box = document.createElement('div');
  box.id = 'uiModal';
  box.setAttribute('style', 'position:fixed;inset:0;z-index:99999;display:none;align-items:center;justify-content:center;background:rgba(8,14,26,.62)');
  box.innerHTML =
    '<div style="width:min(440px,92vw);background:#fff;border:1px solid #d8dee8;border-radius:12px;box-shadow:0 18px 50px rgba(0,0,0,.32);padding:20px 22px;font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#1d2430">' +
      '<div data-role="title" style="font-size:15px;font-weight:700;margin-bottom:10px">请确认</div>' +
      '<div data-role="text" style="font-size:13px;line-height:1.7;white-space:pre-wrap;word-break:break-word;color:#4a5568;max-height:45vh;overflow:auto"></div>' +
      '<div style="display:flex;gap:10px;justify-content:flex-end;margin-top:20px">' +
        '<button type="button" data-role="cancel" style="padding:7px 16px;border:1px solid #cbd5e0;background:#fff;border-radius:7px;cursor:pointer;font-size:13px">取消</button>' +
        '<button type="button" data-role="ok" style="padding:7px 16px;border:1px solid #c0392b;background:#e74c3c;color:#fff;border-radius:7px;cursor:pointer;font-size:13px">确定</button>' +
      '</div></div>';
  document.body.appendChild(box);
  box.querySelector('[data-role="ok"]').addEventListener('click', () => uiClose(true));
  box.querySelector('[data-role="cancel"]').addEventListener('click', () => uiClose(false));
  box.addEventListener('click', e => { if (e.target === box) uiClose(false); });
  document.addEventListener('keydown', e => {
    const b = document.getElementById('uiModal');
    if (!b || b.style.display === 'none') return;
    if (e.key === 'Escape') uiClose(false);
    else if (e.key === 'Enter') uiClose(true);
  });
  return box;
}
function uiClose(v) {
  const box = document.getElementById('uiModal');
  if (box) box.style.display = 'none';
  const fn = _dlgResolve; _dlgResolve = null;
  if (fn) fn(v);
}
/** Promise<boolean>. Never uses window.confirm. */
function uiConfirm(message, title, okText) {
  const box = uiRoot();
  box.querySelector('[data-role="title"]').textContent = title || '请确认';
  box.querySelector('[data-role="text"]').textContent = String(message || '');
  box.querySelector('[data-role="ok"]').textContent = okText || '确定';
  box.style.display = 'flex';
  return new Promise(resolve => { _dlgResolve = resolve; });
}
/** 页面内提示条（右下角带明确标题，不再是一个来路不明的黑框）。 */
function uiAlert(message, bad) {
  let t = document.getElementById('uiToast');
  if (!t) {
    t = document.createElement('div'); t.id = 'uiToast';
    t.setAttribute('style', 'position:fixed;z-index:100000;right:18px;bottom:18px;max-width:min(460px,92vw);padding:11px 16px;border-radius:9px;background:#1d2430;color:#fff;font-size:13px;line-height:1.6;box-shadow:0 10px 30px rgba(0,0,0,.3);cursor:pointer');
    t.title = '点击关闭';
    t.innerHTML = '<div style="font-size:11px;opacity:.7;letter-spacing:.6px;margin-bottom:4px">操作提示 · 点击关闭</div><div data-role="msg" style="white-space:pre-wrap;word-break:break-word"></div>';
    t.addEventListener('click', () => { t.style.display = 'none'; });
    document.body.appendChild(t);
  }
  const msg = t.querySelector('[data-role="msg"]');
  if (msg) msg.textContent = String(message || ''); else t.textContent = String(message || '');
  t.style.background = bad ? '#c0392b' : '#1d2430';
  t.style.display = 'block';
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { t.style.display = 'none'; }, 5000);
}

const pad = n => String(Math.floor(n)).padStart(2, '0');
function hms(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${pad(s / 3600)}:${pad((s % 3600) / 60)}:${pad(s % 60)}`;
}
function fmtSize(b) {
  if (!b) return '0 MB';
  if (b >= 1073741824) return (b / 1073741824).toFixed(2) + ' GiB';
  return (b / 1048576).toFixed(1) + ' MiB';
}
function fmtDurShort(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  if (!s) return '—';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}小时${pad(m)}分` : `${m}分${pad(s % 60)}秒`;
}
function localDT(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function defaultRange() {
  const s = new Date(); s.setDate(s.getDate() + 1); s.setHours(6, 0, 0, 0);
  return [localDT(s), localDT(new Date(s.getTime() + 3600000))];
}
function dateKeyOffset(off) {
  const d = new Date(Date.now() + off * 86400000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/* ------------------------------ form ------------------------------ */

function fillPresets() {
  const sel = $('#preset');
  sel.innerHTML = presets.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')
    + '<option value="custom">自定义…</option>';
  const ps = $('#pStation');
  if (ps) {
    const keep = ps.value;   // 电台库重绘时不要悄悄清空正在编辑的节目单电台
    ps.innerHTML = '<option value="">（用当前全局设置）</option>' +
      presets.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
    if (keep && presets.some(p => p.id === keep)) ps.value = keep;
  }
  const es = $('#epgStation');
  if (es) es.innerHTML = presets.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
}

function fillForm(c) {
  const [rs, re] = defaultRange();
  $('#preset').value = presets.some(p => p.id === c.stationId) ? c.stationId : (presets[0] ? presets[0].id : 'custom');
  $('#streamUrl').value = c.streamUrl || '';
  $('#outputDir').value = c.outputDir || '';
  $('#filePrefix').value = c.filePrefix || 'FM990';
  $('#segmentMinutes').value = String(c.segmentMinutes ?? 60);
  $('#codec').value = c.codec || 'copy';
  $('#engine').value = c.engine || 'ffmpeg';
  $('#autoMonitor').checked = !!c.autoMonitor;
  $('#volume').value = String(c.volume ?? 80);
  $('#volumeVal').textContent = String(c.volume ?? 80);
  $('#autoRestart').checked = c.autoRestart !== false;
  $('#repeatDaily').checked = !!c.repeatDaily;
  $('#durationMinutes').value = String(c.durationMinutes ?? 0);
  $('#hourlyHours').value = String(c.hourlyHours ?? 1);
  $('#hourlyAlign').value = c.hourlyAlign || 'fromNextHour';
  const validStart = c.rangeStart && new Date(c.rangeStart).getTime() > Date.now() ? c.rangeStart : rs;
  const validEnd = c.rangeEnd && new Date(c.rangeEnd).getTime() > new Date(validStart).getTime() ? c.rangeEnd : re;
  $('#rangeStart').value = validStart;
  $('#rangeEnd').value = validEnd;
  $('#ffmpegPath').value = c.ffmpegPath || '';
  $('#ffplayPath').value = c.ffplayPath || '';
  setMode(c.mode || 'now');
  const es = $('#epgStation');
  if (es && presets.some(p => p.id === c.stationId)) es.value = c.stationId;
  applyStationPrefix();
  checkDir();
}

/* ---------------- 文件名前缀：跟随所选电台 ---------------- */

function currentStation() {
  const id = $('#preset').value;
  const s = (st.stations || []).find(x => x.id === id);
  return s || presets.find(x => x.id === id) || null;
}

/** force=true 时忽略「手动模式」（用于勾选框刚打开时立刻回填）。 */
function applyStationPrefix(force) {
  const s = currentStation();
  const box = $('#prefixFollow'), hint = $('#prefixHint'), input = $('#filePrefix');
  if (box) box.checked = prefixFollow;
  if (!s) {
    if (hint) hint.textContent = '自定义模式：前缀由你手动填写，不会自动变化。';
    return;
  }
  const pref = stationPrefix(s);
  if (prefixFollow || force) input.value = pref;
  if (hint) {
    const derived = prefixFromFreq(s.freq) || pref;
    hint.textContent = `${s.name}（${s.freq || '自定义频率'}）→ 前缀 ${pref}`
      + (prefixFollow ? ' · 自动跟随已开启' : ' · 手动输入模式（勾选上方可恢复跟随）');
    if (derived !== pref) hint.textContent += `；按频率推导为 ${derived}（电台库已自定义，优先采用）`;
  }
}

function setPrefixFollow(on, fromUser) {
  prefixFollow = !!on;
  setPref('fm990.prefixFollow', prefixFollow ? '1' : '0');
  applyStationPrefix(prefixFollow);
  if (fromUser && prefixFollow) onChange();
}

/* ---------------- 保存目录：输入 + 可视化浏览 ---------------- */

function fillDirSuggestions(list) {
  const dl = $('#dirSuggestions');
  if (!dl || !Array.isArray(list)) return;
  dirShortcutCache = list;
  dl.innerHTML = list.map(x => `<option value="${esc(x.path)}">${esc(x.name)}</option>`).join('');
}

async function checkDir() {
  const el = $('#dirHint');
  if (!el) return;
  const v = $('#outputDir').value.trim();
  if (!v) { el.className = 'probe'; el.textContent = '请填写保存目录，或点「浏览…」选择。'; return; }
  try {
    const r = await api('/api/browse?path=' + encodeURIComponent(v) + '&check=1');
    el.className = 'probe ' + (r.ok && r.writable ? 'ok' : 'bad');
    el.textContent = r.ok
      ? (r.writable ? `目录可用（可写）：${r.path} · 切换只对之后开始的录制生效` : `目录存在但不可写：${r.path}，请换一个目录`)
      : `目录不可用：${r.message}（可直接填一个尚不存在的目录，程序会自动创建）`;
    if (r.shortcuts) fillDirSuggestions(r.shortcuts);
  } catch (e) { el.className = 'probe bad'; el.textContent = '目录检查失败：本地服务未响应'; }
}

async function browseDir(p) {
  const status = $('#dirStatus');
  try {
    const r = await api('/api/browse?path=' + encodeURIComponent(p || ''));
    if (!r.ok) { status.className = 'probe bad'; status.textContent = '无法打开：' + r.message; return; }
    dirBrowsePath = r.path; dirBrowseParent = r.parent;
    $('#dirPath').value = r.path;
    status.className = 'probe ' + (r.writable ? 'ok' : 'bad');
    status.textContent = (r.writable ? '当前目录可写' : '当前目录不可写，建议换一个')
      + ` · ${r.path} · ${(r.entries || []).length} 个子文件夹` + (r.warning ? ' · ' + r.warning : '');
    fillDirSuggestions(r.shortcuts || []);
    $('#dirShortcuts').innerHTML = (r.shortcuts || [])
      .map(x => `<button type="button" data-path="${esc(x.path)}">${esc(x.name)}</button>`).join('');
    $('#dirList').innerHTML = (r.entries || []).length
      ? r.entries.map(x => `<button type="button" class="dir-item" data-path="${esc(x.path)}" title="${esc(x.path)}">${esc(x.name)}</button>`).join('')
      : '<p class="muted small" style="padding:8px 10px">没有子文件夹，可直接点「选择当前目录」。</p>';
  } catch (e) { status.className = 'probe bad'; status.textContent = '读取目录失败：' + e.message; }
}

function openDirBrowser() {
  $('#dirModal').classList.remove('hidden');
  browseDir($('#outputDir').value.trim());
}
function closeDirBrowser() { $('#dirModal').classList.add('hidden'); }

async function selectDir() {
  if (!dirBrowsePath) return;
  $('#outputDir').value = dirBrowsePath;
  closeDirBrowser();
  await onChange();
  checkDir();
  uiAlert('保存目录已设为：' + dirBrowsePath + '\n（正在录制的任务仍写入原目录，新目录从下一次开始生效）');
}

function bindDirBrowser() {
  $('#btnBrowseDir').addEventListener('click', openDirBrowser);
  $('#btnDirClose').addEventListener('click', closeDirBrowser);
  $('#dirModal').addEventListener('click', e => { if (e.target.id === 'dirModal') closeDirBrowser(); });
  document.addEventListener('keydown', e => {
    const m = $('#dirModal');
    if (m && !m.classList.contains('hidden') && e.key === 'Escape') closeDirBrowser();
  });
  $('#btnDirUp').addEventListener('click', () => browseDir(dirBrowseParent));
  $('#btnDirGo').addEventListener('click', () => browseDir($('#dirPath').value));
  $('#dirPath').addEventListener('keydown', e => { if (e.key === 'Enter') browseDir($('#dirPath').value); });
  $('#dirList').addEventListener('click', e => {
    const b = e.target.closest('[data-path]'); if (b) browseDir(b.dataset.path);
  });
  $('#dirShortcuts').addEventListener('click', e => {
    const b = e.target.closest('[data-path]'); if (b) browseDir(b.dataset.path);
  });
  $('#btnDirSelect').addEventListener('click', selectDir);
  $('#btnDirNew').addEventListener('click', async () => {
    const name = $('#dirNewName').value.trim();
    if (!name) { uiAlert('请先填新文件夹名称', true); return; }
    const r = await post('/api/browse/mkdir', { parent: dirBrowsePath, name });
    if (!r.ok) { uiAlert('新建失败：' + (r.message || '未知原因'), true); return; }
    $('#dirNewName').value = '';
    await browseDir(r.path);
  });
  $('#outputDir').addEventListener('change', checkDir);
  $('#prefixFollow').addEventListener('change', e => setPrefixFollow(e.target.checked, true));
  $('#filePrefix').addEventListener('input', () => {
    if (prefixFollow) setPrefixFollow(false, false);   // 手改前缀后不再跟随，避免下次切台被覆盖
  });
  $('#sFreq').addEventListener('change', () => {
    if (!$('#sPrefix').value.trim()) $('#sPrefix').value = prefixFromFreq($('#sFreq').value);
  });
}

function setMode(m) {
  mode = m;
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.mode === m));
  $$('.mode-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === m));
}

function collect() {
  return {
    stationId: $('#preset').value === 'custom' ? '' : $('#preset').value,
    streamUrl: $('#streamUrl').value.trim(),
    outputDir: $('#outputDir').value.trim(),
    filePrefix: $('#filePrefix').value.trim() || 'FM990',
    segmentMinutes: Number($('#segmentMinutes').value),
    codec: $('#codec').value,
    engine: $('#engine').value,
    autoMonitor: $('#autoMonitor').checked,
    volume: Number($('#volume').value),
    autoRestart: $('#autoRestart').checked,
    repeatDaily: $('#repeatDaily').checked,
    mode,
    durationMinutes: Number($('#durationMinutes').value),
    hourlyHours: Number($('#hourlyHours').value),
    hourlyAlign: $('#hourlyAlign').value,
    rangeStart: $('#rangeStart').value,
    rangeEnd: $('#rangeEnd').value,
    ffmpegPath: $('#ffmpegPath').value.trim(),
    ffplayPath: $('#ffplayPath').value.trim()
  };
}

function onChange() {
  clearTimeout(saveTimer); clearTimeout(probeTimer);
  saveTimer = setTimeout(async () => {
    try { await api('/api/config', collect()); await refreshPreview(); } catch (e) { /* offline */ }
  }, 350);
  probeTimer = setTimeout(runProbe, 1600);
}

async function runProbe() {
  const box = $('#probeBox');
  try {
    const r = await api('/api/probe', { url: $('#streamUrl').value.trim(), seconds: 4 });
    if (!r.ok) { box.className = 'probe bad'; box.textContent = '检测失败：' + r.message; return; }
    box.className = r.found ? 'probe ok' : 'probe bad';
    box.innerHTML = r.hls
      ? `<b>HLS 直播流</b> · ${esc(r.codec)} · 分片零损失直录为 .ts<br>${esc(r.note)}`
      : r.found
        ? `<b>标准音频流</b> · ${esc(r.codec)} · ${r.bitrate} kbps · ${r.samplerate} Hz · 可零损失直录<br>${esc(r.note)}`
        : `<b>未识别到标准 MP3 帧</b><br>${esc(r.note)}`;
  } catch (e) { box.className = 'probe bad'; box.textContent = '检测失败：本地服务未响应'; }
}

async function refreshPreview() {
  try {
    const r = await api('/api/dry-run', { mode });
    if (r.ok) { previewInfo = r; previewCmd = r.command; $('#commandPreview').textContent = r.command; }
    else { previewInfo = null; previewCmd = ''; $('#commandPreview').textContent = '参数有误：' + r.message; }
    renderCountdown();
  } catch (e) { $('#commandPreview').textContent = '服务未响应'; }
}

function primaryJob() {
  const jobs = st.jobs || [];
  return jobs.find(j => ['running', 'stopping', 'scheduled'].includes(j.status)) || st.job || null;
}

function renderCountdown() {
  const job = primaryJob();
  const el = $('#countdown');
  if (job && job.status === 'scheduled') el.textContent = '距开始 ' + hms((job.startAt - (st.serverTime || Date.now())) / 1000);
  else if (job && job.status === 'running') el.textContent = (job.durationSec > 0 ? '剩余 ' + hms(job.remainingSec) : '不限时长 · 手动停止');
  else if (previewInfo) el.textContent = `${previewInfo.startText} · ${previewInfo.durationText}`;
  else el.textContent = '';
}

function renderBadges() {
  const ff = st.ffmpeg || {};
  const badge = $('#ffmpegBadge');
  badge.textContent = ff.found ? 'ffmpeg 已就绪' : '内置引擎模式';
  badge.className = 'badge ' + (ff.found ? 'ok' : 'wait');
  $('#warnBar').classList.toggle('hidden', !!ff.found);

  const n = st.runningCount || 0;
  const job = primaryJob();
  const s = job ? job.status : 'idle';
  const map = { idle: ['空闲', ''], scheduled: ['等待中', 'wait'], running: ['录制中', 'live'],
    stopping: ['停止中', 'wait'], completed: ['已完成', 'ok'], failed: ['失败', 'bad'], cancelled: ['已停止', ''],
    interrupted: ['源中断', 'wait'] };
  const [txt, cls] = map[s] || map.idle;
  const rb = $('#runBadge');
  rb.textContent = n > 1 ? `${n} 路并行录制` : txt;
  rb.className = 'badge ' + (n > 1 ? 'live' : cls);
  $('#statStatus').textContent = n > 1 ? `${n} 路并行` : txt;
  const engineTxt = st.engine === 'builtin' ? '内置直录' : st.engine === 'hls' ? '内置 HLS' : 'FFmpeg';
  $('#controlHint').textContent = (n
    ? `后台有 ${n} 路录制，关闭本页不会中断（服务需保持运行）；换一个电台即可并行再开一路`
    : '设置好参数后点「开始录制」；可换电台再开一路，实现并行') + ' · 主引擎：' + engineTxt;

  $('#btnStart').disabled = false;
  $('#btnStop').disabled = !n;
  $('#btnStopAll').disabled = !n;
  $('#btnPreview').disabled = false;
}

function renderStats() {
  const job = primaryJob();
  $('#statElapsed').textContent = st.running ? hms(st.elapsedSec) : '00:00:00';
  $('#statRemaining').textContent = job && job.durationSec > 0 ? hms(job.remainingSec || 0) : '—';
  $('#statBytes').textContent = fmtSize(st.totalBytes);
  $('#statFiles').textContent = String((st.files || []).length);
  $('#statRestarts').textContent = String(st.restartCount || 0);
  $('#statClock').textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const total = job && job.durationSec > 0 ? job.durationSec : 0;
  const pct = total > 0 && st.running ? Math.min(100, ((job.elapsedSec || 0) / total) * 100) : (job && job.status === 'completed' ? 100 : 0);
  $('#progressBar').style.width = pct.toFixed(1) + '%';
}

/* 实时视图里，只取「清空显示」之后新增的那些行。
 * 优先用服务端单调递增的 logSeq 精确切分；旧服务没有该字段时，
 * 退回用清空瞬间的最后一行内容定位分界。历史日期视图不受基线影响。 */
function liveLogLines() {
  const all = st.logs || [];
  if (!logCleared) return all;
  if (typeof st.logSeq === 'number' && logBaseSeq > 0) {
    if (st.logSeq < logBaseSeq) return all;   // 服务重启过，序号归零，新服务的日志都算新增
    const added = Math.max(0, st.logSeq - logBaseSeq);
    if (!added) return [];
    return all.slice(Math.max(0, all.length - added));
  }
  if (!logBaseTail) return all;      // 清空时本来就没有日志，之后出现的全是新增
  const idx = all.lastIndexOf(logBaseTail);
  return idx < 0 ? all : all.slice(idx + 1);
}

function renderLogs(force) {
  const box = $('#logBox');
  let txt;
  if (logView === 'live') {
    const lines = liveLogLines();
    txt = lines.join('\n');
    if (!txt) txt = logCleared
      ? `— 显示已清空（${logClearedAt}）· 磁盘日志完整保留 —\n等待新增日志…`
      : '暂无日志';
  } else {
    txt = historyText || '该日期暂无日志';
  }
  if (force || box.textContent !== txt) {
    box.textContent = txt;
    box.scrollTop = box.scrollHeight;
  }
}

/** 只清显示框：不动 logs/*.log、不动服务端日志缓冲，之后仅显示新日志。 */
function clearLogDisplay() {
  const all = st.logs || [];
  logCleared = true;
  logBaseSeq = Number(st.logSeq) || 0;
  logBaseTail = all.length ? all[all.length - 1] : '';
  logClearedAt = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  logView = 'live';
  const sel = $('#logDate'); if (sel) sel.value = 'live';
  renderLogs(true);
  const show = $('#btnShowAllLog'); if (show) show.classList.remove('hidden');
  const hint = $('#logHint');
  if (hint) hint.textContent = `${logClearedAt} 已清空显示 · 只显示新增日志`;
}

/** 恢复显示全部日志（仍只是本页显示，日志本来就没被删）。 */
function showAllLogDisplay() {
  logCleared = false; logBaseSeq = 0; logBaseTail = '';
  renderLogs(true);
  const show = $('#btnShowAllLog'); if (show) show.classList.add('hidden');
  const hint = $('#logHint'); if (hint) hint.textContent = '';
}

function renderLogDates() {
  const sel = $('#logDate');
  const dates = st.logDates || [];
  const html = '<option value="live">实时</option>' + dates.map(d => `<option value="${d}">${d}</option>`).join('');
  if (sel.innerHTML !== html) {
    sel.innerHTML = html;
    sel.value = logView === 'live' || dates.includes(logView) ? logView : 'live';
  }
}

function renderCommand() {
  const job = primaryJob();
  const running = job && job.status === 'running' && job.metrics && job.metrics.command;
  const text = running ? job.metrics.command : previewCmd;
  if (text && $('#commandPreview').textContent !== text) $('#commandPreview').textContent = text;
}

/* ------------------------- monitor (v3.1.8) ------------------------- */

function currentVolume() { return Number($('#volume').value || 80) / 100; }

/** 浏览器原生 <audio> 能否直接播放该任务的流；不可播时按钮灰掉，录制不受影响。 */
function monitorEligible(job) {
  const url = job && job.config && String(job.config.streamUrl || '').trim();
  if (!url) return { ok: false, reason: '该任务没有直播流地址' };
  if (!/^https?:\/\//i.test(url)) return { ok: false, reason: '不是 http/https 直播流' };
  if (/\.m3u8(\?|$)/i.test(url)) {
    return { ok: false, reason: 'HLS(.m3u8) 浏览器原生播放器不支持，请用 VLC / mpv 试听；录制不受影响' };
  }
  return { ok: true, url };
}

function monitorHintText(text, tone) {
  const hint = $('#monitorHint');
  if (!hint) return;
  const cls = 'probe' + (tone ? ' ' + tone : '');
  if (hint.className !== cls) hint.className = cls;
  if (hint.textContent !== text) hint.textContent = text;
}

function dropAudio() {
  const el = $('#monitorAudio');
  if (!el) return;
  try { el.pause(); } catch (e) { /* detached */ }
  if (el.getAttribute('src')) { el.removeAttribute('src'); el.load(); }
}

/* ------------------ preview: 10 秒 / 10·30·60 分钟 (v3.1.9) ------------------ */
/* 与任务监听互斥：startMonitor() 会 stopPreview()，startPreview() 会 stopMonitor()。
 * 长试听流中断时自动重连（最多 5 次、间隔 3 秒），到时或手动停止都清源清定时器。 */
const PREVIEW_MAX_RECONNECT = 5;

function previewStateText(text, tone) {
  const el = $('#previewState');
  if (!el) return;
  const cls = 'probe preview-state' + (tone ? ' ' + tone : '');
  if (el.className !== cls) el.className = cls;
  if (el.textContent !== text) el.textContent = text;
}

function syncPreviewButtons() {
  const on = !!previewAudio;
  const stop = $('#btnPreviewStop');
  if (stop) stop.disabled = !on;
  const short = $('#btnPreview');
  const long = $('#btnPreviewLong');
  if (short) short.textContent = on && previewLabel === 'short' ? '● 试听中' : '试听 10 秒';
  if (long) long.textContent = on && previewLabel === 'long' ? '● 长试听中' : '开始长试听';
}

function clearPreviewTimers() {
  if (previewTimer) { clearTimeout(previewTimer); previewTimer = 0; }
  if (previewTicker) { clearInterval(previewTicker); previewTicker = 0; }
}

/** reason 为空时静默收尾（切到任务监听 / 换一个试听源），不覆盖别处的状态提示。 */
function stopPreview(reason, tone) {
  const a = previewAudio;
  const wasLong = previewLabel === 'long';
  previewAudio = null;
  previewEndAt = 0;
  previewLabel = '';
  previewTotalSec = 0;
  previewReconnect = 0;
  previewToken++;                        // 丢弃在途的 play() / 重连回调
  clearPreviewTimers();
  if (a) {
    try { a.pause(); a.removeAttribute('src'); a.load(); } catch (e) { /* detached */ }
  }
  syncPreviewButtons();
  if (reason) previewStateText(reason, tone);
  else if (a) previewStateText(wasLong ? '长试听已停止 · 当前没有试听在播放' : '试听已停止');
}

function previewTick() {
  if (!previewAudio || !previewEndAt) return;
  const left = Math.ceil((previewEndAt - Date.now()) / 1000);
  if (left <= 0) { stopPreview('长试听已到时，已自动停止 · 录音任务不受影响', 'ok'); return; }
  previewStateText(`长试听中 · 共 ${Math.round(previewTotalSec / 60)} 分钟 · 剩余 ${hms(left)} · 点「停止试听」可随时结束；切换电台不会打断当前声音`, 'ok');
}

async function startPreview(seconds, kind) {
  await api('/api/config', collect());
  const url = $('#streamUrl').value.trim();
  if (!url) { uiAlert('请先填写直播流地址'); return; }
  if (/\.m3u8(\?|$)/i.test(url)) {
    uiAlert('当前是 HLS(.m3u8) 流，Chrome/Edge 无法直接播放（长试听同样不行）。请复制「直播流地址」用 VLC / mpv 试听；录制不受影响，仍是零损失直录 .ts。', true);
    previewStateText('当前流是 HLS，浏览器无法直接试听；请用 VLC / mpv，或直接开始录制', 'bad');
    return;
  }
  /* 排他：先停正在监听的任务，再停上一次试听。 */
  if (activeMonitorJobId) stopMonitor(kind === 'long' ? '已停止任务监听，开始长试听…' : '已停止任务监听，开始 10 秒试听…');
  stopPlayback();                      // v3.1.11：试听与回听同样互斥
  stopPreview();
  const token = ++previewToken;
  const a = document.createElement('audio');
  a.preload = 'none';
  a.src = url;
  a.volume = currentVolume();
  previewAudio = a;
  previewLabel = kind;
  previewEndAt = Date.now() + seconds * 1000;
  previewTotalSec = seconds;
  previewReconnect = 0;
  const retry = () => {
    if (previewAudio !== a || token !== previewToken || Date.now() >= previewEndAt) return;
    if (previewReconnect >= PREVIEW_MAX_RECONNECT) {
      stopPreview('长试听已停止：流反复中断，请检查流地址或网络（录制任务不受影响）', 'bad');
      return;
    }
    previewReconnect++;
    previewStateText(`长试听连接中断，3 秒后自动重连（${previewReconnect}/${PREVIEW_MAX_RECONNECT}）…`, 'bad');
    setTimeout(() => {
      if (previewAudio !== a || token !== previewToken) return;
      try { a.load(); a.play().catch(() => {}); } catch (e) { /* ignore */ }
      previewTick();
    }, 3000);
  };
  if (kind === 'long') {
    a.addEventListener('error', retry);
    a.addEventListener('ended', retry);
  }
  syncPreviewButtons();
  previewStateText(kind === 'long'
    ? `长试听启动中 · 共 ${Math.round(seconds / 60)} 分钟 · 剩余 ${hms(seconds)}`
    : '正在试听 10 秒…', 'ok');
  try {
    await a.play();
    if (previewAudio !== a || token !== previewToken) return;
  } catch (err) {
    if (previewAudio !== a || token !== previewToken) return;
    uiAlert('浏览器播放失败：' + ((err && err.message) || '未知原因') + '\n可把地址复制到 VLC 里验证。');
    stopPreview('试听未能开始：' + ((err && err.message) || '播放被拒绝或流不可达'), 'bad');
    return;
  }
  clearPreviewTimers();
  previewTimer = setTimeout(() => {
    if (previewAudio === a) stopPreview(kind === 'long'
      ? '长试听已到时，已自动停止 · 录音任务不受影响'
      : '10 秒试听结束', 'ok');
  }, seconds * 1000);
  previewTicker = setInterval(previewTick, 1000);
  previewTick();
  await api('/api/preview', { url, seconds: 10 });
  await poll();
}

/** 只改按钮外观，不重建整块 DOM，保证点击瞬间按钮不会被替换掉。 */
function refreshMonitorButtons() {
  $$('#jobList .job-row').forEach(row => {
    const btn = row.querySelector('[data-jobmonitor]');
    if (!btn) return;
    const on = btn.dataset.jobmonitor === activeMonitorJobId;
    btn.classList.toggle('on', on);
    btn.textContent = on ? '● 监听中' : (btn.disabled ? '⊘ 不可听' : '○ 监听');
  });
}

/** 回到空闲：清源、清状态、刷新按钮。 */
function setMonitorIdle(text, tone) {
  monitorToken++;
  activeMonitorJobId = '';
  dropAudio();
  refreshMonitorButtons();
  if (text) monitorHintText(text, tone);
}

function stopMonitor(reason, bad) {
  if (!activeMonitorJobId) { refreshMonitorButtons(); return; }
  setMonitorIdle(reason || '监听已停止 · 当前没有声音在播放', bad ? 'bad' : '');
}

async function startMonitor(id, auto) {
  const job = (st.jobs || []).find(j => j.id === id);
  if (!job) { monitorHintText('无法监听：任务不存在或已被删除', 'bad'); return; }
  const e = monitorEligible(job);
  if (!e.ok) { monitorHintText('无法监听：' + e.reason, 'bad'); return; }
  if (activeMonitorJobId === id) return;
  stopPreview();                       // 排他：试听与任务监听不能同时出声
  stopPlayback();                      // v3.1.11：回听也纳入全局单例排他
  dropAudio();                         // 排他：先停掉上一路，再点亮这一路
  activeMonitorJobId = '';
  const token = ++monitorToken;
  activeMonitorJobId = id;
  const el = $('#monitorAudio');
  el.volume = currentVolume();
  el.src = e.url;
  el.load();
  refreshMonitorButtons();
  monitorHintText(`正在连接「${job.label || id}」…`);
  try {
    await el.play();
    if (token !== monitorToken) return;   // 用户已切到别的任务：丢弃过期回调
    monitorHintText(`正在监听：${job.label || id} · 点该行按钮停止；点另一行会自动切换`, 'ok');
  } catch (err) {
    if (token !== monitorToken) return;
    setMonitorIdle((auto ? '浏览器拦截了自动播放：' : '播放失败：') +
      ((err && err.message) || '未知原因') + ' · 点一下该任务的「监听」按钮即可', 'bad');
  }
}

function toggleMonitor(id) {
  if (activeMonitorJobId === id) { stopMonitor(); return; }
  startMonitor(id, false);
}

/** 每次轮询只做校验与音量同步：任务是否还在、源是否变了。绝不在这里自动 play()。 */
function syncMonitor() {
  const el = $('#monitorAudio');
  if (el) el.volume = currentVolume();
  if (!activeMonitorJobId) {
    if (el && el.getAttribute('src')) dropAudio();
    if (!previewAudio) monitorHintText('监听状态：空闲 · 点任意任务行的「监听」按钮开始（同时只能有一路）');
    refreshMonitorButtons();
    return;
  }
  const job = (st.jobs || []).find(j => j.id === activeMonitorJobId);
  if (!job) { setMonitorIdle('监听已自动停止：该任务记录已被删除'); return; }
  const e = monitorEligible(job);
  if (!e.ok) { setMonitorIdle('监听已自动停止：' + e.reason, 'bad'); return; }
  if (el && el.getAttribute('src') !== e.url) {
    el.src = e.url; el.load();
    monitorHintText('任务的流地址发生变化，正在重新连接…');
  }
  refreshMonitorButtons();
}

/* ------------------------------ files ------------------------------ */

/* ---------- 回听（v3.1.11）：播放器与文件列表彻底解耦 ---------- */
/* 关键约束：renderFiles() 用 innerHTML 重建 #fileList。任何放在行内的 <audio>
 * 都会在删除/刷新时连同 DOM 一起被销毁，播放与 currentTime 必然归零。
 * 因此这里只保留一个位于列表外的单例播放器；行内只有普通按钮，重绘不碰它。 */
function syncPlaybackUI() {
  const bar = $('#playbackBar');
  if (bar) bar.classList.toggle('hidden', !activePlaybackName);
  const label = $('#playbackLabel');
  if (label) label.textContent = activePlaybackName ? '正在回听：' + activePlaybackName : '正在回听：—';
  const stop = $('#btnPlaybackStop');
  if (stop) stop.disabled = !activePlaybackName;
  const list = $('#fileList');
  if (list) {
    Array.from(list.querySelectorAll('[data-play]')).forEach(btn => {
      const on = btn.getAttribute('data-play') === activePlaybackName;
      const text = on ? '■ 停止' : '▶ 回听';
      if (btn.textContent !== text) btn.textContent = text;
      btn.classList.toggle('playing', on);
      btn.title = on ? '停止回听' : '回听这个文件（刷新列表不会打断）';
    });
  }
}

/** reason 为空时静默收尾（切换文件 / 切到监听），不覆盖其它地方的状态提示。 */
function stopPlayback(reason) {
  if (!activePlaybackName) { syncPlaybackUI(); return; }
  activePlaybackName = '';
  playbackToken++;                       // 丢弃在途的 play() 回调
  const a = $('#playbackAudio');
  if (a) { try { a.pause(); a.removeAttribute('src'); a.load(); } catch (e) { /* detached */ } }
  syncPlaybackUI();
  if (reason) setFileMsg(reason, false);
}

async function startPlayback(name) {
  const f = (st.files || []).find(x => x.name === name);
  if (!f) { setFileMsg('文件已不存在，无法回听', true); return; }
  if (activePlaybackName === name) { stopPlayback('已停止回听：' + name); return; }
  /* 与任务监听 / 试听保持全局排他：同一时刻只有一路声音。 */
  stopMonitor('已停止任务监听，开始回听录音文件…');
  stopPreview();
  stopPlayback();                        // 静默切掉上一路，下面立刻设新文件
  const token = ++playbackToken;
  activePlaybackName = name;
  const a = $('#playbackAudio');
  if (!a) { activePlaybackName = ''; setFileMsg('回听播放器不可用', true); return; }
  a.src = '/media?name=' + encodeURIComponent(name);
  a.load();
  syncPlaybackUI();
  setFileMsg(`正在回听：${name} · 删除其它文件或刷新列表都不会打断；当前文件被删会自动停止`, false);
  try {
    await a.play();
    if (token !== playbackToken) return;
  } catch (err) {
    if (token !== playbackToken) return;
    setFileMsg('浏览器未自动播放：' + ((err && err.message) || '未知原因') + ' · 点播放器里的播放键即可', true);
  }
}

/** 轮询里只做生命周期校验；只要文件还在，就绝不碰播放器（进度原样保留）。 */
function syncPlaybackLifecycle() {
  if (activePlaybackName && !(st.files || []).some(f => f.name === activePlaybackName)) {
    stopPlayback('正在回听的文件已不在列表中，已自动停止（其它文件不受影响）');
    return;
  }
  syncPlaybackUI();
}

function renderFiles() {
  const files = st.files || [];
  const el = $('#fileList');
  const dh = $('#filesDirHint');
  if (dh) {
    const dir = st.outputDir || $('#outputDir').value.trim();
    dh.className = 'probe';
    dh.textContent = `录音目录：${dir || '未设置'} · 共 ${files.length} 个文件（「打开目录」就是打开这里）`;
  }
  const valid = new Set(files.map(f => f.name));
  for (const n of Array.from(selectedFiles)) if (!valid.has(n)) selectedFiles.delete(n);
  const key = files.map(f => `${f.name}|${f.size}|${f.writing}|${f.deletable}|${f.healthy}|${f.durationSec}|${f.reason || ''}`).join('|')
    + '|' + Array.from(selectedFiles).sort().join(',');
  const shown = files.slice(0, 80);
  if (key !== lastFilesKey) {
    lastFilesKey = key;
    if (!files.length) el.innerHTML = '<p class="muted small">暂无文件</p>';
    else {
      el.innerHTML = shown.map(f => {
        // v3.1.12：0 字节空片段是源中断后未落盘，不是内容损坏，应避免误报。
        const emptySeg = f.healthy === false && /空片段/.test(f.reason || '');
        const flag = f.writing ? '<span class="file-flag writing">写入中</span>'
          : f.healthy === true ? '<span class="file-flag ok">完整</span>'
            : emptySeg ? '<span class="file-flag writing" title="源中断后未落盘任何音频，可安全删除">空片段</span>'
              : f.healthy === false ? '<span class="file-flag bad">疑似损坏</span>'
                : '<span class="file-flag writing">非 MP3</span>';
        const when = new Date(f.mtime).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
        const checked = selectedFiles.has(f.name) ? ' checked' : '';
        const canDel = f.deletable !== false;
        const del = canDel
          ? `<button class="icon-btn" data-del="${esc(f.name)}" title="删除该文件">删除</button>`
          : `<button class="icon-btn locked" data-del="${esc(f.name)}" data-locked="1" title="正在写入：点击可先停止对应任务再删除">停止后删</button>`;
        return `
        <div class="file-item">
          <label class="file-check"><input type="checkbox" data-pick="${esc(f.name)}"${checked}${canDel ? '' : ' disabled'}></label>
          <span class="file-name">${esc(f.name)}</span>
          <span class="file-meta"><span class="file-size">${fmtSize(f.size)}</span> · ${fmtDurShort(f.durationSec)} · ${when}${flag}</span>
          <button class="icon-btn play-btn" data-play="${esc(f.name)}" title="回听这个文件（刷新列表不会打断）">▶ 回听</button>
          ${del}
        </div>`;
      }).join('') + (files.length > shown.length
        ? `<p class="muted small">仅列出最近 ${shown.length} 个（共 ${files.length} 个）；批量删除会处理全部符合条件的文件。</p>` : '');
    }
  }
  const items = el.querySelectorAll('.file-item');
  shown.forEach((f, i) => {
    const span = items[i] && items[i].querySelector('.file-size');
    if (span) span.textContent = fmtSize(f.size);
  });
  /* v3.1.6：合并按钮常亮可点。过去默认 disabled + opacity .4 + ghost 透明底，
     在深色主题下几乎看不见，用户以为「根本没有这个按钮」。未选够时改为点击给提示。 */
  const mergeable = mergeableFiles();
  const mergeableNames = new Set(mergeable.map(f => f.name));
  const pickedMergeable = Array.from(selectedFiles).filter(n => mergeableNames.has(n));
  const bm = $('#btnMerge');
  if (bm) {
    bm.disabled = false;
    bm.textContent = pickedMergeable.length
      ? `合并选中分段（${pickedMergeable.length}）` : '合并选中分段';
  }
  const bd = $('#btnDeleteSelected'); if (bd) bd.disabled = selectedFiles.size === 0;
  const hint = $('#fileSelHint');
  if (hint) hint.textContent = `已选 ${selectedFiles.size} 个 / 共 ${files.length} 个 · 可合并 ${mergeable.length} 个 .mp3`;
  /* v3.1.11：列表重绘后只同步按钮文字 / 显隐，绝不重建播放器元素。 */
  syncPlaybackUI();
}

/** 能进合并的文件 = 可勾选的 .mp3；后端还会再校验一次正在写入的文件。 */
function mergeableFiles() {
  return (st.files || []).filter(f => /\.mp3$/i.test(f.name) && f.deletable !== false);
}

/** 一键勾选全部可合并分段，省得逐个点复选框。 */
function selectMergeable() {
  const list = mergeableFiles();
  if (list.length < 2) {
    setFileMsg(`当前只有 ${list.length} 个可合并的 .mp3 分段，至少需要 2 个才能合并。`, true);
    return;
  }
  const pick = list.slice(0, 100);
  selectedFiles.clear();
  pick.forEach(f => selectedFiles.add(f.name));
  lastFilesKey = '';
  renderFiles();
  setFileMsg(`已勾选 ${pick.length} 个可合并的 .mp3 分段${list.length > 100 ? '（单次上限 100 个，其余未勾选）' : ''}，点蓝色「合并选中分段」即可无损拼接。`, false);
}

/* ----------------------- 文件删除（单个 / 批量） ----------------------- */

function setFileMsg(text, bad) {
  const el = $('#fileMsg');
  if (!el) return;
  el.className = 'file-msg' + (text ? '' : ' hidden') + (bad ? ' bad' : '');
  el.textContent = text || '';
}

async function deleteFilesRequest(names, label) {
  if (!names.length) { setFileMsg('没有可删除的文件（可能都在写入中）', true); return { deleted: [] }; }
  setFileMsg(`正在删除 ${names.length} 个文件…`, false);
  let r;
  try { r = await api('/api/files/delete', { names }); }
  catch (e) {
    setFileMsg(`删除失败：无法连接本地服务（${e.message}）。请确认服务仍在运行后重试。`, true);
    return { deleted: [] };
  }
  const ok = r.deleted || [], errs = r.errors || [];
  /* v3.1.11：只停「正好正在回听」的那一个文件；删别的文件时播放器与进度完全不动。 */
  const wasPlaying = ok.some(n => n === activePlaybackName);
  if (wasPlaying) stopPlayback();     // 静默；最终提示里统一说明
  // ① 乐观更新：立刻把已删文件从本地列表移除并同步重绘 —— 点确定后同帧就能看到行消失。
  const gone = new Set(ok);
  st.files = (st.files || []).filter(f => !gone.has(f.name));
  ok.forEach(n => selectedFiles.delete(n));
  lastFilesKey = null;
  renderFiles();
  // ② 复核服务端磁盘状态：真正消失才算成功，避免「提示成功但文件还在」。
  let still = [];
  try {
    const after = await api('/api/status');
    still = names.filter(n => (after.files || []).some(f => f.name === n));
  } catch (e2) { /* 状态拉取失败不影响已给出的删除结果 */ }
  let msg = `${label}：成功删除 ${ok.length} 个`;
  if (ok.length) msg += `，释放 ${fmtSize(r.bytes)}`;
  if (errs.length) msg += `；跳过 ${errs.length} 个（${errs.slice(0, 3).map(e => `${e.name}：${e.message}`).join('；')}${errs.length > 3 ? ' …' : ''}）`;
  if (!ok.length && !errs.length) msg += `。${r.message || '服务端未返回删除结果'}`;
  if (still.length) msg += `；仍有 ${still.length} 个文件未消失（${still.slice(0, 2).join('、')}${still.length > 2 ? '…' : ''}），可能被录制进程占用，请先停止对应任务再删`;
  else if (ok.length) msg += ' · 列表已实时刷新';
  if (wasPlaying) msg += ' · 你正在回听的文件已删除，回听已自动停止（其它文件的回听不受影响）';
  setFileMsg(msg, !ok.length || errs.length > 0 || still.length > 0);
  // ③ 立即用服务端状态校准（强制刷新，不受服务曾停止的影响），再延迟补刷一次。
  try { await poll(true); } catch (e3) { /* poll 自行处理断线 */ }
  setTimeout(() => { lastFilesKey = null; poll(true); }, 800);
  return r;
}

async function deleteOne(name, locked) {
  if (locked) {
    const job = (st.jobs || []).find(j => j.status === 'running' && j.metrics && j.metrics.activeFile === name);
    setFileMsg(`「${name}」正在写入，需要先停止录制再删除`, true);
    if (!(await uiConfirm(`「${name}」正在写入，不能直接删除。\n\n是否先停止${job ? '这一路' : '所有'}录制任务，再删除该文件？\n已写入磁盘的部分会完整保留在当前文件里。`, '停止后删除', '停止并删除'))) {
      setFileMsg('已取消删除', false); return;
    }
    try {
      await api(job ? '/api/stop' : '/api/stop-all', job ? { id: job.id } : {});
      await new Promise(r => setTimeout(r, 900));
      await poll();
    } catch (e) { setFileMsg('停止录制失败：' + e.message, true); return; }
  } else {
    setFileMsg(`准备删除「${name}」，等待确认…`, false);
    if (!(await uiConfirm(`删除文件 ${name}？此操作不可恢复。`, '删除录音文件', '确认删除'))) {
      setFileMsg('已取消删除', false); return;
    }
  }
  await deleteFilesRequest([name], '删除文件');
}

function selectAllDeletable() {
  (st.files || []).forEach(f => { if (f.deletable !== false) selectedFiles.add(f.name); });
  lastFilesKey = null; renderFiles();
}
function clearSelection() { selectedFiles.clear(); lastFilesKey = null; renderFiles(); }

async function deleteSelected() {
  const names = Array.from(selectedFiles).filter(n => (st.files || []).some(f => f.name === n && f.deletable !== false));
  if (!names.length) { setFileMsg('选中的文件都不可删除（可能正在写入）', true); return; }
  setFileMsg(`准备删除选中的 ${names.length} 个文件，等待确认…`, false);
  if (!(await uiConfirm(`确认永久删除选中的 ${names.length} 个录音文件？此操作不可恢复。`, '批量删除', '确认删除'))) {
    setFileMsg('已取消删除', false); return;
  }
  await deleteFilesRequest(names, '批量删除');
}

async function deleteAllFiles() {
  const deletable = (st.files || []).filter(f => f.deletable !== false);
  const names = deletable.map(f => f.name);
  const bytes = deletable.reduce((s, f) => s + f.size, 0);
  if (!names.length) { setFileMsg('没有可删的文件', true); return; }
  const skipped = (st.files || []).length - names.length;
  setFileMsg(`准备删除 ${names.length} 个文件，等待确认…`, false);
  if (!(await uiConfirm(`确认永久删除输出目录里的 ${names.length} 个录音文件（共 ${fmtSize(bytes)}）？\n${skipped ? `正在写入的 ${skipped} 个会自动跳过。\n` : ''}此操作不可恢复。`, '删除全部文件', '确认删除'))) {
    setFileMsg('已取消删除', false); return;
  }
  await deleteFilesRequest(names, '删除全部');
}

async function cleanTestFiles() {
  let r;
  try { r = await api('/api/selftest/clean', {}); }
  catch (e) { setFileMsg('清理失败：' + e.message, true); return; }
  setFileMsg(`清理测试文件：删除 ${(r.deleted || []).length} 个 · 列表已刷新${(r.errors || []).length ? '，跳过 ' + r.errors.length + ' 个' : ''}`, false);
  const gone = new Set(r.deleted || []);
  if (activePlaybackName && gone.has(activePlaybackName)) stopPlayback();
  st.files = (st.files || []).filter(f => !gone.has(f.name));
  Array.from(selectedFiles).forEach(n => { if (/^(TEST_|__SELFTEST__)/.test(n)) selectedFiles.delete(n); });
  lastFilesKey = null;
  renderFiles();
  try { await poll(true); } catch (e) { /* ignore */ }
}

async function mergeSelected() {
  const names = Array.from(selectedFiles);
  if (names.length < 2) {
    setFileMsg('请先勾选至少 2 个 .mp3 分段，或直接点「全选可合并」一键勾选。', true);
    uiAlert('尚未选中可合并的分段：请先勾选 2 个以上 .mp3，或点「全选可合并」。', true);
    return;
  }
  const mergeableNames = new Set(mergeableFiles().map(f => f.name));
  const bad = names.filter(n => !mergeableNames.has(n));
  if (bad.length) {
    setFileMsg(`选中的 ${bad.length} 个文件不能合并（只支持 .mp3，且不能是正在写入的文件）：${bad.slice(0, 3).join('、')}${bad.length > 3 ? '…' : ''}`, true);
    return;
  }
  if (names.length > 100) {
    setFileMsg('一次最多合并 100 个分段，请减少勾选数量（或分批合并）。', true);
    return;
  }
  // 按真实文件时间排序，文件名升序作为并列时的稳定次序；字典序只在同前缀命名下才等价于时间序。
  const byName = new Map((st.files || []).map(f => [f.name, f]));
  const ordered = names.slice().sort((a, b) => {
    const ta = (byName.get(a) || {}).mtime || 0, tb = (byName.get(b) || {}).mtime || 0;
    return ta - tb || a.localeCompare(b, 'zh-CN');
  });
  if (!await uiConfirm(`把 ${ordered.length} 个分段按文件时间顺序无损拼接成一个 MP3？按字节拼接、零二次损失，原文件保留，生成 MERGE_*.mp3。`)) {
    setFileMsg('已取消合并，未改动任何文件。', false);
    return;
  }
  setFileMsg(`正在无损合并 ${ordered.length} 个分段…`, false);
  let r;
  try { r = await api('/api/files/merge', { names: ordered }); }
  catch (e) {
    setFileMsg(`合并失败：无法连接本地服务（${e.message}）。请确认服务仍在运行后重试。`, true);
    return;
  }
  if (!r.ok) {
    setFileMsg('合并失败：' + (r.message || '未知原因'), true);
    uiAlert(r.message || '合并失败', true);
    return;
  }
  setFileMsg(`合并完成：${r.name}（${fmtSize(r.size)}）· ${ordered.length} 个分段按字节拼接，原文件保留，列表已刷新。`, false);
  uiAlert('合并完成：' + r.name + '（' + fmtSize(r.size) + '）');
  selectedFiles.clear();
  lastFilesKey = null;
  try { await poll(true); } catch (e) { /* ignore */ }
}

/* --------------------------- parallel jobs --------------------------- */

const LIVE_JOB_STATES = ['running', 'stopping', 'scheduled'];
const isLiveJob = j => LIVE_JOB_STATES.includes(j.status);

function setJobMsg(text, bad) {
  const el = $('#jobMsg');
  if (!el) return;
  el.className = 'file-msg' + (text ? '' : ' hidden') + (bad ? ' bad' : '');
  el.textContent = text || '';
}

function renderJobs() {
  const all = st.jobs || [];
  const jobs = all.slice(0, 12);
  const live = all.filter(isLiveJob);
  $('#jobCountHint').textContent = `${live.length} 路进行中 · 上限 ${st.maxParallel || 8}`;
  const cd = $('#btnClearDone');
  if (cd) cd.disabled = !all.some(j => !isLiveJob(j));
  // 计时/码率不参与缓存 key：否则整行每秒重绘，按钮会在点击瞬间被 DOM 替换掉。
  // 计时改为下方单独更新文本节点。
  const key = JSON.stringify(jobs.map(j => [j.id, j.status, j.endedAt || 0,
    j.metrics && j.metrics.activeFile, Math.round((j.metrics && j.metrics.bps || 0) / 100),
    (j.config && j.config.streamUrl) || ''])) + '|' + activeMonitorJobId;
  if (key !== lastJobsKey) {
    lastJobsKey = key;
    const el = $('#jobList');
    if (!jobs.length) el.innerHTML = '<p class="muted small">暂无任务</p>';
    else el.innerHTML = jobs.map(j => {
      const m = j.metrics || {};
      const stMap = { running: ['录制中', 'live'], scheduled: ['等待中', 'wait'], stopping: ['停止中', 'wait'],
        completed: ['已完成', 'ok'], cancelled: ['已停止', ''], failed: ['失败', 'bad'],
        interrupted: ['源中断', 'wait'] };
      const [txt, cls] = stMap[j.status] || ['未知', ''];
      const kbps = (m.bps || 0) * 8 / 1000;
      const pct = Math.min(100, kbps / 128 * 100);
      const alive = m.alive && j.status === 'running';
      const meter = j.status === 'running'
        ? `<div class="meter"><div class="meter-fill ${alive ? '' : 'stall'}" style="width:${pct.toFixed(0)}%"></div></div>
           <span class="job-sub">${kbps.toFixed(0)} kbps · ${alive ? '流活跃' : '静默/重连中'} · 重连 ${m.restartCount || 0} 次<br>${esc(m.activeFile || '准备写盘…')}</span>`
        : `<span class="job-sub">${j.durationSec > 0 ? fmtDurShort(j.remainingSec) + ' 剩余' : '不限时长'}${j.startAt ? ' · ' + new Date(j.startAt).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''}${j.emptySegments && j.emptySegments.length ? ' · 已清理空片段 ' + j.emptySegments.length + ' 个' : ''}</span>`;
      // 进行中 → 停止；已结束（已完成 / 已停止 / 失败）→ 删除记录
      const action = isLiveJob(j)
        ? `<button class="icon-btn" data-jobstop="${esc(j.id)}">停止</button>`
        : `<button class="icon-btn del" data-jobdel="${esc(j.id)}" title="仅移除这条任务记录，磁盘上的录音文件保留">删除</button>`;
      // 监听按钮：三态由 activeMonitorJobId + 源可否播放共同决定；禁用时给得出原因。
      const mon = monitorEligible(j);
      const monOn = j.id === activeMonitorJobId;
      const monBtn = `<button class="mon-btn${monOn ? ' on' : ''}" data-jobmonitor="${esc(j.id)}"${mon.ok ? '' : ' disabled'} title="${esc(mon.ok ? (monOn ? '点击停止监听这一路' : '点击监听这一路（会自动停掉其它路）') : mon.reason)}">${monOn ? '● 监听中' : (mon.ok ? '○ 监听' : '⊘ 不可听')}</button>`;
      return `<div class="job-row${isLiveJob(j) ? '' : ' done'}">
        <div class="job-main">
          <div><b>${esc(j.label || j.id)}</b><span class="tag ${cls}">${txt}</span></div>
          <div class="job-sub">${esc(j.stationName || (j.config && j.config.filePrefix) || '')} · ${esc((j.config && j.config.streamUrl) || '').slice(0, 62)}…</div>
          ${meter}
        </div>
        <div class="job-actions">
          <span class="job-time">${hms(j.elapsedSec || 0)}</span>
          ${monBtn}
          ${action}
        </div>
      </div>`;
    }).join('');
  }
  // 每秒只更新计时文本，不重建 DOM，保证按钮随时可点。
  const rows = $$('#jobList .job-row');
  rows.forEach((row, i) => {
    const t = row.querySelector('.job-time');
    if (t && jobs[i]) t.textContent = hms(jobs[i].elapsedSec || 0);
  });
}

/** 删除一条已结束的任务记录：先立即更新界面，再用服务端状态校准。 */
async function deleteJob(id) {
  const j = (st.jobs || []).find(x => x.id === id);
  if (!j) return;
  if (isLiveJob(j)) { setJobMsg('该任务仍在进行中，请先点「停止」再删除', true); return; }
  setJobMsg('正在移除任务记录…', false);
  let r;
  try { r = await api('/api/jobs/delete', { id }); }
  catch (e) { setJobMsg('移除失败：无法连接本地服务（' + e.message + '）', true); return; }
  if (!r.ok) { setJobMsg('移除失败：' + (r.message || '未知原因'), true); return; }
  st.jobs = (st.jobs || []).filter(x => x.id !== id);
  lastJobsKey = '';
  renderJobs();
  syncMonitor();                       // 正在监听的任务被删掉时立即停声，不等下一次轮询
  setJobMsg(`已移除「${j.label || id}」的任务记录 · 列表已刷新（录音文件保留）`, false);
  await poll(true);
}

/** 批量清理所有已结束任务（需确认）。 */
async function clearDoneJobs() {
  const done = (st.jobs || []).filter(j => !isLiveJob(j));
  if (!done.length) { setJobMsg('没有已结束的任务可清理', false); return; }
  if (!await uiConfirm(`移除 ${done.length} 条已结束的任务记录？\n只清理列表，磁盘上的录音文件全部保留。`, '清理任务记录', '确认清理')) return;
  let r;
  try { r = await api('/api/jobs/delete', { all: true }); }
  catch (e) { setJobMsg('清理失败：' + e.message, true); return; }
  const gone = new Set(r.removed || []);
  st.jobs = (st.jobs || []).filter(x => !gone.has(x.id));
  lastJobsKey = '';
  renderJobs();
  syncMonitor();                       // 批量清理后同样立即校准监听态
  setJobMsg(r.count ? `已清理 ${r.count} 条已结束任务 · 列表已刷新（录音文件保留）` : '没有可清理的任务', !r.count);
  await poll(true);
}

/* ---------------------------- station library ---------------------------- */

function renderStations() {
  const list = st.stations || stationList;
  const key = JSON.stringify(list.map(s => [s.id, s.name, s.freq, s.url]));
  if (key === lastStationsKey) return;
  lastStationsKey = key;
  stationList = list;
  presets = list.map(s => ({ id: s.id, name: `${s.name} ${s.freq}`, url: s.url, freq: s.freq, prefix: s.prefix }));
  const el = $('#stationList');
  if (!el) return;
  el.innerHTML = list.map(s => `<div class="station-row">
      <div><b>${esc(s.name)}</b> <span class="tag on">${esc(s.freq)}</span>
        <span class="sub">${esc(s.url)}<br>前缀 ${esc(s.prefix)} · 频道ID ${s.channelId || '—'} ${s.builtin ? '· 内置' : '· 自定义'}${s.note ? '<br>' + esc(s.note) : ''}</span></div>
      <div class="plan-actions">
        <button class="icon-btn" data-station="use" data-id="${esc(s.id)}">选用</button>
        <button class="icon-btn" data-station="test" data-id="${esc(s.id)}">测活</button>
        <button class="icon-btn" data-station="edit" data-id="${esc(s.id)}">编辑</button>
        ${s.builtin ? '' : `<button class="icon-btn" data-station="del" data-id="${esc(s.id)}">删除</button>`}
      </div>
    </div>`).join('');
  const keep = $('#preset').value;                 // fillPresets() 会重建 option，先留住当前选择
  fillPresets();
  const cur = keep || cfg.stationId;
  if (cur && list.some(s => s.id === cur)) $('#preset').value = cur;
  applyStationPrefix();
}

async function useStation(id) {
  const s = (st.stations || stationList).find(x => x.id === id);
  if (!s) return;
  $('#preset').value = id;
  $('#streamUrl').value = s.url;
  $('#epgStation').value = id;
  applyStationPrefix();
  onChange();
  await loadEpg();
}

function stationFormValues() {
  return {
    name: $('#sName').value.trim(), freq: $('#sFreq').value.trim(),
    url: $('#sUrl').value.trim(),
    prefix: $('#sPrefix').value.trim() || prefixFromFreq($('#sFreq').value) || 'REC',
    channelId: Number($('#sChannelId').value) || 0
  };
}
function resetStationForm() {
  editingStationId = null;
  ['#sName', '#sFreq', '#sUrl', '#sPrefix', '#sChannelId'].forEach(s => { $(s).value = ''; });
  $('#stationMsg').textContent = '';
  $('#btnStationSave').textContent = '保存电台';
}
function setStationForm(s) {
  editingStationId = s.id;
  $('#sName').value = s.name; $('#sFreq').value = s.freq;
  $('#sUrl').value = s.url; $('#sPrefix').value = s.prefix;
  $('#sChannelId').value = s.channelId || '';
  $('#btnStationSave').textContent = '保存修改';
  $('#stationEditor').open = true;
}
async function saveStation() {
  const v = stationFormValues();
  const path = editingStationId ? '/api/stations/update' : '/api/stations/add';
  const body = editingStationId ? { id: editingStationId, station: v } : { station: v };
  const r = await api(path, body);
  if (!r.ok) { $('#stationMsg').textContent = r.message || '保存失败'; return; }
  resetStationForm();
  lastStationsKey = '';
  await poll();
  $('#stationMsg').textContent = '已保存';
}

/* ------------------------------- EPG ------------------------------- */

async function loadEpg() {
  if (epgLoading) return;
  epgLoading = true;
  const sid = $('#epgStation').value || (presets[0] && presets[0].id) || '';
  const date = dateKeyOffset(Number($('#epgDate').value));
  try {
    epgData = await api('/api/epg?stationId=' + encodeURIComponent(sid) + '&date=' + date);
    lastEpgKey = '';
    renderEpg();
  } catch (e) { /* offline */ }
  epgLoading = false;
}

function renderEpg() {
  const el = $('#epgList');
  const d = epgData;
  if (!d || !d.ok) { el.innerHTML = '<p class="muted small">节目表暂不可用</p>'; return; }
  const sourceTxt = d.source === 'builtin' ? '内置静态节目表（在线源不可达）'
    : d.source === 'cache' ? '本地缓存' : '在线抓取';
  $('#epgNote').textContent = `${d.stationName} · ${d.date} · ${d.programmes.length} 档 · ${sourceTxt}`;
  const key = JSON.stringify([d.stationId, d.date, d.source, d.programmes.map(p => [p.title, p.live, p.past])]);
  if (key === lastEpgKey) return;
  lastEpgKey = key;
  if (!d.programmes.length) { el.innerHTML = '<p class="muted small">该电台暂无节目表数据</p>'; return; }
  el.innerHTML = d.programmes.map((p, i) => `<div class="epg-row ${p.live ? 'live' : ''} ${p.past ? 'past' : ''}">
      <span class="epg-time">${esc(p.start)}–${esc(p.end)}</span>
      <span class="epg-title">${p.live ? '<span class="tag live">正在播出</span>' : ''}${esc(p.title)}${p.broadcaster ? ' <small>· ' + esc(p.broadcaster) + '</small>' : ''}</span>
      <span class="epg-dur">${p.durationMin} 分钟</span>
      <button class="icon-btn" data-epg="${i}"${p.past ? ' disabled' : ''}>加入节目单</button>
    </div>`).join('');
}

async function epgToPlan(i) {
  const d = epgData;
  if (!d || !d.programmes[i]) return;
  const r = await api('/api/epg/to-plan', {
    stationId: d.stationId, programme: d.programmes[i], rule: $('#epgRule').value
  });
  if (!r.ok) { uiAlert(r.message || '加入失败'); return; }
  $('#epgNote').textContent = `已加入节目单：${d.programmes[i].title}（可在「定时节目单」里编辑）`;
  await poll();
}

async function refreshEpg(all) {
  const note = $('#epgNote');
  note.textContent = all ? '正在刷新全部电台的节目表…' : '正在刷新…';
  const r = await api('/api/epg/refresh', all ? {} : { stationId: $('#epgStation').value });
  if (!r.ok) { note.textContent = '刷新失败：' + r.message; return; }
  if (all) {
    for (let i = 0; i < 40; i++) {
      await new Promise(x => setTimeout(x, 1000));
      const s = await api('/api/epg/status');
      if (!s.refresh.running) {
        note.textContent = `全部刷新完成（${s.refresh.done} 个电台，失败 ${s.refresh.errors.length}）`;
        break;
      }
      note.textContent = `正在刷新 ${s.refresh.done}/${s.refresh.total}…`;
    }
  } else note.textContent = '本台节目表已刷新';
  await loadEpg();
}

/* ------------------------------ alerts ------------------------------ */

async function loadAlerts() {
  try { alertsData = await api('/api/alerts'); lastAlertKey = ''; renderAlerts(); } catch (e) { /* offline */ }
}

function renderAlerts() {
  const a = (st.alerts || {});
  const unread = a.unread || 0;
  $('#alertBadge').textContent = String(unread);
  $('#alertBadge').classList.toggle('has', unread > 0);
  if (unread !== lastAlertUnread) {
    lastAlertUnread = unread;
    if (unread) loadAlerts();
  }
  const policy = a.policy || (alertsData && alertsData.policy) || {};
  if (!policyDirty) {
    if ($('#alertWebhook') && document.activeElement !== $('#alertWebhook')) $('#alertWebhook').value = policy.webhookUrl || '';
    if ($('#alertHookType')) $('#alertHookType').value = policy.webhookType || 'auto';
    if ($('#alertEnabled')) $('#alertEnabled').checked = policy.enabled !== false;
    if ($('#alertOnFailure')) $('#alertOnFailure').checked = policy.onFailure !== false;
    if ($('#alertOnDisconnect')) $('#alertOnDisconnect').checked = policy.onDisconnect !== false;
    if ($('#alertOnDisk')) $('#alertOnDisk').checked = policy.onDisk !== false;
    if ($('#alertOnPlan')) $('#alertOnPlan').checked = policy.onPlan !== false;
  }
  const events = (alertsData && alertsData.events) || a.recent || [];
  const key = JSON.stringify(events.map(e => [e.id, e.read, e.message]));
  if (key === lastAlertKey) return;
  lastAlertKey = key;
  const el = $('#alertList');
  if (!events.length) { el.innerHTML = '<p class="muted small">暂无告警</p>'; return; }
  el.innerHTML = events.slice(0, 20).map(e => `<div class="alert-row ${e.read ? '' : 'unread'} ${esc(e.level)}">
      <span class="alert-time">${new Date(e.at).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
      <span class="alert-msg">${esc(e.message)}</span>
      ${e.read ? '' : `<button class="icon-btn" data-alertread="${esc(e.id)}">已读</button>`}
    </div>`).join('');
}

async function saveAlertPolicy() {
  const body = {
    enabled: $('#alertEnabled').checked, webhookUrl: $('#alertWebhook').value.trim(),
    webhookType: $('#alertHookType').value,
    onFailure: $('#alertOnFailure').checked, onDisconnect: $('#alertOnDisconnect').checked,
    onDisk: $('#alertOnDisk').checked, onPlan: $('#alertOnPlan').checked
  };
  const r = await api('/api/alerts/policy', body);
  $('#alertPolicyMsg').textContent = r.ok ? '策略已保存' : '保存失败';
  await loadAlerts();
}

/* ------------------------- plans & storage ------------------------- */

const TEMPLATES = {
  morning: { name: '990早新闻', startTime: '06:00', durationMin: 60, rule: 'daily' },
  noon: { name: '午间新闻（工作日）', startTime: '12:00', durationMin: 60, rule: 'weekday' },
  evening: { name: '晚间时段', startTime: '18:00', durationMin: 120, rule: 'daily' }
};

function fillRuleSelect() {
  $('#pRule').innerHTML = planRules.map(r => `<option value="${esc(r.id)}">${esc(r.label)}</option>`).join('');
}

async function setLogView(v) {
  if (v === 'live') { logView = 'live'; historyText = ''; renderLogs(); return; }
  const r = await api('/api/logs/history?date=' + encodeURIComponent(v));
  logView = v; historyText = (r.text || '').trimEnd(); renderLogs();
}

function renderPlans() {
  const plans = st.plans || [];
  const hint = $('#nextPlanHint');
  hint.className = '';
  hint.textContent = st.nextPlanText ? `下次自动录制：${st.nextPlanText}` : '';
  const key = plans.map(p => `${p.id}|${p.name}|${p.enabled}|${p.ruleText}|${p.nextText}|${p.triggeredToday}|${p.streamUrl}|${p.filePrefix}|${p.effectivePrefix}|${p.prefixMode}|${p.prefixFixed}|${p.stationName}`).join('~');
  if (key === lastPlansKey) return;
  lastPlansKey = key;
  const el = $('#planList');
  if (!plans.length) { el.innerHTML = '<p class="muted small">还没有节目，可从 EPG 一键生成或从快捷模板开始。</p>'; return; }
  el.innerHTML = plans.map(p => {
    const pref = p.effectivePrefix || p.filePrefix || '';
    const modeTxt = p.prefixMode === 'manual' ? '自定义' : (p.prefixMode === 'fallback' ? '沿用全局' : '自动 · 按频率');
    const fixed = p.prefixFixed ? `（原存 ${esc(p.filePrefix || '空')}，已按电台自动修正）` : '';
    return `
    <div class="plan-row ${p.enabled ? '' : 'disabled'}">
      <div class="plan-main">
        <b>${esc(p.name)}</b><span class="tag ${p.enabled ? 'on' : 'off'}">${p.enabled ? '启用' : '停用'}</span>
        <span class="sub">${esc(p.ruleText)}｜下次 ${esc(p.nextText)}${p.triggeredToday ? ' · 今日已触发' : ''}
          ${p.stationName ? '<br>电台：' + esc(p.stationName) : ''}${p.streamUrl ? ' · 独立源：' + esc(p.streamUrl) : ''}
          ${pref ? '<br>落盘前缀 <b>' + esc(pref) + '</b> · ' + modeTxt + fixed : ''}</span>
      </div>
      <div class="plan-actions">
        <button class="icon-btn" data-act="toggle" data-id="${esc(p.id)}">${p.enabled ? '停用' : '启用'}</button>
        <button class="icon-btn" data-act="fire" data-id="${esc(p.id)}">立即试跑</button>
        <button class="icon-btn" data-act="edit" data-id="${esc(p.id)}">编辑</button>
        <button class="icon-btn" data-act="del" data-id="${esc(p.id)}">删除</button>
      </div>
    </div>`;
  }).join('');
}

function renderDisk() {
  const d = st.disk || {}, c = st.cleanup || {};
  if (d.valid && d.total > 0) {
    const pct = Math.min(100, d.used / d.total * 100);
    const bar = $('#diskUsedBar');
    bar.style.width = pct.toFixed(1) + '%';
    bar.classList.toggle('warn', pct > 90 || d.free < (Number(c.minFreeGB) || 0) * 1073741824);
    $('#diskUsedTxt').textContent = fmtSize(d.used);
    $('#diskFreeTxt').textContent = fmtSize(d.free);
  } else { $('#diskUsedTxt').textContent = '不可用'; $('#diskFreeTxt').textContent = '—'; }
  $('#diskRecTxt').textContent = fmtSize(st.totalBytes);
  $('#diskFilesTxt').textContent = String((st.files || []).length);
  if (!policyDirty) {
    $('#clRetention').value = c.retentionDays ?? 90;
    $('#clMax').value = c.maxTotalGB ?? 0;
    $('#clMin').value = c.minFreeGB ?? 5;
    $('#clEnabled').checked = !!c.enabled;
  }
}

function syncPlanConditional() {
  const r = $('#pRule').value;
  $('#pWeekdaysWrap').classList.toggle('hidden', r !== 'weekly');
  $('#pDateWrap').classList.toggle('hidden', r !== 'once');
}

/* --------- v3.1.10 节目单前缀：与服务端共用 /plan-prefix.js 的同一套规则 --------- */

function planStationList() { return st.stations || stationList || []; }

/**
 * 依据表单里的电台 / 流地址刷新前缀输入框与说明。
 * 默认「自动」模式：输入框只读，前缀始终跟随电台频率，编辑旧计划也不会残留上一次的值；
 * 勾选「自定义前缀」后才允许手填（这是唯一不跟随频率的情况）。
 */
function syncPlanPrefix() {
  const box = $('#pPrefixManual');
  if (!box || !window.PlanPrefix) return null;
  const manual = box.checked;
  const input = $('#pPrefix'), hint = $('#pPrefixHint');
  input.readOnly = !manual;
  input.placeholder = manual ? '输入你想要的前缀' : '自动按频率生成';
  const sid = $('#pStation').value;
  const s = sid ? planStationList().find(x => x.id === sid) : null;
  const draft = {
    stationId: sid,
    streamUrl: $('#pUrl').value.trim() || (s ? s.url : cfg.streamUrl || ''),
    filePrefix: manual ? input.value : '',
    prefixManual: manual
  };
  const info = PlanPrefix.explain(draft, planStationList(), cfg.filePrefix || 'FM990');
  if (!manual) input.value = info.filePrefix;
  const label = info.custom ? '自定义' : (info.expected ? '自动 · 按频率' : '沿用全局');
  let text = `落盘前缀 ${info.filePrefix || '(空)'}（${label}）`;
  if (info.expected) text += ` · ${info.stationName}${info.matchedBy === 'url' ? '（按流地址识别）' : ''}`;
  else text += ' · 未识别到电台，请在上方选择电台或勾选自定义前缀';
  if (manual && info.expected) text += ` · 该电台默认应为 ${info.expected}`;
  if (hint) { hint.textContent = text; hint.className = 'muted small' + (info.expected || manual ? '' : ' warn-inline'); }
  return info;
}

function planFormValues() {
  const existing = editingPlanId && (st.plans || []).find(p => p.id === editingPlanId);
  const sid = $('#pStation').value;
  const s = sid ? planStationList().find(x => x.id === sid) : null;
  const manual = !!($('#pPrefixManual') && $('#pPrefixManual').checked);
  const draft = {
    name: $('#pName').value.trim(), startTime: $('#pStart').value,
    durationMin: Number($('#pDuration').value), rule: $('#pRule').value,
    weekdays: $$('#pWeekdaysWrap input:checked').map(x => Number(x.value)),
    date: $('#pDate').value,
    stationId: sid,
    streamUrl: $('#pUrl').value.trim() || (s ? s.url : ''),
    filePrefix: $('#pPrefix').value.trim(),
    prefixManual: manual,
    enabled: existing ? !!existing.enabled : true
  };
  return PlanPrefix.normalizePlan(draft, planStationList(), cfg.filePrefix || 'FM990');
}
function resetPlanForm() {
  editingPlanId = null;
  $('#pName').value = ''; $('#pStart').value = '06:00'; $('#pDuration').value = '60';
  $('#pRule').value = 'daily'; $('#pDate').value = ''; $('#pUrl').value = '';
  $('#pPrefix').value = ''; $('#pStation').value = '';
  if ($('#pPrefixManual')) $('#pPrefixManual').checked = false;
  $$('#pWeekdaysWrap input').forEach(x => { x.checked = false; });
  $('#planEditorTitle').textContent = '＋ 添加节目';
  $('#btnPlanSave').textContent = '保存节目';
  $('#planFormMsg').textContent = '';
  $('#planEditor').open = false;
  syncPlanConditional();
  syncPlanPrefix();
}
function setPlanForm(p) {
  editingPlanId = p.id;
  $('#pName').value = p.name || ''; $('#pStart').value = p.startTime || '06:00';
  $('#pDuration').value = String(p.durationMin || 60); $('#pRule').value = p.rule || 'daily';
  $('#pDate').value = p.date || ''; $('#pUrl').value = p.streamUrl || '';
  $('#pPrefix').value = p.effectivePrefix || p.filePrefix || '';
  $('#pStation').value = p.stationId || '';
  if ($('#pPrefixManual')) $('#pPrefixManual').checked = p.prefixMode === 'manual';
  $$('#pWeekdaysWrap input').forEach(x => { x.checked = (p.weekdays || []).includes(Number(x.value)); });
  $('#planEditorTitle').textContent = '编辑：' + p.name;
  $('#btnPlanSave').textContent = '保存修改';
  $('#planFormMsg').textContent = '';
  $('#planEditor').open = true;
  syncPlanConditional();
  syncPlanPrefix();     // 自动模式会立刻把旧计划里残留的 FM990 校正为当前电台前缀
}
async function savePlan() {
  const v = planFormValues();
  const r = editingPlanId ? await api('/api/plans/update', { id: editingPlanId, plan: v }) : await api('/api/plans/add', { plan: v });
  if (!r.ok) { $('#planFormMsg').textContent = r.message || '保存失败'; return; }
  resetPlanForm(); await poll();
}
async function previewClean() {
  const r = await api('/api/cleanup/preview');
  cleanCandidates = r.candidates || [];
  const lines = [`目录内音频 ${r.fileCount} 个 · 共 ${fmtSize(r.totalBytes)}`,
    `磁盘剩余 ${r.disk && r.disk.valid ? fmtSize(r.disk.free) : '未知'} · 保护中 ${r.skippedActive} 个（正在写入或刚写完）`,
    `符合清理条件：${cleanCandidates.length} 个 · 可释放 ${fmtSize(r.freed)}`];
  if (cleanCandidates.length) {
    lines.push('', ...cleanCandidates.slice(0, 12).map(c => `  ${c.name}  ${fmtSize(c.size)}  ← ${c.reason}`));
    if (cleanCandidates.length > 12) lines.push(`  …另有 ${cleanCandidates.length - 12} 个`);
  }
  const box = $('#cleanBox');
  box.textContent = lines.join('\n');
  box.className = 'clean-box' + (cleanCandidates.length ? ' bad' : '');
  $('#btnCleanRun').disabled = !cleanCandidates.length;
}
async function runClean() {
  if (!cleanCandidates.length) return;
  const total = cleanCandidates.reduce((s, c) => s + c.size, 0);
  if (!await uiConfirm(`确认永久删除 ${cleanCandidates.length} 个录音文件（共 ${fmtSize(total)}）？此操作不可恢复。`)) return;
  const r = await api('/api/cleanup/run', { confirm: true, names: cleanCandidates.map(c => c.name) });
  $('#cleanBox').textContent = `已删除 ${(r.deleted || []).length} 个文件，释放 ${fmtSize(r.bytes)}` +
    (r.errors && r.errors.length ? `\n跳过 ${r.errors.length} 个：${r.errors.map(e => e.message).join('; ')}` : '');
  $('#cleanBox').className = 'clean-box';
  cleanCandidates = []; $('#btnCleanRun').disabled = true; lastFilesKey = null;
  await poll();
}
async function savePolicy() {
  const body = { enabled: $('#clEnabled').checked, retentionDays: Number($('#clRetention').value),
    maxTotalGB: Number($('#clMax').value), minFreeGB: Number($('#clMin').value) };
  const r = await api('/api/cleanup/policy', body);
  policyDirty = false; await poll();
  if (r.ok) {
    $('#cleanBox').textContent = '策略已保存。' + (body.enabled ? '自动清理已启用，每 10 分钟检查一次。' : '自动清理仍关闭，仅做预览与磁盘告警。');
    $('#cleanBox').className = 'clean-box';
  }
}

/* ---------------------- 自检 / 试录 / 服务管理 ---------------------- */

function renderServerInfo() {
  const s = st.server || {};
  const el = $('#serverInfo');
  if (!el || !s.pid) return;
  const html = `本机服务 <b>PID ${s.pid}</b> · ${esc(s.host)}:${s.port} · 已运行 ${hms(s.uptimeSec || 0)} · Node ${esc(s.node)}<br>` +
    `ffmpeg：${s.ffmpegPath ? `<span class="ok">已安装</span> · ${esc(s.ffmpegPath)}` : '<span class="bad">未找到（自动使用内置直录引擎）</span>'}`;
  if (el.innerHTML !== html) el.innerHTML = html;
}

function renderTest(r) {
  const badge = $('#testBadge');
  if (badge) {
    badge.textContent = `${r.passed} 通过 / ${r.warned} 提醒 / ${r.failed} 失败 · ${(r.durationMs / 1000).toFixed(1)}s`;
    badge.style.color = r.failed ? 'var(--danger)' : r.warned ? 'var(--warn)' : 'var(--teal)';
  }
  const sum = $('#testSummary');
  if (sum) sum.textContent = `自检完成：${r.summary}。${r.failed ? '请看下方失败项详情。' : '全部关键链路可用。'}`;
  const el = $('#testResult');
  if (!el) return;
  const labels = { pass: '通过', warn: '提醒', fail: '失败' };
  el.innerHTML = (r.items || []).map(i => `<div class="test-row ${esc(i.level)}">
      <span class="test-tag">${labels[i.level] || i.level}</span>
      <b>${esc(i.name)}</b>
      <span class="test-detail">${esc(i.detail).replace(/\n/g, '<br>')}</span>
    </div>`).join('');
}

async function runSelfTest() {
  const btn = $('#btnRunSelfTest');
  if (btn) { btn.disabled = true; btn.textContent = '检查中…'; }
  const sum = $('#testSummary');
  if (sum) sum.textContent = '正在跑 12 项检查（含单元测试子进程与 4 秒直播流探测），约 5–10 秒…';
  try {
    const r = await api('/api/selftest', {});
    testData = r; renderTest(r); await poll();
  } catch (e) {
    if (sum) sum.textContent = '自检失败：本地服务未响应（' + e.message + '）';
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '运行全部检查'; }
  }
}

async function runTestRecord() {
  const btn = $('#btnTestRecord');
  const engine = $('#testEngine') ? $('#testEngine').value : 'auto';
  if (btn) { btn.disabled = true; btn.textContent = '试录中…'; }
  const sum = $('#testSummary');
  if (sum) sum.textContent = `正在用「${engine}」真实录制 6 秒，请不要关闭页面…`;
  try {
    const r = await api('/api/selftest/record', { engine });
    if (!r.ok) {
      if (sum) sum.textContent = '试录失败：' + (r.message || '未知原因') + '。可换一个引擎再试，或先点「检测流格式」。';
      setFileMsg('试录失败：' + (r.message || '未知原因'), true);
    } else {
      if (sum) sum.textContent = `试录成功：${r.name} · ${fmtSize(r.size)} · 引擎 ${r.engine} · 首字节 ${r.head} · ` +
        (r.frameAligned ? `标准 MP3 帧（${r.bitrate} kbps / ${r.samplerate} Hz），约 ${r.durationSec} 秒` : '未识别到 MP3 帧') +
        '。可在上方文件列表回放，或点「清理测试文件」删除。';
      setFileMsg(`试录生成 ${r.name}（${fmtSize(r.size)}），仅用于验证，可随时删除`, false);
      await poll();
    }
  } catch (e) {
    if (sum) sum.textContent = '试录请求失败：' + e.message;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '试录 6 秒'; }
  }
}

function copyReport() {
  if (!testData) { uiAlert('请先运行「全部检查」'); return; }
  const lines = [`FM990 录制台自检 · ${new Date(testData.at).toLocaleString('zh-CN')}`, testData.summary, ''];
  (testData.items || []).forEach(i => lines.push(`[${i.level.toUpperCase()}] ${i.name} — ${i.detail.replace(/\n/g, ' / ')}`));
  copyText(lines.join('\n'), $('#btnCopyReport'));
}

async function shutdownService() {
  const clear = $('#clearSnapshot') ? $('#clearSnapshot').checked : false;
  const n = st.runningCount || 0;
  const msg = `确认停止本地录制服务（端口 8787）？\n\n` +
    `· 当前 ${n} 路录制会中止，已写入磁盘的音频完整保留。\n` +
    `· ${clear ? '续录快照会清除，下次启动不会自动开录。' : '续录快照会保留，下次启动自动接续录制。'}\n` +
    `· 停止后本页会断开；重新启动请双击 start.bat 或 desktop.bat。`;
  if (!await uiConfirm(msg)) return;
  try { await api('/api/shutdown', { clearSnapshot: clear }); }
  catch (e) { /* connection drops during shutdown - normal */ }
  serviceDown = true;
  const badge = $('#runBadge');
  if (badge) { badge.textContent = '服务已停止'; badge.className = 'badge bad'; }
  const sum = $('#testSummary');
  if (sum) sum.textContent = '服务已停止。重新启动：start.bat（浏览器标签）或 desktop.bat（独立窗口）；也可在命令行运行 stop-service.bat 停止。';
  if ($('#serverInfo')) $('#serverInfo').innerHTML = '<span class="bad">服务已退出，页面不再刷新</span>';
}

function bindV4() {
  $('#btnSelfTest').addEventListener('click', () => {
    const c = $('#testCard');
    if (c) c.scrollIntoView({ behavior: 'smooth', block: 'start' });
    runSelfTest();
  });
  $('#btnRunSelfTest').addEventListener('click', runSelfTest);
  $('#btnTestRecord').addEventListener('click', runTestRecord);
  $('#btnCleanTests').addEventListener('click', cleanTestFiles);
  $('#btnCopyReport').addEventListener('click', copyReport);
  $('#btnSelectAll').addEventListener('click', selectAllDeletable);
  $('#btnSelectNone').addEventListener('click', clearSelection);
  $('#btnDeleteSelected').addEventListener('click', deleteSelected);
  $('#btnDeleteAll').addEventListener('click', deleteAllFiles);
  $('#btnDeleteTests').addEventListener('click', cleanTestFiles);
  $('#btnShutdown').addEventListener('click', shutdownService);
  $('#btnShutdown2').addEventListener('click', shutdownService);
  const bcd = $('#btnClearDone');
  if (bcd) bcd.addEventListener('click', clearDoneJobs);
}

/* ------------------------------ render / poll ------------------------------ */

function renderAll() {
  renderStations();
  renderBadges(); renderStats(); renderCountdown(); renderLogs();
  renderFiles(); renderCommand(); syncMonitor();
  renderJobs(); renderPlans(); renderDisk(); renderLogDates();
  renderAlerts(); renderEpg(); renderServerInfo();
}
async function poll(force) {
  // 服务被主动停掉后降频探测（每 4 次 tick 试一次）；服务一旦回来立即恢复自动刷新。
  // 旧版这里直接 return，导致「停止服务 → 重启服务」后页面永久不再刷新、删除看不到效果。
  if (serviceDown && !force) { if (++downTick % 4 !== 0) return; }
  try {
    st = await api('/api/status');
    if (serviceDown) {
      serviceDown = false; downTick = 0;
      const b0 = $('#runBadge'); if (b0) { b0.className = 'badge'; }
      const sum = $('#testSummary'); if (sum) sum.textContent = '服务已恢复连接，页面恢复自动刷新。';
    }
    renderAll();
    /* 外部删除 / 目录变化：仅当正在回听的文件确实消失时才停，正常刷新不动播放器。 */
    syncPlaybackLifecycle();
  } catch (e) {
    const b = $('#runBadge');
    if (b && !serviceDown) { b.textContent = '服务断开'; b.className = 'badge bad'; }
  }
}

async function copyText(text, btn) {
  try { await navigator.clipboard.writeText(text); const old = btn.textContent; btn.textContent = '已复制'; setTimeout(() => { btn.textContent = old; }, 1200); }
  catch (e) { uiAlert('自动复制失败，请手动选中文本复制：\n' + text, true); }
}

/* ------------------------------ bindings ------------------------------ */

function bindPhase2() {
  $('#pRule').addEventListener('change', syncPlanConditional);
  $('#btnPlanSave').addEventListener('click', savePlan);
  $('#btnPlanCancel').addEventListener('click', resetPlanForm);
  /* v3.1.10：电台 / 流地址 / 自定义开关变化都立刻刷新前缀，避免残留上一台的值。 */
  ['#pStation', '#pUrl', '#pPrefixManual'].forEach(sel => {
    if ($(sel)) $(sel).addEventListener('change', syncPlanPrefix);
  });
  if ($('#pPrefix')) $('#pPrefix').addEventListener('input', syncPlanPrefix);
  $$('[data-tpl]').forEach(b => b.addEventListener('click', async () => {
    /* 快捷模板也要带上当前选中的电台，否则又会全部落到全局 FM990。 */
    const tpl = Object.assign({}, TEMPLATES[b.dataset.tpl]);
    const sid = $('#preset').value;
    const s = sid && sid !== 'custom' ? planStationList().find(x => x.id === sid) : null;
    if (s) Object.assign(tpl, {
      stationId: s.id, streamUrl: s.url,
      filePrefix: PlanPrefix.prefixOf(s), prefixMode: 'auto'
    });
    const r = await api('/api/plans/add', { plan: tpl });
    if (!r.ok) uiAlert(r.message || '添加失败');
    else {
      const msg = $('#planFormMsg');
      if (msg) msg.textContent = `已添加「${tpl.name}」· 前缀 ${s ? PlanPrefix.prefixOf(s) : (cfg.filePrefix || '全局前缀')}`;
    }
    await poll();
  }));
  $('#planList').addEventListener('click', async e => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const id = btn.dataset.id, act = btn.dataset.act;
    const p = (st.plans || []).find(x => x.id === id);
    if (!p) return;
    if (act === 'toggle') await api('/api/plans/toggle', { id, enabled: !p.enabled });
    else if (act === 'edit') { setPlanForm(p); return; }
    else if (act === 'del') {
      if (!await uiConfirm('删除节目「' + p.name + '」？')) return;
      await api('/api/plans/delete', { id });
      if (editingPlanId === id) resetPlanForm();
    } else if (act === 'fire') {
      if (!await uiConfirm(`立即按「${p.name}」开始一次 ${p.durationMin} 分钟的录制？`)) return;
      const r = await api('/api/plans/fire', { id });
      if (!r.ok && !r.skipped) uiAlert(r.message || '未能启动');
      else if (r.skipped) uiAlert(r.message || '该电台已有任务在运行');
    }
    await poll();
  });
  ['#clRetention', '#clMax', '#clMin', '#clEnabled'].forEach(sel => {
    $(sel).addEventListener('input', () => { policyDirty = true; });
    $(sel).addEventListener('change', () => { policyDirty = true; });
  });
  $('#clEnabled').addEventListener('change', savePolicy);
  $('#btnCleanPolicy').addEventListener('click', savePolicy);
  $('#btnCleanPreview').addEventListener('click', previewClean);
  $('#btnCleanRun').addEventListener('click', runClean);
  $('#logDate').addEventListener('change', e => setLogView(e.target.value));
  syncPlanConditional();
  syncPlanPrefix();
}

function bindV3() {
  /* station library */
  $('#stationList').addEventListener('click', async e => {
    const btn = e.target.closest('[data-station]');
    if (!btn) return;
    const id = btn.dataset.id, act = btn.dataset.station;
    const s = (st.stations || []).find(x => x.id === id);
    if (!s) return;
    if (act === 'use') return useStation(id);
    if (act === 'edit') { setStationForm(s); return; }
    if (act === 'test') {
      $('#stationMsg').textContent = '正在测活…';
      const r = await api('/api/stations/probe', { url: s.url, ms: 3000 });
      $('#stationMsg').textContent = r.ok ? `可用 · HTTP ${r.status} · ${r.bytes} 字节` : `不可用：${r.message || 'HTTP ' + r.status}`;
      return;
    }
    if (act === 'del') {
      if (!await uiConfirm('删除电台「' + s.name + '」？')) return;
      const r = await api('/api/stations/delete', { id });
      if (!r.ok) uiAlert(r.message);
      lastStationsKey = ''; await poll();
    }
  });
  $('#btnStationTest').addEventListener('click', async () => {
    const url = $('#sUrl').value.trim();
    if (!url) { $('#stationMsg').textContent = '请先填流地址'; return; }
    $('#stationMsg').textContent = '正在测活…';
    const r = await api('/api/stations/probe', { url, ms: 3000 });
    $('#stationMsg').textContent = r.ok ? `可用 · HTTP ${r.status} · ${r.bytes} 字节` : `不可用：${r.message || 'HTTP ' + r.status}`;
  });
  $('#btnStationSave').addEventListener('click', saveStation);
  $('#btnStationCancel').addEventListener('click', resetStationForm);

  /* parallel jobs：停止 / 删除已结束任务 */
  $('#jobList').addEventListener('click', async e => {
    const monBtn = e.target.closest('[data-jobmonitor]');
    if (monBtn) { toggleMonitor(monBtn.dataset.jobmonitor); return; }
    const stopBtn = e.target.closest('[data-jobstop]');
    if (stopBtn) {
      const r = await api('/api/stop', { id: stopBtn.dataset.jobstop });
      if (!r.ok) uiAlert(r.message);
      setJobMsg('正在停止任务，稍后会出现「删除」按钮…', false);
      lastJobsKey = '';
      await poll(true);
      // ffmpeg 收尾是异步的，再校准一次确保状态变成「已完成/已停止」并带出删除按钮
      setTimeout(() => { lastJobsKey = ''; poll(true); }, 1200);
      return;
    }
    const delBtn = e.target.closest('[data-jobdel]');
    if (delBtn) return deleteJob(delBtn.dataset.jobdel);
  });
  $('#btnStopAll').addEventListener('click', async () => {
    const live = (st.jobs || []).filter(isLiveJob);
    if (!live.length) { setJobMsg('当前没有进行中的任务', false); return; }
    if (!await uiConfirm(`停止全部 ${live.length} 路任务？\n已写入的音频文件会完整保留。`, '全部停止', '确认停止')) return;
    let r;
    try { r = await post('/api/stop-all'); }
    catch (e) { setJobMsg('停止失败：无法连接本地服务（' + e.message + '）', true); return; }
    if (!r.ok) { setJobMsg('停止失败：' + (r.message || '未知原因'), true); return; }
    // 先本地置为「停止中」，不用等下一秒轮询就能看到变化
    (st.jobs || []).forEach(j => { if (isLiveJob(j)) j.status = 'stopping'; });
    lastJobsKey = ''; renderJobs();
    setJobMsg(`已向 ${r.count || live.length} 路任务发出停止指令，ffmpeg 收尾中（最多约 3 秒）…`, false);
    await poll(true);
    // ffmpeg 收尾是异步的，分两次校准，确保状态落到终态并带出「删除」按钮
    setTimeout(() => { lastJobsKey = ''; poll(true); }, 1500);
    setTimeout(() => { lastJobsKey = ''; poll(true); }, 4000);
  });

  /* files: checkbox select + merge */
  $('#fileList').addEventListener('change', e => {
    const cb = e.target.closest('[data-pick]');
    if (!cb) return;
    const n = cb.getAttribute('data-pick');
    if (cb.checked) selectedFiles.add(n); else selectedFiles.delete(n);
    lastFilesKey = '';
    renderFiles();
  });
  $('#btnMerge').addEventListener('click', mergeSelected);
  $('#btnSelectMergeable').addEventListener('click', selectMergeable);

  /* EPG */
  $('#epgStation').addEventListener('change', loadEpg);
  $('#epgDate').addEventListener('change', loadEpg);
  $('#epgList').addEventListener('click', e => {
    const b = e.target.closest('[data-epg]');
    if (b) epgToPlan(Number(b.dataset.epg));
  });
  $('#btnEpgRefresh').addEventListener('click', () => refreshEpg(false));
  $('#btnEpgRefreshAll').addEventListener('click', () => refreshEpg(true));

  /* alerts */
  $('#btnAlerts').addEventListener('click', () => {
    $('#alertCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('#alertPolicyBox').open = true;
    loadAlerts();
  });
  $('#alertList').addEventListener('click', async e => {
    const b = e.target.closest('[data-alertread]');
    if (!b) return;
    await api('/api/alerts/read', { id: b.dataset.alertread });
    await loadAlerts(); await poll();
  });
  $('#btnAlertRead').addEventListener('click', async () => { await api('/api/alerts/read', { all: true }); await loadAlerts(); await poll(); });
  $('#btnAlertClear').addEventListener('click', async () => {
    if (!await uiConfirm('清空所有告警记录？')) return;
    await post('/api/alerts/clear'); await loadAlerts(); await poll();
  });
  $('#btnAlertPolicy').addEventListener('click', saveAlertPolicy);
  $('#btnAlertTest').addEventListener('click', async () => {
    const r = await api('/api/alerts/test', { url: $('#alertWebhook').value.trim() });
    $('#alertPolicyMsg').textContent = r.ok ? '测试消息已发送' : ('发送失败：' + (r.message || 'HTTP ' + r.status));
  });
  ['#alertWebhook', '#alertHookType', '#alertEnabled', '#alertOnFailure', '#alertOnDisconnect', '#alertOnDisk', '#alertOnPlan']
    .forEach(s => $(s).addEventListener('change', () => { policyDirty = true; }));
}

function bind() {
  $$('#modeTabs .tab').forEach(t => t.addEventListener('click', () => { setMode(t.dataset.mode); onChange(); }));

  $('#preset').addEventListener('change', () => {
    const id = $('#preset').value;
    const p = presets.find(x => x.id === id);
    if (p) {
      $('#streamUrl').value = p.url;
      $('#epgStation').value = id;
      cfg.stationId = id;
      loadEpg();
    }
    applyStationPrefix();      // 跟随频率自动改前缀；手动模式下不覆盖用户输入
    onChange();
    syncMonitor();             // 切台只改「新任务」的参数，不改变已在监听的任务；这里仅校准按钮态
  });

  ['#streamUrl', '#outputDir', '#filePrefix', '#segmentMinutes', '#codec', '#engine', '#durationMinutes',
    '#hourlyHours', '#hourlyAlign', '#rangeStart', '#rangeEnd', '#ffmpegPath', '#ffplayPath',
    '#autoRestart', '#repeatDaily', '#autoMonitor'].forEach(sel => {
      $(sel).addEventListener('input', onChange);
      $(sel).addEventListener('change', onChange);
    });
  $('#volume').addEventListener('input', () => {
    $('#volumeVal').textContent = $('#volume').value;
    const el = $('#monitorAudio'); if (el) el.volume = currentVolume();
    if (previewAudio) previewAudio.volume = currentVolume();
    onChange();
  });

  /* v3.1.8：播放器隐藏且没有原生控件，唯一的 pause 来自本模块自己（dropAudio），
     所以不能像 v3.1.7 那样在 pause 事件里复位状态——那会把「切换任务时的主动暂停」
     误判成用户停止。只在真实失败（error / ended）时熄灭按钮并给出原因。 */
  const ma = $('#monitorAudio');
  ma.addEventListener('error', () => {
    if (!activeMonitorJobId) return;
    setMonitorIdle('监听已自动停止：流连接失败（地址失效 / 超时 / 证书 / CORS）· 录制任务不受影响', 'bad');
  });
  ma.addEventListener('ended', () => {
    if (!activeMonitorJobId) return;
    setMonitorIdle('监听已停止：该音频流已结束', 'bad');
  });

  $('#btnStart').addEventListener('click', async () => {
    await api('/api/config', collect());
    const r = await api('/api/start', { mode });
    if (!r.ok) { uiAlert(r.message); return; }
    const fresh = r.job || (r.jobs || []).slice(-1)[0];
    await poll(true);
    /* 自动监听只覆盖「手动点开始录制」创建的任务。节目单 / 断点续录由服务端
       定时器触发，不会走这个 handler，因此仍然强制静音、不会半夜突然外放。 */
    if ($('#autoMonitor').checked && fresh && fresh.id) {
      const job = (st.jobs || []).find(j => j.id === fresh.id) || fresh;
      const e = monitorEligible(job);
      if (!e.ok) monitorHintText('新任务未自动监听：' + e.reason, 'bad');
      else startMonitor(fresh.id, true);
    }
  });
  $('#btnStop').addEventListener('click', async () => {
    // 明确带上主任务 id：服务端无 id 时取的是「最早创建」的任务，
    // 而界面主任务显示的是「最新」的一路，两者在多路并行时并不一致。
    const job = primaryJob();
    if (!job && !(st.runningCount > 0)) { setJobMsg('当前没有进行中的任务，无需停止', false); return; }
    let r;
    try { r = await post('/api/stop', job ? { id: job.id } : {}); }
    catch (e) { uiAlert('停止失败：无法连接本地服务（' + e.message + '）', true); return; }
    if (!r.ok) { uiAlert('停止失败：' + (r.message || '未知原因'), true); return; }
    setJobMsg(`已向「${(job && job.label) || '主任务'}」发出停止指令，ffmpeg 收尾中…`, false);
    lastJobsKey = '';
    await poll(true);
    setTimeout(() => { lastJobsKey = ''; poll(true); }, 1500);
    setTimeout(() => { lastJobsKey = ''; poll(true); }, 4000);
  });
  $('#btnPreview').addEventListener('click', () => startPreview(10, 'short'));
  $('#btnPreviewLong').addEventListener('click', () => {
    const sel = $('#previewMinutes');
    const m = Number(sel && sel.value) || 10;
    const minutes = [10, 30, 60].indexOf(m) >= 0 ? m : 10;
    startPreview(minutes * 60, 'long');
  });
  $('#btnPreviewStop').addEventListener('click', () => {
    if (!previewAudio) { previewStateText('当前没有正在进行的试听'); return; }
    stopPreview('已手动停止试听 · 录音任务不受影响', 'ok');
  });
  $('#btnDetect').addEventListener('click', async () => { await post('/api/detect'); await poll(); });
  $('#btnProbe').addEventListener('click', runProbe);
  $('#btnCopyCmd').addEventListener('click', e => copyText($('#commandPreview').textContent, e.currentTarget));
  $('#btnCopyInstall').addEventListener('click', e => copyText($('#installCmd').textContent, e.currentTarget));
  /* 打开录音文件所在目录：勾了文件就定位并选中它；无论系统窗口是否弹出都给可见反馈。 */
  $('#btnOpenFolder').addEventListener('click', async () => {
    const picked = Array.from(selectedFiles)[0] || '';
    let r;
    try { r = await post('/api/open-folder', { name: picked }); }
    catch (e) { setFileMsg('打开目录失败：无法连接本地服务（' + e.message + '）', true); return; }
    if (!r.ok) {
      setFileMsg('无法自动打开：' + (r.message || '未知原因') + ' · 目录 ' + (r.path || st.outputDir || ''), true);
      uiAlert('资源管理器未能自动弹出。可点「复制路径」后手动打开，或用「输出与音质 → 浏览…」在界面内查看。', true);
      return;
    }
    setFileMsg(r.mode === 'select'
      ? `已在资源管理器中定位并选中：${r.path}`
      : `已在资源管理器中打开录音目录：${r.dir}（勾选某个文件再点可直接定位到该文件）`, false);
  });
  $('#btnCopyDir').addEventListener('click', e => {
    const dir = st.outputDir || $('#outputDir').value.trim();
    if (!dir) { setFileMsg('当前没有设置录音目录', true); return; }
    copyText(dir, e.currentTarget);
    setFileMsg(`已复制录音目录：${dir}`, false);
  });
  $('#btnRefreshFiles').addEventListener('click', () => { lastFilesKey = null; poll(true); });
  /* 「清空显示」是纯前端行为：只清本页显示框，服务端与磁盘日志一律不动。 */
  $('#btnClearLog').addEventListener('click', clearLogDisplay);
  $('#btnShowAllLog').addEventListener('click', showAllLogDisplay);

  $('#fileList').addEventListener('click', async e => {
    const play = e.target.closest('[data-play]');
    if (play) { await startPlayback(play.getAttribute('data-play')); return; }
    const btn = e.target.closest('[data-del]');
    if (!btn) return;
    await deleteOne(btn.getAttribute('data-del'), btn.dataset.locked === '1');
  });
  $('#btnPlaybackStop').addEventListener('click', () => stopPlayback('已停止回听 · 录音任务不受影响'));
  bindDirBrowser();
}

(async function init() {
  try {
    const [p, c, s, pl, al] = await Promise.all([
      api('/api/presets'), api('/api/config'), api('/api/status'), api('/api/plans'), api('/api/alerts')
    ]);
    presets = p.presets || [];
    planRules = pl.rules || [];
    alertsData = al;
    cfg = c.config || {};
    st = s;
    stationList = s.stations || presets.map(x => ({ id: x.id, name: x.name, freq: '', url: x.url, prefix: '', channelId: 0, builtin: true }));
    fillPresets();
    fillRuleSelect();
    fillForm(cfg);
    bind(); bindPhase2(); bindV3(); bindV4();
    renderAll();
    refreshPreview(); runProbe(); loadEpg(); renderAlerts();
    setInterval(poll, 1000);
  } catch (e) {
    $('#commandPreview').textContent = '无法连接本地服务，请确认 start.bat / desktop.bat 已运行';
  }
})();
