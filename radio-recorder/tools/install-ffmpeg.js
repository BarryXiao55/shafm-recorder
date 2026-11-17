#!/usr/bin/env node
'use strict';
/*
 * tools/install-ffmpeg.js — FFmpeg 下载 / 安装 / 路径回写（零 npm 依赖，Node 18+）
 *
 * 发布包不含 bin/ffmpeg.exe · ffplay.exe · ffprobe.exe（约 654 MB，第三方许可证）。
 * 本脚本把三个 exe 装回程序目录，并把「安装目录」自动写入所有需要知道它的文件：
 *
 *   config.json                  ffmpegHome / ffmpegPath / ffplayPath（保留其它字段）
 *   config.example.json          仅补一个空的 ffmpegHome 字段，绝不写入绝对路径
 *   bin/ffmpeg-location.json     结构化安装记录（server.js 的 findExe 会读取）
 *   bin/ffmpeg-env.bat           set FFMPEG / FFPLAY / FFPROBE（record_fm990.bat 会 call）
 *   POST /api/detect             若本机服务正在运行，通知它立即重新探测
 *
 * 用法：
 *   node tools/install-ffmpeg.js                 自动下载最新 Windows 构建并安装
 *   node tools/install-ffmpeg.js --check        只检测，不下载、不写任何文件
 *   node tools/install-ffmpeg.js --update       强制重新下载并替换（旧 exe 先备份）
 *   node tools/install-ffmpeg.js --from DIR     从已解压/已安装目录离线复制（含子目录）
 *   node tools/install-ffmpeg.js --source X     X = 本地 .zip 或 http(s) 下载地址
 *   node tools/install-ffmpeg.js --winget       走 winget 安装 Gyan.FFmpeg 后再复制
 *   node tools/install-ffmpeg.js --dir DIR      自定义安装目录（默认 <root>/bin）
 *   node tools/install-ffmpeg.js --root DIR     指定程序根目录（供测试 / 多副本使用）
 *
 * 其它开关：--no-config（不写 config.json）、--no-notify（不通知运行中的服务）、
 *           --no-backup（--update 时不备份旧 exe）、--keep-temp（保留下载的 zip 与解压目录）、
 *           --sha256 HEX（校验下载包）、--yes（非交互，脚本默认即非交互）、--help
 *
 * 安全约定：默认检测到 ffmpeg 已安装就跳过，绝不覆盖或删除已有 exe；
 *           --update 时用「移动」把旧 exe 备份到 bin/_backup-<时间戳>/，绝不直接删除；
 *           临时文件只清理本脚本本次生成的，不碰任何既有文件。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const IS_WIN = process.platform === 'win32';
const EXE = IS_WIN ? '.exe' : '';
const EXE_NAMES = ['ffmpeg', 'ffplay', 'ffprobe'];
const MIN_ZIP_BYTES = 8 * 1024 * 1024;   // 小于 8 MB 一定是错误页/空包
const UA = 'shanghai-fm-radio-recorder/3.1.9 (+local installer)';

/* GitHub 上持续更新的 BtbN 自动构建；gyan.dev 作为国内更稳的备用源。 */
const STATIC_SOURCES = [
  'https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-lgpl.zip',
  'https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip',
  'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
];
const GITHUB_API = 'https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/tags/latest';

/* ------------------------------- 参数 ------------------------------- */

function parseArgs(argv) {
  const o = { _: [] };
  const valued = new Set(['source', 'from', 'dir', 'root', 'sha256']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { o._.push(a); continue; }
    const eq = a.indexOf('=');
    const key = a.slice(2, eq < 0 ? undefined : eq).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (eq >= 0) { o[key] = a.slice(eq + 1); continue; }
    if (valued.has(a.slice(2))) { o[key] = argv[++i] || ''; continue; }
    o[key] = true;
  }
  return o;
}
const A = parseArgs(process.argv.slice(2));
const ROOT = A.root ? path.resolve(A.root) : path.resolve(__dirname, '..');
const BIN = path.join(ROOT, 'bin');                       // 程序固定读取位置
const TARGET = A.dir ? path.resolve(A.dir) : BIN;         // exe 实际安装位置
const CONFIG = path.join(ROOT, 'config.json');
const EXAMPLE = path.join(ROOT, 'config.example.json');
const LOCATION = path.join(BIN, 'ffmpeg-location.json');
const ENV_BAT = path.join(BIN, 'ffmpeg-env.bat');
const STAMP = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

