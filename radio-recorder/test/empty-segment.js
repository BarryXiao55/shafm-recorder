'use strict';
/*
 * v3.1.12 空片段守卫回归。
 * 覆盖三项改进：收尾清理空片段 / 尾部不重连 / 重连首帧超时，
 * 以及 interrupted 终态在任务管理器与 UI 文案中的接入。
 * 全部在临时目录与纯函数上进行，不碰用户录音、配置与运行中的服务。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const guard = require('../lib/segment-guard');
const storage = require('../lib/storage');
const { Recorder } = require('../lib/recorder');
const { JobManager } = require('../lib/jobs');

let checks = 0, groups = 0;
const ok = (c, m) => { assert.ok(c, m || 'assertion failed'); checks++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m || `${a} !== ${b}`); checks++; };
function group(name, fn) { groups++; console.log(`  ${groups}. ${name}`); return fn(); }
function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'rr-empty-')); }
function write(dir, name, bytes) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, Buffer.alloc(bytes, 0xff));
  return p;
}

function makeRecorder(dir, opts) {
  const o = opts || {};
  const job = {
    id: 't1', label: '测试任务', status: 'running',
    durationSec: o.durationSec == null ? 100 : o.durationSec,
    config: Object.assign({ outputDir: dir, filePrefix: 'FM990', streamUrl: 'http://example/64k.mp3' }, o.config || {})
  };
  const logs = [];
  let result = null;
  const r = new Recorder({
    job,
    log: s => logs.push(s),
    onFinish: (j, s) => { result = s; },
    tools: () => ({ ffmpeg: { found: false, path: '' } })
  });
  r.startedAt = Date.now();
  return { r, job, logs, status: () => result };
}

const ROOT = path.resolve(__dirname, '..');

group('阈值常量与空文件判定', () => {
  eq(guard.EMPTY_FILE_BYTES, 8, '空片段阈值 8 字节');
  eq(guard.TAIL_RECONNECT_MIN_SEC, 15, '尾部不重连阈值 15 秒');
  eq(guard.FIRST_FRAME_TIMEOUT_MS, 12000, '首帧超时 12 秒');
  ok(guard.isEmptySize(0), '0 字节算空');
  ok(guard.isEmptySize(7), '7 字节算空');
  ok(!guard.isEmptySize(8), '8 字节不算空');
  ok(!guard.isEmptySize(300000), '正常文件不算空');
  ok(guard.isEmptySize(undefined), '缺失大小按空处理');
});

group('sweepEmptySegments 只删传入的空文件', () => {
  const dir = tmpdir();
  try {
    const a = 'FM990_062951_0000.mp3', b = 'FM990_062951_0001.mp3';
    const c = 'FM990_062951_0002.mp3', other = 'USER_IMPORTANT.mp3';
    write(dir, a, 0); write(dir, b, 7); write(dir, c, 4096); write(dir, other, 0);
    const rep = guard.sweepEmptySegments(dir, [a, b, c, 'missing.mp3']);
    eq(rep.removed.length, 2, '只删 2 个传入的空片段');
    eq(rep.kept.length, 2, '非空 + 不存在各 1 个');
    eq(rep.errors.length, 0, '无错误');
    ok(!fs.existsSync(path.join(dir, a)), '0 字节文件已删除');
    ok(!fs.existsSync(path.join(dir, b)), '7 字节文件已删除');
    ok(fs.existsSync(path.join(dir, c)), '4096 字节文件保留');
    ok(fs.existsSync(path.join(dir, other)), '没传进来的文件绝不被删');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

group('sweepEmptySegments 拒绝路径穿越', () => {
  const dir = tmpdir();
  try {
    write(dir, 'safe.mp3', 0);
    write(path.dirname(dir), 'rr-outside-' + path.basename(dir) + '.mp3', 0);
    const outside = path.join(path.dirname(dir), 'rr-outside-' + path.basename(dir) + '.mp3');
    const rep = guard.sweepEmptySegments(dir, ['../' + path.basename(outside), outside, 'safe.mp3']);
    // basename 会把 ../ 与绝对路径收敛成纯文件名：既不会越界删除，也不产生错误项。
    eq(rep.errors.length, 0, '越界路径被收敛为文件名，不产生非法操作');
    ok(fs.existsSync(outside), '目录外的文件未被删除');
    eq(rep.removed.length, 1, '合法空片段仍被清理');
    eq(rep.kept.length, 2, '两条越界路径按文件名查无此文件');
    eq(guard.sweepEmptySegments(dir, ['../../etc/passwd']).errors.length, 0, '系统路径也被收敛为文件名');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    try { fs.unlinkSync(path.join(path.dirname(dir), 'rr-outside-' + path.basename(dir) + '.mp3')); } catch (e) { /* ignore */ }
  }
});

