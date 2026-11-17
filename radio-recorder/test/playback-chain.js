/* Regression test for the v3.1.11 playback/list decoupling chain.
 *
 * Model under test:
 *   - the playback <audio> lives OUTSIDE #fileList, so renderFiles()'s
 *     innerHTML rebuild cannot destroy it (paused / currentTime survive);
 *   - deleting another file or polling never touches the player;
 *   - deleting the file currently being played stops it with a clear hint;
 *   - playback is exclusive with per-job monitor and with both previews.
 *
 * Run from any cwd: node test/playback-chain.js
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const els = new Map();
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
    paused: true, volume: 1, currentTime: 0, src: '', playReject: false,
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

/* #fileList behaves like innerHTML: every rebuild produces fresh row buttons,
 * while the singleton player stays the very same element. */
const fileList = makeEl('q:#fileList');
Object.defineProperty(fileList, 'innerHTML', {
  get() { return this._html || ''; },
  set(v) {
    this._html = v;
    this._playBtns = Array.from(v.matchAll(/data-play="([^"]*)"/g)).map(m => {
      const name = m[1].replace(/&quot;/g, '"');
      const btn = makeEl('row:' + name);
      btn.setAttribute('data-play', name);
      btn.textContent = '▶ 回听';
      btn.closest = sel => (sel === '[data-play]' ? btn : null);
      btn.classList = makeClassList();
      return btn;
    });
    this._delBtns = Array.from(v.matchAll(/data-del="([^"]*)"/g)).map(m => {
      const btn = makeEl('del:' + m[1]);
      btn.setAttribute('data-del', m[1]);
      btn.closest = sel => (sel === '[data-del]' || sel === '[data-jobmonitor]' ? btn : null);
      return btn;
    });
  }
});
fileList.querySelectorAll = sel => (sel === '[data-play]' ? (fileList._playBtns || []) : []);

const document = {
  querySelector: s => makeEl('q:' + s),
  querySelectorAll: sel => (sel === '#jobList .job-row' ? [] : []),
  getElementById: id => els.get('id:' + id) || makeEl('id:' + id),
  createElement: tag => makeEl('create:' + tag),
  addEventListener() {}, body: makeEl('body')
};

const MP3 = 'https://lhttp-hw.qtfm.cn/live/270/64k.mp3';
const J1 = { id: 'j1', label: '上海新闻广播', status: 'running', config: { streamUrl: MP3, monitor: false } };
const file = (name, size) => ({
  name, size, mtime: 1700000000000, writing: false, deletable: true,
  healthy: true, durationSec: 600
});
const statusObj = {
  version: 3, server: { pid: 1 }, ffmpeg: { found: true, version: 'test' },
  ffplay: { found: true }, engine: 'ffmpeg', jobs: [], job: null,
  running: false, runningCount: 0, maxParallel: 8,
  files: [file('A.mp3', 1000), file('B.mp3', 2000)], logs: [],
  outputDir: 'C:/radio/recordings', stations: [], presets: [], plans: [],
  epg: {}, alerts: {}, disk: {}, stats: {}, cleanup: {}, config: {},
  elapsedSec: 0, remainingSec: 0
};
async function fetchMock(p, opt) {
  if (p === '/api/config') return { json: async () => ({ config: {} }) };
  if (p === '/api/presets') return { json: async () => ({ presets: [] }) };
  if (p === '/api/plans') return { json: async () => ({ rules: [] }) };
  if (p === '/api/alerts') return { json: async () => ({ items: [], unread: 0 }) };
  if (String(p).startsWith('/api/epg')) return { json: async () => ({ ok: false, days: [] }) };
  if (p === '/api/files/delete') {
    const names = JSON.parse((opt && opt.body) || '{}').names || [];
    statusObj.files = statusObj.files.filter(f => !names.includes(f.name));
    return { json: async () => ({ deleted: names, bytes: 123, errors: [] }) };
  }
  if (p === '/api/status') return { json: async () => statusObj };
  return { json: async () => ({ ok: true }) };
}

