'use strict';
/*
 * selftest.js - 一键体检（供 UI 的「系统自检」调用）
 *
 * 全部检查都在本机完成：单元测试走子进程，写盘/删除/合并只碰输出目录里的
 * __SELFTEST__ 前缀文件，检查结束立刻清理；不会改动任何真实录音。
 * 每一项独立 try/catch，单项失败不影响其它项，结果三态：pass / warn / fail。
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const storage = require('./storage');
const stations = require('./stations');
const epg = require('./epg');
const { findMp3Start } = require('./recorder');

const ROOT = path.join(__dirname, '..');
const PREFIX = '__SELFTEST__';

function headOf(file, n) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.statSync(file).size;
    const buf = Buffer.alloc(Math.min(size, n || 16384));
    fs.readSync(fd, buf, 0, buf.length, 0);
    return buf;
  } finally { fs.closeSync(fd); }
}

/**
 * @param {object} ctx
 *   config      - 当前录制配置
 *   tools       - () => ({ffmpeg, ffplay})
 *   probe       - (url, seconds) => Promise<probeResult>
 *   deleteFiles - (names:string[]) => {deleted, errors, bytes}
 *   mergeFiles  - (names:string[], outName:string) => {ok, name, size, message}
 *   port / host  - 本地服务地址
 *   log         - (string) => void
 */
