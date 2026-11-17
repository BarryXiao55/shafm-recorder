'use strict';
/*
 * EPG 电子节目单：自动抓取蜻蜓 FM 各频道页内嵌的 window.__initStores
 * ( ChannelStore.playBill = { yesterday, today, tomorrow } )，本地按日缓存。
 * 断网时降级到内置的上海新闻广播静态节目表，保证节目单永远可用。
 *
 * 只做「读节目表」，不碰任何回听音频、不绕过任何鉴权。
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const CACHE_FILE = path.join(__dirname, '..', 'epg-cache.json');
const SOURCE = 'https://m.qtfm.cn/channels/{id}/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';

let cache = null;

function loadCache() {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); }
  catch (e) { cache = {}; }
  if (!cache || typeof cache !== 'object') cache = {};
  return cache;
}
function saveCache() {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 1), 'utf8'); }
  catch (e) { /* best effort */ }
}

function pad(n) { return String(n).padStart(2, '0'); }
function dateKey(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

/* 从 "00:00 ~ 02:00" 解析分钟；跨午夜自动 +1440 */
function normalize(p, dayKey) {
  const m = /(\d{1,2}):(\d{2})\s*~\s*(\d{1,2}):(\d{2})/.exec(String(p.durationStr || ''));
  if (!m) return null;
  const sm = Number(m[1]) * 60 + Number(m[2]);
  let em = Number(m[3]) * 60 + Number(m[4]);
  if (em <= sm) em += 1440;
  return {
    date: dayKey,
    start: `${pad(m[1])}:${m[2]}`,
    end: `${pad(Number(m[3]))}:${m[4]}`,
    startMin: sm,
    endMin: em,
    durationMin: em - sm,
    title: String(p.title || '').trim() || '未命名节目',
    broadcaster: String(p.broadcasterNames || '').trim(),
    programId: p.programId || 0
  };
}

/* 从 HTML 中按花括号配平切出 __initStores 的 JSON 对象 */
function extractJson(html) {
  const i = html.indexOf('window.__initStores');
  if (i < 0) return null;
  const start = html.indexOf('{', i);
  const end = html.indexOf('</script>', start);
  if (start < 0) return null;
  const raw = (end > 0 ? html.slice(start, end) : html.slice(start));
  let depth = 0, inStr = false, esc = false;
  for (let k = 0; k < raw.length; k++) {
    const c = raw[k];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) {
      try { return JSON.parse(raw.slice(0, k + 1)); } catch (e) { return null; }
    } }
  }
  return null;
}

function fetchHtml(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN' } }, resp => {
      if ([301, 302, 303, 307, 308].includes(resp.statusCode) && resp.headers.location) {
        resp.resume();
        return resolve(fetchHtml(new URL(resp.headers.location, url).toString(), timeoutMs));
      }
      if (resp.statusCode !== 200) { resp.resume(); return reject(new Error('HTTP ' + resp.statusCode)); }
      const chunks = [];
      resp.on('data', d => { chunks.push(d); if (Buffer.concat(chunks).length > 900000) req.destroy(); });
      resp.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      resp.on('error', e => reject(e));
    });
    req.setTimeout(timeoutMs || 12000, () => req.destroy(new Error('timeout')));
    req.on('error', e => reject(e));
  });
}

/** 抓一个频道，写入缓存，返回 { ok, stationId, days, source, fetchedAt } */
async function refresh(channelId, stationId) {
  const id = Number(channelId);
  if (!id) return { ok: false, message: '该电台没有关联的频道 ID，无法拉取节目表' };
  let html;
  try { html = await fetchHtml(SOURCE.replace('{id}', String(id))); }
  catch (e) { return { ok: false, message: '节目表源不可达：' + e.message }; }

  const store = extractJson(html);
  const bill = store && store.ChannelStore && store.ChannelStore.playBill;
  if (!bill) return { ok: false, message: '节目表源结构变化，未解析到 playBill' };

  const now = new Date();
  const mk = off => { const d = new Date(now.getTime() + off * 86400000); return dateKey(d); };
  const map = { yesterday: mk(-1), today: mk(0), tomorrow: mk(1) };
  const days = {};
  let count = 0;
  for (const k of Object.keys(map)) {
    const arr = Array.isArray(bill[k]) ? bill[k] : [];
    days[map[k]] = arr.map(p => normalize(p, map[k])).filter(Boolean)
      .sort((a, b) => a.startMin - b.startMin);
    count += days[map[k]].length;
  }
  if (!count) return { ok: false, message: '节目表为空' };

  const c = loadCache();
  c[String(stationId || id)] = { fetchedAt: Date.now(), source: SOURCE.replace('{id}', String(id)), channelId: id, days };
  saveCache();
  return { ok: true, stationId: String(stationId || id), fetchedAt: Date.now(), days, source: 'm.qtfm.cn' };
}

