'use strict';

/*
 * FM990 / 上海 FM 广播录制台 v3 — 本地后端（零 npm 依赖，Node 18+）
 *
 *  v3: 多电台并行录制 · 上海 FM 电台库 · EPG 自动拉节目表 · 告警中心
 *      · HLS 内置引擎 · 分段无损合并 · 独立桌面窗口启动脚本
 *  v2: 定时节目单 · 磁盘水位与清理 · 日志持久化 · 服务重启断点续录
 *  v1: FFmpeg 命令包装 · 四种录制模式 · 静音/外放监听 · 内置零依赖直录
 *
 *  文件：config.json（录制参数）/ stations.json（电台库）/ runtime.json（节目单、策略、快照）
 *        epg-cache.json（节目表缓存）/ alerts.json（告警与通知策略）
 *        lib/{jobs,recorder,stations,epg,alerts,scheduler,storage,runtime}.js
 *        recordings/ 录制文件   logs/YYYY-MM-DD.log 按日落盘日志
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const runtime = require('./lib/runtime');
const scheduler = require('./lib/scheduler');
const storage = require('./lib/storage');
const stations = require('./lib/stations');
const epg = require('./lib/epg');
const alerts = require('./lib/alerts');
const { JobManager, MAX_PARALLEL, fmtDur, fmtTime } = require('./lib/jobs');
const { findMp3Start, fmtStamp, safePrefix } = require('./lib/recorder');
const selftest = require('./lib/selftest');
const planPrefix = require('./public/plan-prefix.js');

const ROOT = __dirname;
const STARTED_AT = Date.now();
const PUBLIC = path.join(ROOT, 'public');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 8787);
const EXE = process.platform === 'win32' ? '.exe' : '';
const VERSION = 3;

const DEFAULT_CONFIG = {
  ffmpegPath: '', ffplayPath: '',
  ffmpegHome: '',                  // v3.1.9：由 tools/install-ffmpeg.js 写入的安装目录（可为空）
  stationId: 'sh_news',
  streamUrl: 'https://lhttp-hw.qtfm.cn/live/270/64k.mp3',
  outputDir: path.join(ROOT, 'recordings'),
  filePrefix: 'FM990',
  segmentMinutes: 60,
  codec: 'copy',
  engine: 'ffmpeg',
  monitor: false, volume: 80,
  autoMonitor: false,          // v3.1.8：手动开始的新任务是否自动点亮监听（节目单任务除外）
  autoRestart: true,
  mode: 'now', durationMinutes: 0, hourlyHours: 1, hourlyAlign: 'fromNextHour',
  repeatDaily: false, rangeStart: '', rangeEnd: ''
};

let config = loadConfig();
const state = {
  ffmpeg: null, ffplay: null, checkedAt: 0,
  logs: [], logSeq: 0, healthCache: new Map(), cleanupCache: { at: 0, data: null },
  planTimer: null, cleanupTimer: null, epgTimer: null, persistTimer: null,
  lastFileCount: 0, lastDiskWarn: 0,
  epgRefresh: { running: false, done: 0, total: 0, errors: [], startedAt: 0 }
};

/* ------------------------------ helpers ------------------------------ */

function loadConfig() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch (e) { return Object.assign({}, DEFAULT_CONFIG); }
  const c = Object.assign({}, DEFAULT_CONFIG, saved);
  /* v3.1.8 迁移：旧「外放监听」是每次录音是否出声；新语义是「手动开新任务时自动点亮监听」。
     老 config.json 没有 autoMonitor 字段时，沿用旧开关的勾选状态，避免升级后用户设置悄悄丢失。 */
  if (!Object.prototype.hasOwnProperty.call(saved, 'autoMonitor') &&
      Object.prototype.hasOwnProperty.call(saved, 'monitor')) c.autoMonitor = !!saved.monitor;
  return c;
}
function saveConfig() {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8'); }
  catch (e) { pushLog('配置保存失败: ' + e.message); }
}
const pad = n => String(n).padStart(2, '0');
function stamp() { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }

function pushLog(text) {
  const line = `[${stamp()}] ${String(text).replace(/\r/g, '').trim()}`;
  state.logs.push(line);
  state.logSeq++;                       // 单调递增，供前端「清空显示」做基线切分
  if (state.logs.length > 300) state.logs.splice(0, state.logs.length - 300);
  runtime.appendLog(line);
}

function raise(type, level, message, jobId) {
  return alerts.raise(type, level, message, jobId, pushLog);
}

function getVersion(exe) {
  try { return (spawnSync(exe, ['-version'], { encoding: 'utf8', timeout: 3000, windowsHide: true }).stdout || '').split('\n')[0].trim().slice(0, 90); }
  catch (e) { return ''; }
}
/* v3.1.9：安装器会写 bin/ffmpeg-location.json（结构化安装记录）与 config.ffmpegHome。
   两者都作为候选路径参与探测，安装到自定义目录时也能被自动找到；文件不存在时静默跳过，
   保证「没有 ffmpeg → 内置引擎兜底」的原有行为完全不变。 */
