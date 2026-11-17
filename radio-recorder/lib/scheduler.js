'use strict';

/*
 * scheduler.js - pure scheduling logic (no I/O, no timers).
 * Kept separate so the rules can be unit-tested without starting the server.
 *
 * Plan shape:
 *   { id, name, enabled, startTime:"HH:MM", durationMin, rule,
 *     weekdays:[0..6], date:"YYYY-MM-DD", streamUrl:"", filePrefix:"",
 *     stationId:"", prefixMode:"auto|manual|fallback" }
 *
 * rule: daily | weekday | weekend | weekly | once
 *
 * v3.1.10：前缀解析统一交给 public/plan-prefix.js（同样是零 I/O 的纯函数），
 * 保证「保存节目单」与「节目单到点触发」得到完全相同的前缀。
 */

const planPrefix = require('../public/plan-prefix.js');
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
const RULES = [
  { id: 'daily', label: '每天' },
  { id: 'weekday', label: '工作日（周一至周五）' },
  { id: 'weekend', label: '周末（周六、周日）' },
  { id: 'weekly', label: '指定星期' },
  { id: 'once', label: '仅一次（指定日期）' }
];

const pad = n => String(n).padStart(2, '0');

function dateKey(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fmtAt(ms) {
  const d = new Date(ms);
  return `${dateKey(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function parseStart(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return { h: h, m: mi };
}

function validatePlan(input) {
  const p = Object.assign({}, input || {});
  const t = parseStart(p.startTime);
  if (!t) return { ok: false, message: '开始时间格式应为 HH:MM（如 06:00）' };
  p.startTime = `${pad(t.h)}:${pad(t.m)}`;

  p.durationMin = Math.round(Number(p.durationMin));
  if (!isFinite(p.durationMin) || p.durationMin < 1 || p.durationMin > 1440) {
    return { ok: false, message: '录制时长需在 1 ~ 1440 分钟之间' };
  }

  p.rule = RULES.some(r => r.id === p.rule) ? p.rule : 'daily';
  p.name = String(p.name || '').trim().slice(0, 60) || '未命名节目';
  p.enabled = p.enabled !== false;
  p.streamUrl = String(p.streamUrl || '').trim();
  p.filePrefix = String(p.filePrefix || '').trim();
  p.stationId = String(p.stationId || '').trim();
  p.weekdays = Array.isArray(p.weekdays)
    ? p.weekdays.map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 6).filter((n, i, a) => a.indexOf(n) === i)
    : [];
  p.date = /^\d{4}-\d{2}-\d{2}$/.test(String(p.date || '')) ? p.date : '';

  if (p.rule === 'weekly' && !p.weekdays.length) return { ok: false, message: '「指定星期」至少要勾选一天' };
  if (p.rule === 'once' && !p.date) return { ok: false, message: '「仅一次」需要指定日期' };
  return { ok: true, plan: p };
}

function matchesDate(plan, d) {
  const wd = d.getDay();
  switch (plan.rule) {
    case 'weekday': return wd >= 1 && wd <= 5;
    case 'weekend': return wd === 0 || wd === 6;
    case 'weekly': return plan.weekdays.includes(wd);
    case 'once': return dateKey(d) === plan.date;
    default: return true;
  }
}

function fireAtOn(plan, d) {
  const t = parseStart(plan.startTime);
  if (!t) return NaN;
  const x = new Date(d.getTime());
  x.setHours(t.h, t.m, 0, 0);
  return x.getTime();
}

/** Next fire strictly after `afterMs`; null when no future occurrence exists. */
function nextFire(plan, afterMs) {
  if (!plan.enabled) return null;
  const base = new Date(afterMs);
  base.setHours(0, 0, 0, 0);
  for (let i = 0; i < 400; i++) {
    const d = new Date(base.getTime());
    d.setDate(base.getDate() + i);
    if (!matchesDate(plan, d)) continue;
    const f = fireAtOn(plan, d);
    if (f > afterMs) return f;
  }
  return null;
}

/**
 * Is this plan due right now? A short catch-up window (default 5 min) lets a
 * just-restarted service still fire, but avoids back-filling a programme that
 * is already half over. Day -1 is checked too, for midnight boundary cases.
 */
function duePlan(plan, nowMs, catchUpMs) {
  if (!plan.enabled) return null;
  const limit = catchUpMs == null ? 5 * 60 * 1000 : catchUpMs;
  for (const offset of [0, -1]) {
    const d = new Date(nowMs + offset * 86400000);
    if (!matchesDate(plan, d)) continue;
    const f = fireAtOn(plan, d);
    const delta = nowMs - f;
    if (delta >= 0 && delta <= limit) return { fireAt: f, key: dateKey(d) };
  }
  return null;
}

function describe(plan) {
  let r;
  switch (plan.rule) {
    case 'weekday': r = '工作日'; break;
    case 'weekend': r = '周末'; break;
    case 'weekly': r = '周' + plan.weekdays.slice().sort().map(n => WEEK[n]).join('/'); break;
    case 'once': r = plan.date; break;
    default: r = '每天';
  }
  return `${r} ${plan.startTime} · ${plan.durationMin} 分钟`;
}

/** Config overrides applied to a job started by a plan. */
/**
 * 节目单 → 任务配置。
 * v3.1.10：不再无条件回退到全局 filePrefix。只要能通过 stationId 或 streamUrl
 * 识别出电台，就强制使用其频率前缀；这样即使 runtime.json 里存的是旧错值，
 * 到点触发时也照样录成 FM1057 / FM909，而不是全变成 FM990。
 * stationsList 可选（单元自测不传时保持旧行为的兜底）。
 */
function planJobConfig(plan, globalConfig, stationsList) {
  const norm = planPrefix.normalizePlan(plan, stationsList || [], globalConfig.filePrefix);
  return Object.assign({}, globalConfig, {
    mode: 'now',
    durationMinutes: plan.durationMin,
    streamUrl: plan.streamUrl || globalConfig.streamUrl,
    filePrefix: norm.filePrefix,
    stationId: norm.stationId || '',
    outputDir: globalConfig.outputDir,
    monitor: false,          // scheduled recordings must never blast audio
    repeatDaily: false,
    autoRestart: true
  });
}

module.exports = {
  WEEK, RULES, dateKey, fmtAt, parseStart,
  validatePlan, matchesDate, fireAtOn, nextFire, duePlan, describe, planJobConfig
};
