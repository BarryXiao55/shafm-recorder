# 上海 FM 录制台

一个零 npm 依赖的本地 Web 应用，用于无损录制上海地区网络电台直播流。支持 FFmpeg 直录与内置引擎兜底、多电台并行录制、EPG 节目单排期、分段保存、监听/试听与告警。当前版本 **v3.1.12**，许可证 **MIT**。

> 源流本身是 64 kbps / 44.1 kHz 有损音频，本项目采用 `-c:a copy` 或字节原样写入，不重编码，不产生二次音质损失。

## 快速开始

1. 安装 Node.js 18 或更高版本。
2. 进入 `radio-recorder/` 目录，双击 `start.bat`（Windows）或执行 `node server.js`。
3. 浏览器打开 `http://127.0.0.1:8787`。
4. 可选：运行 `tools/install-ffmpeg.js --check` 检测 FFmpeg；未安装时程序自动使用内置直录引擎。

详细配置与操作见 [运行与功能操作手册](radio-recorder/docs/OPERATION_MANUAL.md)。

## 文档

- [运行与功能操作手册](radio-recorder/docs/OPERATION_MANUAL.md) — 安装、界面、任务模式、EPG、告警、排错。
- [网络电台录制调研报告](radio-recorder/docs/RESEARCH_REPORT.md) — 音源方案、容量估算、合规边界。
- [程序源码与说明](radio-recorder/README.md) — 目录结构、接口、测试与发布。

## 主要特性

- 零第三方 npm 依赖，仅使用 Node.js 标准库。
- FFmpeg 引擎（`ffmpeg`）与内置 ICY/HLS 直录引擎自动切换。
- 多任务并行、独立重连计数与速率统计。
- EPG 节目单、每日重复、按频率自动派生文件前缀。
- 断线自动重连；尾部 ≤15 秒不重连；重连后 12 秒无首帧按源中断结束并清理空片段。
- 监听、10/30/60 分钟长试听、回听三者互斥，避免声音通道冲突。
- 告警中心支持企业微信 / 钉钉 / 自定义 Webhook。

## 目录结构

```text
.
├── radio-recorder/
│   ├── server.js              # HTTP 服务与 API
│   ├── public/                # 前端界面
│   ├── lib/                   # 录制、任务、排期、存储等模块
│   ├── tools/                 # FFmpeg 安装与发布构建脚本
│   ├── test/                  # 自测脚本
│   ├── docs/                  # 项目内文档（操作手册 / 调研报告）
│   ├── README.md              # 程序说明
│   └─ stations.json           # 上海 FM 电台库
└── .gitignore / .gitattributes
```

## 运行测试

```bash
cd radio-recorder
npm test
```

测试覆盖删除链路、监听/试听/回听互斥、前缀推导、FFmpeg 安装器与空片段守卫，全部使用临时目录与独立端口，不会改动用户录音。

## 隐私与合规

`config.json`、`runtime.json`、`alerts.json`、`epg-cache.json`、`recordings/`、`logs/`、`bin/` 中的二进制及 `release/` 发布包均不纳入版本控制。录制的广播内容仅限个人学习与研究使用，请勿公开传播、商业使用或绕过平台鉴权。

## 许可证

MIT，见 [LICENSE](radio-recorder/LICENSE)。
