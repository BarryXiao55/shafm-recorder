'use strict';
/*
 * 单个录制任务的引擎实例。每个任务拥有完全独立的连接、写盘流、定时器、
 * 重连计数与统计，因此多个电台可以同时录制而互不干扰。
 *
 * 三条引擎路径：
 *   builtin  - ICY/MP3 裸流：HTTP 响应体字节原样写盘（等价 ffmpeg -c copy，零损失）
 *   hls      - HLS(.m3u8)：按序下载分片并拼接为 MPEG-TS（仍是字节原样，零重编码）
 *   ffmpeg   - 已安装 ffmpeg 时使用，功能最全
 *
 * 质量约束（用户明确要求）：默认不解码、不重编码、不重采样、不改音量。
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const {
  EMPTY_FILE_BYTES, TAIL_RECONNECT_MIN_SEC, FIRST_FRAME_TIMEOUT_MS,
  sweepEmptySegments, decideFfmpegExit
} = require('./segment-guard');

const UA = 'FM990-Recorder/3.0';

function pad(n) { return String(n).padStart(2, '0'); }
function fmtStamp(d) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
function safePrefix(s) { return String(s || 'REC').replace(/[\\/:*?"<>|%]/g, '_').trim() || 'REC'; }

/* ------------------------- MP3 帧结构 ------------------------- */

function mp3Frame(b, i) {
  if (i + 3 >= b.length) return null;
  const h = (b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3];
  if ((h >>> 21) !== 0x7ff) return null;
  const ver = (h >>> 19) & 3, layer = (h >>> 17) & 3;
  if (ver === 1 || layer === 0) return null;
  const bi = (h >>> 12) & 15, si = (h >>> 10) & 3, padBit = (h >>> 9) & 1;
  if (bi === 0 || bi === 15 || si === 3) return null;
  const br = (ver === 3
    ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]
    : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0])[bi];
  const sr = (ver === 3 ? [44100, 48000, 32000] : ver === 2 ? [22050, 24000, 16000] : [11025, 12000, 8000])[si];
  if (!br || !sr) return null;
  let len;
  if (layer === 3) len = Math.floor(12 * br * 1000 / sr + padBit) * 4;
  else if (layer === 2) len = Math.floor(144 * br * 1000 / sr) + padBit;
  else len = Math.floor((ver === 3 ? 144 : 72) * br * 1000 / sr) + padBit;
  if (len < 24 || len > 2000) return null;
  return { len, br, sr, ver, layer };
}

function findMp3Start(buf) {
  const max = Math.min(4096, buf.length - 8);
  for (let i = 0; i < max; i++) {
    const f = mp3Frame(buf, i);
    if (!f || f.layer !== 1) continue;
    if (mp3Frame(buf, i + f.len)) return { offset: i, info: f };
  }
  return null;
}

/* --------------------------- Recorder --------------------------- */

class Recorder {
  /**
   * @param {object} o
   *   job      - 任务对象（含 config）
   *   log      - (string) => void
   *   onFinish - (job, status) => void
   *   onAlert  - (type, level, message) => void
   *   tools    - () => ({ ffmpeg:{found,path}, ffplay:... })
   */
  constructor(o) {
    this.job = o.job;
    this._log = o.log || (() => {});
    this._onFinish = o.onFinish || (() => {});
    this._onAlert = o.onAlert || (() => {});
    this._tools = o.tools || (() => ({ ffmpeg: { found: false, path: null } }));

    this.engine = null;
    this.bytes = 0;
    this.restartCount = 0;
    this.activeFile = null;
    this.lastDataAt = 0;
    this.startedAt = null;
    this.finished = false;
    this.stopped = false;
    this.deadline = Infinity;
    this.command = '';

    this._req = null; this._resp = null; this._ws = null; this._child = null;
    this._segTimer = null; this._checkTimer = null; this._retryTimer = null;
    this._hlsTimer = null; this._forceTimer = null;
    this._b = null;
    this._bpsHistory = [];      // [{ t, bytes }] 最近 30 秒
    this._segBase = 0;          // ffmpeg：已完成分段累计字节
    this._lastActive = null; this._lastSize = 0;
    this._disconnectAlerts = 0;
    this._createdFiles = [];    // 本次任务创建过的文件（空片段清理只碰这些）
    this._segWatch = null;      // 当前片段的首帧监视器
  }

