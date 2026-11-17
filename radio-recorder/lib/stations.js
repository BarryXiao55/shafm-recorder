'use strict';
/*
 * 上海地区 FM 广播电台库（仅上海本地 FM 频率，不含全国台 / 网络台 / 境外台）。
 * 每条频道的直播流均于 2026-11-14 实测 HTTP 200 且持续吐音频字节。
 * 用户可自行增删改，变更写入 stations.json；内置项只作为首次运行种子。
 */

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'stations.json');

/* channelId 同时是蜻蜓节目表页面 https://m.qtfm.cn/channels/<id>/ 的路径参数 */
const SEED = [
  { id: 'sh_news',    name: '上海新闻广播',       freq: 'FM 93.4 / AM 990',  channelId: 270,   prefix: 'FM990',  url: 'https://lhttp-hw.qtfm.cn/live/270/64k.mp3',    backup: 'http://lhttp.qingting.fm/live/270/64k.mp3' },
  { id: 'sh_traffic', name: '上海交通广播',       freq: 'FM 105.7 / AM 648', channelId: 266,   prefix: 'FM1057', url: 'https://lhttp-hw.qtfm.cn/live/266/64k.mp3',    backup: 'http://lhttp.qingting.fm/live/266/64k.mp3' },
  { id: 'sh_cbn',     name: '第一财经广播',       freq: 'FM 90.9',           channelId: 276,   prefix: 'FM909',  url: 'https://lhttp-hw.qtfm.cn/live/276/64k.mp3',    backup: '' },
  { id: 'sh_yangtze', name: '长三角之声',         freq: 'FM 89.9',           channelId: 275,   prefix: 'FM899',  url: 'https://lhttp-hw.qtfm.cn/live/275/64k.mp3',    backup: 'http://lhttp.qingting.fm/live/275/64k.mp3' },
  { id: 'sh_classic', name: '经典947',            freq: 'FM 94.7',           channelId: 267,   prefix: 'FM947',  url: 'https://lhttp-hw.qtfm.cn/live/267/64k.mp3',    backup: 'http://lhttp.qingting.fm/live/267/64k.mp3' },
  { id: 'sh_opera',   name: '上海戏剧曲艺广播',   freq: 'FM 97.2 / AM 1197', channelId: 269,   prefix: 'FM972',  url: 'https://lhttp-hw.qtfm.cn/live/269/64k.mp3',    backup: 'http://lhttp.qingting.fm/live/269/64k.mp3' },
  { id: 'sh_love',    name: 'LoveRadio 经典金曲',  freq: 'FM 103.7',          channelId: 273,   prefix: 'FM1037', url: 'https://lhttp-hw.qtfm.cn/live/273/64k.mp3',    backup: 'http://lhttp.qingting.fm/live/273/64k.mp3' },
  { id: 'sh_pop',     name: '动感101',            freq: 'FM 101.7',          channelId: 274,   prefix: 'FM1017', url: 'https://lhttp-hw.qtfm.cn/live/274/64k.mp3',    backup: 'http://lhttp.qingting.fm/live/274/64k.mp3' },
  { id: 'sh_pudong',  name: '浦东新娱乐广播',     freq: 'FM 100.1',          channelId: 5022341, prefix: 'FM1001', url: 'https://lhttp-hw.qtfm.cn/live/5022341/64k.mp3', backup: 'http://lhttp.qingting.fm/live/5022341/64k.mp3' },
  { id: 'sh_east',    name: '东上海之声',         freq: 'FM 106.5',          channelId: 21355, prefix: 'FM1065', url: 'https://lhttp-hw.qtfm.cn/live/21355/64k.mp3',  backup: 'http://lhttp.qingting.fm/live/21355/64k.mp3' },
  { id: 'sh_cgtn879', name: 'CGTN Radio 英语环球广播', freq: 'FM 87.9（上海落地 · 中央级）', channelId: 0, prefix: 'FM879',
    url: 'https://sk.cri.cn/am846.m3u8', backup: '',
    note: '中央广播电视总台在上海的落地频率，非 SMG 本地台；AAC 48 kHz 立体声 HLS，录出 .ts（零重编码）。' }
];

let cache = null;

function read() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    cache = Array.isArray(raw) && raw.length ? raw : SEED.map(x => Object.assign({ builtin: true }, x));
  } catch (e) {
    cache = SEED.map(x => Object.assign({ builtin: true }, x));
  }
  return cache;
}

