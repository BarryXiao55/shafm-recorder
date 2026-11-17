'use strict';
/*
 * segment-guard.js - v3.1.12 空片段守卫（零依赖，可单独测试）。
 *
 * 背景：直播源在任务尾部短暂中断时，重连后的 ffmpeg 会先创建输出文件再
 * 尝试拉流；若直到任务到点都没有一个完整音频帧落盘，就会留下 0 字节文件，
 * UI 误报「疑似损坏」。本模块提供三项守卫所需的纯判定与安全清理：
 *
 *   1) sweepEmptySegments() - 只删除本次任务自己创建、且小于阈值的文件；
 *   2) TAIL_RECONNECT_MIN_SEC - 尾部剩余时间小于等于它时不再重连；
 *   3) FIRST_FRAME_TIMEOUT_MS - 重连后首帧超时时间。
 *
 * 安全约束：绝不扫描目录、绝不按通配符删除、绝不触碰调用方没传进来的文件。
 */

const fs = require('fs');
const path = require('path');

const EMPTY_FILE_BYTES = 8;           // 小于 8 字节不可能包含完整 MP3 帧
const TAIL_RECONNECT_MIN_SEC = 15;    // 尾部 ≤ 15 秒：直接按源中断结束
const FIRST_FRAME_TIMEOUT_MS = 12000; // 重连后 12 秒无首帧：放弃该片段

function isEmptySize(size) {
  return !(Number(size) >= EMPTY_FILE_BYTES);
}

/**
 * Delete only the explicitly named, tiny files inside `dir`.
 * Returns a per-file report; never throws for a single bad entry.
 */
function sweepEmptySegments(dir, names, opts) {
  const o = opts || {};
  const threshold = Number.isFinite(o.threshold) ? o.threshold : EMPTY_FILE_BYTES;
  const root = path.resolve(dir || '.');
  const removed = [], kept = [], errors = [];
  for (const raw of names || []) {
    const name = path.basename(String(raw || ''));
    if (!name) continue;
    const file = path.resolve(root, name);
    // 仅接受 dir 的直接子文件；拒绝 ..、绝对路径与任何路径穿越。
    if (path.dirname(file) !== root || file === root) {
      errors.push({ name, message: '非法路径' });
      continue;
    }
    try {
      if (!fs.existsSync(file)) { kept.push({ name, reason: '不存在' }); continue; }
      const size = fs.statSync(file).size;
      if (size >= threshold) { kept.push({ name, size }); continue; }
      fs.unlinkSync(file);
      removed.push({ name, size });
    } catch (e) {
      errors.push({ name, message: e.message, busy: /EPERM|EBUSY|EACCES/i.test(e.message) });
    }
  }
  return { removed, kept, errors };
}

/**
 * Pure decision for an ffmpeg child exit. Kept here so all three branches
 * (tail-interrupt / reconnect / finish) can be unit-tested without spawning
 * a real process.
 */
function decideFfmpegExit(o) {
  const limited = Number(o.durationSec) > 0;
  const remain = limited ? Number(o.durationSec) - Number(o.elapsed || 0) : Infinity;
  const tail = limited && remain <= TAIL_RECONNECT_MIN_SEC;
  if (tail && Number(o.code) === 0 && !o.stopped) {
    return { action: 'interrupted', remain, tail };
  }
  if (o.autoRestart !== false && remain > TAIL_RECONNECT_MIN_SEC && !o.stopped) {
    return { action: 'reconnect', remain, tail };
  }
  return {
    action: 'finish',
    status: Number(o.code) === 0 ? (tail ? 'interrupted' : 'completed') : 'failed',
    remain, tail
  };
}

module.exports = {
  EMPTY_FILE_BYTES, TAIL_RECONNECT_MIN_SEC, FIRST_FRAME_TIMEOUT_MS,
  isEmptySize, sweepEmptySegments, decideFfmpegExit
};
