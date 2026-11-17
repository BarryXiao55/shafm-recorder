/* Regression test: execute app.js inside a mock DOM and drive the real delete
 * handlers, proving the browser-side chain works without native dialogs.
 * Run from any cwd: node test/ui-delete-chain.js
 * Guards against the v3.1.2 bug where sandboxed preview panels silently
 * block window.confirm and every delete button appears dead. */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const els = new Map();
let createSeq = 0;
const calls = [];
const dialogCalls = [];

function makeEl(key) {
  if (els.has(key)) return els.get(key);
  const el = {
    _key: key, _handlers: {}, style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    children: [], hidden: false, disabled: false, value: '', checked: false,
    textContent: '', innerHTML: '', className: '', title: '', id: '',
    addEventListener(t, fn) { (this._handlers[t] = this._handlers[t] || []).push(fn); },
    removeEventListener() {},
    appendChild(c) { this.children.push(c); return c; },
    setAttribute(k, v) { if (k !== 'style') this[k] = v; }, getAttribute(k) { return this[k] || null; },
    querySelector(sel) { return makeEl(key + '|' + sel); },
    querySelectorAll() { return []; },
    closest() { return null; },
    focus() {}, remove() {}, contains() { return false; },
    play() { return Promise.resolve(); },
    click(evt) {
      (this._handlers.click || []).forEach(fn => fn(evt || {
        target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}
      }));
    }
  };
  if (key.startsWith('create:')) {
    let v = '';
    Object.defineProperty(el, 'id', {
      get: () => v,
      set: x => { v = x; els.set('id:' + x, el); },
      configurable: true
    });
  }
  els.set(key, el);
  return el;
}

const document = {
  querySelector: s => makeEl('q:' + s),
  querySelectorAll: () => [],
  getElementById: id => els.get('id:' + id) || null,
  createElement: tag => makeEl('create:' + tag + ':' + (++createSeq)),
  addEventListener() {},
  body: makeEl('body')
};
const windowMock = {
  confirm: (...a) => { dialogCalls.push(['confirm', ...a]); return false; },
  alert: (...a) => { dialogCalls.push(['alert', ...a]); },
  prompt: (...a) => { dialogCalls.push(['prompt', ...a]); return null; }
};

const statusObj = {
  version: 3, server: { pid: 1 }, ffmpeg: { found: true, version: 'test' },
  ffplay: { found: true }, engine: 'ffmpeg', jobs: [], job: null,
  running: false, runningCount: 0, maxParallel: 8, files: [], logs: [],
  outputDir: 'C:/radio/recordings',
  stations: [], presets: [], plans: [], epg: {}, alerts: {}, disk: {},
  stats: {}, cleanup: {}, config: {}, elapsedSec: 0, remainingSec: 0
};

/* 模拟真实服务端：这些接口只接受 POST，GET 一律回 404 未知接口。
 * 用来守住 v3.1.4 的「停止 / 清空显示」回归。 */
const SERVER_POST_ONLY = new Set([
  '/api/stop', '/api/stop-all', '/api/logs/clear', '/api/detect', '/api/open-folder',
  '/api/alerts/clear', '/api/files/delete', '/api/files/merge', '/api/jobs/delete', '/api/probe', '/api/dry-run',
  '/api/browse/mkdir'
]);

async function fetch(path, opt) {
  calls.push({ path, opt });
  const p = path.split('?')[0];
  const method = (opt && opt.method) || 'GET';
  if (SERVER_POST_ONLY.has(p) && method !== 'POST') {
    return { json: async () => ({ ok: false, message: '未知接口' }) };
  }
  let out = { ok: true };
  if (path === '/api/status') out = statusObj;
  else if (p === '/api/browse') out = {
    ok: true, path: 'C:/radio/recordings', parent: 'C:/radio', root: 'C:/', writable: true,
    entries: [{ name: '子目录A', path: 'C:/radio/recordings/子目录A' }],
    shortcuts: [{ name: '程序目录', path: 'C:/app' }, { name: '桌面', path: 'C:/Users/me/Desktop' }]
  };
  else if (path === '/api/browse/mkdir') out = { ok: true, path: 'C:/radio/recordings/新目录' };
  else if (path === '/api/open-folder') out = { ok: true, dir: 'C:/radio/recordings', path: 'C:/radio/recordings/a.mp3', mode: 'select' };
  else if (path === '/api/stop') out = { ok: true };
  else if (path === '/api/stop-all') out = { ok: true, count: 2 };
  else if (path === '/api/files/delete') {
    const body = JSON.parse(opt && opt.body || '{}');
    out = { ok: true, deleted: body.names || [body.name], errors: [], bytes: 1024 };
  } else if (path === '/api/files/merge') {
    const body = JSON.parse(opt && opt.body || '{}');
    out = (body.names || []).length >= 2
      ? { ok: true, name: 'MERGE_TEST.mp3', size: 3072 }
      : { ok: false, message: '请至少选择 2 个分段' };
  } else if (path === '/api/jobs/delete') {
    const body = JSON.parse(opt && opt.body || '{}');
    out = body.all ? { ok: true, removed: ['a', 'b'], count: 2 } : { ok: true, removed: [body.id], count: 1 };
  } else if (path === '/api/presets') out = { presets: [] };
  else if (path === '/api/config') out = { config: {} };
  else if (path === '/api/plans') out = { rules: [] };
  else if (path === '/api/alerts') out = { items: [], unread: 0 };
  else if (path === '/api/probe') out = { ok: true, format: 'mp3' };
  else if (path === '/api/epg') out = { ok: true, days: [] };
  return { json: async () => out };
}