function write(list) {
  cache = list;
  try { fs.writeFileSync(FILE, JSON.stringify(list, null, 2), 'utf8'); }
  catch (e) { /* read-only disk: keep in memory */ }
}

function list() { return read().map(x => Object.assign({}, x)); }
function get(id) { return read().find(x => x.id === String(id)) || null; }

function validate(s) {
  const name = String(s.name || '').trim();
  const url = String(s.url || '').trim();
  if (!name || name.length > 40) return '电台名称不能为空且不超过 40 字';
  if (!/^https?:\/\//i.test(url)) return '直播流地址必须以 http:// 或 https:// 开头';
  const freq = String(s.freq || '').trim();
  if (!/FM/i.test(freq)) return '本电台库只收录上海地区 FM 广播，频率请填写 FM xx.x';
  return null;
}

/** FM 频率 → 文件名前缀：FM 99.0 → FM990、FM 105.7 → FM1057、FM 94.7 → FM947。 */
function prefixFromFreq(freq) {
  const m = String(freq || '').match(/FM\s*(\d+(?:\.\d+)?)/i);
  return m ? 'FM' + m[1].replace(/\./g, '') : '';
}

/** 电台的有效前缀：显式配置优先（保留 AM990→FM990 这类历史命名），否则按频率推导。 */
function prefixFor(s) {
  const configured = String((s && s.prefix) || '').trim();
  if (configured && configured !== 'REC') {
    return configured.replace(/[\\/:*?"<>|%]/g, '_').slice(0, 24);
  }
  return prefixFromFreq(s && s.freq) || 'REC';
}

function add(s) {
  const err = validate(s);
  if (err) return { ok: false, message: err };
  const listNow = read();
  const id = 'custom_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const item = {
    id, name: String(s.name).trim(), freq: String(s.freq).trim(),
    channelId: Number(s.channelId) || 0,
    prefix: prefixFor(s),
    url: String(s.url).trim(), backup: String(s.backup || '').trim(), builtin: false
  };
  write(listNow.concat([item]));
  return { ok: true, station: item };
}

function update(id, patch) {
  const listNow = read();
  const i = listNow.findIndex(x => x.id === String(id));
  if (i < 0) return { ok: false, message: '电台不存在' };
  const merged = Object.assign({}, listNow[i], patch, { id: listNow[i].id, builtin: listNow[i].builtin });
  const err = validate(merged);
  if (err) return { ok: false, message: err };
  merged.channelId = Number(merged.channelId) || 0;
  merged.prefix = prefixFor(merged);
  listNow[i] = merged;
  write(listNow);
  return { ok: true, station: merged };
}

function remove(id) {
  const listNow = read();
  const next = listNow.filter(x => x.id !== String(id));
  if (next.length === listNow.length) return { ok: false, message: '电台不存在' };
  write(next);
  return { ok: true };
}

/** Quick liveness check: does the URL return 200 and actually stream bytes? */
function probe(url, ms) {
  return new Promise(resolve => {
    const lib = /^https:/i.test(url) ? require('https') : require('http');
    let bytes = 0, status = 0, head = '', finished = false, req;
    const limit = Math.max(1200, Math.min(6000, ms || 2500));
    function done(err) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { if (req) req.destroy(); } catch (e) { /* ignore */ }
      resolve({ ok: status === 200 && bytes > 200, status, bytes, head, message: err || (status === 200 ? '' : 'HTTP ' + status) });
    }
    const timer = setTimeout(() => done(), limit);
    try {
      req = lib.get(url, { headers: { 'Icy-MetaData': '0', 'User-Agent': 'FM-Recorder/3' } }, resp => {
        status = resp.statusCode;
        if (status !== 200) { resp.resume(); return done(); }
        resp.on('data', d => {
          if (!head) head = d.slice(0, 8).toString('hex');
          bytes += d.length;
          if (bytes > 6000) done();
        });
        resp.on('end', () => done());
        resp.on('error', e => done(e.message));
      });
      req.setTimeout(limit, () => req.destroy(new Error('timeout')));
      req.on('error', e => done(e.message));
    } catch (e) { done(e.message); }
  });
}

module.exports = { list, get, add, update, remove, probe, validate, prefixFromFreq, prefixFor, SEED, FILE };
