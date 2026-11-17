# 上海 FM 广播录制台 / Shanghai FM Radio Recorder

> **v3.1.12** · 零 npm 依赖的本地网络电台录制台 · Node.js + 原生 HTML/CSS/JS · 仅监听 `127.0.0.1:8787`

一个跑在本机的网页应用：把 FFmpeg 的直播流抓取命令包装成可视化操作，支持整点录制、24 小时录制、指定时间段录制、多电台并行、节目单（EPG）自动排期、断点续录、按任务条目排他监听、页面内文件管理。

**核心音质原则：零二次损失。** 全程 `-c copy`（或内置引擎按字节原样写盘），不解码、不重编码、不重采样；录到的就是电台发出的那一串字节。MP3 裸流直出 `.mp3`，HLS 流直出 `.ts`。

---

## 1. 快速开始

### 环境要求

| 依赖 | 要求 | 说明 |
|---|---|---|
| Node.js | **18+**（推荐 20/22 LTS） | 唯一的硬性依赖，无需 `npm install` |
| 浏览器 | Chrome / Edge | 用于打开本地 UI |
| FFmpeg | **可选** | 不装也能录：自动切换到内置零依赖直录引擎。需要时用 `node tools/install-ffmpeg.js` 一键下载安装 |
| 操作系统 | Windows 为主 | `.bat` 启动脚本为 Windows 专用；`node server.js` 跨平台可用 |

### 启动

```bash
# 方式一：命令行（跨平台）
node server.js

# 方式二：Windows 双击
start.bat
```

浏览器打开 <http://127.0.0.1:8787/>。停止服务用界面上的「停止服务」、`stop-service.bat`，或 Ctrl+C。

首次启动会自动创建 `recordings/`（录音目录）与 `logs/`（日志目录）；`config.json`、`runtime.json`、`epg-cache.json`、`alerts.json` 会在**首次需要写入时**按默认值自动生成。`stations.json` 已随包附带（若删除，服务会用内置的 11 台种子自动重建）。**不需要手工建任何文件，也不需要 `npm install`。**

### 可选：安装 FFmpeg（发布包不含二进制）

`bin/` 里的 `ffmpeg.exe` / `ffplay.exe` / `ffprobe.exe` 合计约 654 MB，且 FFmpeg 按 LGPL/GPL 独立授权，**两个发布包都不附带**。需要成熟重连与 HLS 处理时，一键装回来：

```bash
node tools/install-ffmpeg.js          # Windows 也可双击 tools/install-ffmpeg.bat
node tools/install-ffmpeg.js --check  # 只读检测，不下载、不改文件
node tools/install-ffmpeg.js --update # 升级（旧 exe 先备份，不删除）
```

脚本自动完成：**找最新版 → 下载 → SHA256 校验 → 解压 → 复制三个 exe 到 `bin/` → 把安装目录写进所有需要的文件 → 通知运行中的服务重新检测 → 执行 `ffmpeg -version` 验证**。

安装目录会写入 `config.json`（`ffmpegHome` / `ffmpegPath` / `ffplayPath`，保留其它字段并备份）、`bin/ffmpeg-location.json`、`bin/ffmpeg-env.bat`；`config.example.json` 只补空字段，**源码和文档里不写本机绝对路径**。`server.js` 与 `tools/record_fm990.bat` 会读取这些文件，因此 `--dir` 装到自定义目录也能自动找到。

下载源、离线安装（`--source` 本地 zip/镜像、`--from` 已解压目录、`--winget`）、手动三步、校验与故障排查，全部见 **[bin/README.md](bin/README.md)**。

未检测到 ffmpeg 时，程序自动使用**内置直录引擎**：MP3 裸流按帧对齐原样写盘，HLS 流按分片原样拼接为 `.ts`，同样是零重编码、音质完全相同。装 ffmpeg **不会让音质更好**。

---

## 2. 主要功能