  log(s) { this._log(`[${this.job.label || this.job.id}] ${s}`); }

  /* ------------------------- 生命周期 ------------------------- */

  start(remainingSec) {
    if (this.finished) return;
    const c = this.job.config;
    this.startedAt = Date.now();
    this.deadline = remainingSec > 0 ? Date.now() + remainingSec * 1000 : Infinity;
    this.lastDataAt = Date.now();
    const dir = c.outputDir;
    try { fs.mkdirSync(dir, { recursive: true }); }
    catch (e) { this.log('输出目录创建失败: ' + e.message); return this.finish('failed'); }

    const want = c.engine || 'ffmpeg';
    const tools = this._tools();
    const isHls = /\.m3u8(\?|$)/i.test(c.streamUrl || '');

    if (isHls && (want === 'builtin' || (want === 'ffmpeg' && !tools.ffmpeg.found))) {
      this.log('检测到 HLS 源，启用内置 HLS 分片拼接引擎（字节原样，无需 ffmpeg）');
      this._startHls();
    } else if (want === 'builtin' || (want === 'ffmpeg' && !tools.ffmpeg.found)) {
      if (want === 'ffmpeg') this.log('未找到 ffmpeg，自动切换到内置直录引擎（零依赖，等同 -c copy）');
      this._startIcy();
    } else {
      this._startFfmpeg(remainingSec);
    }

    if (!this.finished) this._checkTimer = setInterval(() => this._tick(), 1000);
  }

  _tick() {
    if (this.finished || this.stopped) return;
    const now = Date.now();
    // ffmpeg 引擎不经过 socket：累计所有已写完的分段 + 当前分段大小，驱动速率/活跃度
    if (this.engine === 'ffmpeg' && this.activeFile) {
      let cur = 0;
      try { cur = fs.statSync(path.join(this.job.config.outputDir, this.activeFile)).size; }
      catch (e) { /* 分段刚切换或文件被删 */ }
      if (this._lastActive && this._lastActive !== this.activeFile) {
        this._segBase = (this._segBase || 0) + (this._lastSize || 0);
      }
      this._lastActive = this.activeFile;
      this._lastSize = cur;
      this.bytes = (this._segBase || 0) + cur;
      // 首帧超时守卫以「文件真实大小」为准，不依赖 ffmpeg 日志。
      if (this._segWatch && this._segWatch.name === this.activeFile) this._segWatch.bytes = cur;
    }
    // 实时速率（10 秒滑窗，压掉开播时服务端补推缓冲造成的尖峰）
    this._bpsHistory.push({ t: now, bytes: this.bytes });
    while (this._bpsHistory.length && now - this._bpsHistory[0].t > 10000) this._bpsHistory.shift();
    if (Date.now() > this.deadline) { this.log('达到设定时长，正常结束'); return this.finish('completed'); }
    // v3.1.12：重连后首帧迟迟不到 → 放弃该片段并按源中断结束，不留空文件。
    const w = this._segWatch;
    if (w && w.isRetry && !w.fired && !this.stopped) {
      if (w.bytes >= EMPTY_FILE_BYTES) {
        w.isRetry = false;      // 首帧已落盘，之后的静音不算「无数据」
      } else if (now - w.at >= FIRST_FRAME_TIMEOUT_MS) {
        w.fired = true;
        this.log(`重连后 ${FIRST_FRAME_TIMEOUT_MS / 1000} 秒仍无音频数据，放弃空片段 ${w.name}（源中断）`);
        return this.finish('interrupted');
      }
    }
    if (this.engine === 'builtin' && this._b && this._b.aligned && !this._b.retrying &&
        now - this.lastDataAt > 45000) {
      this.log('45 秒未收到音频数据，判定为假连接，主动重连…');
      this._b.retry();
    }
  }

  bps() {
    // ffmpeg 按块落盘（如 256 KiB），10 秒滑窗会出现尖峰；用全程平均更接近真实码率
    if (this.engine === 'ffmpeg') {
      const elapsed = (Date.now() - (this.startedAt || Date.now())) / 1000;
      return elapsed > 2 && this.bytes > 0 ? Math.round(this.bytes / elapsed) : 0;
    }
    const h = this._bpsHistory;
    if (h.length < 2) return 0;
    const span = (h[h.length - 1].t - h[0].t) / 1000;
    if (span <= 0) return 0;
    return Math.max(0, Math.round((h[h.length - 1].bytes - h[0].bytes) / span));
  }