function help() {
  console.log(`
FFmpeg 安装器（零 npm 依赖）

  node tools/install-ffmpeg.js              自动下载 + 安装 + 写入安装目录
  node tools/install-ffmpeg.js --check      只检测当前安装状态
  node tools/install-ffmpeg.js --update     强制重装（旧 exe 先备份）
  node tools/install-ffmpeg.js --from DIR   从本地已解压目录离线安装
  node tools/install-ffmpeg.js --source X   从本地 zip 或 URL 安装
  node tools/install-ffmpeg.js --winget     先 winget install Gyan.FFmpeg
  node tools/install-ffmpeg.js --dir DIR    自定义安装目录（默认 ${path.join('<root>', 'bin')}）

程序根目录：${ROOT}
安装目标：  ${TARGET}
完整说明：bin/README.md · docs/OPERATION_MANUAL.md
`);
}

/* ------------------------------ 小工具 ------------------------------ */

const log = (...a) => console.log(...a);
const warn = (...a) => console.warn('[WARN]', ...a);
const fail = msg => { console.error('[ERROR] ' + msg); process.exitCode = 1; };
const isUrl = s => /^https?:\/\//i.test(s);
const stampDir = name => path.join(BIN, `${name}-${STAMP}`);

function exeVersion(file) {
  try {
    const r = spawnSync(file, ['-version'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
    if (r.error || r.status !== 0) return '';
    return String(r.stdout || '').split(/\r?\n/)[0].trim().slice(0, 100);
  } catch (e) { return ''; }
}
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}
function backupFile(file) {
  if (!fs.existsSync(file)) return null;
  const dst = `${file}.bak-${STAMP}`;
  try { fs.copyFileSync(file, dst); return dst; } catch (e) { warn('备份失败：' + e.message); return null; }
}
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('data', c => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}
function writeText(file, text, crlf) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, crlf ? text.replace(/\r?\n/g, '\r\n') : text, 'utf8');
}
function walk(dir, depth, out) {
  if (depth > 5 || out.length > 4000) return out;
  let items = [];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const it of items) {
    const p = path.join(dir, it.name);
    if (it.isDirectory()) walk(p, depth + 1, out);
    else if (it.isFile()) out.push(p);
  }
  return out;
}
function findExes(base) {
  const files = walk(base, 0, []);
  const found = {};
  for (const name of EXE_NAMES) {
    const want = IS_WIN ? name + '.exe' : name;
    const hits = files.filter(f => path.basename(f).toLowerCase() === want.toLowerCase());
    hits.sort((a, b) => {
      const score = f => (/(^|[\\/])bin([\\/]|$)/i.test(f) ? 0 : 1) * 1000 + f.length;
      return score(a) - score(b);
    });
    if (hits.length) found[name] = hits[0];
  }
  return found;
}

/* ------------------------------ HTTP ------------------------------ */

function get(url, redirects) {
  redirects = redirects || 0;
  return new Promise((resolve, reject) => {
    if (redirects > 8) return reject(new Error('重定向次数过多'));
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, {
      headers: { 'User-Agent': UA, 'Accept': '*/*', 'Accept-Encoding': 'identity' },
      timeout: 20000
    }, res => {
      const code = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(get(next, redirects + 1));
      }
      if (code !== 200) { res.resume(); return reject(new Error('HTTP ' + code + ' · ' + url)); }
      resolve(res);
    });
    req.on('timeout', () => { req.destroy(new Error('连接超时 · ' + url)); });
    req.on('error', reject);
  });
}
async function getJson(url) {
  const res = await get(url);
  let s = '';
  for await (const chunk of res) s += chunk;
  return JSON.parse(s);
}
async function download(url, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = dest + '.part';
  const res = await get(url);
  const total = Number(res.headers['content-length'] || 0);
  let size = 0, lastShow = 0;
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(part);
    res.on('data', chunk => {
      size += chunk.length;
      if (size - lastShow > 2 * 1024 * 1024) {
        lastShow = size;
        process.stdout.write(`\r  已下载 ${(size / 1048576).toFixed(1)} MB` +
          (total ? ` / ${(total / 1048576).toFixed(1)} MB` : '') + '   ');
      }
    });
    res.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);        // 等写盘真正结束，不能只看 res 的 end
    res.pipe(out);
  });
  process.stdout.write('\r' + ' '.repeat(60) + '\r');
  if (size < MIN_ZIP_BYTES) throw new Error(`下载内容只有 ${size} 字节，可能不是 FFmpeg 压缩包`);
  const fd = fs.openSync(part, 'r');
  const head = Buffer.alloc(4);
  fs.readSync(fd, head, 0, 4, 0);
  fs.closeSync(fd);
  if (!(head[0] === 0x50 && head[1] === 0x4b)) throw new Error('下载内容不是 ZIP 包（PK 头缺失）');
  fs.renameSync(part, dest);
  return { size, sha256: await sha256File(dest) };
}

