# bin/ · FFmpeg 下载与安装说明

这个目录只有说明文件：**源码包与发布包都不附带 `ffmpeg.exe` / `ffplay.exe` / `ffprobe.exe`**。
本文件说明「去哪下载、怎么一键装回来、安装目录会写到哪些文件、怎么升级与排错」。

---

## 1. 为什么不含二进制，且不装也能录

| 原因 | 说明 |
|---|---|
| 体积 | full build 三个 exe 合计约 **654 MB**，源码包无法在开源平台正常分发 |
| 许可证 | FFmpeg 依构建不同按 **LGPL / GPL** 分发，附带二进制需额外履行对应义务 |
| 不是必需 | `lib/recorder.js` 内置零依赖直录引擎：MP3 裸流按帧对齐原样写盘为 `.mp3`，HLS `.m3u8` 分片原样拼接为 `.ts`，都不解码、不重编码，与 `-c copy` 等价 |

服务启动时探测不到 ffmpeg，会自动切换内置引擎并在日志里说明。**装 ffmpeg 不会让音质更好**，价值在于成熟的重连、HLS 处理与容器封装。

---

## 2. 一键安装（推荐）

在项目根目录执行（Windows 也可直接双击 `tools/install-ffmpeg.bat`）：

```bash
node tools/install-ffmpeg.js
```

脚本会自动完成：**找最新版 → 下载 → 校验 → 解压 → 复制三个 exe 到 `bin/` → 回写安装目录到所有需要的文件 → 通知运行中的服务重新检测 → 执行 `ffmpeg -version` 验证**。

```bash
node tools/install-ffmpeg.js --check        # 只检测，不下载、不改任何文件
node tools/install-ffmpeg.js --update       # 强制升级到最新版（旧 exe 先备份）
node tools/install-ffmpeg.js --from DIR     # 从已解压目录 / 系统已装目录离线复制
node tools/install-ffmpeg.js --source ZIP   # 用本地 zip 或指定 URL（含镜像）
node tools/install-ffmpeg.js --winget       # 先 winget install Gyan.FFmpeg 再复制
node tools/install-ffmpeg.js --dir DIR      # 装到自定义目录（路径仍会写回配置）
node tools/install-ffmpeg.js --help         # 全部参数
```

常用附加开关：`--no-config`（不写 `config.json`）、`--no-notify`（不通知运行中的服务）、
`--no-backup`（升级时不备份旧 exe）、`--keep-temp`（保留下载 zip 与解压目录）、
`--sha256 HEX`（校验下载包）、`--no-verify`（跳过 `-version` 校验，仅用于特殊环境/测试）。

**默认不覆盖已有文件**：检测到 `bin/ffmpeg.exe` 已存在就直接跳过。若系统 PATH 里已有 ffmpeg 但程序目录里没有，脚本会**直接复用本机已装的三个 exe 复制到 `bin/`，不联网下载**。

---

## 3. 去哪下载（手动方式）

脚本默认按下表顺序自动选源；手动下载也用同样的地址。

| 来源 | 地址 | 说明 |
|---|---|---|
| **BtbN 自动构建**（脚本首选） | <https://github.com/BtbN/FFmpeg-Builds/releases/tag/latest> | `ffmpeg-master-latest-win64-lgpl.zip`（其次 `-gpl.zip`），静态单文件、含 ffmpeg/ffplay/ffprobe；脚本通过 GitHub API 读取最新 asset 及其 SHA256 digest |
| **gyan.dev essentials**（备用） | <https://www.gyan.dev/ffmpeg/builds/> | `ffmpeg-release-essentials.zip` → 重定向到 `packages/ffmpeg-<版本>-essentials_build.zip`；本机 9.0.2 full build 即由此渠道的 winget 包安装 |
| **winget** | `winget install --id Gyan.FFmpeg -e` | 装到系统，再把三个 exe 复制到 `bin/`；脚本 `--winget` 自动完成这两步 |
| 其它 | <https://ffmpeg.org/download.html> | 官方下载页，列出各平台第三方构建 |

选包要点：

- Windows 64 位选 **`win64`** 且 **非 `shared`** 的 zip（`shared` 版需要一堆 `.dll`，复制单个 exe 会跑不起来）。
- `lgpl` / `gpl` 是许可证差异，录广播用不到需要 GPL 的编码器，任选其一。
- 只要主引擎可以**只复制 `ffmpeg.exe`**；`ffplay.exe` 用于本地试听、`ffprobe.exe` 用于探测流信息，都是可选的（界面监听走浏览器，不依赖 ffplay）。
- 下载完建议校验 SHA256：`certutil -hashfile ffmpeg.zip SHA256`，或给脚本 `--sha256 <值>` 让它自动比对。

**网络不通怎么办**（GitHub 在国内常被墙 / 证书报错）：

```bash
node tools/install-ffmpeg.js --source D:\Downloads\ffmpeg-master-latest-win64-lgpl.zip
node tools/install-ffmpeg.js --source https://<你的镜像>/ffmpeg-master-latest-win64-lgpl.zip
node tools/install-ffmpeg.js --from D:\Downloads\ffmpeg-master-latest-win64-lgpl\bin
```

`--from` 接**已解压目录**（含子目录也会递归找 exe），完全离线；`--source` 接本地 zip 或任意 http(s) 地址。

---

## 4. 手动安装三步