  snapshot() {
    return {
      engine: this.engine, bytes: this.bytes, bps: this.bps(),
      activeFile: this.activeFile, restartCount: this.restartCount,
      lastDataAt: this.lastDataAt, startedAt: this.startedAt, command: this.command,
      alive: !this.finished && (Date.now() - this.lastDataAt < 60000)
    };
  }

  /** Kill child process / socket immediately without changing job status. */
  abort() {
    this.finished = true;
    this._clearAll();
  }

  stop() {
    if (this.finished) return;
    this.stopped = true;
    this.log('收到停止指令');
    const child = this._child;
    if (child) {
      try { child.stdin.write('q\n'); } catch (e) { try { child.kill(); } catch (e2) { /* ignore */ } }
      this._forceTimer = setTimeout(() => {
        if (this.finished) return;
        try { child.kill(); } catch (e) { /* ignore */ }
        this.finish('cancelled');
      }, 3000);
    } else {
      this.finish('cancelled');
    }
  }

  finish(status) {
    if (this.finished) return;
    this.finished = true;
    this._clearAll();
    // v3.1.12：收尾时清理本次任务写出、但没有一个有效音频帧的空片段。
    // 流刚 end() 时句柄可能尚未关闭，失败项延时重试一次（Windows 上常见）。
    const sweep = this._sweepEmptySegments();
    if (sweep.removed.length) this._reportSweep(sweep.removed);
    if (sweep.retry.length) {
      setTimeout(() => {
        const again = sweepEmptySegments(this.job.config.outputDir, sweep.retry);
        if (again.removed.length) this._reportSweep(again.removed);
      }, 300);
    }
    this.job.engineUsed = this.engine;
    // ffmpeg 收到 'q' 后正常退出会回调 'completed'，但那是「手动停止」触发的。
    // 若沿用 completed，JobManager 会把每日重复任务重新排期，看起来像「停不掉」。
    const finalStatus = (this.stopped && status !== 'failed') ? 'cancelled' : status;
    this.log(`任务结束（${finalStatus === 'completed' ? '正常完成' : finalStatus === 'cancelled' ? '手动停止' : finalStatus === 'interrupted' ? '源中断' : '失败'}）`);
    if (finalStatus === 'failed') {
      this._onAlert('failure', 'error', `录制任务「${this.job.label}」失败，请检查流地址与输出目录`);
    }
    try { this._onFinish(this.job, finalStatus); } catch (e) { this.log('结束回调异常: ' + e.message); }
  }

  _clearAll() {
    const killReq = r => { if (r) { try { r.destroy(); } catch (e) { /* ignore */ } } };
    killReq(this._resp); killReq(this._req);
    if (this._ws) { try { this._ws.end(); } catch (e) { /* ignore */ } }
    if (this._child) { try { this._child.kill(); } catch (e) { /* ignore */ } }
    for (const k of ['_segTimer', '_checkTimer', '_hlsTimer']) {
      if (this[k]) { clearInterval(this[k]); this[k] = null; }
    }
    for (const k of ['_retryTimer', '_forceTimer']) {
      if (this[k]) { clearTimeout(this[k]); this[k] = null; }
    }
    this._child = null; this._ws = null; this._req = null; this._resp = null;
    if (this._b) this._b.stop = true;
    this.activeFile = null;
  }

  /* ------------------- v3.1.12 空片段守卫 ------------------- */

  /** 开始监视一个片段的首帧；只有重连后创建的片段需要超时守卫。 */
  _armSegmentWatch(name, isRetry) {
    this._segWatch = { name, at: Date.now(), bytes: 0, isRetry: !!isRetry, fired: false };
  }

  /** 只清理本次任务自己创建的小文件，返回 { removed, retry }。 */
  _sweepEmptySegments() {
    const names = Array.from(new Set(this._createdFiles));
    const report = sweepEmptySegments(this.job.config.outputDir, names);
    // 只对「仍被占用」且确实为空的项重试，避免误删后来才落盘的数据。
    const retry = report.errors.filter(e => e.busy).map(e => e.name);
    return { removed: report.removed, retry };
  }

