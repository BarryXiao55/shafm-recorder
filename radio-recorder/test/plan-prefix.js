/* Regression test for the v3.1.10 scheduled-plan filename prefix chain.
 *
 * Bug (v3.1.9): every plan that was NOT created by "EPG -> 加入节目单"
 * (manual form with a stale prefix, edit of an old plan, stream-URL-only plan,
 * quick template, legacy plan with empty filePrefix) fell back to the GLOBAL
 * config.filePrefix, so different stations all recorded as FM990_*.mp3.
 *
 * Fix: public/plan-prefix.js is the single source of truth, shared by the
 * browser and the server. The prefix is derived from stationId / streamUrl at
 * BOTH "save plan" and "fire plan" time. Explicit custom prefixes still work.
 *
 * Run from any cwd: node test/plan-prefix.js
 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const PP = require(path.join(ROOT, 'public', 'plan-prefix.js'));
const scheduler = require(path.join(ROOT, 'lib', 'scheduler.js'));
const stations = require(path.join(ROOT, 'lib', 'stations.js'));
const epg = require(path.join(ROOT, 'lib', 'epg.js'));

const LIST = stations.list();
const S = id => stations.get(id);
const MP3 = id => S(id).url;
const GLOBAL = {
  streamUrl: MP3('sh_news'), filePrefix: 'FM990', outputDir: 'X',
  monitor: true, repeatDaily: true
};
const base = () => ({ name: '测试节目', startTime: '06:00', durationMin: 60, rule: 'daily' });

let groups = 0, checks = 0;
function t(name, fn) {
  groups++;
  let before = checks;
  const ok = (cond, msg) => { assert.ok(cond, `${name}: ${msg || 'assertion failed'}`); checks++; };
  const eq = (a, b, msg) => { assert.strictEqual(a, b, `${name}: ${msg || 'not equal'} (got ${a}, want ${b})`); checks++; };
  fn(ok, eq);
  console.log(`  [${String(groups).padStart(2, '0')}] ${name} — ${checks - before} 项`);
}

/* ------------------------------------------------------------------ *
 * 1. Pure helpers
 * ------------------------------------------------------------------ */
t('频率 → 前缀推导', (ok, eq) => {
  eq(PP.prefixFromFreq('FM 99.0'), 'FM990');
  eq(PP.prefixFromFreq('FM 105.7'), 'FM1057');
  eq(PP.prefixFromFreq('FM 90.9'), 'FM909');
  eq(PP.prefixFromFreq('FM 87.9（上海落地）'), 'FM879');
  eq(PP.prefixFromFreq('AM 990'), '');
  eq(PP.prefixOf(S('sh_news')), 'FM990');       // 显式配置优先（AM990 的历史命名）
  eq(PP.prefixOf(S('sh_traffic')), 'FM1057');
  eq(PP.prefixOf(S('sh_cbn')), 'FM909');
  eq(PP.prefixOf(S('sh_cgtn879')), 'FM879');
  eq(PP.prefixOf({ freq: 'FM 101.7', prefix: '' }), 'FM1017');
  eq(PP.prefixOf({ freq: 'AM 990', prefix: '' }), 'REC');
});

t('URL 归一化与电台反查', (ok, eq) => {
  eq(PP.normalizeUrl('HTTPS://LHTTP-HW.QTFM.CN/live/266/64k.mp3/?x=1'), 'lhttp-hw.qtfm.cn/live/266/64k.mp3');
  eq(PP.normalizeUrl(''), '');
  eq(PP.stationByUrl(LIST, MP3('sh_pop')).id, 'sh_pop');
  eq(PP.stationByUrl(LIST, 'http://lhttp.qingting.fm/live/266/64k.mp3').id, 'sh_traffic'); // backup 源
  eq(PP.stationByUrl(LIST, 'https://example.com/unknown.mp3'), null);
  eq(PP.stationByUrl(LIST, ''), null);
});

t('非法字符清理与长度限制', (ok, eq) => {
  eq(PP.cleanPrefix('FM 105/7:xx?'), 'FM 105_7_xx_');
  eq(PP.cleanPrefix('A'.repeat(40)).length, 24);
  eq(PP.cleanPrefix(null), '');
});

/* ------------------------------------------------------------------ *
 * 2. decide() / normalizePlan() — 所有入口共用的决策
 * ------------------------------------------------------------------ */