group('收尾自动清理空片段（改进 1）', () => {
  const dir = tmpdir();
  try {
    const empty = 'FM990_20261116_062951_0000.mp3';
    const good = 'FM990_20261116_062951_0001.mp3';
    write(dir, empty, 0); write(dir, good, 262144);
    const { r, job, logs, status } = makeRecorder(dir);
    r.engine = 'builtin';
    r._createdFiles = [empty, good];
    r.finish('interrupted');
    eq(status(), 'interrupted', '源中断终态');
    eq(r.finished, true, '录制器已结束');
    ok(!fs.existsSync(path.join(dir, empty)), '空片段被自动删除');
    ok(fs.existsSync(path.join(dir, good)), '有内容的片段保留');
    eq(job.emptySegments.length, 1, '任务上记录被清理的文件名');
    eq(job.emptySegments[0], empty, '记录名正确');
    ok(logs.some(s => /已清理 1 个空片段/.test(s)), '日志说明清理动作');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

group('ffmpeg 退出决策：尾部不重连（改进 2）', () => {
  const d = guard.decideFfmpegExit({ code: 0, elapsed: 85, durationSec: 100 });
  eq(d.action, 'interrupted', '剩余 15 秒 → 源中断');
  eq(d.tail, true, '标记为尾部');
  ok(d.remain <= 15, '剩余时间正确');
  const d2 = guard.decideFfmpegExit({ code: 0, elapsed: 86, durationSec: 100 });
  eq(d2.action, 'interrupted', '剩余 14 秒 → 源中断');
  const d3 = guard.decideFfmpegExit({ code: 0, elapsed: 84, durationSec: 100 });
  eq(d3.action, 'reconnect', '剩余 16 秒 → 仍重连');
  const d4 = guard.decideFfmpegExit({ code: 1, elapsed: 90, durationSec: 100 });
  eq(d4.action, 'finish', '非零退出码不重连');
  eq(d4.status, 'failed', '非零退出码标记失败');
  const d5 = guard.decideFfmpegExit({ code: 0, elapsed: 10, durationSec: 0 });
  eq(d5.action, 'reconnect', '不限时长任务仍会重连');
  const d6 = guard.decideFfmpegExit({ code: 0, elapsed: 10, durationSec: 100, autoRestart: false });
  eq(d6.action, 'finish', '关闭自动重连时直接结束');
  eq(d6.status, 'completed', '关闭自动重连且正常退出 → completed');
  const d7 = guard.decideFfmpegExit({ code: 0, elapsed: 90, durationSec: 100, stopped: true });
  ok(d7.action !== 'reconnect', '手动停止期间不再拉起新进程');
});

group('内置引擎尾部不重连', () => {
  const dir = tmpdir();
  try {
    const a = makeRecorder(dir, { durationSec: 100 });
    a.r._b = { stop: false, retrying: false, aligned: false };
    a.r.deadline = Date.now() + 5000;
    a.r._icyRetry();
    eq(a.status(), 'interrupted', '尾部断流按源中断结束');
    eq(a.r._retryTimer, null, '没有安排新的连接定时器');
    ok(a.logs.some(s => /剩余不足 15 秒/.test(s)), '日志说明不再重连');

    const b = makeRecorder(dir, { durationSec: 100 });
    b.r._b = { stop: false, retrying: false, aligned: false };
    b.r.deadline = Date.now() + 60000;
    b.r._icyRetry();
    eq(b.status(), null, '远离截止点时不会结束任务');
    ok(b.r._retryTimer, '中部断流仍安排重连');
    eq(b.r.restartCount, 1, '重连计数递增');
    clearTimeout(b.r._retryTimer);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

group('重连后首帧超时（改进 3）', () => {
  const dir = tmpdir();
  try {
    const a = makeRecorder(dir, { durationSec: 300 });
    const name = 'FM990_20261116_090008_0000.mp3';
    write(dir, name, 0);
    a.r.engine = 'builtin';
    a.r.activeFile = name;
    a.r._createdFiles = [name];
    a.r._b = { stop: false, retrying: false, aligned: false };
    a.r.deadline = Date.now() + 120000;
    a.r._segWatch = { name, at: Date.now() - 13000, bytes: 0, isRetry: true, fired: false };
    a.r._tick();
    eq(a.status(), 'interrupted', '12 秒无首帧 → 源中断');
    ok(a.logs.some(s => /放弃空片段/.test(s)), '日志说明放弃片段');
    ok(!fs.existsSync(path.join(dir, name)), '超时空片段被清理');

    const b = makeRecorder(dir, { durationSec: 300 });
    b.r.engine = 'builtin';
    b.r._b = { stop: false, retrying: false, aligned: false };
    b.r.deadline = Date.now() + 120000;
    b.r._segWatch = { name: 'ok.mp3', at: Date.now() - 13000, bytes: 262144, isRetry: true, fired: false };
    b.r._tick();
    eq(b.status(), null, '首帧已落盘的任务不会误判');
    eq(b.r._segWatch.isRetry, false, '守卫已解除');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

group('0 字节文件在 UI 上不再误报损坏', () => {
  const dir = tmpdir();
  try {
    const name = 'FM990_legacy_0000.mp3';
    write(dir, name, 0);
    const info = storage.inspectAudio(dir, name);
    eq(info.healthy, false, '仍是非健康文件（不可听）');
    eq(info.reason, '空片段（源中断）', '原因改为源中断空片段');
    const html = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
    ok(/空片段<\/span>/.test(html), '前端显示「空片段」而非「疑似损坏」');
    ok(html.includes('interrupted: [\'源中断\', \'wait\']'), '状态映射含源中断');
    const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    ok(srv.includes('reason: info.reason'), '服务端透传健康原因');
    ok(storage.inspectAudio(dir, 'missing.mp3').reason.length >= 0, '缺失文件不抛异常');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

group('interrupted 是终态且保留每日重复', () => {
  const runtime = { setLastJobs() {}, bumpStats() {}, getLastJobs: () => [], clearLastJobs() {} };
  const stations = { get: () => null, list: () => [] };
  const mgr = new JobManager({
    config: {}, runtime, scheduler: {}, stations,
    tools: () => ({ ffmpeg: { found: false } }), log: () => {}, alert: () => {}
  });
  const job = {
    id: 'j_interrupted', label: '源中断任务', status: 'running',
    repeatDaily: true, mode: 'now', config: {}, createdAt: Date.now()
  };
  mgr.jobs.set(job.id, job);
  mgr.finish(job, 'interrupted');
  eq(job.status, 'interrupted', '任务进入源中断终态');
  eq(job.repeatDaily, true, '每日重复标志保留（主体已录到）');
  eq(mgr.live().length, 0, '不再算在途任务');
  eq(mgr.running().length, 0, '不再算运行中任务');
  eq(mgr.remove(job.id).ok, true, '源中断记录可以删除');

  const job2 = {
    id: 'j_failed', label: '失败任务', status: 'running',
    repeatDaily: true, mode: 'now', config: {}, createdAt: Date.now()
  };
  mgr.jobs.set(job2.id, job2);
  mgr.finish(job2, 'failed');
  eq(job2.repeatDaily, false, '真正失败仍停止每日重复');
});

console.log(`\nEMPTY_SEGMENT_CHAIN=PASS groups=${groups} checks=${checks}`);