/* --------------------------- 来源与解压 --------------------------- */

async function resolveSources() {
  const list = [];
  try {
    const rel = await getJson(GITHUB_API);
    const assets = (rel.assets || []).filter(a =>
      /win64/i.test(a.name) && /\.zip$/i.test(a.name) && !/shared|win32|arm/i.test(a.name));
    assets.sort((a, b) => {
      const rank = n => (/lgpl/i.test(n) ? 0 : /gpl/i.test(n) ? 1 : 2);
      return rank(a.name) - rank(b.name);
    });
    for (const a of assets.slice(0, 3)) {
      list.push({ url: a.browser_download_url, sha256: (a.digest || '').replace(/^sha256:/, '') || '', label: a.name });
    }
    if (list.length) log(`  GitHub 最新构建：${list[0].label}`);
  } catch (e) { warn('GitHub API 不可用（' + e.message + '），改用内置下载源'); }
  for (const url of STATIC_SOURCES) if (!list.some(x => x.url === url)) list.push({ url, sha256: '', label: url.split('/').pop() });
  return list;
}
function unzip(zipFile, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const attempts = IS_WIN ? [
    () => {
      const q = s => "'" + String(s).replace(/'/g, "''") + "'";
      const cmd = `Expand-Archive -LiteralPath ${q(zipFile)} -DestinationPath ${q(outDir)} -Force`;
      return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd],
        { encoding: 'utf8', timeout: 600000, windowsHide: true });
    },
    () => spawnSync('tar.exe', ['-xf', zipFile, '-C', outDir],
      { encoding: 'utf8', timeout: 600000, windowsHide: true })
  ] : [
    () => spawnSync('unzip', ['-q', '-o', zipFile, '-d', outDir],
      { encoding: 'utf8', timeout: 600000 })
  ];
  let last = '';
  for (const run of attempts) {
    const r = run();
    if (r.error) { last = r.error.message; continue; }
    if (r.status === 0 && walk(outDir, 0, []).length) return;
    last = (r.stderr || r.stdout || 'exit ' + r.status).toString().trim().slice(0, 300);
  }
  throw new Error('解压失败：' + last + '（可加 --keep-temp 保留 zip，手动解压后用 --from 安装）');
}
function wingetInstall() {
  log('  执行 winget install --id Gyan.FFmpeg -e …');
  const r = spawnSync('winget', ['install', '--id', 'Gyan.FFmpeg', '-e',
    '--accept-source-agreements', '--accept-package-agreements'],
  { encoding: 'utf8', timeout: 900000, windowsHide: true });
  if (r.error) throw new Error('winget 不可用：' + r.error.message);
  log('  ' + String(r.stdout || '').trim().split(/\r?\n/).slice(-3).join(' | '));
  const base = path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Packages');
  const hits = walk(base, 0, [])
    .filter(f => path.basename(f).toLowerCase() === 'ffmpeg.exe' && /Gyan/i.test(f))
    .sort((a, b) => a.length - b.length);
  if (!hits.length) throw new Error('winget 安装后未找到 ffmpeg.exe，可用 --from 指定其所在目录');
  return path.dirname(hits[0]);
}

/* ------------------------- 检测 / 安装 / 回写 ------------------------- */