const ctx = vm.createContext({
  document, window: windowMock, fetch, console,
  setTimeout: fn => { try { fn(); } catch (e) { /* ignore */ } return 0; },
  clearTimeout() {}, setInterval() { return 0; }, clearInterval() {},
  navigator: { clipboard: { writeText: async () => {} } },
  location: { href: 'http://127.0.0.1:8787/' },
  encodeURIComponent, decodeURIComponent, URL, TextEncoder, TextDecoder
});

const code = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
vm.runInContext(code, ctx, { filename: 'app.js' });

const tick = () => new Promise(r => setImmediate(r));
const run = expr => vm.runInContext(expr, ctx);
const okBtn = () => makeEl('id:uiModal').querySelector('[data-role="ok"]');
const cancelBtn = () => makeEl('id:uiModal').querySelector('[data-role="cancel"]');
const postDeletes = () => calls.filter(c => c.path === '/api/files/delete');

(async () => {
  await tick(); await tick();
  const FILE = '_UIBTN_TEST.mp3';
  run(`st = ${JSON.stringify(statusObj)}; st.files = [{name:'${FILE}',size:1024,deletable:true,writing:false,healthy:true,mtime:Date.now()}]; selectedFiles = new Set(['${FILE}']);`);

  console.log('--- 1. deleteSelected() + click in-page OK ---');
  const p1 = run('deleteSelected()');
  await tick();
  okBtn().click();
  await p1;
  const d1 = postDeletes();
  console.log('   delete API calls:', d1.length, '| body:', d1.length ? d1[d1.length - 1].opt.body : '-');
  console.log('   fileMsg:', makeEl('q:#fileMsg').textContent);

  console.log('--- 2. deleteSelected() + click Cancel ---');
  run(`st.files = [{name:'${FILE}',size:1024,deletable:true,writing:false,healthy:true,mtime:Date.now()}]; selectedFiles = new Set(['${FILE}']);`);
  const p2 = run('deleteSelected()');
  await tick();
  cancelBtn().click();
  await p2;
  console.log('   delete API calls total:', postDeletes().length, '| fileMsg:', makeEl('q:#fileMsg').textContent);

  console.log('--- 3. deleteOne() single row + OK ---');
  const p3 = run(`deleteOne('${FILE}', false)`);
  await tick();
  okBtn().click();
  await p3;
  console.log('   delete API calls total:', postDeletes().length, '| fileMsg:', makeEl('q:#fileMsg').textContent);

  console.log('--- 4. native dialog calls ---');
  console.log('   ', dialogCalls.length ? JSON.stringify(dialogCalls) : 'none');

  console.log('--- 5. deleteJob() on a finished job ---');
  run(`st.jobs = [{id:'job_done',label:'已停止任务',status:'completed',elapsedSec:60,durationSec:60,startAt:Date.now(),config:{streamUrl:'x'}}]; lastJobsKey='';`);
  await run(`deleteJob('job_done')`);
  const jobDeletes = () => calls.filter(c => c.path === '/api/jobs/delete');
  const msg5 = makeEl('q:#jobMsg').textContent;
  console.log('   jobs/delete calls:', jobDeletes().length, '| body:', jobDeletes()[0] && jobDeletes()[0].opt.body);
  console.log('   jobMsg:', msg5);

  console.log('--- 5b. deleteJob() refuses a live job ---');
  run(`st.jobs = [{id:'live1',label:'录制中',status:'running',elapsedSec:5,durationSec:0,config:{}}];`);
  await run(`deleteJob('live1')`);
  const refused = jobDeletes().length === 1;
  console.log('   no extra request:', refused, '| jobMsg:', makeEl('q:#jobMsg').textContent);

  console.log('--- 6. clearDoneJobs() + in-page OK ---');
  run(`st.jobs = [{id:'a',status:'completed',label:'A',config:{}},{id:'b',status:'cancelled',label:'B',config:{}},{id:'c',status:'running',label:'C',config:{}}]; lastJobsKey='';`);
  const p6 = run('clearDoneJobs()');
  await tick();
  okBtn().click();
  await p6;
  const clearCalls = jobDeletes().filter(c => /"all":true/.test(c.opt.body));
  const msg6 = makeEl('q:#jobMsg').textContent;
  console.log('   clear-all calls:', clearCalls.length, '| jobMsg:', msg6);
  /* 后面的用例会清空 calls，先在这里快照前 6 组的计数 */
  const nFileDeletes = postDeletes().length, nJobDeletes = jobDeletes().length, nClearAll = clearCalls.length;
  const fileMsgSnapshot = makeEl('q:#fileMsg').textContent;   // 后面的用例会覆盖 fileMsg，先快照

  /* ---------------- v3.1.4：停止 / 清空显示 回归 ---------------- */
  const toastReset = () => run(`(function(){var t=document.getElementById('uiToast');if(t){var m=t.querySelector('[data-role="msg"]');if(m)m.textContent='';t.textContent='';}})()`);
  const toastText = () => {
    const t = els.get('id:uiToast');
    if (!t) return '';
    return (t.querySelector('[data-role="msg"]') || {}).textContent || t.textContent || '';
  };

  console.log('--- 7. 停止主任务：必须 POST，且不再弹「未知接口」 ---');
  toastReset();
  run(`st.jobs=[{id:'job_main',label:'主任务',status:'running',elapsedSec:10,durationSec:0,config:{}}]; st.runningCount=1; lastJobsKey='';`);
  calls.length = 0;
  await makeEl('q:#btnStop')._handlers.click[0]();
  await tick();
  const stopCalls = calls.filter(c => c.path === '/api/stop');
  const stopPost = stopCalls.length === 1 && stopCalls[0].opt.method === 'POST';
  const stopMsg = makeEl('q:#jobMsg').textContent;
  console.log('   /api/stop:', stopCalls.length, '| method:', stopCalls[0] && stopCalls[0].opt.method,
    '| body:', stopCalls[0] && stopCalls[0].opt.body);
  console.log('   jobMsg:', stopMsg, '| toast:', JSON.stringify(toastText()));

  console.log('--- 8. 全部停止：必须 POST /api/stop-all ---');
  toastReset();
  run(`st.jobs=[{id:'a',label:'A',status:'running',elapsedSec:5,durationSec:0,config:{}},{id:'b',label:'B',status:'scheduled',elapsedSec:0,durationSec:0,config:{}}]; st.runningCount=2; lastJobsKey='';`);
  calls.length = 0;
  const p8 = makeEl('q:#btnStopAll')._handlers.click[0]();
  await tick();
  okBtn().click();
  await p8;
  await tick(); await tick();
  const allCalls = calls.filter(c => c.path === '/api/stop-all');
  const allPost = allCalls.length === 1 && allCalls[0].opt.method === 'POST';
  const allMsg = makeEl('q:#jobMsg').textContent;
  console.log('   /api/stop-all:', allCalls.length, '| method:', allCalls[0] && allCalls[0].opt.method);
  console.log('   jobMsg:', allMsg, '| toast:', JSON.stringify(toastText()));

  console.log('--- 9. 清空显示：纯前端，磁盘日志不动，只显示新增 ---');
  run(`st.logs=['[08:00:00] 旧日志A','[08:00:01] 旧日志B']; st.logSeq=2; logCleared=false; logView='live'; logBaseSeq=0; logBaseTail='';`);
  makeEl('q:#logBox').textContent = '[08:00:00] 旧日志A\n[08:00:01] 旧日志B';
  calls.length = 0;
  makeEl('q:#btnClearLog')._handlers.click[0]();
  const clearBox = makeEl('q:#logBox').textContent;
  const noClearApi = calls.filter(c => c.path === '/api/logs/clear').length === 0;
  run(`st.logs = st.logs.concat('[08:01:00] 新日志C'); st.logSeq = 3; renderLogs();`);
  const afterNew = makeEl('q:#logBox').textContent;
  makeEl('q:#btnShowAllLog')._handlers.click[0]();
  const afterAll = makeEl('q:#logBox').textContent;
  console.log('   清空后:', JSON.stringify(clearBox));
  console.log('   新增一条后:', JSON.stringify(afterNew));
  console.log('   恢复全部后:', JSON.stringify(afterAll));
  console.log('   未调用 /api/logs/clear:', noClearApi);

  const clearOk = noClearApi && /显示已清空/.test(clearBox)
    && /新日志C/.test(afterNew) && !/旧日志A/.test(afterNew)
    && /旧日志A/.test(afterAll);

  console.log('--- 10. 清空显示后服务重启（logSeq 归零）不会卡成空白 ---');
  run(`st.logs=['[09:00:00] 重启后日志D']; st.logSeq=6; logCleared=false; logView='live'; clearLogDisplay();`);
  run(`st.logs=['[09:00:00] 重启后日志D','[09:00:02] 新日志E']; st.logSeq=1; renderLogs();`);
  const afterRestart = makeEl('q:#logBox').textContent;
  const restartOk = /新日志E/.test(afterRestart);
  console.log('   重启后显示:', JSON.stringify(afterRestart));

  console.log('--- 11. 文件名前缀跟随电台频率 ---');
  const derived = JSON.parse(run(`JSON.stringify(['FM 99.0','FM 105.7','FM 94.7','FM 101.7'].map(prefixFromFreq))`));
  const deriveOk = JSON.stringify(derived) === JSON.stringify(['FM990', 'FM1057', 'FM947', 'FM1017']);
  console.log('   频率推导:', JSON.stringify(derived), '| 匹配用户样例:', deriveOk);
  run(`
    presets = [
      {id:'sh_news', name:'上海新闻广播', freq:'FM 93.4 / AM 990', prefix:'FM990', url:'u1'},
      {id:'sh_traffic', name:'上海交通广播', freq:'FM 105.7 / AM 648', prefix:'FM1057', url:'u2'},
      {id:'sh_classic', name:'经典947', freq:'FM 94.7', prefix:'FM947', url:'u3'},
      {id:'sh_cgtn879', name:'CGTN Radio', freq:'FM 87.9（上海落地）', prefix:'FM879', url:'u4'}
    ];
    st.stations = presets; fillPresets(); prefixFollow = true;
  `);
  const presetEl = makeEl('q:#preset'), prefixEl = makeEl('q:#filePrefix');
  const firePreset = () => (presetEl._handlers.change || []).forEach(fn => fn({ target: presetEl }));
  presetEl.value = 'sh_classic'; firePreset();
  const pClassic = prefixEl.value;
  presetEl.value = 'sh_traffic'; firePreset();
  const pTraffic = prefixEl.value;
  presetEl.value = 'sh_cgtn879'; firePreset();
  const p879 = prefixEl.value;
  console.log('   经典947→', pClassic, '| 交通→', pTraffic, '| FM87.9→', p879);
  // 手动改前缀应自动关闭跟随，切台不再覆盖；重新勾选则恢复
  prefixEl.value = 'MY_OWN';
  (prefixEl._handlers.input || []).forEach(fn => fn({ target: prefixEl }));
  presetEl.value = 'sh_news'; firePreset();
  const manualKept = prefixEl.value === 'MY_OWN' && run('prefixFollow') === false;
  const followBox = makeEl('q:#prefixFollow');
  followBox.checked = true;
  (followBox._handlers.change || []).forEach(fn => fn({ target: followBox }));
  const followResumed = prefixEl.value === 'FM990' && run('prefixFollow') === true;
  console.log('   手改后切台保持:', manualKept, '| 重新勾选恢复:', followResumed, '→', prefixEl.value);
  const prefixOk = deriveOk && pClassic === 'FM947' && pTraffic === 'FM1057'
    && p879 === 'FM879' && manualKept && followResumed;

  console.log('--- 12. 保存目录可视化选择 + 打开目录反馈 ---');
  calls.length = 0;
  run(`$('#outputDir').value = 'C:/radio/recordings';`);
  makeEl('q:#btnBrowseDir')._handlers.click[0]();
  await tick(); await tick();
  const browseCalls = calls.filter(c => c.path.startsWith('/api/browse?') && !c.opt.method);
  console.log('   /api/browse GET 调用:', browseCalls.length);
  await makeEl('q:#btnDirSelect')._handlers.click[0]();
  const dirPicked = makeEl('q:#outputDir').value === 'C:/radio/recordings';
  calls.length = 0;
  run(`selectedFiles = new Set(['FM990_a.mp3']);`);
  await makeEl('q:#btnOpenFolder')._handlers.click[0]();
  const openCalls = calls.filter(c => c.path === '/api/open-folder');
  const openPost = openCalls.length === 1 && openCalls[0].opt.method === 'POST'
    && /FM990_a\.mp3/.test(openCalls[0].opt.body);
  const openMsg = makeEl('q:#fileMsg').textContent;
  console.log('   /api/open-folder POST:', openPost, '| 选中目录:', dirPicked);
  console.log('   fileMsg:', openMsg);
  const dirOk = browseCalls.length >= 1 && dirPicked && openPost && /已在资源管理器/.test(openMsg);

  console.log('--- 13. 无损合并入口：常亮可点 + 全选可合并 + POST 正确 ---');
  /* 先故意把按钮设成 disabled：v3.1.5 的 renderFiles() 会在未选够时这样灰掉它，
     导致深色主题下几乎看不见。新逻辑必须把它恢复成可点。 */
  makeEl('q:#btnMerge').disabled = true;
  const files13 = `[
    {name:'FM990_a.mp3',size:1024,deletable:true,writing:false,healthy:true,mtime:1000},
    {name:'FM990_b.mp3',size:2048,deletable:true,writing:false,healthy:true,mtime:2000},
    {name:'FM879_x.ts',size:512,deletable:true,writing:false,healthy:null,mtime:3000}
  ]`;
  run(`st.files = ${files13}; selectedFiles = new Set(); lastFilesKey = ''; renderFiles();`);
  const mergeVisible = makeEl('q:#btnMerge').disabled === false;
  const hint13 = makeEl('q:#fileSelHint').textContent;
  console.log('   按钮 disabled:', makeEl('q:#btnMerge').disabled, '| 选择提示:', hint13);

  calls.length = 0;
  await makeEl('q:#btnMerge')._handlers.click[0]();
  const noReqEmpty = calls.filter(c => c.path === '/api/files/merge').length === 0;
  const emptyMsg = makeEl('q:#fileMsg').textContent;
  console.log('   未选够：不发请求', noReqEmpty, '| 提示:', emptyMsg);

  makeEl('q:#btnSelectMergeable')._handlers.click[0]();
  const picked = JSON.parse(run('JSON.stringify(Array.from(selectedFiles))'));
  console.log('   全选可合并:', JSON.stringify(picked));

  calls.length = 0;
  const p13 = makeEl('q:#btnMerge')._handlers.click[0]();
  await tick();
  okBtn().click();
  await p13;
  await tick();
  const mCalls = calls.filter(c => c.path === '/api/files/merge');
  const mBody = mCalls[0] && JSON.parse(mCalls[0].opt.body);
  const mergePost = mCalls.length === 1 && mCalls[0].opt.method === 'POST'
    && JSON.stringify(mBody.names) === JSON.stringify(['FM990_a.mp3', 'FM990_b.mp3']);
  const mergeMsg = makeEl('q:#fileMsg').textContent;
  console.log('   /api/files/merge:', mCalls.length, '| method:', mCalls[0] && mCalls[0].opt.method,
    '| body:', mCalls[0] && mCalls[0].opt.body);
  console.log('   结果反馈:', mergeMsg);

  /* poll(true) 会把 st 换成 mock 的 statusObj（files 为空），所以这里重设文件列表。 */
  calls.length = 0;
  run(`st.files = ${files13}; selectedFiles = new Set(['FM990_a.mp3','FM879_x.ts']); lastFilesKey = ''; renderFiles();`);
  await makeEl('q:#btnMerge')._handlers.click[0]();
  const tsRejected = calls.filter(c => c.path === '/api/files/merge').length === 0
    && /不能合并/.test(makeEl('q:#fileMsg').textContent);
  console.log('   混入 .ts 被前端拦下:', tsRejected, '| 提示:', makeEl('q:#fileMsg').textContent);

  const mergeOk = mergeVisible && /可合并 2 个/.test(hint13)
    && noReqEmpty && /至少 2 个/.test(emptyMsg)
    && picked.length === 2 && picked.every(n => /\.mp3$/.test(n))
    && mergePost && /合并完成/.test(mergeMsg) && tsRejected;

  const pass = d1.length === 1 && nFileDeletes === 2 && dialogCalls.length === 0
    && /成功删除 1 个/.test(fileMsgSnapshot)
    && nJobDeletes === 2 && /已移除/.test(msg5) && refused
    && nClearAll === 1 && /已清理/.test(msg6)
    && stopPost && !/未知接口|停止失败/.test(stopMsg) && !/未知接口/.test(toastText())
    && allPost && !/停止失败/.test(allMsg)
    && clearOk && restartOk && prefixOk && dirOk && mergeOk;
  console.log(pass ? 'UI_DELETE_CHAIN=PASS' : 'UI_DELETE_CHAIN=FAIL');
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error('TEST ERROR', e); process.exit(1); });
