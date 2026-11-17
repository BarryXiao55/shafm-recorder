'use strict';
/* Self-test for the pure modules. Run: node test/selftest.js
   No server, no network, no writes outside the OS temp directory. */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const s = require('../lib/scheduler');
const storage = require('../lib/storage');

let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  PASS  ' + name); }
  catch (e) { console.error('  FAIL  ' + name + ' -> ' + e.message); process.exitCode = 1; }
}

const at = (y, m, d, h, mi) => new Date(y, m - 1, d, h, mi || 0, 0, 0).getTime();

console.log('scheduler:');
t('validatePlan rejects bad time / duration', () => {
  assert.equal(s.validatePlan({ startTime: '25:99', durationMin: 60 }).ok, false);
  assert.equal(s.validatePlan({ startTime: '06:00', durationMin: 0 }).ok, false);
  assert.equal(s.validatePlan({ startTime: '06:00', durationMin: 60, rule: 'weekly' }).ok, false);
  assert.equal(s.validatePlan({ startTime: '6:00', durationMin: 60 }).plan.startTime, '06:00');
});

t('daily nextFire is tomorrow when today 06:00 already passed', () => {
  const p = s.validatePlan({ name: '早新闻', startTime: '06:00', durationMin: 60, rule: 'daily', enabled: true }).plan;
  const now = at(2026, 11, 14, 9, 0);           // Saturday
  assert.equal(new Date(s.nextFire(p, now)).getDate(), 15);
  assert.equal(new Date(s.nextFire(p, now)).getHours(), 6);
});

t('weekday skips Saturday and Sunday', () => {
  const p = s.validatePlan({ name: 'w', startTime: '07:30', durationMin: 30, rule: 'weekday', enabled: true }).plan;
  const n = s.nextFire(p, at(2026, 11, 14, 10, 0));  // Sat -> Monday 16th
  assert.equal(new Date(n).getDate(), 16);
  assert.equal(new Date(n).getDay(), 1);
});

t('weekend hits Sunday first', () => {
  const p = s.validatePlan({ name: 'e', startTime: '08:00', durationMin: 60, rule: 'weekend', enabled: true }).plan;
  const n = s.nextFire(p, at(2026, 11, 14, 10, 0));  // Sat -> Sun 15th
  assert.equal(new Date(n).getDate(), 15);
  assert.equal(new Date(n).getDay(), 0);
});

t('weekly only on selected weekdays', () => {
  const p = s.validatePlan({ name: 'mwf', startTime: '12:00', durationMin: 60, rule: 'weekly', weekdays: [1, 3, 5], enabled: true }).plan;
  const n = s.nextFire(p, at(2026, 11, 15, 13, 0));  // Sun -> Mon 16th
  assert.equal(new Date(n).getDay(), 1);
});

t('once fires only on its date', () => {
  const p = s.validatePlan({ name: 'o', startTime: '20:00', durationMin: 60, rule: 'once', date: '2026-11-20', enabled: true }).plan;
  assert.equal(new Date(s.nextFire(p, at(2026, 11, 14, 9, 0))).getDate(), 20);
  assert.equal(s.nextFire(p, at(2026, 11, 21, 9, 0)), null);
});

t('duePlan fires within catch-up window, not after it', () => {
  const p = s.validatePlan({ name: 'd', startTime: '06:00', durationMin: 60, rule: 'daily', enabled: true }).plan;
  const fire = s.fireAtOn(p, new Date(at(2026, 11, 14, 6, 0)));
  assert.ok(s.duePlan(p, fire + 60000));
  assert.equal(s.duePlan(p, fire + 20 * 60000), null);
  assert.equal(s.duePlan(p, fire - 60000), null);
  assert.equal(s.duePlan(Object.assign({}, p, { enabled: false }), fire + 1000), null);
});

t('planJobConfig forces silent, non-repeating job', () => {
  const p = s.validatePlan({ name: 'x', startTime: '06:00', durationMin: 45, rule: 'daily' }).plan;
  const c = s.planJobConfig(p, { streamUrl: 'U', filePrefix: 'FM990', monitor: true, repeatDaily: true });
  assert.equal(c.monitor, false);
  assert.equal(c.repeatDaily, false);
  assert.equal(c.durationMinutes, 45);
  assert.equal(c.streamUrl, 'U');
});