function detectInstalled() {
  const c = readJson(CONFIG) || {};
  const loc = readJson(LOCATION) || {};
  const candidates = [
    ['config.json · ffmpegPath', c.ffmpegPath],
    ['bin/ffmpeg-location.json', loc.ffmpegPath],
    ['程序目录 bin/', path.join(BIN, 'ffmpeg' + EXE)],
    ['安装目标目录', path.join(TARGET, 'ffmpeg' + EXE)],
    ['config.json · ffmpegHome', c.ffmpegHome ? path.join(c.ffmpegHome, 'ffmpeg' + EXE) : ''],
    ['PATH', 'ffmpeg' + EXE]
  ];
  for (const [label, p] of candidates) {
    if (!p) continue;
    let file = p;
    if (!path.isAbsolute(p)) {
      const where = spawnSync(IS_WIN ? 'where' : 'which', [p], { encoding: 'utf8', timeout: 4000 });
      if (where.status !== 0) continue;
      file = String(where.stdout || '').split(/\r?\n/)[0].trim();
    }
    try {
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
      const lower = path.resolve(file).toLowerCase();
      const inProgram = lower === path.resolve(path.join(BIN, 'ffmpeg' + EXE)).toLowerCase() ||
        lower === path.resolve(path.join(TARGET, 'ffmpeg' + EXE)).toLowerCase();
      return { found: true, label, path: file, version: exeVersion(file) || '（无法读取版本）', inProgram };
    } catch (e) { /* keep looking */ }
  }
  return { found: false };
}

async function acquire() {
  const temp = { zip: '', dir: '', keep: !!A.keepTemp };
  if (A.from) {
    const dir = path.resolve(A.from);
    if (!fs.existsSync(dir)) throw new Error('目录不存在：' + dir);
    return { dir, source: '本地目录 ' + dir, temp };
  }
  if (A.winget) {
    const dir = wingetInstall();
    return { dir, source: 'winget Gyan.FFmpeg', temp };
  }
  let zipFile = '', expectedSha = A.sha256 || '';
  if (A.source && !isUrl(A.source)) {
    zipFile = path.resolve(A.source);
    if (!fs.existsSync(zipFile)) throw new Error('本地压缩包不存在：' + zipFile);
    log(`  使用本地压缩包：${zipFile}`);
  } else {
    const sources = A.source ? [{ url: A.source, sha256: expectedSha, label: A.source.split('/').pop() }] : await resolveSources();
    let lastErr = '';
    for (const s of sources) {
      try {
        log(`  下载：${s.url}`);
        zipFile = stampDir('_download') + '.zip';
        const r = await download(s.url, zipFile);
        expectedSha = expectedSha || s.sha256;
        if (expectedSha && r.sha256.toLowerCase() !== expectedSha.toLowerCase())
          throw new Error('SHA256 校验不通过（期望 ' + expectedSha + '，实际 ' + r.sha256 + '）');
        log(`  下载完成：${(r.size / 1048576).toFixed(1)} MB` + (expectedSha ? ' · SHA256 已校验' : ' · SHA256 ' + r.sha256.slice(0, 16) + '…'));
        temp.zip = zipFile;
        return { dir: '', source: s.url, temp, zipFile, sha256: r.sha256 };
      } catch (e) {
        lastErr = e.message;
        warn('该下载源失败：' + e.message);
        try { if (fs.existsSync(zipFile)) fs.unlinkSync(zipFile); } catch (_) { /* ignore */ }
        try { if (fs.existsSync(zipFile + '.part')) fs.unlinkSync(zipFile + '.part'); } catch (_) { /* ignore */ }
        zipFile = '';
      }
    }
    throw new Error('所有下载源都失败：' + lastErr + '；可用 --source 指定本地 zip 或镜像 URL');
  }
  temp.zip = '';   // 用户自己的 zip 不清理
  return { dir: '', source: '本地压缩包 ' + zipFile, temp, zipFile,
    sha256: await sha256File(zipFile) };
}