/** 取某电台某天的节目单；dayKey 省略为今天。返回带 live 标记的数组。 */
function getDay(stationId, channelId, dayKey) {
  const key = dayKey || dateKey(new Date());
  const c = loadCache();
  const hit = c[String(stationId)];
  let list = hit && hit.days && hit.days[key];
  let source = hit ? 'cache' : 'none';

  if (!list || !list.length) {
    const fb = fallback(Number(channelId), key);
    if (fb.length) { list = fb; source = 'builtin'; }
  }
  if (!list) list = [];

  const now = new Date();
  const today = dateKey(now);
  const cur = now.getHours() * 60 + now.getMinutes();
  return {
    ok: true, date: key, source,
    fetchedAt: hit ? hit.fetchedAt : 0,
    programmes: list.map(p => Object.assign({}, p, {
      live: key === today && cur >= p.startMin && cur < p.endMin,
      past: key < today || (key === today && cur >= p.endMin)
    }))
  };
}

function cacheInfo() {
  const c = loadCache();
  return Object.keys(c).map(k => ({ stationId: k, fetchedAt: c[k].fetchedAt, channelId: c[k].channelId,
    days: Object.keys(c[k].days || {}).map(d => ({ date: d, count: (c[k].days[d] || []).length })) }));
}

/* ---------------- 离线兜底：上海新闻广播 2026 节目表 ----------------
   来源：广播迷 / RadioTime / YunFM 公开的 AM990 FM93.4 节目时间表。
   仅当在线源不可达时使用，避免界面空白。                              */
const FALLBACK = {
  weekday: '00:00-02:00|947爱乐厅;02:00-03:00|活过100岁;03:00-04:00|法眼看天下;04:00-05:00|十万个为什么;05:00-06:00|活过100岁;06:00-06:30|清晨新闻;06:30-07:00|转播新闻和报纸摘要;07:00-09:00|990早新闻;09:00-10:00|直通990;10:00-11:00|海波热线;11:00-12:00|民生一网通;12:00-13:00|市民与社会;13:00-15:00|直通990;15:00-16:00|活过100岁;16:00-17:00|法眼看天下;17:00-18:30|今晚;18:30-19:00|转播全国新闻联播;19:00-20:00|阿拉HUI生活;20:00-21:00|十万个为什么;21:00-21:30|新闻编辑室;21:30-22:00|空中体坛晚间直播;22:00-23:00|民生一网通;23:00-24:00|市民与社会',
  saturday: '00:00-05:00|停机检修;05:00-06:00|活过100岁;06:00-06:30|清晨新闻;06:30-07:00|转播新闻和报纸摘要;07:00-09:00|990早新闻;09:00-10:00|直通990;10:00-11:00|海波热线;11:00-12:00|民生一网通;12:00-13:00|市民与社会;13:00-15:00|直通990;15:00-16:00|活过100岁;16:00-17:00|法眼看天下;17:00-18:30|今晚;18:30-19:00|转播全国新闻联播;19:00-20:00|阿拉HUI生活;20:00-21:00|十万个为什么;21:00-21:30|新闻编辑室;21:30-22:00|空中体坛晚间直播;22:00-23:00|民生一网通;23:00-24:00|市民与社会',
  sunday: '00:00-02:00|947爱乐厅;02:00-03:00|活过100岁;03:00-04:00|法眼看天下;04:00-05:00|十万个为什么;05:00-06:00|活过100岁;06:00-06:30|清晨新闻;06:30-07:00|转播新闻和报纸摘要;07:00-09:00|990早新闻;09:00-10:00|直通990;10:00-11:00|周末来打卡;11:00-12:00|教子有方;12:00-13:00|听江南;13:00-15:00|直通990;15:00-16:00|问律师;16:00-17:00|青未来FM;17:00-18:00|极客秀;18:00-18:30|今晚;18:30-19:00|转播全国新闻联播;19:00-20:00|人文星空下;20:00-21:00|海上畅谈;21:00-21:30|新闻编辑室;21:30-22:00|空中体坛晚间直播;22:00-23:00|教子有方;23:00-24:00|听江南'
};

function fallback(channelId, dayKey) {
  if (Number(channelId) !== 270) return [];      // 静态表只覆盖上海新闻广播
  const d = new Date(dayKey + 'T00:00:00');
  if (isNaN(d.getTime())) return [];
  const key = d.getDay() === 0 ? 'sunday' : d.getDay() === 6 ? 'saturday' : 'weekday';
  return FALLBACK[key].split(';').map(s => {
    const [range, title] = s.split('|');
    const [a, b] = range.split('-');
    const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
    return { date: dayKey, start: a, end: b === '24:00' ? '23:59' : b,
      startMin: toMin(a), endMin: toMin(b), durationMin: toMin(b) - toMin(a),
      title, broadcaster: '', programId: 0 };
  }).sort((x, y) => x.startMin - y.startMin);
}

/** 把一个 EPG 节目转成节目单计划对象（供 scheduler.validatePlan 使用） */
function toPlan(programme, station, rule) {
  return {
    name: `${station.name} · ${programme.title}`,
    startTime: programme.start,
    durationMin: Math.max(1, Math.round(programme.durationMin)),
    rule: rule || 'daily',
    stationId: station.id,
    streamUrl: station.url,
    filePrefix: station.prefix,
    days: []
  };
}

module.exports = { refresh, getDay, cacheInfo, refreshUrl: SOURCE, fallback, toPlan, normalize, extractJson, dateKey, CACHE_FILE };
