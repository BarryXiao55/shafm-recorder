#!/usr/bin/env node
'use strict';
/*
 * tools/build-release.js — 可复现地生成源码包 / 发布包（零 npm 依赖，Windows PowerShell 压缩）
 *
 *   node tools/build-release.js            # 版本取 package.json
 *   node tools/build-release.js v3.1.12    # 指定版本
 *
 * 只往 <workspace>/release/ 里写新文件；源码、录音、配置、运行中的服务一律不动，
 * 也绝不删除 release/ 里已有的包或 _staging 中间目录。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RELEASE = path.resolve(ROOT, '..', 'release');
const version = (process.argv[2] || 'v' + require(path.join(ROOT, 'package.json')).version).replace(/^v/, 'v');
const NAME = 'shanghai-fm-recorder-' + version;
const STAGE = path.join(RELEASE, '_staging', version.replace(/\./g, ''));
const SOURCE_DIR = path.join(STAGE, 'source', NAME);
const RELEASE_DIR = path.join(STAGE, 'release', NAME);
const q = s => "'" + String(s).replace(/'/g, "''") + "'";

const COMMON = [
  'server.js', 'stations.json', 'package.json', 'config.example.json',
  'README.md', 'LICENSE', 'NOTICE.md', 'CHANGELOG.md',
  'start.bat', 'stop-service.bat', 'desktop.bat', 'install-autostart.bat', 'uninstall-autostart.bat',
  'bin/README.md', 'docs/OPERATION_MANUAL.md',
  'tools/install-ffmpeg.js', 'tools/install-ffmpeg.bat'
];
const LIB = fs.readdirSync(path.join(ROOT, 'lib')).map(f => 'lib/' + f);
const PUBLIC = fs.readdirSync(path.join(ROOT, 'public')).map(f => 'public/' + f);
const SOURCE_ONLY = [
  '.gitignore', 'docs/RESEARCH_REPORT.md', 'tools/record_fm990.bat',
  'tools/build-release.js'
].concat(fs.readdirSync(path.join(ROOT, 'test')).map(f => 'test/' + f));

const FORBIDDEN_NAMES = /^(config\.json|runtime\.json|epg-cache\.json|alerts\.json|.*\.(exe|dll|zip|mp3|ts|log|wav|m4a))$/i;
const PRIVATE_PATTERNS = [
  /C:[\\/]{1,2}Users[\\/]/i,
  /[\\/]Users[\\/][A-Za-z0-9._-]{2,}[\\/]/i,   // macOS /Users/<name>/ 之类本机主目录
  /\b\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\b/,   // 形如工作区目录的时间戳 ID
  /(password|api[_-]?key|secret|token)\s*[:=]\s*['"][^'"]{8,}/i
];

function sanitize(text) {
  return text
    .replace(/C:[\\/]{1,2}Users[\\/]+[^\\/\s"']+[\\/]+WorkBuddy[\\/]+[^\\/\s"']+/gi, 'C:/Radio')
    .replace(/C:[\\/]{1,2}Users[\\/]+\.\.\.[\\/]+recordings/gi, 'C:/Radio/recordings')
    .replace(/C:[\\/]{1,2}Users[\\/]+me[\\/]+Desktop/gi, 'C:/Radio/Desktop');
}
function copySet(files, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const rel of files) {
    const src = path.join(ROOT, rel);
    if (!fs.existsSync(src)) throw new Error('白名单文件不存在：' + rel);
    const out = path.join(dest, rel);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const raw = fs.readFileSync(src);
    const isText = /\.(md|js|json|html|css|txt|bat|vbs|gitignore)$/i.test(rel) || rel === '.gitignore';
    const data = isText ? Buffer.from(sanitize(raw.toString('utf8')), 'utf8') : raw;
    fs.writeFileSync(out, data);
  }
}
function listFiles(dir, base) {
  base = base || dir;
  const out = [];
  for (const it of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, it.name);
    if (it.isDirectory()) out.push(...listFiles(p, base));
    else out.push(path.relative(base, p).replace(/\\/g, '/'));
  }
  return out;
}
function writeManifest(dest, kind) {
  const files = listFiles(dest).filter(f => f !== 'MANIFEST.txt').sort();
  const lines = [
    `${kind.toUpperCase()} ARCHIVE - ${NAME}-${kind}.zip`,
    `Version      : ${version}`,
    `Generated    : ${new Date().toISOString()}`,
    `Files        : ${files.length + 1}`,
    '',
    '--- Included files (relative path | bytes | sha256[0:12]) ---'
  ];
  let total = 0;
  for (const rel of files) {
    const b = fs.readFileSync(path.join(dest, rel));
    total += b.length;
    lines.push(`${rel.padEnd(46)} ${String(b.length).padStart(8)}  ${crypto.createHash('sha256').update(b).digest('hex').slice(0, 12)}`);
  }
  lines.push('', '--- Excluded on purpose ---',
    'recordings/ (user audio), logs/, config.json, runtime.json, epg-cache.json,',
    'alerts.json, bin/*.exe (3 ffmpeg binaries, ~654 MB), .workbuddy/, release/ staging.',
    'FFmpeg is NOT bundled: install it with tools/install-ffmpeg.js (see bin/README.md).',
    'No user recording, log, credential, machine-specific absolute path or binary is included.',
    `Total bytes  : ${total} (plus this manifest)`);
  fs.writeFileSync(path.join(dest, 'MANIFEST.txt'), lines.join('\n') + '\n', 'utf8');
}
function writeStartHere(dest) {
  const text = [
    `Shanghai FM Radio Recorder ${version} - runnable release`,
    '',
    '1) Install Node.js 18 or newer (https://nodejs.org/) - no npm install needed.',
    '2) Windows: double-click start.bat   |   Any OS: node server.js',
    '3) Open http://127.0.0.1:8787/ in Chrome or Edge.',
    '4) Stop: use the Stop Service button in the UI, stop-service.bat, or Ctrl+C.',
    '5) Optional FFmpeg: node tools/install-ffmpeg.js  (or double-click tools/install-ffmpeg.bat)',
    '   It downloads ffmpeg/ffplay/ffprobe, installs them into bin/ and writes the',
    '   install folder into config.json, bin/ffmpeg-location.json and bin/ffmpeg-env.bat.',
    '   See bin/README.md for download sources, offline install and troubleshooting.',
    '',
    'FFmpeg is OPTIONAL and NOT bundled (size + LGPL/GPL). Without it the built-in',
    'zero-dependency recorder writes the stream bytes unchanged (equivalent to -c copy).',
    '',
    'Try a long preview in the station card: 10 / 30 / 60 minutes, with a countdown,',
    'auto-stop and reconnection. It is exclusive with per-job monitoring.',
    '',
    'Scheduled plans name their files after the station frequency automatically',
    '(FM 90.9 -> FM909). Pick a station in the plan editor and the prefix follows;',
    'check "Custom prefix" only if you really want to override it.',
    '',
    'Replay a recording with the play button on its row: the player lives outside',
    'the file list, so deleting another file or refreshing the list will not stop',
    'playback or reset its position. It is exclusive with monitoring and previews.',
    '',
    'If the live stream drops in the last 15 seconds, the job ends as "source',
    'interrupted" instead of reconnecting into an empty file. Reconnected segments',
    'with no audio frame within 12 seconds are discarded; zero-byte leftovers from',
    'the current job are cleaned up automatically. Historical empty files are',
    'labelled "empty segment" rather than "corrupted" and can be deleted safely.',
    '',
    'First start creates recordings/ and logs/; config.json, runtime.json,',
    'epg-cache.json and alerts.json appear on first write. Nothing is sent to',
    'the internet except the radio stream you chose to record (and the optional',
    'FFmpeg download you explicitly start).',
    '',
    'Documentation: README.md | docs/OPERATION_MANUAL.md | bin/README.md',
    'License: MIT (LICENSE) | Third-party terms: NOTICE.md',
    ''
  ].join('\r\n');
  fs.writeFileSync(path.join(dest, 'START_HERE.txt'), text, 'ascii');
}
function audit(dir, label) {
  const problems = [];
  for (const rel of listFiles(dir)) {
    if (FORBIDDEN_NAMES.test(rel)) problems.push(`${label}: 禁止的文件 ${rel}`);
    const b = fs.readFileSync(path.join(dir, rel));
    if (b.subarray(0, 2).toString('latin1') === 'MZ') problems.push(`${label}: 二进制可执行文件 ${rel}`);
    if (/\.(md|js|json|html|css|txt|bat|vbs)$/i.test(rel) || rel === '.gitignore') {
      const s = b.toString('utf8');
      for (const re of PRIVATE_PATTERNS) if (re.test(s)) problems.push(`${label}: 疑似隐私内容 ${rel} (${re})`);
    }
  }
  return problems;
}
function zip(stageDir, zipPath) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `Compress-Archive -LiteralPath ${q(stageDir)} -DestinationPath ${q(zipPath)} -Force`],
  { encoding: 'utf8', timeout: 300000, windowsHide: true });
  if (r.status !== 0) throw new Error('Compress-Archive 失败：' + (r.stderr || r.stdout || '').toString().slice(0, 400));
}

/* --------------------------------- main --------------------------------- */
fs.mkdirSync(STAGE, { recursive: true });
copySet(COMMON.concat(LIB, PUBLIC), SOURCE_DIR);
copySet(SOURCE_ONLY, SOURCE_DIR);
copySet(COMMON.concat(LIB, PUBLIC), RELEASE_DIR);
writeStartHere(RELEASE_DIR);
writeManifest(SOURCE_DIR, 'source');
writeManifest(RELEASE_DIR, 'release');