t('按 stationId 识别电台 → 强制频率前缀', (ok, eq) => {
  const d = PP.decide({ stationId: 'sh_traffic', streamUrl: MP3('sh_traffic'), filePrefix: 'FM990' }, LIST, 'FM990');
  eq(d.filePrefix, 'FM1057');
  eq(d.prefixMode, 'auto');
  eq(d.changed, true);
  eq(d.expected, 'FM1057');
  eq(d.matchedBy, 'station');
});

t('只填流地址（无 stationId）→ 反查电台并补 stationId', (ok, eq) => {
  const d = PP.decide({ stationId: '', streamUrl: MP3('sh_cbn'), filePrefix: '' }, LIST, 'FM990');
  eq(d.filePrefix, 'FM909');
  eq(d.stationId, 'sh_cbn');
  eq(d.matchedBy, 'url');
  eq(d.inferredStation, true);
});

t('快捷模板 / 存量空前缀计划 → 不再塌成 FM990', (ok, eq) => {
  const legacy = { stationId: 'sh_pop', streamUrl: MP3('sh_pop'), filePrefix: '' };
  eq(PP.normalizePlan(legacy, LIST, 'FM990').filePrefix, 'FM1017');
  eq(PP.normalizePlan({ streamUrl: MP3('sh_traffic') }, LIST, 'FM990').filePrefix, 'FM1057');
  // 真正无法识别的自定义源才允许沿用全局
  eq(PP.normalizePlan({ streamUrl: 'https://example.com/x.mp3' }, LIST, 'FM990').filePrefix, 'FM990');
  eq(PP.normalizePlan({ streamUrl: 'https://example.com/x.mp3' }, LIST, 'FM990').prefixMode, 'fallback');
});

t('显式自定义前缀是唯一例外', (ok, eq) => {
  const d = PP.decide({ stationId: 'sh_traffic', streamUrl: MP3('sh_traffic'), filePrefix: 'MY_SHOW', prefixManual: true }, LIST, 'FM990');
  eq(d.filePrefix, 'MY_SHOW');
  eq(d.prefixMode, 'manual');
  eq(d.expected, 'FM1057');
  // 没勾选自定义时，即使填了自定义值也要按频率校正
  eq(PP.decide({ stationId: 'sh_traffic', filePrefix: 'MY_SHOW' }, LIST, 'FM990').filePrefix, 'FM1057');
});

t('normalizePlan 不删字段、不改原对象', (ok, eq) => {
  const raw = Object.assign(base(), { stationId: 'sh_cbn', streamUrl: MP3('sh_cbn'), filePrefix: 'FM990', days: [1, 2] });
  const out = PP.normalizePlan(raw, LIST, 'FM990');
  eq(out.filePrefix, 'FM909');
  eq(raw.filePrefix, 'FM990', '原对象必须保持不变');
  eq(out.days.length, 2);
  eq(out.name, '测试节目');
  ok(!('prefixManual' in out), '不应把表单临时字段写进节目单');
});

/* ------------------------------------------------------------------ *
 * 3. Server-side chain: validatePlan -> normalizePlan -> planJobConfig
 * ------------------------------------------------------------------ */
function effectivePrefix(raw, withList) {
  const p = scheduler.validatePlan(raw).plan;
  const norm = PP.normalizePlan(p, withList ? LIST : [], GLOBAL.filePrefix);
  return scheduler.planJobConfig(norm, GLOBAL, withList ? LIST : []);
}

t('EPG 加入：不同电台得到不同前缀', (ok, eq) => {
  eq(effectivePrefix(epg.toPlan({ start: '06:00', title: 'T', durationMin: 60 }, S('sh_traffic'), 'daily'), true).filePrefix, 'FM1057');
  eq(effectivePrefix(epg.toPlan({ start: '06:00', title: 'T', durationMin: 60 }, S('sh_cbn'), 'daily'), true).filePrefix, 'FM909');
  eq(effectivePrefix(epg.toPlan({ start: '06:00', title: 'T', durationMin: 60 }, S('sh_news'), 'daily'), true).filePrefix, 'FM990');
});

t('编辑旧计划残留 FM990 → 保存时按新电台校正', (ok, eq) => {
  const c = effectivePrefix(Object.assign(base(), { stationId: 'sh_pop', streamUrl: MP3('sh_pop'), filePrefix: 'FM990' }), true);
  eq(c.filePrefix, 'FM1017');
  eq(c.stationId, 'sh_pop');
  eq(c.streamUrl, MP3('sh_pop'));
});