const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const ctx = vm.createContext({
  document,
  window: { confirm: () => false, alert: () => {}, prompt: () => null },
  fetch: fetchMock, console,
  setTimeout: (fn) => { if (fn) return 1; return 1; },
  clearTimeout() {}, setInterval: () => 2, clearInterval() {},
  navigator: { clipboard: { writeText: async () => {} } },
  localStorage: { getItem: () => '1', setItem() {} },
  location: { href: 'http://127.0.0.1:8787/' },
  encodeURIComponent, decodeURIComponent, URL, TextEncoder, TextDecoder
});
vm.runInContext(appSrc, ctx, { filename: 'app.js' });
const run = e => vm.runInContext(e, ctx);
const tick = () => new Promise(r => setImmediate(r));
const ticks = async (n = 6) => { for (let i = 0; i < n; i++) await tick(); };
const S = () => run('st');
const audio = makeEl('q:#playbackAudio');
const bar = makeEl('q:#playbackBar');
const label = makeEl('q:#playbackLabel');
const btnStop = makeEl('q:#btnPlaybackStop');
const msg = makeEl('q:#fileMsg');
const urlEl = makeEl('q:#streamUrl');
const dummyEvt = target => ({ target, currentTarget: target, preventDefault() {}, stopPropagation() {} });

function reset() {
  run("stopPlayback(); stopPreview(); activeMonitorJobId=''; lastFilesKey=null;");
  statusObj.files = [file('A.mp3', 1000), file('B.mp3', 2000)];
  S().files = statusObj.files;
  statusObj.jobs = [J1];
  S().jobs = statusObj.jobs;
  audio.removeAttribute('src');
  audio.paused = true; audio.currentTime = 0; audio.playReject = false;
  audio.playCount = 0; audio.pauseCount = 0; audio.loadCount = 0;
  urlEl.value = MP3;
  msg.textContent = '';
  run('renderFiles()');
}

