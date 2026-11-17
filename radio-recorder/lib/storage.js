'use strict';

/*
 * storage.js - disk water level, audio health checks and retention cleanup.
 *
 * Cleanup is deliberately split into "compute" and "execute": the UI always
 * shows a preview first, and automatic cleanup is opt-in (disabled by default).
 * Files still being written (mtime within the last 90 s) are never touched.
 */

const fs = require('fs');
const path = require('path');

const AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.flac', '.wav', '.ts']);
const SKIP_RECENT_MS = 90 * 1000;

/* --------------------------- disk water level --------------------------- */

function diskInfo(dir) {
  try {
    const p = fs.existsSync(dir) ? dir : path.dirname(dir);
    const s = fs.statfsSync(p);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    return { valid: true, total, free, used: Math.max(0, total - free), mount: p };
  } catch (e) {
    return { valid: false, total: 0, free: 0, used: 0, mount: dir };
  }
}

/* ------------------------------- files --------------------------------- */

function audioFiles(dir) {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(f => AUDIO_EXT.has(path.extname(f).toLowerCase()))
      .map(f => {
        const st = fs.statSync(path.join(dir, f));
        return { name: f, size: st.size, mtime: st.mtimeMs };
      }).sort((a, b) => b.mtime - a.mtime);
  } catch (e) { return []; }
}

/* --------------------------- MP3 frame check --------------------------- */

function mp3Frame(b, i) {
  if (i + 3 >= b.length) return null;
  const h = (b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3];
  if ((h >>> 21) !== 0x7ff) return null;          // 11 sync bits
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

/**
 * Read only the head of a file: find a valid frame chain, then estimate
 * duration from size / bitrate (CBR live streams are accurate to ~1%).
 */
function inspectAudio(dir, name) {
  const full = path.join(dir, name);
  let size = 0;
  let fd = null;
  try {
    size = fs.statSync(full).size;
    if (!AUDIO_EXT.has(path.extname(name).toLowerCase())) return { healthy: null, size, durationSec: 0 };
    if (path.extname(name).toLowerCase() !== '.mp3') return { healthy: null, size, durationSec: 0 };
    // v3.1.12：0 字节是「重连后未落盘任何音频」的空片段，不是内容损坏。
    // 新任务会在收尾时自动清理；历史遗留文件在 UI 上也不再误报「疑似损坏」。
    if (size < 8) return {
      healthy: false, size, durationSec: 0,
      reason: size === 0 ? '空片段（源中断）' : '文件过小'
    };
    fd = fs.openSync(full, 'r');
    const n = Math.min(size, 32768);
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, 0);
    let start = -1, info = null;
    for (let i = 0; i < n - 8; i++) {
      const f = mp3Frame(buf, i);
      if (f && f.layer === 1 && mp3Frame(buf, i + f.len)) { start = i; info = f; break; }
    }
    if (start < 0) return { healthy: false, size, durationSec: 0, reason: '未找到 MP3 帧同步' };
    let p = start, frames = 0;
    while (p + 4 < n && frames < 120) {
      const f = mp3Frame(buf, p);
      if (!f || f.layer !== 1) break;
      frames++; p += f.len;
    }
    const bitrate = info.br, samplerate = info.sr;
    return {
      healthy: frames >= 3,
      size,
      frames,
      codec: `MPEG-${info.ver === 3 ? 1 : 2} Layer III`,
      bitrate, samplerate,
      durationSec: bitrate ? Math.round(size * 8 / (bitrate * 1000)) : 0,
      prefixBytes: start,
      reason: frames >= 3 ? '' : '帧链不完整'
    };
  } catch (e) {
    return { healthy: false, size, durationSec: 0, reason: e.message };
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch (e) { /* ignore */ } }
  }
}

/* ------------------------------- cleanup ------------------------------- */

/**
 * Returns the deletion candidates WITHOUT deleting anything.
 * Three independent triggers: retention age, total-size cap, low free space.
 */
function computeClean(dir, opts, activeNames, now) {
  const o = Object.assign({ enabled: false, retentionDays: 90, maxTotalGB: 0, minFreeGB: 5 }, opts || {});
  const all = audioFiles(dir);
  const disk = diskInfo(dir);
  const totalBytes = all.reduce((s, f) => s + f.size, 0);
  const active = activeNames instanceof Set ? activeNames : new Set(activeNames || []);
  const cutoff = (now || Date.now()) - Number(o.retentionDays) * 86400000;
  const capBytes = Number(o.maxTotalGB) * 1073741824;
  const minFree = Number(o.minFreeGB) * 1073741824;

  // oldest first; never touch a file that is still being written
  const pool = all.filter(f =>
    !active.has(f.name) && (now || Date.now()) - f.mtime > SKIP_RECENT_MS
  ).sort((a, b) => a.mtime - b.mtime);

  const candidates = [];
  let freed = 0, simulatedTotal = totalBytes, simulatedFree = disk.free;
  for (const f of pool) {
    let reason = '';
    if (f.mtime < cutoff) reason = `超过保留期 ${o.retentionDays} 天`;
    else if (capBytes > 0 && simulatedTotal > capBytes) reason = `录音总量超过 ${o.maxTotalGB} GiB 上限`;
    else if (minFree > 0 && disk.valid && simulatedFree < minFree) reason = `磁盘可用空间低于 ${o.minFreeGB} GiB`;
    if (!reason) continue;
    candidates.push({ name: f.name, size: f.size, mtime: f.mtime, reason });
    freed += f.size;
    simulatedTotal -= f.size;
    simulatedFree += f.size;
  }
  return {
    candidates, freed, totalBytes, disk,
    fileCount: all.length,
    skippedActive: all.length - pool.length,
    policy: o
  };
}

/** Delete explicit names inside `dir` only. Returns a per-file report. */
function executeClean(dir, names) {
  const root = path.resolve(dir);
  const deleted = [], errors = [];
  let bytes = 0;
  for (const raw of names || []) {
    const name = path.basename(String(raw));
    const file = path.resolve(root, name);
    if (!file.startsWith(root + path.sep)) { errors.push({ name, message: '非法路径' }); continue; }
    try {
      const size = fs.statSync(file).size;
      fs.unlinkSync(file);
      deleted.push(name);
      bytes += size;
    } catch (e) { errors.push({ name, message: e.message }); }
  }
  return { deleted, errors, bytes };
}

module.exports = {
  AUDIO_EXT, SKIP_RECENT_MS,
  diskInfo, audioFiles, inspectAudio,
  computeClean, executeClean
};