function installFrom(fromDir, source) {
  const found = findExes(fromDir);
  if (!found.ffmpeg) throw new Error('在来源目录里没有找到 ffmpeg' + EXE + '：' + fromDir);
  fs.mkdirSync(TARGET, { recursive: true });
  fs.mkdirSync(BIN, { recursive: true });

  let backupDir = '';
  const existing = EXE_NAMES.filter(n => fs.existsSync(path.join(TARGET, n + EXE)));
  if (existing.length && !A.noBackup) {
    backupDir = path.join(BIN, '_backup-' + STAMP);
    fs.mkdirSync(backupDir, { recursive: true });
    for (const n of existing) {
      fs.renameSync(path.join(TARGET, n + EXE), path.join(backupDir, n + EXE));
    }
    log(`  旧文件已备份（移动，未删除）：${backupDir}`);
  } else if (existing.length && A.noBackup) {
    warn('--no-backup：旧 exe 将被直接覆盖');
  }

  const installed = {}, created = [];
  try {
    for (const n of EXE_NAMES) {
      if (!found[n]) continue;
      const dst = path.join(TARGET, n + EXE);
      fs.copyFileSync(found[n], dst);
      created.push(dst);
      installed[n] = dst;
    }
    const version = A.noVerify ? '（--no-verify，跳过版本校验）' : exeVersion(installed.ffmpeg);
    if (!version) throw new Error('安装后的 ffmpeg 无法执行 -version（文件损坏或架构不匹配）');
    log(`  已安装：${installed.ffmpeg}`);
    log(`  版本：${version}`);
    return { installed, version, backupDir, source, missing: EXE_NAMES.filter(n => !found[n]) };
  } catch (e) {
    /* 回滚：只删本脚本刚才复制出来的文件，再把备份移回原位；既有文件一个都不丢。 */
    for (const f of created) { try { fs.rmSync(f, { force: true }); } catch (_) { /* ignore */ } }
    if (backupDir) {
      for (const n of existing) {
        try { fs.renameSync(path.join(backupDir, n + EXE), path.join(TARGET, n + EXE)); } catch (_) { /* ignore */ }
      }
      warn('安装失败，已从备份恢复原文件');
    }
    throw e;
  }
}

function writeTargets(info) {
  const written = [];
  const home = TARGET;
  const ffmpegPath = info.installed.ffmpeg;
  const ffplayPath = info.installed.ffplay || '';
  const ffprobePath = info.installed.ffprobe || '';

  /* 1. 结构化安装记录：server.js 的 findExe() 会把它作为候选路径读取。 */
  writeText(LOCATION, JSON.stringify({
    ffmpegHome: home,
    ffmpegPath, ffplayPath, ffprobePath,
    version: info.version, source: info.source,
    installedAt: new Date().toISOString(),
    note: '由 tools/install-ffmpeg.js 生成；可手工编辑或删除，删除后服务端仍会从 bin/ 与 PATH 探测。'
  }, null, 2) + '\n');
  written.push(LOCATION);

  /* 2. 供 .bat 复用的环境变量文件（CRLF）。 */
  const envLines = [
    '@echo off',
    'rem Generated by tools/install-ffmpeg.js - re-run the installer to update.',
    `set "FFMPEG_BIN=${home}"`,
    `set "FFMPEG=${ffmpegPath}"`,
    `set "FFPLAY=${ffplayPath || ffmpegPath}"`,
    `set "FFPROBE=${ffprobePath || ffmpegPath}"`,
    ''
  ];
  writeText(ENV_BAT, envLines.join('\n'), true);
  written.push(ENV_BAT);
  if (/[^\x00-\x7F]/.test(home)) warn('安装路径含非 ASCII 字符，ffmpeg-env.bat 在 cmd 下可能乱码；建议用 --dir 指定纯英文路径');

  /* 3. 运行时配置：只覆盖 ffmpeg 相关键，用户的保存目录 / 定时段等原样保留。 */
  if (!A.noConfig) {
    const prev = readJson(CONFIG);
    const c = prev || {};
    const bak = prev ? backupFile(CONFIG) : null;
    c.ffmpegHome = home;
    c.ffmpegPath = ffmpegPath;
    if (ffplayPath) c.ffplayPath = ffplayPath;
    writeText(CONFIG, JSON.stringify(c, null, 2) + '\n');
    written.push(CONFIG + (bak ? `（原文件备份为 ${path.basename(bak)}）` : '（新建）'));
  } else written.push('config.json（--no-config，跳过）');

  /* 4. 配置模板：只补一个空字段，绝不把本机绝对路径写进要发布的源码。 */
  const tpl = readJson(EXAMPLE);
  if (tpl && !Object.prototype.hasOwnProperty.call(tpl, 'ffmpegHome')) {
    const out = {};
    for (const k of Object.keys(tpl)) {
      out[k] = tpl[k];
      if (k === 'ffplayPath') out.ffmpegHome = '';
    }
    if (!Object.prototype.hasOwnProperty.call(out, 'ffmpegHome')) out.ffmpegHome = '';
    writeText(EXAMPLE, JSON.stringify(out, null, 2) + '\n');
    written.push(EXAMPLE + '（补 ffmpegHome 空字段）');
  }
  return written;
}

