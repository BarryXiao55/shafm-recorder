/* Regression test for the v3.1.8 per-job exclusive monitor chain.
 *
 * Model under test:
 *   - one <audio> for the whole page, living OUTSIDE #jobList (innerHTML rebuild kills it);
 *   - activeMonitorJobId is the single source of truth => exclusivity is structural;
 *   - every job row has a tri-state button (on / off / disabled when the source is unplayable);
 *   - autoMonitor only applies to jobs created by the manual "开始录制" handler.
 *
 * Run from any cwd: node test/monitor-chain.js
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const els = new Map();
let createSeq = 0;
let jobRows = [];
let startResult = { ok: true, job: null, jobs: [] };

function makeClassList() {
  return {
    _s: new Set(),
    add(x) { this._s.add(x); },
    remove(x) { this._s.delete(x); },
    toggle(x, f) { f ? this._s.add(x) : this._s.delete(x); },
    contains(x) { return this._s.has(x); }
  };
}

function makeEl(key) {
  if (els.has(key)) return els.get(key);
  const el = {
    _key: key, _handlers: {}, _attrs: {}, style: {}, dataset: {},
    classList: makeClassList(),
    children: [], hidden: false, disabled: false, value: '', checked: false,
    textContent: '', innerHTML: '', className: '', title: '', id: '',
    paused: true, volume: 1, src: '', playReject: false,
    playCount: 0, pauseCount: 0, loadCount: 0,
    addEventListener(t, fn) { (this._handlers[t] = this._handlers[t] || []).push(fn); },
    fire(t, evt) {
      (this._handlers[t] || []).forEach(fn => fn(evt || {
        target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}
      }));
    },
    removeEventListener() {},
    appendChild(c) { this.children.push(c); return c; },
    setAttribute(k, v) { this._attrs[k] = v; this[k] = v; },
    getAttribute(k) { return this._attrs[k] !== undefined ? this._attrs[k] : (this[k] || null); },
    removeAttribute(k) { delete this._attrs[k]; this[k] = ''; },
    querySelector(s) { return makeEl(key + '|' + s); },
    querySelectorAll() { return []; },
    closest() { return null; },
    focus() {}, remove() {}, contains() { return false; },
    play() {
      this.playCount++;
      if (this.playReject) return Promise.reject(new Error('NotAllowedError: autoplay blocked'));
      this.paused = false;
      return Promise.resolve();
    },
    pause() { this.pauseCount++; this.paused = true; },
    load() { this.loadCount++; },
    click(evt) { this.fire('click', evt); }
  };
  els.set(key, el);
  return el;
}

function makeRow(id, disabled) {
  const btn = {
    dataset: { jobmonitor: id }, disabled: !!disabled, textContent: '', title: '',
    classList: makeClassList(),
    closest(sel) { return sel === '[data-jobmonitor]' ? this : null; }
  };
  return { btn, querySelector(sel) { return sel === '[data-jobmonitor]' ? btn : null; } };
}
const setRows = defs => { jobRows = defs.map(d => makeRow(d.id, d.disabled)); };

const document = {
  querySelector: s => makeEl('q:' + s),
  querySelectorAll: sel => (sel === '#jobList .job-row' ? jobRows : []),
  getElementById: id => els.get('id:' + id) || null,
  createElement: tag => makeEl('create:' + tag + ':' + (++createSeq)),
  addEventListener() {},
  body: makeEl('body')
};

const statusObj = {
  version: 3, server: { pid: 1 }, ffmpeg: { found: true, version: 'test' },
  ffplay: { found: true }, engine: 'ffmpeg', jobs: [], job: null,
  running: false, runningCount: 0, maxParallel: 8, files: [], logs: [],
  outputDir: 'C:/radio/recordings', stations: [], presets: [], plans: [],
  epg: {}, alerts: {}, disk: {}, stats: {}, cleanup: {}, config: {},
  elapsedSec: 0, remainingSec: 0
};

async function fetchMock(p) {
  if (p === '/api/config') return { json: async () => ({ config: {} }) };
  if (p === '/api/presets') return { json: async () => ({ presets: [] }) };
  if (p === '/api/plans') return { json: async () => ({ rules: [] }) };
  if (p === '/api/alerts') return { json: async () => ({ items: [], unread: 0 }) };
  if (p === '/api/epg') return { json: async () => ({ ok: true, days: [] }) };
  if (p === '/api/status') return { json: async () => statusObj };
  if (p === '/api/start') return { json: async () => startResult };
  return { json: async () => ({ ok: true }) };
}

const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const ctx = vm.createContext({
  document,
  window: { confirm: () => false, alert: () => {}, prompt: () => null },
  fetch: fetchMock, console,
  setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
  navigator: { clipboard: { writeText: async () => {} } },
  location: { href: 'http://127.0.0.1:8787/' },
  Audio: function () { return makeEl('audio:' + (++createSeq)); },
  encodeURIComponent, decodeURIComponent, URL, TextEncoder, TextDecoder
});
vm.runInContext(appSrc, ctx, { filename: 'app.js' });

const run = e => vm.runInContext(e, ctx);
const tick = () => new Promise(r => setImmediate(r));
const ticks = async (n = 3) => { for (let i = 0; i < n; i++) await tick(); };

const audio = makeEl('q:#monitorAudio');
const hint = makeEl('q:#monitorHint');
const jobList = makeEl('q:#jobList');
const volEl = makeEl('q:#volume');
const autoMon = makeEl('q:#autoMonitor');
const urlEl = makeEl('q:#streamUrl');
const btnStart = makeEl('q:#btnStart');
const btnPreview = makeEl('q:#btnPreview');
const basePlay = audio.play.bind(audio);
const dummyEvt = target => ({ target, currentTarget: target, preventDefault() {}, stopPropagation() {} });

const MP3A = 'https://lhttp-hw.qtfm.cn/live/270/64k.mp3';
const MP3B = 'https://lhttp-hw.qtfm.cn/live/266/64k.mp3';
const HLS = 'https://sk.cri.cn/am846.m3u8';
const J1 = { id: 'j1', label: '上海新闻广播', status: 'running', config: { streamUrl: MP3A, monitor: false } };
const J2 = { id: 'j2', label: '上海交通广播', status: 'running', config: { streamUrl: MP3B, monitor: false } };
const J3 = { id: 'j3', label: 'CGTN Radio', status: 'completed', config: { streamUrl: HLS, monitor: false } };
const J4 = { id: 'j4', label: '无源任务', status: 'completed', config: { streamUrl: '' } };

function reset(jobs) {
  audio.play = basePlay;
  audio.removeAttribute('src');
  audio.paused = true; audio.playReject = false;
  audio.playCount = 0; audio.pauseCount = 0; audio.loadCount = 0; audio.volume = 1;
  audio.classList._s.clear();
  hint.textContent = ''; hint.className = '';
  volEl.value = '76'; urlEl.value = MP3A; autoMon.checked = false;
  statusObj.jobs = jobs;
  startResult = { ok: true, job: null, jobs: [] };
  run(`st = ${JSON.stringify(statusObj)}; activeMonitorJobId = ''; monitorToken = 0; previewAudio = null; lastJobsKey = '';`);
  setRows(jobs.map(j => ({ id: j.id, disabled: !run(`monitorEligible(${JSON.stringify(j)}).ok`) })));
}
const src = () => audio.getAttribute('src');
const active = () => run('activeMonitorJobId');
const clickMon = async id => {
  const row = jobRows.find(r => r.btn.dataset.jobmonitor === id);
  jobList.fire('click', dummyEvt(row.btn));
  await ticks(4);
};
const btnHtml = (html, id) => (html.match(new RegExp(
  '<button class="mon-btn[^"]*" data-jobmonitor="' + id + '"[^>]*>[^<]*</button>')) || [''])[0];

(async () => {
  await ticks(6);                         // 等 app.js 的异步初始化 + bind() 完成
  let pass = true, total = 0;
  const check = (name, ok, detail) => {
    total++;
    if (!ok) pass = false;
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
  };

  console.log('--- 1. 任务行按钮三态渲染 ---');
  reset([J1, J2, J3, J4]);
  run('renderJobs()');
  const h1 = jobList.innerHTML;
  check('MP3 可听任务按钮可点', btnHtml(h1, 'j1').includes('○ 监听') && !btnHtml(h1, 'j1').includes('disabled'));
  check('第二路 MP3 也可点', btnHtml(h1, 'j2').includes('○ 监听') && !btnHtml(h1, 'j2').includes('disabled'));
  check('HLS 任务按钮灰掉', btnHtml(h1, 'j3').includes('disabled') && btnHtml(h1, 'j3').includes('⊘ 不可听'));
  check('灰按钮 title 说明 VLC', /VLC/.test(btnHtml(h1, 'j3')), btnHtml(h1, 'j3').slice(0, 110));
  check('空地址任务按钮灰掉', btnHtml(h1, 'j4').includes('disabled'));
  run("activeMonitorJobId = 'j1'; renderJobs()");
  const h2 = jobList.innerHTML;
  check('点亮态由 activeId 驱动重绘', /class="mon-btn on" data-jobmonitor="j1"/.test(h2) && h2.includes('● 监听中'));

  console.log('--- 2. 点击点亮 / 再点熄灭（真实事件委托） ---');
  reset([J1, J2]);
  await clickMon('j1');
  check('点亮后 active=j1', active() === 'j1', 'active=' + active());
  check('播放器载入该任务的流', src() === MP3A, 'src=' + src());
  check('play() 被调用一次', audio.playCount === 1, 'playCount=' + audio.playCount);
  check('提示「正在监听」', /正在监听/.test(hint.textContent), hint.textContent);
  check('j1 按钮点亮', jobRows[0].btn.classList.contains('on'));
  await clickMon('j1');
  check('再点熄灭', active() === '');
  check('源被清空', !src(), 'src=' + src());
  check('pause() 被调用', audio.pauseCount > 0);

  console.log('--- 3. 排他：点另一行自动停掉上一行 ---');
  reset([J1, J2, J3]);
  await clickMon('j1');
  const pauseBefore = audio.pauseCount;
  await clickMon('j2');
  check('active 切到 j2', active() === 'j2', 'active=' + active());
  check('源换成 j2 的流', src() === MP3B, 'src=' + src());
  check('旧一路被 pause', audio.pauseCount > pauseBefore);
  check('j1 按钮熄灭', !jobRows[0].btn.classList.contains('on'));
  check('j2 按钮点亮', jobRows[1].btn.classList.contains('on'));
  check('全局只有一个 active', typeof active() === 'string' && active() === 'j2');
  check('全局只有一个 audio 元素', makeEl('q:#monitorAudio') === audio);

  console.log('--- 4. 不可监听源：即使绕过 UI 也拦下 ---');
  reset([J1, J3, J4]);
  run("toggleMonitor('j3')"); await ticks();
  check('HLS 不设源', active() === '' && !src());
  check('提示含 VLC 建议', /VLC/.test(hint.textContent), hint.textContent);
  reset([J1, J3, J4]);
  run("toggleMonitor('j4')"); await ticks();
  check('空地址被拒', active() === '');
  check('提示说明没有流地址', /没有直播流地址/.test(hint.textContent), hint.textContent);

  console.log('--- 5. 任务记录被删除时自动停声 ---');
  reset([J1, J2]);
  await clickMon('j1');
  run('st.jobs = []; syncMonitor();');
  check('active 清空', active() === '');
  check('源清空', !src());
  check('提示说明任务记录被删除', /已(被)?删除/.test(hint.textContent), hint.textContent);

  console.log('--- 6. 自动播放被拒：如实复位，不误记为成功 ---');
  reset([J1]);
  audio.playReject = true;
  run("startMonitor('j1', true)"); await ticks(4);
  check('自动监听失败后复位', active() === '');
  check('源清空', !src());
  check('提示「拦截了自动播放」', /拦截了自动播放/.test(hint.textContent), hint.textContent);
  check('按钮熄灭', !jobRows[0].btn.classList.contains('on'));
  reset([J1]);
  audio.playReject = true;
  run("startMonitor('j1', false)"); await ticks(4);
  check('手动失败提示「播放失败」', /播放失败/.test(hint.textContent), hint.textContent);

  console.log('--- 7. 快速连点的竞态：过期 play() 回调不覆盖新任务 ---');
  reset([J1, J2]);
  let resolveFirst;
  audio.play = () => new Promise(r => { resolveFirst = r; });
  run("startMonitor('j1', false)"); await tick();
  check('j1 处于连接中', active() === 'j1');
  audio.play = basePlay;
  run("startMonitor('j2', false)"); await ticks(3);
  if (resolveFirst) resolveFirst();
  await ticks(3);
  check('过期的 j1 回调不覆盖 j2', active() === 'j2', 'active=' + active());
  check('源仍是 j2 的流', src() === MP3B);
  check('提示是 j2 而非 j1', /上海交通广播/.test(hint.textContent) && !/上海新闻广播/.test(hint.textContent), hint.textContent);

  console.log('--- 8. 音量同步 + 每秒轮询不打断播放 ---');
  reset([J1]);
  await clickMon('j1');
  const loads = audio.loadCount;
  volEl.value = '30';
  run('syncMonitor(); syncMonitor();');
  check('音量实时同步', Math.abs(audio.volume - 0.3) < 1e-6, 'volume=' + audio.volume);
  check('重复轮询不重载', audio.loadCount === loads, 'loadCount ' + loads + ' → ' + audio.loadCount);
  check('active 保持不变', active() === 'j1');

  console.log('--- 9. autoMonitor 参数只作用于手动开始的新任务 ---');
  reset([J1]);
  autoMon.checked = true;
  const collected = JSON.parse(run('JSON.stringify(collect())'));
  check('collect 下发 autoMonitor', collected.autoMonitor === true);
  check('collect 不再下发旧 monitor 字段', !Object.prototype.hasOwnProperty.call(collected, 'monitor'));
  run('fillForm({ autoMonitor: true, volume: 55, streamUrl: "' + MP3A + '" })');
  check('fillForm 回填开关', autoMon.checked === true);
  check('fillForm 回填音量', volEl.value === '55');
  const PLAN = { id: 'jplan', label: '节目单 · 教子有方', status: 'running', config: { streamUrl: MP3B, monitor: false } };
  run(`st.jobs = ${JSON.stringify([J1, PLAN])}; syncMonitor();`);
  check('轮询不会自动点亮节目单任务', active() === '');
  const NEW = { id: 'jnew', label: '手动录制', status: 'scheduled', config: { streamUrl: MP3A } };
  reset([J1]);
  statusObj.jobs = [J1, NEW];
  startResult = { ok: true, job: NEW, jobs: [J1, NEW] };
  autoMon.checked = true;
  btnStart.fire('click', dummyEvt(btnStart));
  await ticks(6);
  check('手动新任务自动点亮', active() === 'jnew', 'active=' + active());
  check('新任务流已载入', src() === MP3A, 'src=' + src());
  check('自动监听代码确实在 btnStart handler 内', /btnStart[\s\S]{0,1200}autoMonitor/.test(appSrc));

  console.log('--- 10. 试听 10 秒与任务监听互斥 ---');
  reset([J1]);
  urlEl.value = MP3A;
  await clickMon('j1');
  btnPreview.fire('click', dummyEvt(btnPreview));
  await ticks(6);
  check('试听先停掉任务监听', active() === '');
  check('试听播放器已建立', run('previewAudio !== null') === true);
  check('任务监听源已清空', !src());
  await clickMon('j1');
  check('点亮任务会停掉试听', run('previewAudio === null') === true);
  check('任务监听恢复', active() === 'j1');

  console.log('--- 11. 运行时连接失败：熄灭按钮并给原因 ---');
  reset([J1]);
  await clickMon('j1');
  audio.fire('error');
  check('error 事件熄灭监听', active() === '');
  check('提示说明连接失败、录制不受影响', /连接失败/.test(hint.textContent) && /录制任务不受影响/.test(hint.textContent), hint.textContent);

  console.log(`${pass ? 'MONITOR_CHAIN=PASS' : 'MONITOR_CHAIN=FAIL'} · ${total} 项断言`);
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error('TEST ERROR', e); process.exit(1); });