t('到点触发时再算一次：存量旧值也不会写错文件', (ok, eq) => {
  const stale = scheduler.validatePlan(Object.assign(base(), {
    id: 'p_old', stationId: 'sh_traffic', streamUrl: MP3('sh_traffic'), filePrefix: 'FM990'
  })).plan;
  // 故意不调用 normalizePlan（模拟磁盘上还没被改过的旧计划）
  const c = scheduler.planJobConfig(stale, GLOBAL, LIST);
  eq(c.filePrefix, 'FM1057');
  eq(c.monitor, false, '节目单任务仍必须静音');
  eq(c.repeatDaily, false, '节目单任务不能变成每日重复');
});

t('未传电台库时保持旧兜底行为（兼容既有单元自测）', (ok, eq) => {
  const c = scheduler.planJobConfig(scheduler.validatePlan(Object.assign(base(), { filePrefix: 'X' })).plan, GLOBAL);
  eq(c.filePrefix, 'X');
  eq(scheduler.planJobConfig(scheduler.validatePlan(base()).plan, GLOBAL).filePrefix, 'FM990');
});

t('服务端四处入口都调用了统一前缀模块', (ok, eq) => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  ok(server.includes("require('./public/plan-prefix.js')"), 'server.js 必须引入统一模块');
  eq((server.match(/normalizePlanForSave\(/g) || []).length >= 4, true, 'EPG 加入/新增/更新/定义四处');
  const jobs = fs.readFileSync(path.join(ROOT, 'lib', 'jobs.js'), 'utf8');
  ok(jobs.includes('this.stations.list()'), 'firePlan 必须把电台库传给 planJobConfig');
  const sched = fs.readFileSync(path.join(ROOT, 'lib', 'scheduler.js'), 'utf8');
  ok(sched.includes('planPrefix.normalizePlan'), 'planJobConfig 必须走统一模块');
});

/* ------------------------------------------------------------------ *
 * 4. Browser side: real app.js in a DOM sandbox
 * ------------------------------------------------------------------ */
const els = new Map();
let createSeq = 0;
function makeClassList() {
  return { _s: new Set(), add(x) { this._s.add(x); }, remove(x) { this._s.delete(x); },
    toggle(x, f) { f ? this._s.add(x) : this._s.delete(x); }, contains(x) { return this._s.has(x); } };
}
function makeEl(key) {
  if (els.has(key)) return els.get(key);
  const el = {
    _key: key, _handlers: {}, _attrs: {}, style: {}, dataset: {}, classList: makeClassList(),
    children: [], hidden: false, disabled: false, value: '', checked: false, readOnly: false,
    textContent: '', innerHTML: '', className: '', title: '', id: '', open: false, placeholder: '',
    addEventListener(t, fn) { (this._handlers[t] = this._handlers[t] || []).push(fn); },
    fire(t, evt) { (this._handlers[t] || []).forEach(fn => fn(evt || { target: this, preventDefault() {} })); },
    removeEventListener() {}, appendChild(c) { this.children.push(c); return c; },
    setAttribute(k, v) { this._attrs[k] = v; this[k] = v; },
    removeAttribute(k) { delete this._attrs[k]; this[k] = ''; },
    querySelector(s) { return makeEl(key + '|' + s); },
    querySelectorAll() { return []; }, closest() { return null; },
    focus() {}, remove() {}, contains() { return false; }, click() {}
  };
  els.set(key, el);
  return el;
}
const document = {
  querySelector: s => makeEl('q:' + s),
  querySelectorAll: () => [],
  getElementById: id => els.get('id:' + id) || null,
  createElement: tag => makeEl('create:' + tag + ':' + (++createSeq)),
  addEventListener() {}, body: makeEl('body')
};
const fetchMock = async p => {
  if (p === '/api/config') return { json: async () => ({ config: {} }) };
  if (p === '/api/presets') return { json: async () => ({ presets: [] }) };
  if (p === '/api/plans') return { json: async () => ({ rules: [] }) };
  if (p === '/api/alerts') return { json: async () => ({ items: [], unread: 0 }) };
  if (p === '/api/epg') return { json: async () => ({ ok: true, days: [] }) };
  return { json: async () => ({ version: 3, stations: LIST, plans: [], jobs: [], files: [], logs: [],
    epg: {}, alerts: {}, disk: {}, stats: {}, cleanup: {}, ffmpeg: {}, ffplay: {}, server: {}, config: {} }) };
};
const win = { confirm: () => false, alert: () => {}, prompt: () => null, PlanPrefix: PP };
const ctx = vm.createContext({
  document, window: win, PlanPrefix: PP, fetch: fetchMock, console,
  setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
  navigator: { clipboard: { writeText: async () => {} } },
  location: { href: 'http://127.0.0.1:8787/' },
  Audio: function () { return makeEl('audio:' + (++createSeq)); },
  encodeURIComponent, decodeURIComponent, URL, TextEncoder, TextDecoder
});
vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8'), ctx, { filename: 'app.js' });
const run = expr => vm.runInContext(expr, ctx);
const el = sel => makeEl('q:' + sel);

