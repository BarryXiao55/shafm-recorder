'use strict';

/*
 * runtime.js - persistent runtime state, separate from user config.
 *
 * config.json  : user-facing recording parameters (edited from the UI)
 * runtime.json : schedules, cleanup policy, trigger dedupe, crash-recovery snapshot
 * logs/*.log   : append-only daily log files
 *
 * All writes are atomic (write temp + rename) so a power cut cannot leave a
 * half-written JSON file that would wipe the user's schedule.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, 'runtime.json');
const LOG_DIR = path.join(ROOT, 'logs');

const DEFAULT_CLEANUP = {
  enabled: false,      // off by default: deleting files must be an explicit choice
  retentionDays: 90,
  maxTotalGB: 0,       // 0 = no cap on total recording size
  minFreeGB: 5,        // stop deleting once free space is back above this
};

function dateKey(d) {
  const x = d instanceof Date ? d : new Date(d);
  const p = n => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
}

function blank() {
  return {
    version: 2,
    plans: [],
    cleanup: Object.assign({}, DEFAULT_CLEANUP),
    lastTriggered: {},
    lastJob: null,          // v2 single-job snapshot (kept for backward compatibility)
    lastJobs: [],           // v3: all running/scheduled jobs, for parallel crash recovery
    stats: { recordings: 0, cleanups: 0, bytesDeleted: 0 }
  };
}

function normalize(raw) {
  const d = blank();
  if (!raw || typeof raw !== 'object') return d;
  if (Array.isArray(raw.plans)) d.plans = raw.plans.filter(p => p && typeof p === 'object');
  d.cleanup = Object.assign({}, DEFAULT_CLEANUP, raw.cleanup || {});
  d.cleanup.retentionDays = Math.max(1, Math.min(3650, Number(d.cleanup.retentionDays) || 90));
  d.cleanup.maxTotalGB = Math.max(0, Number(d.cleanup.maxTotalGB) || 0);
  d.cleanup.minFreeGB = Math.max(0, Number(d.cleanup.minFreeGB) || 0);
  d.cleanup.enabled = !!d.cleanup.enabled;
  if (raw.lastTriggered && typeof raw.lastTriggered === 'object') d.lastTriggered = raw.lastTriggered;
  if (raw.lastJob && typeof raw.lastJob === 'object') d.lastJob = raw.lastJob;
  if (Array.isArray(raw.lastJobs)) d.lastJobs = raw.lastJobs.filter(x => x && typeof x === 'object');
  if (raw.stats && typeof raw.stats === 'object') d.stats = Object.assign(d.stats, raw.stats);
  return d;
}

let cache = null;

function get() {
  if (cache) return cache;
  try { cache = normalize(JSON.parse(fs.readFileSync(FILE, 'utf8'))); }
  catch (e) { cache = blank(); }
  return cache;
}

function save() {
  const data = get();
  try {
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, FILE);
    return true;
  } catch (e) {
    return false;
  }
}

/** Mutate runtime state and persist in one step. */
function patch(fn) {
  const d = get();
  fn(d);
  save();
  return d;
}

/* ----------------------------- plans ----------------------------- */

function newPlanId() {
  return 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function listPlans() { return get().plans.slice(); }

function addPlan(plan) {
  return patch(d => {
    d.plans.push(Object.assign({ id: newPlanId() }, plan));
  }).plans.slice(-1)[0];
}

function updatePlan(id, changes) {
  let found = null;
  patch(d => {
    const i = d.plans.findIndex(p => p.id === id);
    if (i < 0) return;
    d.plans[i] = Object.assign({}, d.plans[i], changes, { id });
    found = d.plans[i];
  });
  return found;
}

function removePlan(id) {
  let removed = false;
  patch(d => {
    const before = d.plans.length;
    d.plans = d.plans.filter(p => p.id !== id);
    delete d.lastTriggered[id];
    removed = before !== d.plans.length;
  });
  return removed;
}

/* ------------------------ trigger dedupe ------------------------ */

function wasTriggered(id, key) { return get().lastTriggered[id] === key; }

function markTriggered(id, key) {
  patch(d => {
    d.lastTriggered[id] = key;
    // keep the map small even if plans are deleted over the years
    const keys = Object.keys(d.lastTriggered);
    if (keys.length > 200) {
      const ids = new Set(d.plans.map(p => p.id));
      keys.filter(k => !ids.has(k)).forEach(k => delete d.lastTriggered[k]);
    }
  });
}

/* ---------------------- crash-recovery snapshot ---------------------- */

/**
 * Only jobs that were actually recording are snapshotted. A recovery restart
 * intentionally begins a NEW file (the interrupted segment is kept intact).
 */
function setLastJob(job) {
  if (!job) return clearLastJob();
  patch(d => {
    d.lastJob = {
      id: job.id,
      mode: job.mode,
      label: job.label,
      status: job.status,
      startAt: job.startAt,
      startedAt: job.startedAt,
      durationSec: job.durationSec,
      config: job.config,
      savedAt: Date.now()
    };
  });
}

function getLastJob() { return get().lastJob; }

function clearLastJob() { patch(d => { d.lastJob = null; }); }

/** v3: snapshot every live job so all parallel recordings survive a restart. */
function setLastJobs(jobs) {
  patch(d => {
    d.lastJobs = (jobs || []).filter(j => j && ['running', 'stopping', 'scheduled'].includes(j.status))
      .map(j => ({
        id: j.id, mode: j.mode, label: j.label, stationId: j.stationId || '',
        status: j.status, startAt: j.startAt, startedAt: j.startedAt,
        durationSec: j.durationSec, config: j.config, repeatDaily: !!j.repeatDaily,
        planId: j.planId || '', savedAt: Date.now()
      }));
  });
}
function getLastJobs() { return get().lastJobs.slice(); }
function clearLastJobs() { patch(d => { d.lastJobs = []; d.lastJob = null; }); }

function bumpStats(fields) {
  patch(d => {
    for (const k of Object.keys(fields || {})) {
      d.stats[k] = (Number(d.stats[k]) || 0) + Number(fields[k] || 0);
    }
  });
}

/* ------------------------------ logs ------------------------------ */

function logFile(date) { return path.join(LOG_DIR, `${date || dateKey(new Date())}.log`); }

function appendLog(line) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(logFile(), line + '\n', 'utf8');
  } catch (e) { /* logging must never break recording */ }
}

function listLogDates() {
  try {
    return fs.readdirSync(LOG_DIR)
      .filter(f => /^\d{4}-\d{2}-\d{2}\.log$/.test(f))
      .map(f => f.slice(0, 10)).sort().reverse();
  } catch (e) { return []; }
}

function readLog(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return '';
  try { return fs.readFileSync(logFile(date), 'utf8'); }
  catch (e) { return ''; }
}

module.exports = {
  ROOT, FILE, LOG_DIR, DEFAULT_CLEANUP, dateKey,
  get, save, patch,
  listPlans, addPlan, updatePlan, removePlan,
  wasTriggered, markTriggered,
  setLastJob, getLastJob, clearLastJob,
  setLastJobs, getLastJobs, clearLastJobs,
  bumpStats,
  appendLog, listLogDates, readLog
};