| 模块 | 能力 |
|---|---|
| 录制模式 | 立即录制 / 整点对齐录制 / 指定时长 / 指定起止时间段 / 24 小时连续 / 每日重复 |
| 多电台并行 | 最多 8 路同时录制，每路独立状态、速率、当前文件、启停与删除 |
| 零损失落盘 | `-c copy`、`-id3v2_version 0`、`-flush_packets 1`、递增序号分段，避免同名覆盖 |
| 无损合并 | 多个 `.mp3` 分段按时间顺序按字节拼接（不解码、不重编码），原文件保留 |
| EPG 节目单 | 自动拉取节目表，按节目名定时录制，支持每日重复；**每条节目单的文件名前缀按该电台频率自动生成**（FM 90.9 → FM909），换台 / 编辑 / 只填流地址都会自动校正，可显式勾选自定义前缀 |
| 断点续录 | 服务重启后自动接管未完成任务 |
| 空片段守卫 | 尾部剩余 ≤ 15 秒断流不再重连，直接标记「源中断」（保留每日重复）；重连后 12 秒无首帧自动放弃；收尾只清理本次任务创建的 0 字节片段，历史空文件不再误报「疑似损坏」 |
| 监听 | 每个任务行有独立监听按钮，全页单例播放器**排他**；不可播放的源自动灰掉 |
| 试听 | 「试听 10 秒」快速验声；**长试听 10 / 30 / 60 分钟**，倒计时显示、到时自动停止、断流自动重连，与任务监听互斥 |
| 流格式自检 | 识别 HTTP 长连接 MP3 裸流 / HLS `.m3u8`，自动选择对应的录制参数与扩展名 |
| 6 秒试录 / 命令预览 | 起正式任务前可先验证流可用性与 FFmpeg 命令 |
| 一键自检 | 12 项自检覆盖单元测试、ffmpeg、流、写盘、删除、合并、EPG、磁盘、API |
| 文件管理 | 页面内删除、批量删除、打开目录、复制路径、可视化目录浏览器新建/选择保存目录；**回听播放器与列表解耦**，删除其它文件 / 刷新列表不打断播放与进度 |
| 回听 | 每行「▶ 回听」调用列表外单例播放器；删到正在回听的文件才自动停止；与任务监听、短/长试听全局排他 |
| 告警与清理 | 磁盘水位告警、按策略自动清理旧录音 |

---

## 3. 电台库

`stations.json` 收录 **11 台上海地区可收听的 FM 频率**（含中央级在沪落地频率），可在 UI 里增删改。前缀默认按频率推导：`FM 105.7 → FM1057`、`FM 94.7 → FM947`、`FM 87.9 → FM879`。

| 频率 | 电台 | 流格式 |
|---|---|---|
| FM 93.4 / AM 990 | 上海新闻广播 | MP3 裸流 |
| FM 105.7 / AM 648 | 上海交通广播 | MP3 裸流 |
| FM 94.7 | 上海经典音乐广播 | MP3 裸流 |
| 其余 7 台 SMG 本地台 | 见 `stations.json` | MP3 裸流 |
| FM 87.9 | CGTN Radio 英语环球广播（中央级在沪落地，非 SMG 本地台） | **HLS / AAC → `.ts`** |

**频率辨析**：AM 990 kHz 与 FM 93.4 MHz 是上海新闻广播**同一套节目双频同步**；FM 99.0 MHz 是另一个台（中央广播电视总台「中国之声」）。项目里的文件前缀 `FM990` 来自中波呼号，是历史命名，不是调频频率。

> FM 87.9 是 HLS 流，Chrome/Edge 的原生 `<audio>` 不支持 m3u8，界面会把该任务的监听按钮灰掉；试听请用 VLC / mpv 打开流地址。**录制不受影响**，仍是零损失直录 `.ts`。

---

## 4. 目录结构

```
.
├── server.js                 本地 HTTP 服务与全部 API（零 npm 依赖）
├── lib/
│   ├── recorder.js           录制引擎：ffmpeg / 内置直录 / HLS 分片
│   ├── jobs.js               多任务管理、停止与删除、断点续录
│   ├── scheduler.js          定时与节目单排期
│   ├── epg.js                节目表抓取与缓存
│   ├── storage.js            录音文件枚举、删除保护、健康校验
│   ├── stations.js           电台库与前缀推导
│   ├── runtime.js            运行时状态持久化与日志
│   ├── alerts.js             告警策略
│   ├── selftest.js           12 项一键自检
│   └── launch-hidden.vbs     桌面窗口辅助脚本
├── public/                   index.html / app.js / app.css（原生前端，无构建步骤）
├── test/                     模拟 DOM 与模块级回归测试
├── docs/                     运行与功能操作手册、调研报告
├── tools/                    install-ffmpeg.js（下载/安装/路径回写）、install-ffmpeg.bat、build-release.js（打发布包）、record_fm990.bat
├── bin/                      可选：放 ffmpeg.exe / ffplay.exe / ffprobe.exe；含下载说明 README.md
├── config.example.json       配置模板（复制为 config.json 可自定义）
├── stations.json             默认电台库
├── start.bat / stop-service.bat / desktop.bat / install-autostart.bat / uninstall-autostart.bat
├── package.json              仅定义脚本，无 dependencies
├── README.md / LICENSE / NOTICE.md / CHANGELOG.md / .gitignore
├── recordings/               【运行时生成】录音文件，不纳入版本控制
└── logs/                     【运行时生成】日志
```

---

## 5. 配置

`config.json` 由首次启动自动生成，也可以通过 UI 的「输出与音质」写入。想手工定制，把 `config.example.json` 复制为 `config.json` 后修改。