  _reportSweep(removed) {
    const names = removed.map(x => x.name);
    this.job.emptySegments = (this.job.emptySegments || []).concat(names);
    this.log(`已清理 ${names.length} 个空片段（源中断，无有效音频）：${names.join('、')}`);
  }

  /* ------------------- ICY / MP3 裸流直录 ------------------- */

  _startIcy() {
    const c = this.job.config;
    const dir = c.outputDir;
    const prefix = safePrefix(c.filePrefix);
    const segMs = Math.max(0, Number(c.segmentMinutes || 0)) * 60000;
    const self = this;
    this.engine = 'builtin';
    this.command = `[内置直录] GET ${c.streamUrl} -> ${path.join(dir, prefix + '_YYYYmmdd_HHMMSS.mp3')}（字节原样，等价 ffmpeg -c copy）`;

    const b = {
      stop: false, aligned: false, pending: Buffer.alloc(0), splitPending: false,
      splitBuf: Buffer.alloc(0), paused: false, retrying: false, segMs, dir, prefix,
      retry: () => self._icyRetry()
    };
    this._b = b;

    this._newSegment('.mp3');
    this._icyConnect(c.streamUrl, 0);
    if (segMs > 0) this._segTimer = setInterval(() => {
      if (b.stop || b.splitPending) return;
      b.splitPending = true;
      this.log('到达分段点，等待下一个 MP3 帧边界后切新文件…');
    }, segMs);
  }

  _newSegment(ext) {
    const b = this._b || (this._b = {});
    if (this._ws) { try { this._ws.end(); } catch (e) { /* ignore */ } }
    const prefix = safePrefix(this.job.config.filePrefix);
    const name = `${prefix}_${fmtStamp(new Date())}${ext || '.mp3'}`;
    const dir = this.job.config.outputDir;
    this._ws = fs.createWriteStream(path.join(dir, name));
    this._ws.on('error', e => this.log('写文件错误: ' + e.message));
    this.activeFile = name;
    this._createdFiles.push(name);
    this._armSegmentWatch(name, this.restartCount > 0);
    b.paused = false;
    this.log('新分段: ' + name);
  }

  _write(data) {
    const b = this._b;
    if (!this._ws || b.stop || !data || !data.length) return;
    if (this._segWatch) this._segWatch.bytes += data.length;
    const ok = this._ws.write(data);
    if (!ok && this._resp && !b.paused) {
      b.paused = true;
      this._resp.pause();
      this._ws.once('drain', () => {
        b.paused = false;
        if (!b.stop && this._resp) this._resp.resume();
      });
    }
  }

  _icyRetry() {
    const b = this._b;
    if (!b || b.stop || this.finished || Date.now() > this.deadline || b.retrying) return;
    // v3.1.12：尾部不足 15 秒不再重连，避免只创建空文件却录不到声音。
    if (isFinite(this.deadline) && this.deadline - Date.now() <= TAIL_RECONNECT_MIN_SEC * 1000) {
      this.log(`剩余不足 ${TAIL_RECONNECT_MIN_SEC} 秒，按源中断结束（不再重连，避免空片段）`);
      this.finish('interrupted');
      return;
    }
    b.retrying = true;
    if (this._resp) { try { this._resp.destroy(); } catch (e) { /* ignore */ } }
    if (this._req) { try { this._req.destroy(); } catch (e) { /* ignore */ } }
    if (this._retryTimer) clearTimeout(this._retryTimer);
    this.restartCount++;
    this._disconnectAlerts++;
    this.log('连接中断，5 秒后重连…（第 ' + this.restartCount + ' 次）');
    if (this._disconnectAlerts === 3) {
      this._onAlert('disconnect', 'warn', `「${this.job.label}」短时间内反复断流 ${this._disconnectAlerts} 次`);
    }
    this._retryTimer = setTimeout(() => {
      b.retrying = false;
      if (!b.stop && !this.finished) this._icyConnect(this.job.config.streamUrl, 0);
    }, 5000);
  }

