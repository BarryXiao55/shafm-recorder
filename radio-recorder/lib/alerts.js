'use strict';
/*
 * 告警中心：录制失败 / 反复断流 / 磁盘水位 / 节目单启动失败 等事件统一汇聚，
 * 界面显示未读红点，可选推送到 Webhook（企业微信 / 钉钉 / 自定义 JSON）。
 * 不去重会把断流刷屏，所以同类型事件 5 分钟内只记一次。
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const FILE = path.join(__dirname, '..', 'alerts.json');
const MAX = 200;
const DEDUP_MS = 5 * 60 * 1000;

const DEFAULT_POLICY = {
  enabled: true,
  webhookUrl: '',
  webhookType: 'auto',      // auto | generic | wecom | dingtalk
  onFailure: true,
  onDisconnect: true,
  onDisk: true,
  onPlan: true
};

let data = null;

function load() {
  if (data) return data;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    data = { policy: Object.assign({}, DEFAULT_POLICY, raw.policy || {}), events: Array.isArray(raw.events) ? raw.events : [] };
  } catch (e) {
    data = { policy: Object.assign({}, DEFAULT_POLICY), events: [] };
  }
  return data;
}
function save() {
  try { fs.writeFileSync(FILE, JSON.stringify(data, null, 2), 'utf8'); }
  catch (e) { /* best effort */ }
}

function getPolicy() { return Object.assign({}, load().policy); }

function setPolicy(patch) {
  const d = load();
  for (const k of Object.keys(DEFAULT_POLICY)) {
    if (Object.prototype.hasOwnProperty.call(patch, k)) {
      d.policy[k] = typeof DEFAULT_POLICY[k] === 'boolean' ? !!patch[k] : String(patch[k] || '').trim();
    }
  }
  save();
  return getPolicy();
}

function list(limit) { return load().events.slice(0, Math.max(1, Math.min(MAX, limit || 60))); }
function unread() { return load().events.filter(e => !e.read).length; }

function markRead(id) {
  const d = load();
  const e = d.events.find(x => x.id === String(id));
  if (!e) return false;
  e.read = true; save(); return true;
}
function markAllRead() { const d = load(); d.events.forEach(e => { e.read = true; }); save(); return true; }
function clear() { load().events = []; save(); return true; }

function buildBody(type, policy, ev) {
  const text = `【FM990 录制台${ev.level === 'error' ? '·异常' : ev.level === 'warn' ? '·提醒' : '·消息'}】\n${ev.message}\n时间：${new Date(ev.at).toLocaleString('zh-CN', { hour12: false })}`;
  const u = String(policy.webhookUrl || '');
  const t = policy.webhookType === 'auto'
    ? (/qyapi\.weixin\.qq\.com/.test(u) ? 'wecom' : /dingtalk\.com|oapi\.dingtalk/.test(u) ? 'dingtalk' : 'generic')
    : policy.webhookType;
  if (t === 'wecom') return { msgtype: 'text', text: { content: text } };
  if (t === 'dingtalk') return { msgtype: 'text', text: { content: text } };
  return { title: 'FM990 录制台', level: ev.level, type: ev.type, message: ev.message,
    at: ev.at, source: 'FM990 Radio Recorder v3' };
}

function post(url, body) {
  return new Promise(resolve => {
    let req;
    try {
      const lib = /^https:/i.test(url) ? https : http;
      const payload = JSON.stringify(body);
      req = lib.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }, timeout: 8000 }, resp => {
        resp.resume();
        resp.on('end', () => resolve({ ok: resp.statusCode >= 200 && resp.statusCode < 300, status: resp.statusCode }));
      });
      req.on('error', e => resolve({ ok: false, message: e.message }));
      req.on('timeout', () => { try { req.destroy(); } catch (e) { /* ignore */ } resolve({ ok: false, message: 'timeout' }); });
      req.write(payload);
      req.end();
    } catch (e) { resolve({ ok: false, message: e.message }); }
  });
}

async function sendWebhook(body) {
  const p = getPolicy();
  if (!p.enabled || !p.webhookUrl) return { ok: false, message: '未配置 Webhook' };
  if (!/^https?:\/\//i.test(p.webhookUrl)) return { ok: false, message: 'Webhook 地址必须以 http(s):// 开头' };
  return post(p.webhookUrl, body);
}

/**
 * 记录一条告警。type: failure | disconnect | disk | plan | info
 * 返回 { event, deduped }。onLog 回调把内容同时写进运行日志。
 */
function raise(type, level, message, jobId, onLog) {
  const d = load();
  const now = Date.now();
  const policy = d.policy;
  const key = type + '|' + String(message).slice(0, 80);
  const recent = d.events.find(e => e.key === key && now - e.at < DEDUP_MS);
  if (recent) return { deduped: true, event: recent };

  const ev = {
    id: now.toString(36) + Math.random().toString(36).slice(2, 6),
    key, type, level: level || 'warn', message: String(message), jobId: jobId || '',
    at: now, read: false
  };
  d.events.unshift(ev);
  if (d.events.length > MAX) d.events.length = MAX;
  save();
  if (onLog) { try { onLog(`⚠ [${type}] ${ev.message}`); } catch (e) { /* ignore */ } }

  const flag = { failure: 'onFailure', disconnect: 'onDisconnect', disk: 'onDisk', plan: 'onPlan' }[type];
  if (policy.enabled && policy.webhookUrl && (flag === undefined || policy[flag])) {
    post(policy.webhookUrl, buildBody(type, policy, ev)).then(r => {
      if (!r.ok) { try { if (onLog) onLog(`Webhook 推送失败: ${r.message || 'HTTP ' + r.status}`); } catch (e) { /* ignore */ } }
    });
  }
  return { deduped: false, event: ev };
}

module.exports = { getPolicy, setPolicy, list, unread, markRead, markAllRead, clear, raise, sendWebhook, buildBody, DEFAULT_POLICY };