| 字段 | 默认 | 含义 |
|---|---|---|
| `streamUrl` / `stationId` | 上海新闻广播 | 直播流地址与选中的电台 |
| `outputDir` | 程序目录下 `recordings/` | 保存目录；模板里特意**不写绝对路径**，避免绑定某台机器 |
| `filePrefix` | `FM990` | 文件名前缀，跟随电台频率自动变化 |
| `segmentMinutes` | `60` | 分段时长（分钟） |
| `engine` | `ffmpeg` | `ffmpeg` / `builtin`（零依赖）；未装 ffmpeg 时自动回退 |
| `ffmpegHome` / `ffmpegPath` / `ffplayPath` | 空 | ffmpeg 安装目录与可执行文件路径，由 `tools/install-ffmpeg.js` 自动写入；也可在 UI 手动指定。模板里故意留空，不含绝对路径 |
| `codec` | `copy` | 固定为流拷贝，**不要改成重编码**，那会二次损失音质 |
| `volume` / `autoMonitor` | `80` / `false` | 监听音量；「开始新任务时自动监听」（仅手动启动的任务） |
| `mode` / `durationMinutes` / `hourlyHours` / `rangeStart` / `rangeEnd` | — | 录制模式参数，一般由 UI 写入 |

`PORT` 环境变量可改端口（默认 `8787`）；服务只绑定 `127.0.0.1`，不对外网开放。

---

## 6. 测试

```bash
node test/selftest.js          # 模块自测：25 项
node test/ui-delete-chain.js   # 模拟 DOM 按钮链路回归：13 组
node test/monitor-chain.js     # 监听排他 / 灰化 / 生命周期：11 组 55 项
node test/preview-chain.js     # 长试听 10/30/60 分钟、倒计时、断流重连：10 组 55 项
node test/ffmpeg-installer.js  # 安装脚本：离线安装 / 路径回写 / 备份升级 / 回滚（只在临时目录跑）
node test/plan-prefix.js       # 节目单前缀：频率推导 / 流地址反查 / 六条入口 / 表单联动：19 组 74 项
node test/playback-chain.js    # 回听与列表刷新解耦：进度保持 / 删除其它文件不受影响 / 排他：12 组 44 项
node test/empty-segment.js     # 空片段守卫：收尾清理 / 尾部不重连 / 首帧超时 / 源中断终态：9 组 61 项
```

也可以 `npm test` 一次跑完全部，或在 UI 里点「一键自检」。测试不需要 `npm install`，也不会改动你已有的录音文件、节目单、本机 ffmpeg 或 `config.json`。

---

## 7. 发布包说明

本项目产出两种压缩包，均放在仓库外的 `release/` 目录：

| 包 | 用途 | 内容差异 |
|---|---|---|
| `*-source.zip` | 上传到开源源码托管/发布服务 | 全量源码、8 套测试、安装/开发脚本、调研报告、`.gitignore`、`package.json` |
| `*-release.zip` | 解压即用 | 只含运行所需文件与文档（含 `tools/install-ffmpeg.*` 与 `bin/README.md`），不含 `test/`、调研报告 |

两个包**都不包含**：用户录音、日志、本机配置与运行状态、ffmpeg 二进制、任何本机绝对路径或个人标识。但都**包含**自动安装脚本与下载说明，解压后一条命令即可把三个 exe 装回 `bin/`。详见 `bin/README.md` 与 `release/RELEASE_NOTES.md`。

想自己重建这两个包：`node tools/build-release.js v3.1.12`（白名单复制 → 隐私扫描 → 生成 MANIFEST / START_HERE → 压缩 → 更新 SHA256SUMS；只往 `release/` 写新文件，不删旧版本）。

---

## 8. 合规与许可

- 本项目只提供**录制工具**，不提供、不托管、不转播任何广播内容。内置的流地址来自公开网络，可能随时变更或失效，请自行确认可用性并遵守对应平台的服务条款。
- 广播节目的著作权归各广播机构所有。录制内容仅限个人学习、研究或私用时移，**请勿公开传播或商用**。详见 [NOTICE.md](NOTICE.md)。
- ffmpeg 为独立的第三方项目，本仓库不分发其二进制；用 `tools/install-ffmpeg.js` 自行下载安装时请遵守其 LGPL/GPL 许可。
- 本项目采用 [MIT License](LICENSE)。

---

## 9. 文档

- `docs/OPERATION_MANUAL.md` — 运行与功能操作手册（含各版本变更、故障排查、API 表）
- `docs/RESEARCH_REPORT.md` — 网络电台直播流保存可行性与容量估算调研报告

当前版本：**v3.1.12**（2026-11-16）。版本变更摘要见 [CHANGELOG.md](CHANGELOG.md)。