async function runChecks(ctx) {
  const startedAt = Date.now();
  const items = [];
  const add = (id, name, level, detail, extra) => items.push(Object.assign({ id, name, level, detail }, extra || {}));
  const log = ctx.log || (() => {});
  const dir = path.resolve(ctx.config.outputDir);
  const temps = [];
  const tmp = name => { const p = path.join(dir, PREFIX + name); temps.push(p); return p; };

  async function check(id, name, fn, warnOnNull) {
    try {
      const r = await fn();
      if (r === null) add(id, name, warnOnNull === false ? 'fail' : 'warn', '跳过（本机条件不满足）');
      else if (r && r.level) add(id, name, r.level, r.detail, r.extra);
      else add(id, name, 'pass', String(r));
    } catch (e) { add(id, name, 'fail', e.message); }
  }

  /* 1. Node 运行时 */
  await check('runtime', 'Node 运行时', () => {
    const major = Number(process.versions.node.split('.')[0]);
    if (major < 18) throw new Error('Node 版本过低：' + process.version + '（需 18+）');
    return `Node ${process.version} · ${process.platform} · PID ${process.pid}`;
  });

  /* 2. 纯模块单元测试 */
  await check('unit', '模块单元测试套件', () => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'test', 'selftest.js')],
      { encoding: 'utf8', timeout: 30000, windowsHide: true });
    const out = (r.stdout || '') + (r.stderr || '');
    const m = /(\d+) checks passed\./.exec(out);
    const fails = out.split('\n').filter(l => /FAIL/.test(l)).map(l => l.trim()).slice(0, 3);
    if (r.status !== 0 || fails.length) throw new Error(`退出码 ${r.status}；` + (fails.join(' / ') || '用例失败'));
    return `${m ? m[1] : '?'} 项断言全部通过（调度器 / 存储 / 电台 / EPG / 告警 / 任务管理）`;
  });

  /* 3. ffmpeg */
  await check('ffmpeg', 'FFmpeg 主引擎', () => {
    const ff = ctx.tools().ffmpeg;
    if (!ff || !ff.found) return { level: 'warn', detail: '未安装 ffmpeg，当前由内置直录引擎工作（音质同样零损失）' };
    const v = spawnSync(ff.path, ['-version'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    if (v.status !== 0) throw new Error('ffmpeg 无法执行：' + ((v.stderr || '').split('\n')[0] || v.status));
    const enc = spawnSync(ff.path, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
    const lame = /libmp3lame/.test(enc.stdout || '');
    return `已安装 · ${(v.stdout || '').split('\n')[0].slice(0, 70)} · ${lame ? '含 libmp3lame' : '无 libmp3lame（不影响 -c copy）'}` +
      `\n路径 ${ff.path}`;
  });

  /* 4. 上海 FM 电台库 */
  await check('stations', '上海 FM 电台库', () => {
    const list = stations.list();
    if (!list.length) throw new Error('电台库为空');
    const bad = list.filter(s => !/FM/i.test(s.freq) || !/^https?:\/\//.test(s.url));
    if (bad.length) throw new Error(`${bad.length} 个电台频率/地址不合法`);
    return `${list.length} 个上海 FM 频率 · 流地址全部合法`;
  });

  /* 5. 直播流可达性与格式 */
  await check('stream', '直播流探测（4 秒）', async () => {
    const r = await ctx.probe(ctx.config.streamUrl, 4);
    if (!r.ok) throw new Error(r.message || '连接失败');
    if (!r.found) return { level: 'warn', detail: `收到 ${r.bytes} 字节但未识别到标准 MP3 帧（可能是 HLS 或临时故障）` };
    return `${r.codec} · ${r.bitrate} kbps / ${r.samplerate} Hz · 跳过 ${r.prefixBytes} 字节前导 · 可零损失直录`;
  });

  /* 6. 写盘权限 */
  await check('write', '输出目录写盘', () => {
    const f = tmp('write.tmp');
    fs.writeFileSync(f, Buffer.alloc(4096, 0x41));
    if (fs.statSync(f).size !== 4096) throw new Error('写入大小不符');
    return `${dir} · 写入 4 KiB 成功`;
  }, false);

  /* 7. 文件删除链路 */
  await check('delete', '文件删除链路', () => {
    const f = tmp('delete.mp3');
    fs.writeFileSync(f, Buffer.alloc(1024, 0x42));
    const r = ctx.deleteFiles([path.basename(f)]);
    if (!r.deleted.includes(path.basename(f))) {
      throw new Error('删除未生效：' + (r.errors[0] && r.errors[0].message || '未知原因'));
    }
    if (fs.existsSync(f)) throw new Error('接口返回成功但文件仍在');
    return '创建测试文件 → 调用删除接口 → 文件已从磁盘消失';
  }, false);

  /* 8. 无损合并链路 */
  await check('merge', '无损合并链路', async () => {
    const a = tmp('a.mp3'), b = tmp('b.mp3'), out = tmp('merged.mp3');
    fs.writeFileSync(a, Buffer.alloc(1000, 0x43));
    fs.writeFileSync(b, Buffer.alloc(2000, 0x44));
    const r = await ctx.mergeFiles([path.basename(a), path.basename(b)], path.basename(out));
    if (!r.ok) throw new Error(r.message || '合并失败');
    if (r.size !== 3000) throw new Error(`合并后大小 ${r.size}，应为 3000 字节`);
    temps.push(out);
    return '两个分段按字节顺序拼接，大小精确相加（不解码、不重编码）';
  }, false);

  /* 9. 真实录音的 MP3 帧健康 */
  await check('health', '录音文件帧校验', () => {
    // 跳过刚开始写、还没落够数据的分段，避免瞬时误报
    const real = storage.audioFiles(dir).filter(f => !f.name.startsWith(PREFIX) && /\.mp3$/i.test(f.name) && f.size > 4096)
      .sort((a, b) => b.mtime - a.mtime).slice(0, 3);
    if (!real.length) return null;
    const ok = [], bad = [];
    for (const f of real) {
      const hit = findMp3Start(headOf(path.join(dir, f.name), 16384));
      (hit ? ok : bad).push(f.name);
    }
    if (bad.length) return { level: 'warn', detail: `未识别到帧同步：${bad.join('、')}` };
    return `${ok.length} 个最新录音首部均为标准 MP3 帧（FF FB …）`;
  });

  /* 10. EPG 缓存 */
  await check('epg', 'EPG 节目表缓存', () => {
    const info = epg.cacheInfo();
    const arr = Array.isArray(info) ? info : [];
    if (!arr.length) return { level: 'warn', detail: '缓存为空（服务启动 4 秒后会自动刷新，或点「刷新全部」）' };
    const dates = new Set();
    let programmes = 0;
    arr.forEach(s => (s.days || []).forEach(d => { dates.add(d.date); programmes += d.count || 0; }));
    return `本地缓存 ${arr.length} 个电台 / ${dates.size} 天 / ${programmes} 档节目 · 断网可回退内置节目表`;
  });

  /* 11. 磁盘水位 */
  await check('disk', '磁盘水位', () => {
    const d = storage.diskInfo(dir);
    if (!d.valid) throw new Error('无法读取磁盘信息');
    const freeGB = d.free / 1073741824;
    return { level: freeGB < 2 ? 'warn' : 'pass',
      detail: `可用 ${freeGB.toFixed(1)} GiB / 共 ${(d.total / 1073741824).toFixed(1)} GiB · 单路 24 小时约 0.69 GB` };
  }, false);

  /* 12. 服务自身 HTTP 连通 */
  await check('http', '本地服务 API 连通', () => new Promise((resolve, reject) => {
    const req = http.get(`http://${ctx.host || '127.0.0.1'}:${ctx.port}/api/status`, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(raw);
          if (res.statusCode !== 200 || !j.version) throw new Error('HTTP ' + res.statusCode);
          resolve(`GET /api/status → 200 · 服务 v${j.version} · ${(j.jobs || []).length} 个任务记录`);
        } catch (e) { reject(e); }
      });
    });
    req.setTimeout(4000, () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
  }), false);

  /* 清理所有测试产物 */
  for (const f of temps) { try { fs.unlinkSync(f); } catch (e) { /* already gone */ } }

  const passed = items.filter(i => i.level === 'pass').length;
  const warned = items.filter(i => i.level === 'warn').length;
  const failed = items.filter(i => i.level === 'fail').length;
  const summary = `${passed} 通过 / ${warned} 提醒 / ${failed} 失败`;
  log(`一键自检完成：${summary}`);
  return { at: Date.now(), durationMs: Date.now() - startedAt, items, passed, warned, failed, total: items.length, summary };
}

module.exports = { runChecks, PREFIX };
