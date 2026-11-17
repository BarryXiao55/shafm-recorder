/* Regression test for the v3.1.9 long preview chain.
 *
 * Model under test:
 *   - 10 s preview and 10/30/60 min preview share ONE temporary <audio>;
 *   - previewEndAt is a wall-clock deadline; a 1 s ticker re-checks it so a
 *     throttled/background tab can never overrun the promised duration;
 *   - preview and per-job monitor are mutually exclusive in BOTH directions;
 *   - long preview reconnects on error/ended up to 5 times, then gives up.
 *
 * Run from any cwd: node test/preview-chain.js
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

let now = 1700000000000;
class FakeDate extends Date {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return now; }
}

const els = new Map();
let createSeq = 0, lastCreatedAudio = null;
let jobRows = [];
const timers = [];      // { id, ms, fn, kind, fired }
const intervals = [];
let timerSeq = 0;
const setTimeoutMock = (fn, ms) => { const id = ++timerSeq; timers.push({ id, ms: ms || 0, fn, fired: false }); return id; };
const setIntervalMock = (fn, ms) => { const id = ++timerSeq; intervals.push({ id, ms: ms || 0, fn }); return id; };
const clearTimerMock = id => {
  const t = timers.find(x => x.id === id);
  if (t) t.fired = true;
};
const fireTimer = ms => {
  const t = timers.find(x => !x.fired && x.ms === ms);
  if (!t) return false;
  t.fired = true;
  t.fn();
  return true;
};

function makeClassList() {
  return {
    _s: new Set(),
    add(x) { this._s.add(x); }, remove(x) { this._s.delete(x); },
    toggle(x, f) { f ? this._s.add(x) : this._s.delete(x); },
    contains(x) { return this._s.has(x); }
  };
}
function makeEl(key) {
  if (els.has(key)) return els.get(key);
  const el = {
    _key: key, _handlers: {}, _attrs: {}, style: {}, dataset: {},
    classList: makeClassList(), children: [], hidden: false, disabled: false,
    value: '', checked: false, textContent: '', innerHTML: '', className: '', title: '', id: '',
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
    setAttribute(k, v) { this._attrs[k] = v; if (k !== 'style') this[k] = v; },
    getAttribute(k) { return this._attrs[k] !== undefined ? this._attrs[k] : (this[k] || null); },
    removeAttribute(k) { delete this._attrs[k]; this[k] = ''; },
    querySelector(s) { return makeEl(key + '|' + s); },
    querySelectorAll() { return []; },
    closest() { return null; }, focus() {}, remove() {}, contains() { return false; },
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
  createElement: tag => {
    const e = makeEl('create:' + tag + ':' + (++createSeq));
    if (tag === 'audio') lastCreatedAudio = e;
    return e;
  },
  addEventListener() {}, body: makeEl('body')
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
  return { json: async () => ({ ok: true }) };
}

const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const ctx = vm.createContext({
  document,
  window: { confirm: () => false, alert: () => {}, prompt: () => null },
  fetch: fetchMock, console,
  Date: FakeDate,
  setTimeout: setTimeoutMock, clearTimeout: clearTimerMock,
  setInterval: setIntervalMock, clearInterval: clearTimerMock,
  navigator: { clipboard: { writeText: async () => {} } },
  location: { href: 'http://127.0.0.1:8787/' },
  Audio: function () { return makeEl('audio:' + (++createSeq)); },
  encodeURIComponent, decodeURIComponent, URL, TextEncoder, TextDecoder
});
vm.runInContext(appSrc, ctx, { filename: 'app.js' });
const run = e => vm.runInContext(e, ctx);
const tick = () => new Promise(r => setImmediate(r));
const ticks = async (n = 4) => { for (let i = 0; i < n; i++) await tick(); };

const MP3 = 'https://lhttp-hw.qtfm.cn/live/270/64k.mp3';
const HLS = 'https://sk.cri.cn/am846.m3u8';
const J1 = { id: 'j1', label: '上海新闻广播', status: 'running', config: { streamUrl: MP3, monitor: false } };
const urlEl = makeEl('q:#streamUrl');
const minsEl = makeEl('q:#previewMinutes');
const btnShort = makeEl('q:#btnPreview');
const btnLong = makeEl('q:#btnPreviewLong');
const btnStop = makeEl('q:#btnPreviewStop');
const stateEl = makeEl('q:#previewState');
const audio = makeEl('q:#monitorAudio');
const jobList = makeEl('q:#jobList');
const volEl = makeEl('q:#volume');
const dummyEvt = target => ({ target, currentTarget: target, preventDefault() {}, stopPropagation() {} });

function reset() {
  run("stopPreview(); setMonitorIdle(''); st = " + JSON.stringify(statusObj) + ';');
  now = 1700000000000;
  timers.length = 0; intervals.length = 0; timerSeq = 0;
  urlEl.value = MP3; minsEl.value = '10'; volEl.value = '70';
  btnStop.disabled = true; stateEl.textContent = ''; stateEl.className = '';
  audio.removeAttribute('src'); audio.paused = true; audio.playReject = false;
  audio.playCount = 0; audio.pauseCount = 0; audio.loadCount = 0;
  statusObj.jobs = [J1];
  setRows([{ id: 'j1', disabled: false }]);
  run('st.jobs = ' + JSON.stringify([J1]) + ';');
  lastCreatedAudio = null;
}

(async () => {
  await ticks(6);
  let pass = true, total = 0;
  const check = (name, ok, detail) => {
    total++;
    if (!ok) pass = false;
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
  };

  console.log('--- 1. 初始按钮态 ---');
  reset();
  check('停止试听默认禁用', btnStop.disabled === true);
  check('长试听按钮文案', btnLong.textContent === '开始长试听' || btnLong.textContent === '', String(btnLong.textContent));

  console.log('--- 2. 10 / 30 / 60 分钟三档时长 ---');
  for (const [m, ms] of [['10', 600000], ['30', 1800000], ['60', 3600000]]) {
    reset();
    minsEl.value = m;
    btnLong.fire('click', dummyEvt(btnLong));
    await ticks(6);
    const end = run('previewEndAt');
    check(`${m} 分钟：结束时间 = 起点 + ${ms} ms`, end - now === ms, String(end - now));
    check(`${m} 分钟：结束定时器存在`, timers.some(t => !t.fired && t.ms === ms));
    check(`${m} 分钟：状态写明总时长`, stateEl.textContent.includes(`共 ${m} 分钟`), stateEl.textContent);
    check(`${m} 分钟：按钮点亮`, btnLong.textContent.includes('长试听中') && btnStop.disabled === false);
    check(`${m} 分钟：播放器已建立`, run('previewAudio !== null') === true);
  }

  console.log('--- 3. 非法时长回落 10 分钟 ---');
  reset();
  minsEl.value = '999';
  btnLong.fire('click', dummyEvt(btnLong));
  await ticks(6);
  check('回落到 600000 ms', run('previewEndAt') - now === 600000);

  console.log('--- 4. 倒计时与墙钟到时（后台节流不会超时长） ---');
  reset();
  minsEl.value = '60';
  btnLong.fire('click', dummyEvt(btnLong));
  await ticks(6);
  const started = now;
  const hasTicker = intervals.some(t => t.ms === 1000);
  check('注册了 1 秒校准 ticker', hasTicker === true);
  now = started + 65000;
  run('previewTick()');
  check('倒计时按墙钟显示剩余', stateEl.textContent.includes('00:58:55'), stateEl.textContent);
  now = started + 3600000 + 1;
  run('previewTick()');
  check('到时自动停止（不依赖 setTimeout 是否准时）', run('previewAudio === null') === true);
  check('到时状态提示', /已到时/.test(stateEl.textContent), stateEl.textContent);
  check('停止按钮复位禁用', btnStop.disabled === true);
  check('长试听按钮复位', btnLong.textContent === '开始长试听');

  console.log('--- 5. 手动停止 ---');
  reset();
  btnLong.fire('click', dummyEvt(btnLong));
  await ticks(6);
  const pa = lastCreatedAudio;
  btnStop.fire('click', dummyEvt(btnStop));
  check('手动停止清播放器', run('previewAudio === null') === true);
  check('手动停止清结束时间', run('previewEndAt') === 0);
  check('audio 被 pause 且清源', pa.pauseCount > 0 && !pa.getAttribute('src'));
  check('状态提示已手动停止', /已手动停止试听/.test(stateEl.textContent), stateEl.textContent);
  check('定时器被清理', timers.filter(t => t.ms === 600000).every(t => t.fired));
  btnStop.fire('click', dummyEvt(btnStop));
  check('空态再点停止有反馈', /当前没有正在进行的试听/.test(stateEl.textContent));

  console.log('--- 6. 与任务监听双向排他 ---');
  reset();
  jobList.fire('click', dummyEvt(jobRows[0].btn));
  await ticks(4);
  check('先点亮任务监听', run('activeMonitorJobId') === 'j1');
  btnLong.fire('click', dummyEvt(btnLong));
  await ticks(6);
  check('长试听停掉任务监听', run('activeMonitorJobId') === '');
  check('任务播放器源清空', !audio.getAttribute('src'));
  jobList.fire('click', dummyEvt(jobRows[0].btn));
  await ticks(4);
  check('点亮任务监听停掉长试听', run('previewAudio === null') === true);
  check('状态行提示长试听已停止', /长试听已停止/.test(stateEl.textContent), stateEl.textContent);
  check('任务监听恢复', run('activeMonitorJobId') === 'j1');

  console.log('--- 7. 短试听与长试听互斥、10 秒到时 ---');
  reset();
  btnLong.fire('click', dummyEvt(btnLong));
  await ticks(6);
  btnShort.fire('click', dummyEvt(btnShort));
  await ticks(6);
  check('短试听接管后只有一个播放器', run('previewAudio !== null') === true && run('previewLabel') === 'short');
  check('长试听结束定时器已取消', timers.filter(t => t.ms === 600000).every(t => t.fired));
  fireTimer(10000);
  check('10 秒到时自动结束', run('previewAudio === null') === true);
  check('10 秒结束提示', /10 秒试听结束/.test(stateEl.textContent), stateEl.textContent);

  console.log('--- 8. 不可试听的源被拦下 ---');
  reset();
  urlEl.value = HLS;
  btnLong.fire('click', dummyEvt(btnLong));
  await ticks(6);
  check('HLS 不建立播放器', run('previewAudio === null') === true);
  check('HLS 给出 VLC 提示', /HLS/.test(stateEl.textContent) && /VLC/.test(stateEl.textContent), stateEl.textContent);
  reset();
  urlEl.value = '   ';
  btnLong.fire('click', dummyEvt(btnLong));
  await ticks(4);
  check('空地址不建立播放器', run('previewAudio === null') === true);

  console.log('--- 9. 长试听断流自动重连 ---');
  reset();
  minsEl.value = '30';
  btnLong.fire('click', dummyEvt(btnLong));
  await ticks(6);
  const pa2 = lastCreatedAudio;
  const loadsBefore = pa2.loadCount, playsBefore = pa2.playCount;
  pa2.fire('error');
  check('error 后状态提示重连', /自动重连/.test(stateEl.textContent), stateEl.textContent);
  check('注册 3 秒重连定时器', timers.some(t => !t.fired && t.ms === 3000));
  fireTimer(3000);
  await ticks(3);
  check('重连重新 load + play', pa2.loadCount > loadsBefore && pa2.playCount > playsBefore);
  check('重连后播放器仍是同一个', run('previewAudio !== null') === true);
  for (let i = 0; i < 6; i++) { pa2.fire('error'); fireTimer(3000); await ticks(2); }
  check('重连超过上限后自动停止', run('previewAudio === null') === true, stateEl.textContent);
  check('上限提示说明流反复中断', /反复中断/.test(stateEl.textContent), stateEl.textContent);

  console.log('--- 10. 音量同步 / 播放失败 / 源码契约 ---');
  reset();
  btnLong.fire('click', dummyEvt(btnLong));
  await ticks(6);
  volEl.value = '25';
  const volTarget = makeEl('q:#volume');
  volTarget.value = '25';
  volTarget.fire('input', dummyEvt(volTarget));
  check('长试听音量实时同步', Math.abs(lastCreatedAudio.volume - 0.25) < 1e-6, String(lastCreatedAudio.volume));
  reset();
  const origCreate = document.createElement;
  document.createElement = tag => {
    const e = makeEl('create:reject:' + (++createSeq));
    if (tag === 'audio') { lastCreatedAudio = e; e.playReject = true; }
    return e;
  };
  btnLong.fire('click', dummyEvt(btnLong));
  await ticks(6);
  check('play() 被拒后如实复位', run('previewAudio === null') === true);
  check('播放失败提示', /试听未能开始/.test(stateEl.textContent), stateEl.textContent);
  document.createElement = origCreate;
  check('源码按墙钟判定到时', /previewEndAt - Date\.now\(\)/.test(appSrc));
  check('源码三档白名单 10/30/60', /\[10, 30, 60\]/.test(appSrc));
  check('源码限制重连次数', /PREVIEW_MAX_RECONNECT/.test(appSrc));

  console.log(`${pass ? 'PREVIEW_CHAIN=PASS' : 'PREVIEW_CHAIN=FAIL'} · ${total} 项断言`);
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error('TEST ERROR', e); process.exit(1); });