function notifyService() {
  if (A.noNotify) return;
  const req = http.request({ host: '127.0.0.1', port: Number(process.env.PORT || 8787),
    path: '/api/detect', method: 'POST', timeout: 1200,
    headers: { 'Content-Type': 'application/json', 'Content-Length': 2 } }, res => {
    res.resume();
    log(`  已通知本机服务重新检测 ffmpeg（HTTP ${res.statusCode}）`);
  });
  req.on('error', () => { /* 服务没开是正常的，静默跳过 */ });
  req.on('timeout', () => req.destroy());
  req.end('{}');
}

/* ------------------------------- 主流程 ------------------------------- */

async function main() {
  if (A.help || A.h) { help(); return; }

  log('== FFmpeg 可选组件安装器 ==');
  log(`  程序目录：${ROOT}`);
  log(`  安装目标：${TARGET}\n`);

  const cur = detectInstalled();
  if (A.check) {
    log(cur.found
      ? `[已安装] ${cur.path}\n  来源：${cur.label}\n  位置：${cur.inProgram ? '程序目录（随程序走）' : '系统 PATH／其它目录'}\n  版本：${cur.version}`
      : '[未安装] 未找到 ffmpeg；程序会自动使用内置零依赖直录引擎（音质同样零二次损失）。');
    log('\n  想安装：node tools/install-ffmpeg.js  （或双击 tools/install-ffmpeg.bat）');
    log('  --check 只做检测，未下载文件、未修改任何配置。');
    return;
  }
  if (cur.found && !A.update && cur.inProgram) {
    log(`[跳过] 程序目录里已有 ffmpeg：${cur.path}`);
    log(`        ${cur.version}`);
    log('        默认不覆盖已有文件。若要升级，运行：node tools/install-ffmpeg.js --update');
    log('        若只想把当前安装目录写入配置，运行：node tools/install-ffmpeg.js --update --from "' +
      path.dirname(cur.path) + '"');
    return;
  }
  if (cur.found && !A.update && !A.from && !A.source && !A.winget) {
    log(`[复用] 系统里已有 ffmpeg，但不在程序目录：${cur.path}`);
    log(`        ${cur.version}`);
    log('        将直接从该目录复制三个 exe 到 bin/，不联网下载（想下载最新版请加 --update）。');
    A.from = path.dirname(cur.path);
  }

  const acq = await acquire();
  const fromDir = acq.dir || (acq.zipFile ? (acq.temp.dir = stampDir('_extract'), unzip(acq.zipFile, acq.temp.dir), acq.temp.dir) : '');
  const info = installFrom(fromDir, acq.source);

  /* 清理只针对本脚本本次生成的临时物，绝不删已有 exe / 配置。 */
  if (!A.keepTemp) {
    if (acq.temp.zip && fs.existsSync(acq.temp.zip)) { try { fs.rmSync(acq.temp.zip, { force: true }); } catch (_) {} }
    if (acq.temp.dir && fs.existsSync(acq.temp.dir)) { try { fs.rmSync(acq.temp.dir, { recursive: true, force: true }); } catch (_) {} }
    const dl = path.dirname(acq.temp.zip || '');
    if (dl && dl.startsWith(BIN) && path.basename(dl).startsWith('_download-')) {
      try { fs.rmdirSync(dl); } catch (_) { /* 非空就留着 */ }
    }
  } else {
    log(`  临时文件已保留：${acq.temp.zip || '（无）'} ${acq.temp.dir || ''}`);
  }

  log('\n== 回写安装目录到需要的文件 ==');
  for (const w of writeTargets(info)) log('  ✓ ' + w);
  notifyService();
  if (info.missing.length) warn('来源中缺少：' + info.missing.join(', ') + '（可选组件，不影响录制）');
  if (info.backupDir) log(`  旧 exe 备份：${info.backupDir}（确认新版本可用后可自行删除）`);
  log('\n完成。若服务正在运行，点界面「重新检测」或重启服务即可切换到 ffmpeg 引擎。');
  log('许可提醒：FFmpeg 为独立第三方项目，请遵守其 LGPL/GPL 许可：https://ffmpeg.org/legal.html');
}

main().catch(e => { fail(e.message); process.exit(1); });
