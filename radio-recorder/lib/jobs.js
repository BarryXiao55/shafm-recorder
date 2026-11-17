'use strict';
/*
 * 并行任务管理器。v2 是「全局只能有一个录制任务」；v3 允许多个电台同时录制，
 * 每个任务持有自己的 Recorder 实例、定时器、重连计数和统计。
 *
 * 冲突规则：同一个电台已有任务在跑 → 拒绝再开（避免两个进程写同一批文件）；
 * 不同电台 → 完全并行。节目单触发遵循同一规则。
 */

const { Recorder } = require('./recorder');

const MAX_PARALLEL = 8;
// v3.1.12：新增 interrupted（源中断）终态——主体已录到，但尾部因流中断收尾。
// 它与 completed/cancelled/failed 一样是终态，可删除记录、不再算在途任务。
const TERMINAL_STATES = ['completed', 'cancelled', 'failed', 'interrupted'];
const pad = n => String(n).padStart(2, '0');

function fmtDur(sec) {
  if (!sec || sec <= 0) return '不限时长';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  return [h ? h + '小时' : '', m ? m + '分' : '', (!h && !m) ? s + '秒' : ''].filter(Boolean).join('') || (s + '秒');
}
function fmtTime(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function localDateTime(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function nextHour(after) {
  const d = new Date(after); d.setHours(d.getHours() + 1, 0, 0, 0); return d.getTime();
}

class JobManager {
  /**
   * @param {object} o  config, runtime, scheduler, stations, tools, log, alert, onNewJob
   */
  constructor(o) {
    this.config = o.config;                 // live reference to the config object
    this.runtime = o.runtime;
    this.scheduler = o.scheduler;
    this.stations = o.stations;
    this.tools = o.tools;
    this.log = o.log || (() => {});
    this.alert = o.alert || (() => {});
    this.jobs = new Map();
    this.onNewJob = o.onNewJob || (() => {});
  }

  /* --------------------------- create --------------------------- */

  create(mode, cfg) {
    const c = Object.assign({}, this.config, cfg || {});
    const now = Date.now();
    const job = {
      id: now.toString(36) + Math.random().toString(36).slice(2, 6),
      mode, label: '', stationId: c.stationId || '',
      startAt: now, durationSec: 0, config: c,
      status: 'scheduled', createdAt: now, startedAt: null, endedAt: null,
      command: '', engineUsed: '', repeatDaily: !!c.repeatDaily,
      _recorder: null, _timer: null, _planId: ''
    };

    if (mode === 'now') {
      job.label = '立即录制';
      job.durationSec = Math.max(0, Number(c.durationMinutes || 0)) * 60;
    } else if (mode === 'hourly') {
      const hours = Math.max(1, Math.min(24, Number(c.hourlyHours || 1)));
      const nh = nextHour(now);
      if (c.hourlyAlign === 'untilNextHour') {
        job.durationSec = Math.max(1, Math.round((nh - now) / 1000));
      } else {
        job.startAt = nh;
        job.durationSec = hours * 3600;
      }
      job.label = c.hourlyAlign === 'untilNextHour' ? '整点录制 · 至下个整点' : `整点录制 · ${hours} 小时`;
    } else if (mode === 'daily24') {
      job.label = '24 小时连续';
      job.durationSec = 86400;
    } else if (mode === 'range') {
      const s = new Date(c.rangeStart).getTime(), e = new Date(c.rangeEnd).getTime();
      if (!isFinite(s) || !isFinite(e) || e <= s) throw new Error('时间段无效：结束时间必须晚于开始时间');
      if (e - s > 48 * 3600000) throw new Error('单次时间段不能超过 48 小时');
      job.startAt = s;
      job.durationSec = Math.round((e - s) / 1000);
      job.label = '指定时间段';
    } else {
      throw new Error('未知录制模式: ' + mode);
    }
    return job;
  }

  /* --------------------------- queries --------------------------- */

  get(id) { return this.jobs.get(String(id)) || null; }

  live() {
    return Array.from(this.jobs.values()).filter(j => ['scheduled', 'running', 'stopping'].includes(j.status));
  }

  running() { return Array.from(this.jobs.values()).filter(j => j.status === 'running'); }

  /** Scheduled/running job on the same station (or same stream URL). */
  conflictFor(cfg) {
    const sid = cfg.stationId || '';
    const url = String(cfg.streamUrl || '').trim();
    return this.live().find(j => {
      const jc = j.config;
      if (sid && jc.stationId) return jc.stationId === sid;
      return String(jc.streamUrl || '').trim() === url;
    }) || null;
  }

  activeFiles() {
    return this.running().map(j => j._recorder && j._recorder.activeFile).filter(Boolean);
  }

  publicJob(j) {
    const out = {};
    for (const k of Object.keys(j)) if (!k.startsWith('_')) out[k] = j[k];
    const r = j._recorder;
    out.metrics = r ? r.snapshot() : { engine: j.engineUsed || '', bytes: 0, bps: 0, activeFile: null, restartCount: 0, alive: false };
    out.elapsedSec = j.startedAt ? (Date.now() - j.startedAt) / 1000 : 0;
    out.remainingSec = j.durationSec > 0 ? Math.max(0, j.durationSec - out.elapsedSec) : 0;
    out.stationName = j.stationId ? ((this.stations.get(j.stationId) || {}).name || '') : '';
    return out;
  }

  list() {
    return Array.from(this.jobs.values())
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 40).map(j => this.publicJob(j));
  }

  /* --------------------------- schedule --------------------------- */

  schedule(job) {
    if (this.jobs.has(job.id)) throw new Error('任务 ID 重复');
    this.jobs.set(job.id, job);
    job.status = 'scheduled';
    const delay = Math.max(0, job.startAt - Date.now());
    this.log(`任务已排期：${job.label} | 开始 ${fmtTime(job.startAt)} | 时长 ${fmtDur(job.durationSec)} | 分段 ${job.config.segmentMinutes || '不分段'} 分钟`);
    if (delay > 0) this.log(`将在 ${fmtDur(Math.round(delay / 1000))} 后自动开始`);
    job._timer = setTimeout(() => {
      job._timer = null;
      if (job.status !== 'scheduled') return;
      this.launch(job, job.durationSec);
    }, delay);
    this.prune();
    this.onNewJob(job);
    return job;
  }

  launch(job, remainingSec) {
    if (this.live().length > MAX_PARALLEL + 2) {
      this.log(`并行任务已达上限 ${MAX_PARALLEL}，放弃启动 ${job.label}`);
      return this.finish(job, 'failed');
    }
    job.status = 'running';
    job.startedAt = Date.now();
    const r = new Recorder({
      job,
      log: s => this.log(s),
      tools: this.tools,
      onAlert: (type, level, msg) => this.alert(type, level, msg, job.id),
      onFinish: (j, status) => this.finish(j, status)
    });
    job._recorder = r;
    r.start(remainingSec);
    this.persist();
  }

  /* ---------------------------- stop ---------------------------- */

  stop(id, reason) {
    const j = this.get(id);
    if (!j) return { ok: false, message: '任务不存在' };
    if (TERMINAL_STATES.includes(j.status)) return { ok: false, message: '任务已结束' };
    if (j._timer) { clearTimeout(j._timer); j._timer = null; }
    if (j.status === 'scheduled') return this.finish(j, reason === 'completed' ? 'completed' : 'cancelled');
    if (j._recorder) {
      // Set the transitional status BEFORE stop(): a builtin recorder finishes
      // synchronously and writes 'cancelled' through the onFinish callback.
      j.status = 'stopping';
      j._recorder.stop();
      if (j.status === 'stopping' && j._recorder.finished) this.finish(j, 'cancelled');
    } else this.finish(j, 'cancelled');
    return { ok: true };
  }

  stopAll(reason) {
    const list = this.live();
    list.forEach(j => this.stop(j.id, reason || 'cancelled'));
    return { ok: true, count: list.length };
  }

  /* ---------------------- remove finished job records ----------------------
   * Only terminal-state jobs may be removed. Audio files on disk are never
   * touched here - this is purely cleaning up the in-memory task list.
   */
  remove(id) {
    const j = this.get(id);
    if (!j) return { ok: false, message: '任务不存在' };
    if (['scheduled', 'running', 'stopping'].includes(j.status)) {
      return { ok: false, message: '任务仍在进行中，请先点「停止」再删除' };
    }
    if (j._timer) { clearTimeout(j._timer); j._timer = null; }
    this.jobs.delete(j.id);
    this.log(`已移除任务记录「${j.label}」（${j.status}）；磁盘录音文件不受影响`);
    this.persist();
    return { ok: true, removed: [j.id] };
  }

  clearFinished() {
    const done = Array.from(this.jobs.values())
      .filter(j => TERMINAL_STATES.includes(j.status));
    for (const j of done) {
      if (j._timer) { clearTimeout(j._timer); j._timer = null; }
      this.jobs.delete(j.id);
    }
    if (done.length) this.log(`已清理 ${done.length} 条已结束任务记录（录音文件保留）`);
    this.persist();
    return { ok: true, removed: done.map(j => j.id), count: done.length };
  }

  finish(job, status) {
    if (TERMINAL_STATES.includes(job.status)) return { ok: true };
    if (job._timer) { clearTimeout(job._timer); job._timer = null; }
    job.status = status;
    job.endedAt = Date.now();
    // 源中断通常只丢尾部几秒，主体节目已录到：仍保留每日重复排期。
    job.repeatDaily = job.repeatDaily && (status === 'completed' || status === 'interrupted');
    this.log(`任务结束（${status === 'completed' ? '正常完成' : status === 'cancelled' ? '手动停止' : status === 'interrupted' ? '源中断' : '失败'}）：${job.label}`);
    this.runtime.bumpStats({ recordings: 1 });
    this.persist();

    if ((status === 'completed' || status === 'interrupted') && job.repeatDaily && job.mode !== 'now') {
      try {
        const c = Object.assign({}, job.config);
        if (job.mode === 'range') {
          c.rangeStart = localDateTime(new Date(new Date(c.rangeStart).getTime() + 86400000));
          c.rangeEnd = localDateTime(new Date(new Date(c.rangeEnd).getTime() + 86400000));
        }
        const next = this.create(job.mode, c);
        next.repeatDaily = true;
        next.stationId = job.stationId;
        next.label = job.label;
        this.log('每日重复已启用，下一次：' + fmtTime(next.startAt));
        this.schedule(next);
      } catch (e) { this.log('重复排期失败: ' + e.message); }
    }
    this.prune();
    return { ok: true };
  }

  prune() {
    const done = Array.from(this.jobs.values())
      .filter(j => TERMINAL_STATES.includes(j.status))
      .sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0));
    done.slice(24).forEach(j => this.jobs.delete(j.id));
  }

  /* --------------------------- plans --------------------------- */

  /** 节目单触发：同电台不抢占，不同电台可并行。 */
  firePlan(plan) {
    /* v3.1.10：传入电台库，让前缀在「触发时刻」也按频率现算一次，
       存量节目单即使存着旧的 FM990 也不会再写错文件。 */
    const cfg = this.scheduler.planJobConfig(plan, this.config, this.stations.list());
    const conflict = this.conflictFor(cfg);
    if (conflict) {
      this.log(`节目单「${plan.name}」到点，但该电台已有任务「${conflict.label}」在跑 → 跳过本次（不抢占）`);
      return { ok: false, skipped: true, message: '该电台已有录制任务在运行' };
    }
    if (this.live().length >= MAX_PARALLEL) {
      this.log(`节目单「${plan.name}」到点，但并行任务已达上限 ${MAX_PARALLEL}`);
      this.alert('plan', 'warn', `节目单「${plan.name}」因并行上限 ${MAX_PARALLEL} 未启动`);
      return { ok: false, skipped: true, message: '并行任务已达上限' };
    }
    try {
      const job = this.create('now', cfg);
      job.label = `节目单 · ${plan.name}`;
      job._planId = plan.id;
      this.schedule(job);
      this.log(`节目单触发：${plan.name}｜${this.scheduler.describe(plan)}｜预计 ${fmtTime(Date.now() + job.durationSec * 1000)} 结束`);
      return { ok: true, jobId: job.id };
    } catch (e) {
      this.log(`节目单「${plan.name}」启动失败: ${e.message}`);
      this.alert('plan', 'error', `节目单「${plan.name}」启动失败：${e.message}`);
      return { ok: false, message: e.message };
    }
  }

  /* ---------------------- persistence / recovery ---------------------- */

  persist() {
    this.runtime.setLastJobs(this.live());
  }

  /**
   * Restore every live job after a restart. Audio aired while the service was
   * down cannot be recovered; each job starts a fresh segment and the old file
   * stays intact.
   */
  recover() {
    let snaps = this.runtime.getLastJobs();
    if (!snaps.length) {
      const old = this.runtime.getLastJob();      // v2 -> v3 migration
      if (old) snaps = [old];
    }
    if (!snaps.length) return 0;
    let restored = 0;
    for (const s of snaps) {
      if (!['running', 'stopping', 'scheduled'].includes(s.status)) continue;
      const now = Date.now();
      const started = s.startedAt || s.startAt || now;
      const remain = s.durationSec > 0 ? s.durationSec - (now - started) / 1000 : Infinity;
      const staleSchedule = s.status === 'scheduled' && s.startAt < now - 5 * 60000;
      // A 30s floor used to discard every job whose total duration was under
      // 30s (e.g. a 24s test recording). Only skip when essentially nothing
      // is left, so short-but-live jobs are recovered too.
      if (staleSchedule || (s.durationSec > 0 && remain <= 5)) {
        this.log(`上次任务「${s.label || '录制'}」已过期或已录完，未恢复`);
        continue;
      }
      try {
        const c = Object.assign({}, s.config, {
          monitor: false, repeatDaily: false, durationMinutes: 0,
          outputDir: s.config.outputDir || this.config.outputDir
        });
        const job = this.create('now', c);
        const base = String(s.label || '上次任务').replace(/^(?:断点续录 · )+/, '');
        const station = s.stationId ? this.stations.get(s.stationId) : null;
        const tag = station ? station.name : (c.filePrefix || '');
        // Distinguish parallel jobs in the UI, without stacking the tag on
        // repeated restarts.
        job.label = '断点续录 · ' + (tag && base.includes(tag) ? base : base + (tag ? ' · ' + tag : ''));
        job.stationId = s.stationId || '';
        job._planId = s.planId || '';
        job.durationSec = s.durationSec > 0 ? Math.max(1, Math.round(remain)) : 0;
        job.startAt = now;
        // bypass the same-station conflict check on restore
        this.schedule(job);
        restored++;
        this.log(`已自动断点续录「${job.label}」（服务中断期间的音频无法补回）`);
      } catch (e) {
        this.log('断点续录失败: ' + e.message);
      }
    }
    this.runtime.clearLastJobs();
    this.persist();
    return restored;
  }
}

module.exports = { JobManager, MAX_PARALLEL, fmtDur, fmtTime, localDateTime };