1. 下载上表任一 Windows 64 位 zip 并解压。
2. 把解压出来的 `bin/ffmpeg.exe`、`ffplay.exe`、`ffprobe.exe` 复制到**本 `bin/` 目录**。
3. 重启服务，或在界面点「重新检测」。也可在「输出与音质 → 高级」里直接填 `ffmpegPath` 绝对路径。

服务端 `findExe()` 的探测顺序见第 5 节，**不依赖 PATH、不写注册表、不需要管理员权限**。

---

## 5. 「安装目录」会被写到哪些文件

这是 `--dir` 自定义安装目录时最关键的部分：脚本不只复制 exe，还会把目录/路径写进所有需要知道它的地方。

| 文件 | 写入/读取内容 | 由谁用 |
|---|---|---|
| `config.json` | `ffmpegHome`（安装目录）、`ffmpegPath`、`ffplayPath`；**保留**保存目录、定时段等其它字段，并自动备份为 `config.json.bak-<时间戳>` | `server.js` 的 `findExe()` |
| `config.example.json` | 只补一个空的 `ffmpegHome` 字段 | 配置模板说明；**绝不写入绝对路径**，保证发布包不绑定某台机器 |
| `bin/ffmpeg-location.json` | 结构化安装记录：三个 exe 路径、版本、来源、安装时间 | `server.js` 的 `ffmpegLocation()` 作为候选路径读取 |
| `bin/ffmpeg-env.bat` | `set "FFMPEG_BIN=…"` / `FFMPEG` / `FFPLAY` / `FFPROBE`（CRLF） | `tools/record_fm990.bat` 用 `call` 读取，独立极简录制脚本也能找到自定义目录 |
| `tools/record_fm990.bat` | 不改写源码，运行时 `call bin/ffmpeg-env.bat` | 独立脚本 |
| `server.js` | 不改写源码，`findExe()` 增加 `ffmpegHome` 与 `ffmpeg-location.json` 两类候选 | 主服务 |
| `POST /api/detect` | 安装完通知正在运行的本机服务立即重新探测 | 免重启生效 |

源码与文档里**不写死任何本机绝对路径**；只有运行时生成的 `config.json`、`ffmpeg-location.json`、`ffmpeg-env.bat` 会带本机路径，这三个文件都在 `.gitignore` 里（或由安装器生成），不进发布包。

---

## 6. 升级、回退与卸载

- 升级：`node tools/install-ffmpeg.js --update`。旧 exe 以「移动」方式备份到 `bin/_backup-<时间戳>/`，**不删除**；确认新版可用后可自行清理备份目录。`--update` 会占额外约 654 MB 磁盘，加 `--no-backup` 可跳过备份（直接覆盖）。
- 失败自动回滚：若复制后的 `ffmpeg -version` 执行失败，脚本会把备份移回原位，并只清理本次新建的文件。
- 回退：把 `bin/_backup-<时间戳>/` 里的三个 exe 复制回 `bin/` 即可。
- 卸载：把三个 exe 移走（或删掉 `bin/ffmpeg-location.json` 并在 UI 清空 `ffmpegPath`），服务会自动回到内置零依赖引擎。安装器**不提供自动卸载**，避免误删用户文件。
- 安装路径含中文/空格时，生成的 `ffmpeg-env.bat` 在 cmd 下可能乱码；建议用 `--dir` 指定纯英文路径，或在 UI 里手动填 `ffmpegPath`。

---

## 7. 校验与故障排查

```bash
node tools/install-ffmpeg.js --check          # 只读检测：是否安装、位置、版本
bin\ffmpeg.exe -version                        # 直接确认可执行文件
```

| 现象 | 原因与处理 |
|---|---|
| `所有下载源都失败` | GitHub / gyan.dev 被网络策略拦截 → 用 `--source` 指向本地 zip 或镜像 URL，或 `--winget` / `--from` 离线安装 |
| `下载内容只有 N 字节` / `不是 ZIP 包` | 拿到的是错误页或鉴权页（脚本要求 > 8 MB 且 `PK` 头）→ 换源 |
| `SHA256 校验不通过` | 下载被篡改或镜像文件不同 → 换源；或显式 `--sha256` 指定正确值 |
| `解压失败` | Windows 优先用 PowerShell `Expand-Archive`，失败回落 `tar.exe`；两者都不可用时加 `--keep-temp` 保留 zip，手动解压后 `--from` |
| `安装后的 ffmpeg 无法执行 -version` | 架构不匹配（如 win32/arm 包）、文件损坏、杀软拦截 → 换 win64 非 shared 包；特殊环境可 `--no-verify` 跳过 |
| 界面仍显示「未检测到 ffmpeg」 | 点「重新检测」或重启服务；检查 `config.json` 的 `ffmpegPath` / `bin/ffmpeg-location.json`；期间内置引擎照常录制 |
| 只想验证某个流 | UI 的「检测流格式 / 6 秒试录 / 长试听」，与 ffmpeg 是否安装无关 |

---

## 8. 许可证

FFmpeg 是独立第三方项目，本仓库**不分发其二进制**。自行下载/安装时请遵守对应构建的 LGPL / GPL 许可：<https://ffmpeg.org/legal.html>。本项目自身采用 MIT，见根目录 `LICENSE`。

完整操作细节见 `docs/OPERATION_MANUAL.md`，下载源与容量估算见 `docs/RESEARCH_REPORT.md`。