console.log('storage:');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-test-'));
const old = Date.now() - 200 * 86400000;
const recent = Date.now() - 2 * 86400000;
for (const [name, size, mt] of [
  ['ancient.mp3', 1000, old], ['old2.mp3', 2000, old + 1000],
  ['fresh.mp3', 3000, recent], ['writing.mp3', 4000, Date.now()], ['notes.txt', 5000, old]
]) {
  const f = path.join(tmp, name);
  fs.writeFileSync(f, Buffer.alloc(size, 0x41));
  fs.utimesSync(f, mt / 1000, mt / 1000);
}

t('audioFiles picks audio only, newest first', () => {
  const list = storage.audioFiles(tmp);
  assert.equal(list.length, 4);
  assert.ok(list.every(f => f.name.endsWith('.mp3')));
  assert.equal(list[0].name, 'writing.mp3');
});

t('computeClean deletes expired files but never the file being written', () => {
  const c = storage.computeClean(tmp, { retentionDays: 90, maxTotalGB: 0, minFreeGB: 0 }, new Set(), Date.now());
  assert.deepEqual(c.candidates.map(x => x.name), ['ancient.mp3', 'old2.mp3']);
  assert.equal(c.skippedActive, 1);
  assert.equal(c.freed, 3000);
});

t('computeClean respects explicit activeNames', () => {
  const c = storage.computeClean(tmp, { retentionDays: 90, maxTotalGB: 0, minFreeGB: 0 }, new Set(['ancient.mp3']), Date.now());
  assert.deepEqual(c.candidates.map(x => x.name), ['old2.mp3']);
});

t('computeClean honours total size cap', () => {
  const c = storage.computeClean(tmp, { retentionDays: 3650, maxTotalGB: 0.000005, minFreeGB: 0 }, new Set(), Date.now());
  assert.ok(c.candidates.length >= 1);
  assert.ok(c.candidates.some(x => /上限/.test(x.reason)));
});

t('executeClean refuses paths outside the directory', () => {
  const r = storage.executeClean(tmp, ['ancient.mp3', '..\\evil.mp3']);
  assert.deepEqual(r.deleted, ['ancient.mp3']);
  assert.equal(r.errors.length, 1);
});

t('inspectAudio flags a file with no MP3 frames', () => {
  const r = storage.inspectAudio(tmp, 'fresh.mp3');
  assert.equal(r.healthy, false);
  assert.equal(r.durationSec, 0);
});

fs.rmSync(tmp, { recursive: true, force: true });

/* ----------------------------- Phase 2b ----------------------------- */
const stations = require('../lib/stations');
const epg = require('../lib/epg');
const alerts = require('../lib/alerts');
const scheduler = require('../lib/scheduler');
const { JobManager } = require('../lib/jobs');