function ffmpegLocation() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'bin', 'ffmpeg-location.json'), 'utf8')); }
  catch (e) { return null; }
}
function findExe(name, configured) {
  const c = [];
  if (configured) c.push(configured);
  const loc = ffmpegLocation();
  if (loc) {
    if (loc[name + 'Path']) c.push(loc[name + 'Path']);
    if (loc.ffmpegHome) c.push(path.join(loc.ffmpegHome, name + EXE), path.join(loc.ffmpegHome, 'bin', name + EXE));
  }
  if (config.ffmpegHome) c.push(path.join(config.ffmpegHome, name + EXE), path.join(config.ffmpegHome, 'bin', name + EXE));
  c.push(path.join(ROOT, 'bin', name + EXE), path.join(ROOT, 'bin', name),
    `C:/ffmpeg/bin/${name}${EXE}`,
    path.join(os.homedir(), 'scoop', 'apps', 'ffmpeg', 'current', 'bin', name + EXE),
    `C:/Program Files/ffmpeg/bin/${name}${EXE}`, `C:/tools/ffmpeg/bin/${name}${EXE}`,
    path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links', name + EXE));
  for (const d of (process.env.PATH || '').split(path.delimiter)) {
    if (d) c.push(path.join(d, name + EXE), path.join(d, name));
  }
  for (const p of c) {
    try { if (p && fs.existsSync(p) && fs.statSync(p).isFile()) return { found: true, path: p, version: getVersion(p) }; }
    catch (e) { /* keep looking */ }
  }
  return { found: false, path: null, version: null };
}
function detectTools(force) {
  if (!force && state.ffmpeg && Date.now() - state.checkedAt < 30000) return;
  const first = !state.ffmpeg;
  state.ffmpeg = findExe('ffmpeg', config.ffmpegPath);
  state.ffplay = findExe('ffplay', config.ffplayPath);
  state.checkedAt = Date.now();
  if (first || force) pushLog(`环境检测: ffmpeg ${state.ffmpeg.found ? 'OK ' + state.ffmpeg.path : '未找到'} | ffplay ${state.ffplay.found ? 'OK' : '未找到'}（内置引擎可独立工作）`);
}
function tools() { detectTools(false); return { ffmpeg: state.ffmpeg, ffplay: state.ffplay }; }
function quoteArg(a) { return /[\s"&|<>^]/.test(a) ? '"' + String(a).replace(/"/g, '\\"') + '"' : String(a); }

/* --------------------- stream format / quality check --------------------- */

function probeStream(url, seconds) {
  return new Promise(resolve => {
    const lib = url.startsWith('https:') ? require('https') : http;
    let chunks = [], total = 0, done = false, req = null;
    const timer = setTimeout(() => finish(), Math.max(2, Math.min(10, seconds || 4)) * 1000);
    function finish(err) {
      if (done) return;
      done = true; clearTimeout(timer);
      if (req) { try { req.destroy(); } catch (e) { /* ignore */ } }
      const buf = Buffer.concat(chunks);
      if (err && !buf.length) return resolve({ ok: false, message: err });
      const hit = findMp3Start(buf);
      const hls = /\.m3u8(\?|$)/i.test(url) && /^#EXTM3U/.test(buf.toString('utf8').trim());
      pushLog(`流格式自检: ${buf.length} 字节 → ${hit ? `MP3 ${hit.info.br} kbps / ${hit.info.sr} Hz` : hls ? 'HLS 播放列表（分片直录）' : '未识别到标准 MP3 帧'}`);
      resolve({
        ok: true, bytes: buf.length, head: buf.slice(0, 12).toString('hex'),
        found: !!hit || hls, hls,
        codec: hls ? 'HLS / MPEG-TS（分片音频由 ffmpeg 自动识别，通常为 AAC）'
          : hit ? `MPEG-${hit.info.ver === 3 ? 1 : 2} Layer III (MP3)` : '未识别',
        bitrate: hit ? hit.info.br : 0, samplerate: hit ? hit.info.sr : 0,
        prefixBytes: hit ? hit.offset : 0,
        note: hls ? 'HLS 直播：分片按序字节原样拼接为 .ts，或由 ffmpeg -c copy 直录，零二次损失。浏览器 <audio> 一般不支持 m3u8，试听请用 VLC。'
          : hit ? '标准 MP3 裸流：字节原样写入即零损失，无需重编码'
            : '未检测到标准 MP3 帧结构：直接写盘可能不可播放，建议换流地址或安装 ffmpeg'
      });
    }
    try {
      req = lib.get(url, { headers: { 'Icy-MetaData': '0', 'User-Agent': 'FM990-Recorder/3' } }, resp => {
        if ([301, 302, 303, 307, 308].includes(resp.statusCode) && resp.headers.location) {
          done = true; clearTimeout(timer); resp.resume();
          if (req) req.destroy();
          return probeStream(new URL(resp.headers.location, url).toString(), seconds).then(resolve);
        }
        if (resp.statusCode !== 200) { resp.resume(); return finish('HTTP ' + resp.statusCode); }
        resp.on('data', d => { chunks.push(d); total += d.length; if (total > 65536) finish(); });
        resp.on('end', () => finish());
        resp.on('error', e => finish(e.message));
      });
      req.setTimeout(8000, () => req.destroy(new Error('timeout')));
      req.on('error', e => finish(e.message));
    } catch (e) { finish(e.message); }
  });
}

/** Preview of the exact ffmpeg command line for the UI (no process started). */
function previewCommand(job) {
  const c = job.config;
  const isHlsIn = /\.m3u8(\?|$)/i.test(c.streamUrl || '');
  const args = ['-hide_banner', '-loglevel', 'info'];
  // 与 Recorder._startFfmpeg 保持一致：HLS 流不下发 reconnect 参数（分片 EOF 会触发无限重连）
  if (!isHlsIn) args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_at_eof', '1',
    '-reconnect_delay_max', '10', '-rw_timeout', '10000000');
  args.push('-i', c.streamUrl, '-vn');
  if (c.codec === 'mp3_64') args.push('-c:a', 'libmp3lame', '-b:a', '64k');
  else if (c.codec === 'mp3_128') args.push('-c:a', 'libmp3lame', '-b:a', '128k');
  else args.push('-c:a', 'copy');
  const t = Math.ceil(job.durationSec);
  if (t > 0) args.push('-t', String(t));
  const ext = /\.m3u8(\?|$)/i.test(c.streamUrl) ? '.ts' : '.mp3';
  const seg = Math.max(0, Number(c.segmentMinutes || 0));
  let out;
  if (seg > 0) {
    args.push('-f', 'segment', '-segment_time', String(Math.round(seg * 60)), '-reset_timestamps', '1');
    if (ext === '.mp3') args.push('-segment_format_options', 'id3v2_version=0');
    out = path.join(c.outputDir, `${safePrefix(c.filePrefix)}_${fmtStamp(new Date())}_%04d${ext}`);
  } else {
    if (ext === '.mp3') args.push('-id3v2_version', '0');   // 纯 MP3 帧流，便于无损合并
    out = path.join(c.outputDir, `${safePrefix(c.filePrefix)}_${fmtStamp(new Date())}${ext}`);
  }
  args.push('-flush_packets', '1');   // 每个音频包立刻落盘
  args.push('-y', out);
  const exe = (state.ffmpeg && state.ffmpeg.path) || 'ffmpeg';
  const builtinNote = (c.engine === 'builtin' || (c.engine === 'ffmpeg' && !state.ffmpeg.found))
    ? '  # 本机未装 ffmpeg → 实际使用内置直录引擎，字节原样写盘（等价 -c copy）' : '';
  return `${quoteArg(exe)} ${args.map(quoteArg).join(' ')}${builtinNote}`;
}

/* ------------------------------ manager ------------------------------ */

const manager = new JobManager({
  config, runtime, scheduler, stations,
  tools, log: pushLog, alert: raise
});

/* ------------------------------- files ------------------------------- */

function currentDir() { return config.outputDir; }

/* --------------------- 可视化选择保存目录（只读浏览） ---------------------
 * 不依赖系统文件对话框：嵌入式预览面板 / --app 窗口都能用。
 * 只列子目录，绝不改动或删除任何已有文件。 */
function isWritableDir(dir) {
  try { fs.accessSync(dir, fs.constants.W_OK); return true; } catch (e) { return false; }
}
function browseShortcuts() {
  const out = [];
  const push = (name, p) => { try { if (p && fs.existsSync(p) && fs.statSync(p).isDirectory()) out.push({ name, path: p }); } catch (e) { /* ignore */ } };
  push('程序目录', ROOT);
  push('当前录制目录', path.resolve(config.outputDir || ROOT));
  const home = os.homedir();
  push('桌面', path.join(home, 'Desktop'));
  push('下载', path.join(home, 'Downloads'));
  push('文档', path.join(home, 'Documents'));
  if (process.platform === 'win32') {
    for (let c = 65; c <= 90; c++) {
      const root = String.fromCharCode(c) + ':\\';
      try { if (fs.existsSync(root)) out.push({ name: '磁盘 ' + root, path: root }); } catch (e) { /* ignore */ }
    }
  } else push('根目录 /', '/');
  return out;
}
function browseDir(raw, checkOnly) {
  const target = path.resolve(String(raw || '').trim() || config.outputDir || ROOT);
  let stat;
  try { stat = fs.statSync(target); } catch (e) { return { ok: false, message: '目录不存在或无法访问：' + e.message }; }
  if (!stat.isDirectory()) return { ok: false, message: '这不是一个文件夹：' + target };
  const base = {
    ok: true, path: target, parent: path.dirname(target),
    root: path.parse(target).root, writable: isWritableDir(target),
    shortcuts: browseShortcuts()
  };
  if (checkOnly) return base;
  try {
    const entries = fs.readdirSync(target, { withFileTypes: true })
      .filter(d => (d.isDirectory() || d.isSymbolicLink()) && !/^[.$]/.test(d.name))
      .map(d => ({ name: d.name, path: path.join(target, d.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
      .slice(0, 500);
    return Object.assign(base, { entries });
  } catch (e) { return Object.assign(base, { entries: [], warning: '部分子目录无法列出：' + e.message }); }
}

/** Delete one or many audio files. Active (being written) files are protected. */
function deleteFiles(names) {
  const dir = path.resolve(currentDir());
  const active = new Set(manager.activeFiles());
  const deleted = [], errors = [];
  let bytes = 0;
  for (const raw of (Array.isArray(names) ? names : [names])) {
    const name = path.basename(String(raw || ''));
    const file = path.resolve(dir, name);
    if (!name || !file.startsWith(dir + path.sep)) { errors.push({ name, message: '非法路径' }); continue; }
    if (!storage.AUDIO_EXT.has(path.extname(name).toLowerCase())) { errors.push({ name, message: '不是受支持的音频文件' }); continue; }
    if (active.has(name)) { errors.push({ name, message: '正在写入，请先停止对应任务' }); continue; }
    try {
      const st = fs.statSync(file);
      if (!st.isFile()) throw new Error('不是普通文件');
      fs.unlinkSync(file);
      deleted.push(name); bytes += st.size;
    } catch (e) {
      // Windows keeps an open ffmpeg output file locked: EPERM/EBUSY looks like
      // a mystery to the user, so translate it into an actionable hint.
      let message = e.message;
      if (['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(e.code) || /being used|permission|locked/i.test(e.message)) {
        message = `文件被录制进程或其他程序占用，请先停止对应任务再删除（${e.code || '占用'}）`;
      } else if (e.code === 'ENOENT') {
        message = '文件已不存在';
      }
      errors.push({ name, message });
    }
  }
  if (deleted.length) { state.healthCache.clear(); state.cleanupCache = { at: 0, data: null }; }
  return { deleted, errors, bytes };
}

/** Lossless MP3 concatenation: raw frames appended byte-for-byte, no decode. */
async function mergeFiles(names, outName) {
  const dir = path.resolve(currentDir());
  const active = new Set(manager.activeFiles());
  const clean = (names || []).map(n => path.basename(String(n)));
  if (clean.length < 2) return { ok: false, message: '请至少选择 2 个分段' };
  if (clean.length > 100) return { ok: false, message: '一次最多合并 100 个分段' };
  if (!clean.every(n => /\.mp3$/i.test(n))) return { ok: false, message: '目前只支持合并 .mp3 分段' };
  for (const n of clean) {
    const f = path.resolve(dir, n);
    if (!f.startsWith(dir + path.sep) || !fs.existsSync(f)) return { ok: false, message: '文件不存在: ' + n };
    if (active.has(n)) return { ok: false, message: '不能合并正在写入的文件: ' + n };
  }
  const out = outName || `MERGE_${fmtStamp(new Date())}.mp3`;
  const dest = path.resolve(dir, path.basename(out));
  try {
    const ws = fs.createWriteStream(dest);
    for (const n of clean) {
      const rs = fs.createReadStream(path.resolve(dir, n));
      for await (const chunk of rs) {
        if (!ws.write(chunk)) await new Promise(r => ws.once('drain', r));
      }
    }
    await new Promise((resolve, reject) => { ws.end(resolve); ws.once('error', reject); });
    const size = fs.statSync(dest).size;
    state.healthCache.clear();
    return { ok: true, name: path.basename(dest), size };
  } catch (e) {
    try { fs.unlinkSync(dest); } catch (e2) { /* ignore */ }
    return { ok: false, message: e.message };
  }
}

function listFiles() {
  const dir = currentDir();
  const now = Date.now();
  const active = new Set(manager.activeFiles());
  return storage.audioFiles(dir).map(f => {
    const writing = active.has(f.name) || (!active.size && (now - f.mtime) < storage.SKIP_RECENT_MS);
    const deletable = !active.has(f.name);
    if (writing) return Object.assign({}, f, { healthy: null, durationSec: 0, writing: true, deletable });
    const key = `${f.name}|${f.size}|${Math.floor(f.mtime / 1000)}`;
    let info = state.healthCache.get(key);
    if (!info) {
      info = storage.inspectAudio(dir, f.name);
      if (state.healthCache.size > 400) state.healthCache.clear();
      state.healthCache.set(key, info);
    }
    return Object.assign({}, f, {
      healthy: info.healthy, durationSec: info.durationSec || 0,
      bitrate: info.bitrate || 0, codec: info.codec || '', reason: info.reason || '',
      writing: false, deletable
    });
  }).slice(0, 200);
}

function cleanupPreview(force) {
  if (!force && state.cleanupCache.data && Date.now() - state.cleanupCache.at < 20000) return state.cleanupCache.data;
  const active = new Set(manager.activeFiles());
  const data = storage.computeClean(currentDir(), runtime.get().cleanup, active, Date.now());
  state.cleanupCache = { at: Date.now(), data };
  return data;
}

/**
 * v3.1.10：节目单保存前统一校正前缀。
 * 只返回规整后的新对象，绝不修改 / 删除 runtime.json 里已有的节目单；
 * 「显式自定义前缀」是唯一允许不跟随频率的情况。
 */
function normalizePlanForSave(raw, action) {
  const list = stations.list();
  const info = planPrefix.explain(raw, list, config.filePrefix);
  const plan = planPrefix.normalizePlan(raw, list, config.filePrefix);
  const before = planPrefix.cleanPrefix(raw && raw.filePrefix);
  if (info.changed && info.expected) {
    pushLog(`节目单前缀按电台校正：${before || '(空)'} → ${plan.filePrefix}（${info.stationName}｜${action}）`);
  }
  if (info.inferredStation) {
    pushLog(`节目单「${raw.name || ''}」按流地址识别电台：${info.stationName} → 前缀 ${plan.filePrefix}`);
  }
  if (!info.expected) {
    pushLog(`节目单「${raw.name || ''}」未能识别电台，前缀沿用 ${plan.filePrefix}（可选电台或勾选自定义前缀）`);
  }
  return plan;
}

function plansPayload() {
  const now = Date.now();
  const list = stations.list();
  return runtime.listPlans().map(p => {
    const n = scheduler.nextFire(p, now);
    const st = p.stationId ? stations.get(p.stationId) : null;
    /* 只读派生的「有效前缀」：即使磁盘上是旧值，UI 与实际录制都按这个来。 */
    const info = planPrefix.explain(p, list, config.filePrefix);
    return Object.assign({}, p, {
      ruleText: scheduler.describe(p), nextFire: n,
      nextText: n ? scheduler.fmtAt(n) : '无后续触发',
      triggeredToday: runtime.wasTriggered(p.id, scheduler.dateKey(new Date(now))),
      stationName: st ? st.name : (p.stationId ? '未知电台' : (info.stationName ? info.stationName + '（按流地址识别）' : '当前默认')),
      effectivePrefix: info.filePrefix,
      prefixMode: info.prefixMode,
      prefixExpected: info.expected,
      prefixFixed: info.changed && !!info.expected,
      prefixMatchedBy: info.matchedBy,
      prefixInferredStation: info.inferredStation
    });
  });
}

/* --------------------------- automation loops --------------------------- */

function tickPlans() {
  const now = Date.now();
  for (const plan of runtime.listPlans()) {
    if (!plan.enabled) continue;
    const due = scheduler.duePlan(plan, now);
    if (!due || runtime.wasTriggered(plan.id, due.key)) continue;
    runtime.markTriggered(plan.id, due.key);
    manager.firePlan(plan);
  }
}

function tickCleanup() {
  const policy = runtime.get().cleanup;
  const active = new Set(manager.activeFiles());
  const clean = storage.computeClean(currentDir(), policy, active, Date.now());
  const minFree = Number(policy.minFreeGB) * 1073741824;
  if (clean.disk.valid && minFree > 0 && clean.disk.free < minFree && Date.now() - state.lastDiskWarn > 86400000) {
    state.lastDiskWarn = Date.now();
    const msg = `磁盘可用 ${(clean.disk.free / 1073741824).toFixed(1)} GiB 低于下限 ${policy.minFreeGB} GiB` +
      (policy.enabled ? '，按保留策略自动清理' : '（自动清理未启用，请在「存储与清理」里手动处理）');
    pushLog('⚠ ' + msg);
    raise('disk', 'warn', msg);
  }
  if (!policy.enabled || !clean.candidates.length) return clean;
  const r = storage.executeClean(currentDir(), clean.candidates.map(c => c.name));
  if (r.deleted.length) {
    pushLog(`自动清理：删除 ${r.deleted.length} 个旧文件，释放 ${(r.bytes / 1048576).toFixed(1)} MiB；原因：${clean.candidates[0].reason}`);
    runtime.bumpStats({ cleanups: 1, bytesDeleted: r.bytes });
    state.healthCache.clear();
    state.cleanupCache = { at: 0, data: null };
  }
  r.errors.forEach(e => pushLog('自动清理跳过 ' + e.name + ': ' + e.message));
  return clean;
}

/** Refresh EPG for every Shanghai FM station (sequential, non-blocking for HTTP). */
async function refreshAllEpg() {
  if (state.epgRefresh.running) return { ok: false, message: '节目表正在刷新中' };
  const list = stations.list().filter(s => s.channelId);
  state.epgRefresh = { running: true, done: 0, total: list.length, errors: [], startedAt: Date.now() };
  for (const s of list) {
    try {
      const r = await epg.refresh(s.channelId, s.id);
      if (!r.ok) state.epgRefresh.errors.push(`${s.name}: ${r.message}`);
    } catch (e) { state.epgRefresh.errors.push(`${s.name}: ${e.message}`); }
    state.epgRefresh.done++;
  }
  pushLog(`EPG 自动刷新完成：成功 ${state.epgRefresh.done - state.epgRefresh.errors.length}/${state.epgRefresh.total} 个电台` +
    (state.epgRefresh.errors.length ? `，失败 ${state.epgRefresh.errors.length} 个` : ''));
  if (state.epgRefresh.errors.length >= state.epgRefresh.total) {
    raise('plan', 'warn', 'EPG 节目表源全部拉取失败，界面将使用内置静态节目表');
  }
  state.epgRefresh.running = false;
  return { ok: true, errors: state.epgRefresh.errors };
}

/* --------------------------- test utilities --------------------------- */

function runProcess(exe, args, timeoutMs) {
  return new Promise(resolve => {
    let out = '', err = '', done = false, child = null;
    const finish = (ok, message) => {
      if (done) return;
      done = true; clearTimeout(timer);
      resolve({ ok, message: message || '', stdout: out.trim(), stderr: err.trim() });
    };
    const timer = setTimeout(() => { if (child) { try { child.kill(); } catch (e) { /* ignore */ } } finish(false, '执行超时'); }, timeoutMs || 30000);
    try { child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return finish(false, e.message); }
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => finish(false, e.message));
    child.on('close', code => finish(code === 0, code === 0 ? '' : `退出码 ${code}: ${err.trim().slice(0, 240)}`));
  });
}

/** Capture a few seconds of the live stream into a file using the builtin engine. */
function captureBuiltinSample(url, dest, seconds) {
  return new Promise(resolve => {
    const lib = String(url).startsWith('https:') ? require('https') : http;
    let chunks = [], done = false, req = null;
    const timer = setTimeout(() => finish(), (seconds || 6) * 1000);
    function finish(errMsg) {
      if (done) return;
      done = true; clearTimeout(timer);
      if (req) { try { req.destroy(); } catch (e) { /* ignore */ } }
      const buf = Buffer.concat(chunks);
      if (errMsg && !buf.length) return resolve({ ok: false, message: errMsg });
      const hit = findMp3Start(buf);
      const payload = hit ? buf.slice(hit.offset) : buf;
      try {
        fs.writeFileSync(dest, payload);
        resolve({ ok: payload.length > 0, message: payload.length ? '' : '未收到数据',
          bytes: payload.length, aligned: !!hit, head: payload.slice(0, 4).toString('hex') });
      } catch (e) { resolve({ ok: false, message: e.message }); }
    }
    try {
      req = lib.get(url, { headers: { 'Icy-MetaData': '0', 'User-Agent': 'FM990-Recorder/3' } }, resp => {
        if ([301, 302, 303, 307, 308].includes(resp.statusCode) && resp.headers.location) {
          resp.resume();
          try { req.destroy(); } catch (e) { /* ignore */ }
          done = true; clearTimeout(timer);
          return captureBuiltinSample(new URL(resp.headers.location, url).toString(), dest, seconds).then(resolve);
        }
        if (resp.statusCode !== 200) { resp.resume(); return finish('HTTP ' + resp.statusCode); }
        resp.on('data', d => { chunks.push(d); });
        resp.on('end', () => finish());
        resp.on('error', e => finish(e.message));
      });
      req.setTimeout(10000, () => req.destroy(new Error('连接超时')));
      req.on('error', e => finish(e.message));
    } catch (e) { finish(e.message); }
  });
}

/** Real 6-second test recording. Produces TEST_*.mp3 (deletable from the UI). */
async function testRecord(engine) {
  const dir = path.resolve(currentDir());
  try { fs.mkdirSync(dir, { recursive: true }); }
  catch (e) { return { ok: false, message: '输出目录不可写：' + e.message }; }
  const isHls = /\.m3u8(\?|$)/i.test(config.streamUrl || '');
  const name = `TEST_${fmtStamp(new Date())}${isHls ? '.ts' : '.mp3'}`;
  const dest = path.join(dir, name);
  const ff = tools().ffmpeg;
  const useFfmpeg = engine === 'ffmpeg' ? true : engine === 'builtin' ? false : !!ff.found;
  if (useFfmpeg && !ff.found) return { ok: false, message: '未找到 ffmpeg，请改用内置引擎试录' };
  let r;
  if (useFfmpeg) {
    const args = ['-hide_banner', '-loglevel', 'error'];
    // HLS 与正式录制一致：不下发 reconnect、不写 ID3、容器用 .ts（AAC 原样 copy）
    if (!isHls) args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_at_eof', '1',
      '-reconnect_delay_max', '5', '-rw_timeout', '10000000');
    args.push('-i', config.streamUrl, '-t', '6', '-vn', '-c:a', 'copy');
    if (!isHls) args.push('-id3v2_version', '0');
    args.push('-y', dest);
    r = await runProcess(ff.path, args, 30000);
    if (!r.ok) r = { ok: false, message: 'ffmpeg 试录失败：' + r.message };
  } else {
    r = await captureBuiltinSample(config.streamUrl, dest, 6);
    if (!r.ok) r = { ok: false, message: '内置引擎试录失败：' + r.message };
  }
  if (!r.ok) { try { fs.unlinkSync(dest); } catch (e) { /* ignore */ } return r; }
  try {
    const size = fs.statSync(dest).size;
    if (size < 1024) { fs.unlinkSync(dest); return { ok: false, message: `只录到 ${size} 字节，疑似流不可达` }; }
    const fd = fs.openSync(dest, 'r');
    const head = Buffer.alloc(Math.min(size, 16384));
    fs.readSync(fd, head, 0, head.length, 0); fs.closeSync(fd);
    const hit = findMp3Start(head);
    const kbps = hit ? hit.info.br : 0, sr = hit ? hit.info.sr : 0;
    pushLog(`试录完成：${name} · ${(size / 1024).toFixed(1)} KiB · 引擎 ${useFfmpeg ? 'ffmpeg' : 'builtin'}` +
      (hit ? ` · MP3 ${kbps} kbps / ${sr} Hz 帧对齐` : ' · 未识别到 MP3 帧'));
    state.healthCache.clear(); state.cleanupCache = { at: 0, data: null };
    return { ok: true, name, size, engine: useFfmpeg ? 'ffmpeg' : 'builtin',
      head: head.slice(0, 4).toString('hex'), frameAligned: !!hit, bitrate: kbps, samplerate: sr,
      durationSec: kbps ? +(size * 8 / (kbps * 1000)).toFixed(1) : 0,
      note: '该文件仅用于验证链路，可在「录制文件」里删除，或点「清理测试文件」' };
  } catch (e) { return { ok: false, message: e.message }; }
}

/* -------------------------------- HTTP -------------------------------- */

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function json(res, obj, code) {
  const body = JSON.stringify(obj);
  res.writeHead(code || 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function readBody(req) {
  return new Promise(resolve => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 200000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch (e) { resolve({}); } });
  });
}

function statusPayload() {
  detectTools(false);
  const files = listFiles();
  const totalBytes = files.reduce((s, f) => s + f.size, 0);
  const jobs = manager.list();                       // serialized jobs (include metrics)
  const live = jobs.filter(j => ['running', 'stopping', 'scheduled'].includes(j.status));
  const runningJobs = jobs.filter(j => j.status === 'running');
  const primary = live[0] || jobs[0] || null;
  if (manager.running().length && files.length > state.lastFileCount) {
    pushLog(`已生成新分段，当前共 ${files.length} 个文件，累计 ${(totalBytes / 1048576).toFixed(1)} MiB`);
  }
  state.lastFileCount = files.length;
  const clean = cleanupPreview();
  const plans = plansPayload();
  const nextPlan = plans.filter(p => p.enabled && p.nextFire).sort((a, b) => a.nextFire - b.nextFire)[0];
  return {
    serverTime: Date.now(), version: VERSION, maxParallel: MAX_PARALLEL,
    server: { pid: process.pid, port: PORT, host: HOST, startedAt: STARTED_AT,
      uptimeSec: (Date.now() - STARTED_AT) / 1000, node: process.version,
      ffmpegPath: state.ffmpeg.path || '', launch: 'start.bat / desktop.bat' },
    ffmpeg: state.ffmpeg, ffplay: state.ffplay,
    jobs, job: primary, running: manager.running().length > 0,
    runningCount: manager.running().length,
    elapsedSec: primary ? primary.elapsedSec : 0,
    remainingSec: primary ? primary.remainingSec : 0,
    files, totalBytes,
    logs: state.logs.slice(-150), logSeq: state.logSeq,
    restartCount: jobs.reduce((s, j) => s + (j.metrics.restartCount || 0), 0),
    monitorOn: !!config.autoMonitor,
    engine: (runningJobs[0] && runningJobs[0].metrics && runningJobs[0].metrics.engine) || (state.ffmpeg.found ? 'ffmpeg' : 'builtin'),
    outputDir: currentDir(),
    installHint: 'winget install --id Gyan.FFmpeg -e',
    disk: clean.disk,
    plans, cleanup: runtime.get().cleanup,
    cleanupPending: clean.candidates.length, cleanupPendingBytes: clean.freed, cleanupSkipped: clean.skippedActive,
    nextPlanText: nextPlan ? `${nextPlan.name} · ${nextPlan.nextText}` : '',
    logDates: runtime.listLogDates(), stats: runtime.get().stats,
    stations: stations.list(),
    alerts: { unread: alerts.unread(), recent: alerts.list(6), policy: alerts.getPolicy() },
    epg: { refresh: state.epgRefresh, cache: epg.cacheInfo() }
  };
}

/* 停止指令下发后，ffmpeg 收到 'q' 才优雅收尾；若子进程不响应，
 * Recorder 自身 3 秒后会强杀。这里再加一层 5 秒兜底：任何仍卡在
 * stopping 的任务一律终止子进程并落到终态，保证「全部停止」不会假停。 */
function guardStoppingJobs() {
  const t = setTimeout(() => {
    for (const j of manager.live().filter(x => x.status === 'stopping')) {
      try { if (j._recorder) j._recorder.abort(); } catch (e) { /* ignore */ }
      manager.finish(j, 'cancelled');
      pushLog(`停止兜底：任务「${j.label}」未自行收尾，已强制结束`);
    }
  }, 5000);
  if (t.unref) t.unref();
}

async function handleApi(req, res, url) {
  const p = url.pathname, method = req.method;

  /* -------------------------- 上海 FM 电台库 -------------------------- */
  if (p === '/api/stations' && method === 'GET') {
    return json(res, { stations: stations.list(), epgSource: epg.refreshUrl });
  }
  if (p === '/api/stations/add' && method === 'POST') {
    const body = await readBody(req);
    const r = stations.add(body.station || body);
    if (r.ok) pushLog('新增电台：' + r.station.name + ' / ' + r.station.freq);
    return json(res, Object.assign(r, { stations: stations.list() }));
  }
  if (p === '/api/stations/update' && method === 'POST') {
    const body = await readBody(req);
    const r = stations.update(String(body.id || ''), body.station || body);
    if (r.ok) pushLog('更新电台：' + r.station.name);
    return json(res, Object.assign(r, { stations: stations.list() }));
  }
  if (p === '/api/stations/delete' && method === 'POST') {
    const body = await readBody(req);
    const r = stations.remove(String(body.id || ''));
    if (r.ok) pushLog('删除电台 ' + body.id);
    return json(res, Object.assign(r, { stations: stations.list() }));
  }
  if (p === '/api/stations/probe' && method === 'POST') {
    const body = await readBody(req);
    const r = await stations.probe(body.url || '', Number(body.ms || 2500));
    return json(res, Object.assign({ url: body.url || '' }, r));
  }

  /* ----------------------------- EPG 节目表 ----------------------------- */
  if (p === '/api/epg' && method === 'GET') {
    const sid = url.searchParams.get('stationId') || config.stationId;
    const s = stations.get(sid) || stations.list()[0];
    if (!s) return json(res, { ok: false, message: '电台库为空' });
    const day = url.searchParams.get('date') || '';
    return json(res, Object.assign({ stationId: s.id, stationName: s.name, freq: s.freq },
      epg.getDay(s.id, s.channelId, day)));
  }
  if (p === '/api/epg/refresh' && method === 'POST') {
    const body = await readBody(req);
    if (body.stationId) {
      const s = stations.get(body.stationId);
      if (!s) return json(res, { ok: false, message: '电台不存在' });
      const r = await epg.refresh(s.channelId, s.id);
      if (r.ok) pushLog(`EPG 已刷新：${s.name}（今日 ${(r.days[epg.dateKey(new Date())] || []).length} 档节目）`);
      else pushLog(`EPG 刷新失败：${s.name} - ${r.message}`);
      return json(res, r);
    }
    refreshAllEpg().catch(e => pushLog('EPG 刷新异常: ' + e.message));
    return json(res, { ok: true, started: true, total: state.epgRefresh.total });
  }
  if (p === '/api/epg/status' && method === 'GET') {
    return json(res, { refresh: state.epgRefresh, cache: epg.cacheInfo() });
  }
  if (p === '/api/epg/to-plan' && method === 'POST') {
    const body = await readBody(req);
    const s = stations.get(body.stationId);
    if (!s) return json(res, { ok: false, message: '电台不存在' });
    const prog = body.programme || {};
    if (!prog.start || !prog.title) return json(res, { ok: false, message: '节目信息不完整' });
    const v = scheduler.validatePlan(epg.toPlan(prog, s, body.rule));
    if (!v.ok) return json(res, { ok: false, message: v.message });
    const plan = runtime.addPlan(normalizePlanForSave(v.plan, 'EPG 加入'));
    pushLog(`EPG → 节目单：${plan.name}（${scheduler.describe(plan)}）`);
    return json(res, { ok: true, plan, plans: plansPayload() });
  }

  /* ----------------------------- 告警中心 ----------------------------- */
  if (p === '/api/alerts' && method === 'GET') {
    return json(res, { events: alerts.list(60), unread: alerts.unread(), policy: alerts.getPolicy() });
  }
  if (p === '/api/alerts/policy' && method === 'POST') {
    const body = await readBody(req);
    return json(res, { ok: true, policy: alerts.setPolicy(body) });
  }
  if (p === '/api/alerts/read' && method === 'POST') {
    const body = await readBody(req);
    if (body.all) alerts.markAllRead(); else alerts.markRead(body.id);
    return json(res, { ok: true, unread: alerts.unread() });
  }
  if (p === '/api/alerts/clear' && method === 'POST') {
    alerts.clear();
    return json(res, { ok: true });
  }
  if (p === '/api/alerts/test' && method === 'POST') {
    const body = await readBody(req);
    const ev = { level: 'info', type: 'info', message: 'FM990 录制台测试消息（可忽略）', at: Date.now() };
    const policy = alerts.getPolicy();
    if (body.url) policy.webhookUrl = body.url;
    if (!policy.webhookUrl) return json(res, { ok: false, message: '请先填写 Webhook 地址' });
    const r = await alerts.sendWebhook(alerts.buildBody('test', policy, ev));
    return json(res, r);
  }

  /* ---------------------------- 并行任务控制 ---------------------------- */
  if (p === '/api/jobs' && method === 'GET') return json(res, { jobs: manager.list(), maxParallel: MAX_PARALLEL });

  if (p === '/api/start' && method === 'POST') {
    const body = await readBody(req);
    const mode = body.mode || config.mode;
    try {
      const overrides = {};
      if (body.stationId) {
        const s = stations.get(body.stationId);
        if (!s) return json(res, { ok: false, message: '电台不存在' });
        overrides.stationId = s.id;
        overrides.streamUrl = s.url;
        overrides.filePrefix = stations.prefixFor(s);
      }
      const job = manager.create(mode, overrides);
      const conflict = manager.conflictFor(job.config);
      if (conflict) return json(res, { ok: false, message: `该电台已有任务「${conflict.label}」在运行；如需重开请先停止它` });
      if (manager.live().length >= MAX_PARALLEL) return json(res, { ok: false, message: `并行任务已达上限 ${MAX_PARALLEL}` });
      manager.schedule(job);
      return json(res, { ok: true, job: manager.publicJob(job), jobs: manager.list() });
    } catch (e) { return json(res, { ok: false, message: e.message }); }
  }
  if (p === '/api/stop' && method === 'POST') {
    const body = await readBody(req);
    let r;
    if (body.id) r = manager.stop(String(body.id), body.reason || 'cancelled');
    else {
      const live = manager.live();
      if (!live.length) return json(res, { ok: false, message: '当前没有任务' });
      r = manager.stop(live[0].id, 'cancelled');
    }
    if (r.ok) guardStoppingJobs();
    return json(res, Object.assign({}, r, { jobs: manager.list() }));
  }
  if (p === '/api/stop-all' && method === 'POST') {
    const r = manager.stopAll('cancelled');
    guardStoppingJobs();
    return json(res, Object.assign({}, r, { jobs: manager.list() }));
  }

  /** 删除已结束任务记录（不删磁盘音频）。支持 {id} / {ids:[...]} / {all:true}。 */
  if (p === '/api/jobs/delete' && method === 'POST') {
    const body = await readBody(req);
    let r;
    if (body.all === true) r = manager.clearFinished();
    else if (Array.isArray(body.ids)) {
      const removed = [];
      for (const id of body.ids) {
        const one = manager.remove(String(id));
        if (one.ok) removed.push(...one.removed);
      }
      r = { ok: removed.length > 0, removed, count: removed.length };
      if (!removed.length) r.message = '没有可删除的已结束任务';
    } else r = manager.remove(String(body.id || ''));
    return json(res, Object.assign({}, r, { jobs: manager.list() }));
  }

  /* --------------------------- 节目单（v2） --------------------------- */
  if (p === '/api/plans' && method === 'GET') {
    return json(res, { plans: plansPayload(), rules: scheduler.RULES, week: scheduler.WEEK, stations: stations.list() });
  }
  if (p === '/api/plans/add' && method === 'POST') {
    const body = await readBody(req);
    const v = scheduler.validatePlan(body.plan || body);
    if (!v.ok) return json(res, { ok: false, message: v.message });
    const plan = runtime.addPlan(normalizePlanForSave(v.plan, '新增'));
    pushLog(`新增节目单：${plan.name}（${scheduler.describe(plan)}）｜前缀 ${plan.filePrefix}`);
    return json(res, { ok: true, plan, plans: plansPayload() });
  }
  if (p === '/api/plans/update' && method === 'POST') {
    const body = await readBody(req);
    const v = scheduler.validatePlan(body.plan || body);
    if (!v.ok) return json(res, { ok: false, message: v.message });
    const plan = runtime.updatePlan(String(body.id || v.plan.id || ''), normalizePlanForSave(v.plan, '更新'));
    if (!plan) return json(res, { ok: false, message: '节目单不存在' });
    pushLog(`更新节目单：${plan.name}｜前缀 ${plan.filePrefix}`);
    return json(res, { ok: true, plan, plans: plansPayload() });
  }
  if (p === '/api/plans/toggle' && method === 'POST') {
    const body = await readBody(req);
    const plan = runtime.updatePlan(String(body.id || ''), { enabled: !!body.enabled });
    if (!plan) return json(res, { ok: false, message: '节目单不存在' });
    pushLog(`节目单「${plan.name}」已${plan.enabled ? '启用' : '停用'}`);
    return json(res, { ok: true, plans: plansPayload() });
  }
  if (p === '/api/plans/delete' && method === 'POST') {
    const body = await readBody(req);
    const ok = runtime.removePlan(String(body.id || ''));
    if (!ok) return json(res, { ok: false, message: '节目单不存在' });
    pushLog('已删除节目单 ' + body.id);
    return json(res, { ok: true, plans: plansPayload() });
  }
  if (p === '/api/plans/fire' && method === 'POST') {
    const body = await readBody(req);
    const plan = runtime.listPlans().find(x => x.id === String(body.id || ''));
    if (!plan) return json(res, { ok: false, message: '节目单不存在' });
    const r = manager.firePlan(plan);
    runtime.markTriggered(plan.id, scheduler.dateKey(new Date()));
    return json(res, r);
  }

  /* ------------------------- 磁盘 & 保留策略 ------------------------- */
  if (p === '/api/cleanup/policy' && method === 'POST') {
    const body = await readBody(req);
    runtime.patch(d => {
      if (Object.prototype.hasOwnProperty.call(body, 'enabled')) d.cleanup.enabled = !!body.enabled;
      if (Object.prototype.hasOwnProperty.call(body, 'retentionDays')) d.cleanup.retentionDays = Math.max(1, Math.min(3650, Number(body.retentionDays) || 90));
      if (Object.prototype.hasOwnProperty.call(body, 'maxTotalGB')) d.cleanup.maxTotalGB = Math.max(0, Number(body.maxTotalGB) || 0);
      if (Object.prototype.hasOwnProperty.call(body, 'minFreeGB')) d.cleanup.minFreeGB = Math.max(0, Number(body.minFreeGB) || 0);
    });
    state.cleanupCache = { at: 0, data: null };
    pushLog('清理策略已更新: ' + JSON.stringify(runtime.get().cleanup));
    return json(res, { ok: true, cleanup: runtime.get().cleanup });
  }
  if (p === '/api/cleanup/preview' && method === 'GET') {
    const c = cleanupPreview(true);
    state.cleanupCache = { at: 0, data: null };
    return json(res, { ok: true, disk: c.disk, totalBytes: c.totalBytes, fileCount: c.fileCount,
      skippedActive: c.skippedActive, freed: c.freed, candidates: c.candidates.slice(0, 200), policy: c.policy });
  }
  if (p === '/api/cleanup/run' && method === 'POST') {
    const body = await readBody(req);
    if (body.confirm !== true) return json(res, { ok: false, message: '需要显式确认才能删除文件' });
    const allowed = new Set(cleanupPreview(true).candidates.map(c => c.name));
    const names = (Array.isArray(body.names) ? body.names : Array.from(allowed)).filter(n => allowed.has(n));
    if (!names.length) return json(res, { ok: true, deleted: [], bytes: 0, errors: [], message: '没有符合清理条件的文件' });
    const r = storage.executeClean(currentDir(), names);
    state.healthCache.clear(); state.cleanupCache = { at: 0, data: null };
    if (r.deleted.length) {
      pushLog(`手动清理：删除 ${r.deleted.length} 个文件，释放 ${(r.bytes / 1048576).toFixed(1)} MiB`);
      runtime.bumpStats({ cleanups: 1, bytesDeleted: r.bytes });
    }
    return json(res, Object.assign({ ok: true }, r));
  }

  /* ------------------------------ 日志 ------------------------------ */
  if (p === '/api/logs/history' && method === 'GET') {
    const date = url.searchParams.get('date') || runtime.dateKey(new Date());
    return json(res, { date, text: runtime.readLog(date), dates: runtime.listLogDates() });
  }
  /* v3.1.4: 「清空显示」改成纯前端行为。此接口仅保留给可能存在的旧缓存页面，
   * 绝不再清空内存日志（磁盘 logs/*.log 本来也不会被清）。 */
  if (p === '/api/logs/clear' && method === 'POST') {
    return json(res, { ok: true, noop: true, logSeq: state.logSeq,
      note: '日志不再由服务端清空；请在界面点「显示全部」恢复显示' });
  }

  /* --------------------------- 目录浏览 --------------------------- */
  if (p === '/api/browse' && method === 'GET') {
    return json(res, browseDir(url.searchParams.get('path'), url.searchParams.get('check') === '1'));
  }
  if (p === '/api/browse/mkdir' && method === 'POST') {
    const body = await readBody(req);
    const parent = path.resolve(String(body.parent || '').trim() || config.outputDir || ROOT);
    const name = String(body.name || '').trim();
    if (!name || name === '.' || name === '..' || /[\\/:*?"<>|]/.test(name) || name.length > 60) {
      return json(res, { ok: false, message: '文件夹名称不合法（不能含 \\ / : * ? " < > |）' });
    }
    const target = path.join(parent, name);
    try {
      if (fs.existsSync(target)) return json(res, { ok: false, message: '同名文件夹已存在' });
      fs.mkdirSync(target);
      pushLog(`新建保存目录：${target}`);
      return json(res, { ok: true, path: target });
    } catch (e) { return json(res, { ok: false, message: e.message }); }
  }

  /* ------------------------------ 配置 ------------------------------ */
  if (p === '/api/presets' && method === 'GET') {
    return json(res, { presets: stations.list().map(s => ({
      id: s.id, name: `${s.name} ${s.freq}`, url: s.url, freq: s.freq, prefix: stations.prefixFor(s)
    })) });
  }
  if (p === '/api/config') {
    if (method === 'GET') return json(res, { config });
    if (method === 'POST') {
      const body = await readBody(req);
      for (const k of Object.keys(DEFAULT_CONFIG)) {
        if (!Object.prototype.hasOwnProperty.call(body, k)) continue;
        // 保存目录统一去首尾空白（可视化选择返回的是绝对路径，手输可能带空格）
        config[k] = (k === 'outputDir') ? String(body[k] || '').trim() : body[k];
      }
      saveConfig();
      state.cleanupCache = { at: 0, data: null };
      return json(res, { ok: true, config });
    }
  }
  if (p === '/api/status' && method === 'GET') return json(res, statusPayload());
  if (p === '/api/detect' && method === 'POST') { detectTools(true); return json(res, { ok: true, ffmpeg: state.ffmpeg, ffplay: state.ffplay }); }
  if (p === '/api/probe' && method === 'POST') {
    const body = await readBody(req);
    return json(res, await probeStream(body.url || config.streamUrl, Number(body.seconds || 4)));
  }
  if (p === '/api/dry-run' && method === 'POST') {
    const body = await readBody(req);
    try {
      const job = manager.create(body.mode || config.mode, config);
      return json(res, { ok: true, command: previewCommand(job), startAt: job.startAt,
        startText: fmtTime(job.startAt), durationSec: job.durationSec, durationText: fmtDur(job.durationSec),
        outputDir: config.outputDir, label: job.label });
    } catch (e) { return json(res, { ok: false, message: e.message }); }
  }
  if (p === '/api/preview' && method === 'POST') {
    pushLog('试听请求（由浏览器独立连接播放，不进入录制文件）');
    return json(res, { ok: true, browser: true });
  }

  /* ---------------------------- 文件管理 ---------------------------- */
  if (p === '/api/files/delete' && method === 'POST') {
    const body = await readBody(req);
    const names = Array.isArray(body.names) ? body.names : [body.name];
    const r = deleteFiles(names);
    if (r.deleted.length) pushLog(`已删除 ${r.deleted.length} 个文件（${(r.bytes / 1048576).toFixed(2)} MiB）：` + r.deleted.slice(0, 5).join('、') + (r.deleted.length > 5 ? '…' : ''));
    r.errors.forEach(e => pushLog('删除跳过 ' + e.name + '：' + e.message));
    return json(res, Object.assign({ ok: r.deleted.length > 0, message: r.deleted.length ? '' : (r.errors[0] && r.errors[0].message) || '没有可删除的文件' }, r));
  }

  /** 无损合并分段：MP3 裸帧流按字节顺序拼接即可，不解码、不重编码。 */
  if (p === '/api/files/merge' && method === 'POST') {
    const body = await readBody(req);
    const r = await mergeFiles(body.names, body.outName);
    if (r.ok) pushLog(`无损合并 ${(body.names || []).length} 个分段 → ${r.name}（${(r.size / 1048576).toFixed(1)} MiB，字节原样拼接）`);
    return json(res, r);
  }

  /* 打开录音文件所在目录。带 name 时用 explorer /select 直接定位并选中该文件。
   * 不加 windowsHide：该标志会设置 CREATE_NO_WINDOW，可能让资源管理器窗口不显示。 */
  if (p === '/api/open-folder' && method === 'POST') {
    const body = await readBody(req);
    const dir = path.resolve(currentDir());
    try {
      fs.mkdirSync(dir, { recursive: true });
      const name = path.basename(String(body.name || ''));
      let target = dir, mode = 'dir';
      if (name && storage.AUDIO_EXT.has(path.extname(name).toLowerCase())
          && path.resolve(dir, name).startsWith(dir + path.sep)) {
        target = path.resolve(dir, name); mode = 'select';
      }
      if (process.platform !== 'win32') {
        return json(res, { ok: false, path: dir, message: '当前系统不支持自动打开资源管理器，请复制路径手动打开' });
      }
      const args = mode === 'select' ? ['/select,', target] : [target];
      const child = spawn('explorer.exe', args, { stdio: 'ignore', detached: true });
      child.on('error', e => pushLog('打开目录失败：' + e.message));
      child.unref();
      return json(res, { ok: true, path: target, dir, mode });
    } catch (e) { return json(res, { ok: false, path: dir, message: e.message }); }
  }

  /* ------------------------ 一键自检 / 试录 / 清理 ------------------------ */
  if (p === '/api/selftest' && method === 'POST') {
    const body = await readBody(req);
    pushLog('开始一键自检（单元测试 / ffmpeg / 流 / 写盘 / 删除 / 合并 / EPG / 磁盘 / API）');
    const r = await selftest.runChecks({
      config, tools, probe: probeStream, deleteFiles, mergeFiles,
      port: PORT, host: HOST, log: pushLog
    });
    if (body && body.writeLog !== false) runtime.appendLog(`[${stamp()}] 自检结果：${r.summary}`);
    return json(res, r);
  }
  if (p === '/api/selftest/record' && method === 'POST') {
    const body = await readBody(req);
    pushLog(`开始 6 秒试录（引擎 ${body.engine || '自动'}）`);
    return json(res, await testRecord(body.engine || 'auto'));
  }
  if (p === '/api/selftest/clean' && method === 'POST') {
    const names = storage.audioFiles(currentDir()).map(f => f.name)
      .filter(n => n.startsWith('TEST_') || n.startsWith(selftest.PREFIX));
    const r = deleteFiles(names);
    pushLog(`清理测试文件：删除 ${r.deleted.length} 个`);
    return json(res, Object.assign({ ok: true }, r));
  }

  /* ---------------------------- 停止服务 ---------------------------- */
  if (p === '/api/shutdown' && method === 'POST') {
    const body = await readBody(req);
    const n = manager.running().length;
    pushLog(`收到停止服务指令：运行中的任务 ${n} 路${body.clearSnapshot ? '；清除续录快照' : '；保留续录快照'}`);
    json(res, { ok: true, message: '服务正在退出', running: n, clearSnapshot: !!body.clearSnapshot });
    setTimeout(() => shutdown(!!body.clearSnapshot), 350);
    return;
  }

  return json(res, { ok: false, message: '未知接口' }, 404);
}

/* --------------------------- media / static --------------------------- */

function serveMedia(req, res, url) {
  const name = path.basename(String(url.searchParams.get('name') || ''));
  const dir = path.resolve(currentDir());
  const file = path.resolve(dir, name);
  if (!name || !file.startsWith(dir + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
  const size = fs.statSync(file).size;
  const ct = /\.ts$/i.test(name) ? 'video/mp2t' : 'audio/mpeg';
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m && m[1] ? parseInt(m[1], 10) : 0;
    const end = m && m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1;
    if (start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
    res.writeHead(206, { 'Content-Type': ct, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Type': ct, 'Accept-Ranges': 'bytes', 'Content-Length': size });
    fs.createReadStream(file).pipe(res);
  }
}
function serveStatic(req, res, url) {
  let rel = url.pathname === '/' ? '/index.html' : url.pathname;
  rel = rel.replace(/^\/+/, '');
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(path.resolve(PUBLIC) + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (url.pathname.startsWith('/api/')) handleApi(req, res, url).catch(e => json(res, { ok: false, message: e.message }, 500));
  else if (url.pathname === '/media') serveMedia(req, res, url);
  else serveStatic(req, res, url);
});

let clearSnapshotOnExit = false;
function shutdown(clearSnapshot) {
  clearSnapshotOnExit = !!clearSnapshot;
  if (clearSnapshot) {
    runtime.clearLastJobs();           // 彻底停止：下次启动不再自动续录
    pushLog('服务退出，续录快照已清除（下次启动不会自动开录）');
  } else {
    manager.persist();                // snapshot BEFORE killing recorders
    pushLog('服务退出，已保存所有并行任务快照（下次启动自动续录）');
  }
  manager.running().forEach(j => { if (j._recorder) j._recorder.abort(); });
  try { server.close(); } catch (e) { /* ignore */ }
  setTimeout(() => process.exit(0), 120);
}
process.on('SIGINT', () => shutdown(false));
process.on('SIGTERM', () => shutdown(false));
process.on('exit', () => {
  try { if (clearSnapshotOnExit) runtime.clearLastJobs(); else manager.persist(); }
  catch (e) { /* best effort */ }
});

/* ------------------------------- startup ------------------------------- */

detectTools(true);
try { fs.mkdirSync(config.outputDir, { recursive: true }); }
catch (e) { pushLog('输出目录暂不可写: ' + e.message + '（可在界面里改用别的目录）'); }
try { fs.mkdirSync(runtime.LOG_DIR, { recursive: true }); }
catch (e) { /* best effort */ }

state.persistTimer = setInterval(() => manager.persist(), 5000);
state.planTimer = setInterval(tickPlans, 15000);
state.cleanupTimer = setInterval(tickCleanup, 10 * 60 * 1000);
state.epgTimer = setInterval(() => refreshAllEpg().catch(() => {}), 30 * 60 * 1000);

server.on('error', e => {
  console.error('Cannot start server: ' + e.message);
  if (e.code === 'EADDRINUSE') console.error(`Port ${PORT} is busy. Close the other instance or set PORT=xxxx.`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  pushLog(`上海 FM 录制台 v${VERSION} 已启动: http://${HOST}:${PORT}`);
  pushLog(`电台库 ${stations.list().length} 个上海 FM 频率｜并行上限 ${MAX_PARALLEL}｜输出目录 ${config.outputDir}`);
  const plans = runtime.listPlans();
  pushLog(`节目单 ${plans.length} 条（启用 ${plans.filter(p => p.enabled).length}）｜自动清理 ${runtime.get().cleanup.enabled ? '已启用' : '关闭'}`);
  const d = storage.diskInfo(currentDir());
  if (d.valid) pushLog(`磁盘可用 ${(d.free / 1073741824).toFixed(1)} GiB / 共 ${(d.total / 1073741824).toFixed(1)} GiB`);
  console.log(`Shanghai FM Recorder v${VERSION} running at http://${HOST}:${PORT}`);
  if (!state.ffmpeg.found) console.log('NOTE: ffmpeg not found - builtin zero-dependency engine (ICY + HLS) is active. Install: node tools/install-ffmpeg.js (see bin/README.md)');

  const restored = manager.recover();
  if (restored) pushLog(`断点续录已接管 ${restored} 个任务`);
  setTimeout(tickPlans, 2500);
  setTimeout(() => refreshAllEpg().catch(() => {}), 4000);

  if (process.env.OPEN_BROWSER === '1') {
    try { spawn('explorer.exe', [`http://${HOST}:${PORT}`], { windowsHide: true, stdio: 'ignore', detached: true }).unref(); }
    catch (e) { /* ignore */ }
  }
});
