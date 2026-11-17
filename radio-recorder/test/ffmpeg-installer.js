/* Regression test for tools/install-ffmpeg.js (v3.1.9).
 *
 * Everything runs against a throwaway --root, so the real bin/ffmpeg.exe,
 * config.json and the running 8787 service are never touched.
 * Fake "exe" files + --no-verify let us exercise install / skip / update /
 * rollback and all path write-backs without downloading 200 MB.
 *
 * Run from any cwd: node test/ffmpeg-installer.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SRC = path.resolve(__dirname, '..');
const INSTALLER = path.join(SRC, 'tools', 'install-ffmpeg.js');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-ffmpeg-test-'));
const FROM = path.join(ROOT, '_source');
const FROM2 = path.join(ROOT, '_source2');
const BIN = path.join(ROOT, 'bin');
const CLEAN_ENV = Object.assign({}, process.env, {
  PATH: (process.env.SystemRoot || 'C:\\Windows') + '\\System32'
});

function writeFake(dir, tag) {
  fs.mkdirSync(dir, { recursive: true });
  for (const n of ['ffmpeg', 'ffplay', 'ffprobe']) fs.writeFileSync(path.join(dir, n + '.exe'), 'FAKE-' + tag + '-' + n);
}
function run(args) {
  return spawnSync(process.execPath, [INSTALLER].concat(args), {
    encoding: 'utf8', env: CLEAN_ENV, timeout: 30000, cwd: SRC
  });
}
const out = r => (r.stdout || '') + (r.stderr || '');
let pass = true, total = 0;
const check = (name, ok, detail) => {
  total++;
  if (!ok) pass = false;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
};
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };

try {
  console.log('--- 1. 空目录 --check：只读，不创建任何东西 ---');
  writeFake(FROM, 'v1');
  writeFake(FROM2, 'v2');
  const c0 = run(['--check', '--root', ROOT, '--no-notify']);
  check('--check 退出码 0', c0.status === 0, out(c0).slice(0, 160));
  check('报告未安装', /未安装/.test(out(c0)));
  check('明确不写任何文件', /未修改任何配置/.test(out(c0)));
  check('未生成 config.json', !fs.existsSync(path.join(ROOT, 'config.json')));
  check('未生成 bin/ 目录内容', !fs.existsSync(path.join(BIN, 'ffmpeg-location.json')));

  console.log('--- 2. --from 离线安装 + 路径回写 ---');
  fs.writeFileSync(path.join(ROOT, 'config.json'), JSON.stringify({
    outputDir: 'D:/my-radio', filePrefix: 'FM990', volume: 42, engine: 'ffmpeg'
  }, null, 2));
  fs.writeFileSync(path.join(ROOT, 'config.example.json'), JSON.stringify({
    ffmpegPath: '', ffplayPath: '', engine: 'ffmpeg'
  }, null, 2));
  fs.mkdirSync(BIN, { recursive: true });
  fs.writeFileSync(path.join(BIN, 'sentinel.txt'), 'do-not-delete');
  const r1 = run(['--root', ROOT, '--from', FROM, '--no-verify', '--no-notify']);
  check('安装退出码 0', r1.status === 0, out(r1).slice(0, 300));
  check('三个 exe 已复制', ['ffmpeg', 'ffplay', 'ffprobe'].every(n => fs.existsSync(path.join(BIN, n + '.exe'))));
  check('既有 sentinel 文件完好', fs.readFileSync(path.join(BIN, 'sentinel.txt'), 'utf8') === 'do-not-delete');
  const cfg = readJson(path.join(ROOT, 'config.json'));
  check('config.json 写入 ffmpegHome', cfg.ffmpegHome === BIN, String(cfg.ffmpegHome));
  check('config.json 写入 ffmpegPath', cfg.ffmpegPath === path.join(BIN, 'ffmpeg.exe'));
  check('config.json 写入 ffplayPath', cfg.ffplayPath === path.join(BIN, 'ffplay.exe'));
  check('用户原有字段保留', cfg.outputDir === 'D:/my-radio' && cfg.filePrefix === 'FM990' && cfg.volume === 42);
  check('原 config 已备份', fs.readdirSync(ROOT).some(f => f.startsWith('config.json.bak-')));
  const tpl = readJson(path.join(ROOT, 'config.example.json'));
  check('模板补了 ffmpegHome 空字段', tpl.ffmpegHome === '');
  check('模板不含本机绝对路径', !JSON.stringify(tpl).includes(ROOT));
  const loc = readJson(path.join(BIN, 'ffmpeg-location.json'));
  check('location.json 记录安装目录', loc && loc.ffmpegHome === BIN && loc.ffmpegPath === path.join(BIN, 'ffmpeg.exe'));
  check('location.json 记录来源', loc && /_source/.test(loc.source));
  const envBat = fs.readFileSync(path.join(BIN, 'ffmpeg-env.bat'));
  check('ffmpeg-env.bat 为 CRLF', envBat.includes(Buffer.from('\r\n')));
  check('ffmpeg-env.bat 含 FFMPEG 绝对路径', envBat.toString('utf8').includes('set "FFMPEG=' + path.join(BIN, 'ffmpeg.exe') + '"'));

  console.log('--- 3. 默认重跑：不覆盖已有 exe ---');
  const before = fs.readFileSync(path.join(BIN, 'ffmpeg.exe'), 'utf8');
  const r2 = run(['--root', ROOT, '--no-notify']);
  check('重跑退出码 0', r2.status === 0, out(r2).slice(0, 200));
  check('明确提示跳过', /\[跳过\]/.test(out(r2)));
  check('exe 内容未被改动', fs.readFileSync(path.join(BIN, 'ffmpeg.exe'), 'utf8') === before);
  check('未联网下载', !/下载：/.test(out(r2)));

  console.log('--- 4. --check 装后状态 ---');
  const c1 = run(['--check', '--root', ROOT, '--no-notify']);
  check('报告已安装', /已安装/.test(out(c1)));
  check('识别为程序目录', /程序目录（随程序走）/.test(out(c1)));

  console.log('--- 5. --update：旧 exe 备份而非删除 ---');
  const r3 = run(['--root', ROOT, '--from', FROM2, '--update', '--no-verify', '--no-notify']);
  check('升级退出码 0', r3.status === 0, out(r3).slice(0, 300));
  check('新版本已生效', fs.readFileSync(path.join(BIN, 'ffmpeg.exe'), 'utf8').includes('FAKE-v2'));
  const backups = fs.readdirSync(BIN).filter(f => f.startsWith('_backup-'));
  check('生成备份目录', backups.length >= 1, backups.join(','));
  check('备份里保留旧 exe', backups.some(b => fs.readFileSync(path.join(BIN, b, 'ffmpeg.exe'), 'utf8').includes('FAKE-v1')));
  check('sentinel 仍在', fs.existsSync(path.join(BIN, 'sentinel.txt')));

  console.log('--- 6. --no-config / 纯脚本静态契约 ---');
  const ROOT2 = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-ffmpeg-test2-'));
  const r4 = run(['--root', ROOT2, '--from', FROM, '--no-verify', '--no-notify', '--no-config']);
  check('--no-config 安装成功', r4.status === 0, out(r4).slice(0, 220));
  check('--no-config 不写 config.json', !fs.existsSync(path.join(ROOT2, 'config.json')));
  check('仍写 location.json / env.bat', fs.existsSync(path.join(ROOT2, 'bin', 'ffmpeg-location.json')) &&
    fs.existsSync(path.join(ROOT2, 'bin', 'ffmpeg-env.bat')));
  const serverSrc = fs.readFileSync(path.join(SRC, 'server.js'), 'utf8');
  const batSrc = fs.readFileSync(path.join(SRC, 'tools', 'record_fm990.bat'), 'utf8');
  const readme = fs.readFileSync(path.join(SRC, 'bin', 'README.md'), 'utf8');
  check('server.js 读取 ffmpeg-location.json', /ffmpeg-location\.json/.test(serverSrc));
  check('server.js 支持 ffmpegHome', /ffmpegHome/.test(serverSrc));
  check('record_fm990.bat 读取 ffmpeg-env.bat', /ffmpeg-env\.bat/.test(batSrc));
  check('bin/README.md 有下载说明', /install-ffmpeg/.test(readme) && /gyan|Gyan|BtbN/.test(readme));
  const bat = fs.readFileSync(path.join(SRC, 'tools', 'install-ffmpeg.bat'));
  check('安装入口 .bat 为 CRLF + ASCII', bat.includes(Buffer.from('\r\n')) && bat.every(b => b < 128));
  check('安装脚本语法通过', run(['--help']).status === 0);
  fs.rmSync(ROOT2, { recursive: true, force: true });
} finally {
  fs.rmSync(ROOT, { recursive: true, force: true });
}
console.log(`${pass ? 'FFMPEG_INSTALLER=PASS' : 'FFMPEG_INSTALLER=FAIL'} · ${total} 项断言`);
process.exit(pass ? 0 : 1);