  _icyConnect(target, hop) {
    const b = this._b;
    if (!b || b.stop || this.finished) return;
    b.aligned = false;
    b.pending = Buffer.alloc(0);
    b.splitPending = false;
    b.splitBuf = Buffer.alloc(0);
    const lib = target.startsWith('https:') ? https : http;
    let req;
    try {
      req = lib.get(target, {
        headers: { 'User-Agent': UA, 'Icy-MetaData': '0', 'Connection': 'keep-alive' }
      }, resp => {
        if ([301, 302, 303, 307, 308].includes(resp.statusCode) && resp.headers.location && hop < 4) {
          resp.resume();
          const next = new URL(resp.headers.location, target).toString();
          this.log('跟随重定向: ' + next);
          return this._icyConnect(next, hop + 1);
        }
        if (resp.statusCode !== 200) {
          this.log('直播流返回 HTTP ' + resp.statusCode);
          resp.resume();
          return this._icyRetry();
        }
        this._resp = resp;
        this.lastDataAt = Date.now();
        this.log('已连上直播流，开始写盘（音频帧字节原样，零损失）');
        resp.on('data', chunk => {
          if (!this._ws || b.stop) return;
          this.lastDataAt = Date.now();
          this.bytes += chunk.length;

          if (!b.aligned) {
            b.pending = Buffer.concat([b.pending, chunk]);
            const hit = findMp3Start(b.pending);
            if (hit) {
              b.aligned = true;
              this._write(b.pending.slice(hit.offset));
              b.pending = Buffer.alloc(0);
              this.log(`帧对齐完成：跳过 ${hit.offset} 字节非音频前导，音频帧字节原样写入`);
            } else if (b.pending.length > 16384) {
              b.aligned = true;
              this._write(b.pending);
              b.pending = Buffer.alloc(0);
              this.log('未识别到 MP3 帧同步，按原始字节保存（可能需 ffmpeg 二次封装）');
            }
            return;
          }

          if (b.splitPending) {
            b.splitBuf = Buffer.concat([b.splitBuf, chunk]);
            const hit = findMp3Start(b.splitBuf);
            if (hit || b.splitBuf.length > 32768) {
              const at = hit ? hit.offset : b.splitBuf.length;
              this._write(b.splitBuf.slice(0, at));
              this._newSegment('.mp3');
              if (at < b.splitBuf.length) this._write(b.splitBuf.slice(at));
              b.splitPending = false;
              b.splitBuf = Buffer.alloc(0);
            }
            return;
          }
          this._write(chunk);
        });
        resp.on('end', () => this._icyRetry());
        resp.on('error', e => { if (!b.stop && !this.finished) { this.log('流读取错误: ' + e.message); this._icyRetry(); } });
      });
      this._req = req;
      req.setTimeout(20000, () => req.destroy(new Error('读取超时')));
      req.on('error', e => { if (!b.stop && !this.finished) { this.log('连接错误: ' + e.message); this._icyRetry(); } });
    } catch (e) {
      this.log('连接失败: ' + e.message);
      this._icyRetry();
    }
  }

  /* ----------------------- HLS 分片拼接 -----------------------
     MPEG-TS 分片天然可按字节顺序拼接，不需要 remux；
     若分片是 fMP4/AAC 裸流则明确报错，引导改用 ffmpeg。        */

  _startHls() {
    const c = this.job.config;
    this.engine = 'hls';
    this.command = `[内置 HLS] 拉取 ${c.streamUrl} 的分片并按序拼接为 .ts（无重编码）`;
    this._newSegment('.ts');
    const b = this._b || (this._b = {});
    b.seen = new Set();
    b.lastSeq = -1;
    b.playlistUrl = c.streamUrl;
    b.busy = false;
    this._hlsTimer = setInterval(() => this._hlsPull(), 1500);
    this._hlsPull();
  }

  _hlsPull() {
    const b = this._b;
    if (this.finished || b.busy) return;
    b.busy = true;
    this._fetchText(b.playlistUrl, 0).then(text => {
      b.busy = false;
      if (!text) return;
      let playlist = text;
      // master playlist -> pick the first variant
      const variants = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
      if (text.includes('#EXT-X-STREAM-INF') && variants.length) {
        const next = new URL(variants[0], b.playlistUrl).toString();
        b.playlistUrl = next;
        this.log('HLS 主列表 → 选用子流: ' + next);
        return this._fetchText(next, 0).then(t => t && this._hlsSegments(t, next));
      }
      this._hlsSegments(text, b.playlistUrl);
    }).catch(e => { b.busy = false; this.log('HLS 列表拉取失败: ' + e.message); });
  }