console.log('stations (Shanghai FM only):');
t('seed contains 11 receivable FM stations, all with FM frequency & http url', () => {
  assert.equal(stations.SEED.length, 11);
  assert.ok(stations.SEED.every(x => /FM/i.test(x.freq)));
  assert.ok(stations.SEED.every(x => /^https?:\/\//.test(x.url)));
});
t('prefix derivation: FM xx.x -> FMxxx, and AM990 keeps its legacy prefix', () => {
  assert.equal(stations.prefixFromFreq('FM 99.0'), 'FM990');
  assert.equal(stations.prefixFromFreq('FM 105.7'), 'FM1057');
  assert.equal(stations.prefixFromFreq('FM 94.7'), 'FM947');
  assert.equal(stations.prefixFromFreq('FM 87.9（上海落地）'), 'FM879');
  assert.equal(stations.prefixFor({ freq: 'FM 94.7', prefix: '' }), 'FM947');
  assert.equal(stations.prefixFor({ freq: 'FM 93.4 / AM 990', prefix: 'FM990' }), 'FM990');
});
t('validate refuses non-FM / bad url', () => {
  assert.ok(stations.validate({ name: '全国台', freq: 'AM 990', url: 'http://x/y.mp3' }));
  assert.ok(stations.validate({ name: 'x', freq: 'FM 99.0', url: 'ftp://x' }));
  assert.equal(stations.validate({ name: '上海FM', freq: 'FM 99.0', url: 'https://x/y.mp3' }), null);
});

console.log('epg:');
t('normalize parses time range and handles midnight rollover', () => {
  const a = epg.normalize({ durationStr: '23:00 ~ 00:30', title: '深夜节目' }, '2026-11-14');
  assert.equal(a.startMin, 1380);
  assert.equal(a.endMin, 1470);
  assert.equal(a.durationMin, 90);
  assert.equal(a.title, '深夜节目');
});
t('extractJson pulls __initStores out of HTML', () => {
  const html = '<script>window.__initStores={"ChannelStore":{"playBill":{"today":[{"durationStr":"06:00 ~ 07:00","title":"早新闻"}]}}};</script><div>x</div>';
  const j = epg.extractJson(html);
  assert.equal(j.ChannelStore.playBill.today[0].title, '早新闻');
});
t('offline fallback covers a full day for channel 270', () => {
  const list = epg.fallback(270, '2026-11-16');   // Monday
  assert.ok(list.length >= 20);
  assert.ok(list.some(p => /990早新闻/.test(p.title)));
  assert.equal(epg.fallback(266, '2026-11-16').length, 0);
});
t('toPlan produces a valid scheduler plan bound to the station', () => {
  const s = stations.SEED[0];
  const p = epg.toPlan({ start: '07:00', durationMin: 120, title: '990早新闻' }, s, 'weekday');
  assert.equal(scheduler.validatePlan(p).ok, true);
  assert.equal(p.stationId, s.id);
  assert.equal(p.streamUrl, s.url);
});

console.log('alerts:');
t('buildBody auto-detects WeCom / DingTalk / generic', () => {
  const ev = { level: 'warn', type: 'disk', message: '磁盘不足', at: Date.now() };
  assert.ok(alerts.buildBody('disk', { webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x', webhookType: 'auto' }, ev).msgtype);
  assert.ok(alerts.buildBody('disk', { webhookUrl: 'https://oapi.dingtalk.com/robot/send', webhookType: 'auto' }, ev).msgtype);
  assert.equal(alerts.buildBody('disk', { webhookUrl: 'https://example.com/hook', webhookType: 'auto' }, ev).source, 'FM990 Radio Recorder v3');
});

console.log('jobs (parallel manager, no I/O):');
const mockRuntime = { bumpStats() {}, setLastJobs() {}, getLastJobs: () => [], clearLastJobs() {}, getLastJob: () => null };
const mockConfig = {
  streamUrl: 'https://x/270.mp3', filePrefix: 'FM990', outputDir: os.tmpdir(),
  segmentMinutes: 60, engine: 'builtin', codec: 'copy', monitor: false,
  durationMinutes: 0, hourlyHours: 1, hourlyAlign: 'fromNextHour',
  repeatDaily: false, rangeStart: '', rangeEnd: '', autoRestart: true
};
const mkManager = () => new JobManager({ config: mockConfig, runtime: mockRuntime,
  scheduler, stations, tools: () => ({ ffmpeg: { found: false, path: null } }), log: () => {}, alert: () => {} });

t('create() builds all four modes', () => {
  const m = mkManager();
  assert.equal(m.create('now', {}).label, '立即录制');
  assert.equal(m.create('daily24', {}).durationSec, 86400);
  assert.ok(m.create('hourly', {}).durationSec > 0);
  const end = new Date(Date.now() + 3600000).toISOString().slice(0, 16);
  const start = new Date(Date.now() + 60000).toISOString().slice(0, 16);
  assert.equal(Math.round(m.create('range', { rangeStart: start, rangeEnd: end }).durationSec / 60), 59);
});
t('conflictFor blocks the same station but allows another', () => {
  const m = mkManager();
  const a = m.create('now', { stationId: 'sh_news', streamUrl: 'https://x/270.mp3' });
  a.status = 'running'; m.jobs.set(a.id, a);
  assert.ok(m.conflictFor({ stationId: 'sh_news', streamUrl: 'https://x/270.mp3' }));
  assert.equal(m.conflictFor({ stationId: 'sh_traffic', streamUrl: 'https://x/266.mp3' }), null);
});
t('publicJob exposes metrics and hides internals', () => {
  const m = mkManager();
  const j = m.create('now', {});
  const pub = m.publicJob(j);
  assert.ok(pub.metrics && typeof pub.metrics.bps === 'number');
  assert.equal(pub._recorder, undefined);
  assert.equal(Object.keys(pub).some(k => k.startsWith('_')), false);
});

console.log(`\n${passed} checks passed.`);