run(`st = ${JSON.stringify({ stations: LIST, plans: [], jobs: [], files: [], logs: [], epg: {}, alerts: {}, disk: {}, stats: {}, cleanup: {} })};
     cfg = ${JSON.stringify({ stationId: 'sh_news', streamUrl: MP3('sh_news'), filePrefix: 'FM990' })};
     stationList = ${JSON.stringify(LIST)};
     presets = ${JSON.stringify(LIST.map(s => ({ id: s.id, name: s.name, url: s.url, freq: s.freq, prefix: s.prefix })))};`);

t('选择电台后前缀框自动跟随频率', (ok, eq) => {
  el('#pStation').value = 'sh_traffic';
  run('syncPlanPrefix()');
  eq(el('#pPrefix').value, 'FM1057');
  eq(el('#pPrefix').readOnly, true);
  ok(el('#pPrefixHint').textContent.includes('FM1057'), '提示行要显示当前前缀');
  el('#pStation').value = 'sh_cbn';
  run('syncPlanPrefix()');
  eq(el('#pPrefix').value, 'FM909');
});

t('切换电台会覆盖手工残留的 FM990', (ok, eq) => {
  el('#pPrefix').value = 'FM990';
  el('#pStation').value = 'sh_pop';
  run('syncPlanPrefix()');
  eq(el('#pPrefix').value, 'FM1017');
});

t('编辑旧计划：打开表单时立刻按电台校正旧前缀', (ok, eq) => {
  run(`setPlanForm(${JSON.stringify(Object.assign(base(), {
    id: 'p1', stationId: 'sh_cbn', streamUrl: MP3('sh_cbn'), filePrefix: 'FM990', prefixMode: 'auto', weekdays: []
  }))})`);
  eq(el('#pPrefix').value, 'FM909');
  eq(el('#pPrefixManual').checked, false);
});

t('只填流地址也能识别电台并带上 stationId', (ok, eq) => {
  el('#pStation').value = '';
  el('#pUrl').value = MP3('sh_traffic');
  el('#pPrefixManual').checked = false;
  run('syncPlanPrefix()');
  eq(el('#pPrefix').value, 'FM1057');
  const v = run('planFormValues()');
  eq(v.stationId, 'sh_traffic');
  eq(v.filePrefix, 'FM1057');
});

t('自定义前缀开关：勾选可手填，取消后立刻回到频率前缀', (ok, eq) => {
  el('#pStation').value = 'sh_cbn';
  el('#pUrl').value = MP3('sh_cbn');
  el('#pPrefixManual').checked = true;
  el('#pPrefix').value = 'MY_SHOW';
  run('syncPlanPrefix()');
  eq(el('#pPrefix').readOnly, false);
  let v = run('planFormValues()');
  eq(v.filePrefix, 'MY_SHOW');
  eq(v.prefixMode, 'manual');
  el('#pPrefixManual').checked = false;
  run('syncPlanPrefix()');
  v = run('planFormValues()');
  eq(v.filePrefix, 'FM909');
  eq(v.prefixMode, 'auto');
});

t('快捷模板带上当前电台后不会落全局 FM990', (ok, eq) => {
  const tpl = Object.assign({}, run('TEMPLATES.morning'), {
    stationId: 'sh_pop', streamUrl: MP3('sh_pop'),
    filePrefix: PP.prefixOf(S('sh_pop')), prefixMode: 'auto'
  });
  const out = PP.normalizePlan(scheduler.validatePlan(tpl).plan, LIST, 'FM990');
  eq(out.filePrefix, 'FM1017');
  eq(out.stationId, 'sh_pop');
});

console.log(`\nPLAN_PREFIX_CHAIN=PASS groups=${groups} assertions=${checks}`);