  _hlsSegments(text, baseUrl) {
    const b = this._b;
    const lines = text.split('\n').map(l => l.trim());
    const urls = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
        b.lastSeq = parseInt(lines[i].split(':')[1], 10) || -1;
      }
      const l = lines[i];
      if (!l || l.startsWith('#')) continue;
      const u = new URL(l, baseUrl).toString();
      if (!b.seen.has(u)) { b.seen.add(u); urls.push(u); }
      if (b.seen.size > 4000) { const arr = Array.from(b.seen); b.seen = new Set(arr.slice(-2000)); }
    }
    if (!urls.length) return;
    // 顺序下载，保证字节顺序与播出顺序一致
    (async () => {
      for (const u of urls.slice(-12)) {
        if (this.finished) return;
        const buf = await this._fetchBuffer(u, 0);
        if (!buf || !buf.length) continue;
        if (buf[0] !== 0x47) {
          this.log('HLS 分片不是 MPEG-TS（首字节 ' + buf[0].toString(16) + '），内置引擎无法无损拼接，请安装 ffmpeg 后改用 ffmpeg 引擎');
          this._onAlert('failure', 'error', `「${this.job.label}」HLS 分片非 TS 格式，需 ffmpeg 才能录制`);
          return this.finish('failed');
        }
        this._write(buf);
        this.bytes += buf.length;
        this.lastDataAt = Date.now();
      }
    })().catch(e => this.log('HLS 分片处理异常: ' + e.message));
  }

  _fetchText(url, hop) { return this._fetchBuffer(url, hop).then(b => b && b.toString('utf8')); }

  _fetchBuffer(url, hop) {
    return new Promise(resolve => {
      if (hop > 3) return resolve(null);
      const lib = /^https:/i.test(url) ? https : http;
      let req;
      try {
        req = lib.get(url, { headers: { 'User-Agent': UA } }, resp => {
          if ([301, 302, 303, 307, 308].includes(resp.statusCode) && resp.headers.location) {
            resp.resume();
            return resolve(this._fetchBuffer(new URL(resp.headers.location, url).toString(), hop + 1));
          }
          if (resp.statusCode !== 200) { resp.resume(); return resolve(null); }
          const chunks = [];
          resp.on('data', d => chunks.push(d));
          resp.on('end', () => resolve(Buffer.concat(chunks)));
          resp.on('error', () => resolve(null));
        });
        req.setTimeout(12000, () => req.destroy(new Error('timeout')));
        req.on('error', () => resolve(null));
      } catch (e) { resolve(null); }
    });
  }

  /* --------------------------- ffmpeg --------------------------- */

  _startFfmpeg(remainingSec) {
    const tools = this._tools();
    if (!tools.ffmpeg.found) {
      this.log('录制失败：未找到 ffmpeg');
      return this.finish('failed');
    }
    const c = this.job.config;
    const isHlsIn = /\.m3u8(\?|$)/i.test(c.streamUrl || '');
    const args = ['-hide_banner', '-loglevel', 'info'];   // info 级别才输出 "Opening 'xxx' for writing"
    /* HTTP 长连接 MP3 裸流需要这套断线重连参数；但 HLS 由 demuxer 自己管理分片与重试。
     * 尤其 -reconnect_at_eof：每个 .ts 分片读完就是 EOF，会触发反复 302 重连而不写任何数据
     * （FM 87.9 的 AAC/HLS 流实测如此）。因此 HLS 一律不下发这组参数。 */
    if (!isHlsIn) args.push(
      '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_at_eof', '1',
      '-reconnect_delay_max', '10', '-rw_timeout', '10000000'
    );
    args.push('-i', c.streamUrl, '-vn');
    if (c.codec === 'mp3_64') args.push('-c:a', 'libmp3lame', '-b:a', '64k');
    else if (c.codec === 'mp3_128') args.push('-c:a', 'libmp3lame', '-b:a', '128k');
    else args.push('-c:a', 'copy');

    const t = Math.ceil(remainingSec > 0 ? remainingSec : (this.job.durationSec || 0));
    if (t > 0) args.push('-t', String(t));
    const ext = isHlsIn ? '.ts' : '.mp3';
    let out;
    const seg = Math.max(0, Number(c.segmentMinutes || 0));
    if (seg > 0) {
      args.push('-f', 'segment', '-segment_time', String(Math.round(seg * 60)), '-reset_timestamps', '1');
      // segment 的内部封装器要单独传参，否则每段开头都会多一个 ID3v2 标签
      if (ext === '.mp3') args.push('-segment_format_options', 'id3v2_version=0');
      // 不用 -strftime：ffmpeg 9 下多个分段会算出同一个时间戳文件名而互相覆盖，
      // 改用 %04d 递增序号，每段一个独立文件，按文件名排序即可无损合并。
      out = path.join(c.outputDir, `${safePrefix(c.filePrefix)}_${fmtStamp(new Date())}_%04d${ext}`);
    } else {
      // 单文件输出：关掉 ID3v2 头，保持与内置引擎一致的纯 MP3 帧流
      if (ext === '.mp3') args.push('-id3v2_version', '0');
      out = path.join(c.outputDir, `${safePrefix(c.filePrefix)}_${fmtStamp(new Date())}${ext}`);
      this.activeFile = path.basename(out);
      this._createdFiles.push(this.activeFile);
      this._armSegmentWatch(this.activeFile, this.restartCount > 0);
    }
    args.push('-flush_packets', '1');   // 每个音频包立刻落盘，减少断电时丢失的尾部
    args.push('-y', out);
    this.engine = 'ffmpeg';
    this.command = `${tools.ffmpeg.path} ${args.map(a => /\s/.test(a) ? '"' + a + '"' : a).join(' ')}`;
    this.log('启动 ffmpeg: ' + this.command);

    let child;
    try { child = spawn(tools.ffmpeg.path, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (e) { this.log('ffmpeg 启动失败: ' + e.message); return this.finish('failed'); }
    this._child = child;
    this.lastDataAt = Date.now();
    const handle = buf => {
      this.lastDataAt = Date.now();
      String(buf).split(/[\r\n]+/).forEach(raw => {
        const line = String(raw).trim();
        if (!line) return;
        // 从 ffmpeg 日志里认出「当前正在写哪个文件」，删除保护与活跃度都依赖它
        const open = /Opening\s+'([^']+)'\s+for writing/.exec(line);
        const to = /Output\s+#0,.*\bto\s+'([^']+)'/.exec(line);
        const m = open || to;
        if (m) {
          const f = path.basename(m[1]);
          // "Output #0 ... to '<含 %04d 的模板>'" 是输出模板，不是真实文件；
          // 只有 segment 的 "Opening 'xxx' for writing" 才是当前文件名。
          if (f.includes('%')) return;
          if (f !== this.activeFile) {
            this.activeFile = f;
            this._createdFiles.push(f);
            this._armSegmentWatch(f, this.restartCount > 0);
            this.log('正在写入: ' + f);
          }
          return;
        }
        // 进度行（frame=…）不刷日志，只保留错误与关键提示
        if (/error|failed|invalid|unable|refused|timeout|connection/i.test(line) && !/^frame=/.test(line)) {
          this.log('ffmpeg: ' + line.slice(0, 200));
        }
      });
    };
    child.stdout.on('data', handle);
    child.stderr.on('data', handle);
    child.on('error', e => this.log('ffmpeg 进程错误: ' + e.message));
    child.on('exit', code => {
      if (this._child !== child || this.finished) return;
      const elapsed = (Date.now() - this.startedAt) / 1000;
      const d = decideFfmpegExit({
        code, elapsed, durationSec: this.job.durationSec,
        autoRestart: c.autoRestart, stopped: this.stopped
      });
      if (d.action === 'interrupted') {
        // v3.1.12：尾部源中断不再重连，收尾时顺手清掉刚创建的空文件。
        this.log(`ffmpeg 退出，剩余 ${Math.ceil(d.remain)} 秒（≤${TAIL_RECONNECT_MIN_SEC} 秒），按源中断结束，不再重连`);
        return this.finish('interrupted');
      }
      if (d.action === 'reconnect') {
        this.restartCount++;
        this.log(`ffmpeg 意外退出 (code ${code})，10 秒后自动重连，剩余 ${Math.ceil(d.remain)} 秒`);
        this._retryTimer = setTimeout(() => {
          if (!this.finished) this._startFfmpeg(Math.ceil(d.remain));
        }, 10000);
      } else {
        this.finish(d.status);
      }
    });
  }
}

module.exports = { Recorder, mp3Frame, findMp3Start, fmtStamp, safePrefix };