(async () => {
  await ticks();
  let pass = true, total = 0;
  const check = (name, ok, detail) => {
    total++;
    if (!ok) pass = false;
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
  };

  console.log('--- 1. 初始状态 ---');
  reset();
  check('默认没有回听文件', run('activePlaybackName') === '');
  check('回听栏默认隐藏', bar.classList.contains('hidden'));
  check('停止按钮默认禁用', btnStop.disabled === true);

  console.log('--- 2. 开始回听 A ---');
  reset();
  await run("startPlayback('A.mp3')");
  check('活动文件 = A', run('activePlaybackName') === 'A.mp3');
  check('播放器 src 指向 A', String(audio.src).includes('A.mp3'), String(audio.src));
  check('播放器开始播放', audio.playCount === 1 && audio.paused === false);
  check('回听栏显示', !bar.classList.contains('hidden'));
  check('状态标签正确', label.textContent === '正在回听：A.mp3', label.textContent);
  check('提示说明刷新不打断', msg.textContent.includes('刷新列表都不会打断'), msg.textContent);

  console.log('--- 3. 核心：文件列表刷新后播放器与进度原样保留 ---');
  reset();
  await run("startPlayback('A.mp3')");
  audio.currentTime = 42.5;
  const sameNode = run("document.querySelector('#playbackAudio')") === audio;
  const loads = audio.loadCount, pauses = audio.pauseCount;
  run('st.files[1].size = 999999; renderFiles();');   // 触发 innerHTML 重建
  check('播放器 DOM 引用未变（未被 innerHTML 重建）', sameNode);
  check('currentTime 保持 42.5 秒', audio.currentTime === 42.5, String(audio.currentTime));
  check('播放状态保持', audio.paused === false);
  check('未被额外 load / pause', audio.loadCount === loads && audio.pauseCount === pauses,
    `load ${loads}->${audio.loadCount}, pause ${pauses}->${audio.pauseCount}`);
  const btnA = fileList._playBtns.find(b => b.getAttribute('data-play') === 'A.mp3');
  const btnB = fileList._playBtns.find(b => b.getAttribute('data-play') === 'B.mp3');
  check('A 行按钮变成「■ 停止」', !!btnA && btnA.textContent === '■ 停止', btnA && btnA.textContent);
  check('B 行按钮仍是「▶ 回听」', !!btnB && btnB.textContent === '▶ 回听', btnB && btnB.textContent);

  console.log('--- 4. 删除其它文件 B：回听不受影响 ---');
  reset();
  await run("startPlayback('A.mp3')");
  audio.currentTime = 77;
  const srcBefore = audio.src, loadsB = audio.loadCount;
  await run("deleteFilesRequest(['B.mp3'],'批量删除')");
  check('仍在回听 A', run('activePlaybackName') === 'A.mp3');
  check('src 未变', audio.src === srcBefore);
  check('进度未变', audio.currentTime === 77, String(audio.currentTime));
  check('没有重新 load', audio.loadCount === loadsB);
  check('结果提示未误报回听停止', msg.textContent.includes('列表已实时刷新') && !msg.textContent.includes('回听已自动停止'));

  console.log('--- 5. 定时轮询刷新：回听不受影响 ---');
  reset();
  await run("startPlayback('A.mp3')");
  audio.currentTime = 91;
  await run('poll(true)');
  check('轮询后仍在回听 A', run('activePlaybackName') === 'A.mp3');
  check('轮询后进度仍是 91 秒', audio.currentTime === 91, String(audio.currentTime));

  console.log('--- 6. 删除正在回听的 A：自动停止并提示 ---');
  reset();
  await run("startPlayback('A.mp3')");
  await run("deleteFilesRequest(['A.mp3'],'删除文件')");
  check('活动文件清空', run('activePlaybackName') === '');
  check('播放器已暂停', audio.paused === true);
  check('播放器 src 已释放', !audio.getAttribute('src'));
  check('提示写明回听已停止', msg.textContent.includes('回听已自动停止'), msg.textContent);
  check('回听栏隐藏', bar.classList.contains('hidden'));

  console.log('--- 7. 回听单例排他：A → B ---');
  reset();
  await run("startPlayback('A.mp3')");
  await run("startPlayback('B.mp3')");
  check('活动文件切到 B', run('activePlaybackName') === 'B.mp3');
  check('src 已指向 B', String(audio.src).includes('B.mp3'), String(audio.src));
  check('切换时重新 load 一次', audio.loadCount >= 2, String(audio.loadCount));

  console.log('--- 8. 回听与任务监听互斥（双向） ---');
  reset();
  run("activeMonitorJobId='j1'");
  await run("startPlayback('A.mp3')");
  check('开始回听会停掉监听', run('activeMonitorJobId') === '');
  check('回听已点亮', run('activePlaybackName') === 'A.mp3');
  await run("startMonitor('j1')");
  check('开始监听会停掉回听', run('activePlaybackName') === '');

  console.log('--- 9. 回听与试听互斥 ---');
  reset();
  await run("startPlayback('A.mp3')");
  await run("startPreview(10,'short')");
  check('开始试听会停掉回听', run('activePlaybackName') === '');
  check('试听已点亮', run('previewAudio !== null') === true);

  console.log('--- 10. 手动停止 / 再点同一行停止 ---');
  reset();
  await run("startPlayback('A.mp3')");
  btnStop.fire('click', dummyEvt(btnStop));
  check('停止按钮生效', run('activePlaybackName') === '');
  check('停止按钮提示不误导', msg.textContent.includes('已停止回听'));
  reset();
  await run("startPlayback('A.mp3')");
  await run("startPlayback('A.mp3')");
  check('点活动行再点一次 = 停止', run('activePlaybackName') === '');

  console.log('--- 11. 外部删除（不经本 UI）后的自动收尾 ---');
  reset();
  await run("startPlayback('A.mp3')");
  S().files = [file('B.mp3', 2000)];
  statusObj.files = S().files;
  await run('poll(true)');
  check('文件消失后自动停止回听', run('activePlaybackName') === '');
  check('提示说明自动停止', msg.textContent.includes('已自动停止'), msg.textContent);

  console.log('--- 12. 异常输入与浏览器拒绝播放 ---');
  reset();
  await run("startPlayback('NOPE.mp3')");
  check('不存在的文件不会启动播放', run('activePlaybackName') === '');
  check('明确提示文件不存在', msg.textContent.includes('文件已不存在'), msg.textContent);
  reset();
  audio.playReject = true;
  await run("startPlayback('A.mp3')");
  check('自动播放被拒仍保留选中态（用户可点播放键）', run('activePlaybackName') === 'A.mp3');
  check('提示用户手动点播放', msg.textContent.includes('浏览器未自动播放'), msg.textContent);

  console.log(`\nPLAYBACK_CHAIN=${pass ? 'PASS' : 'FAIL'} checks=${total}`);
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