const problems = audit(SOURCE_DIR, 'source').concat(audit(RELEASE_DIR, 'release'));
if (problems.length) {
  console.error('隐私/白名单扫描未通过：');
  problems.forEach(p => console.error('  - ' + p));
  process.exit(1);
}
console.log(`隐私扫描通过：source ${listFiles(SOURCE_DIR).length} 文件 / release ${listFiles(RELEASE_DIR).length} 文件，0 处禁止项`);

const sourceZip = path.join(RELEASE, `${NAME}-source.zip`);
const releaseZip = path.join(RELEASE, `${NAME}-release.zip`);
zip(SOURCE_DIR, sourceZip);
zip(RELEASE_DIR, releaseZip);

const sums = [sourceZip, releaseZip].map(p => {
  const h = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  return { file: path.basename(p), hash: h, size: fs.statSync(p).size };
});
const sumsPath = path.join(RELEASE, 'SHA256SUMS.txt');
let old = '';
try { old = fs.readFileSync(sumsPath, 'utf8').trimEnd(); } catch (e) { /* first build */ }
const kept = old.split(/\r?\n/).filter(l => l.trim() && !l.includes(`${NAME}-source.zip`) && !l.includes(`${NAME}-release.zip`));
const lines = kept.concat(sums.map(s => `${s.hash}  ${s.file}`));
fs.writeFileSync(sumsPath, lines.join('\n') + '\n', 'utf8');

for (const s of sums) console.log(`${s.file}  ${s.size} B  sha256=${s.hash.slice(0, 16)}…`);
console.log(`完成：${NAME} 两个包已生成，release/ 中旧版本文件全部保留。`);
