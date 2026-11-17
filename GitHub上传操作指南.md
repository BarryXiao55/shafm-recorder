# GitHub 上传（驻留）操作指南

适用场景：把当前工作区 `C:/Users/barry/WorkBuddy/2026-11-14-21-06-10` 的上海 FM 录制台项目安全、可回滚地上传到 GitHub。项目版本 v3.1.12，零 npm 依赖，许可证 MIT（仓库内已有 `LICENSE` 与 `package.json`）。

## 0. 结论

**推荐做法：源代码和文档进 Git 仓库；约 654 MB 的 FFmpeg 二进制、用户录音、运行日志、本机配置和发布压缩包一律不进仓库。** 发布包作为 GitHub Release 附件上传。按此方案，Git 仓库体积可从 730 MB 级降到约 1–2 MB，推送稳定且不会泄露本机路径、排期或 Webhook 地址。

两套路径都基于同一个安全基线，命令可直接复制执行：

- **方案 A（我自动处理）**：我执行本地准备与提交，创建远端仓库和推送前**暂停并请你确认一次**。
- **方案 B（你手动处理）**：你在 GitHub 网页建空仓库，再用本地命令行提交和推送。

---

## 1. 本机现状（已核验，2026-11-18）

| 项目 | 结果 | 影响 |
|---|---|---|
| Git 仓库 | 当前工作区**尚未** `git init`，没有远端 | 两套方案都从初始化开始 |
| GitHub CLI | 已安装并登录 `BarryXiao55`，Token 含 `repo`、`workflow` 权限 | 可直接用 `gh` 建仓、推送、发 Release |
| Git 身份 | `barryxiao <test-qa@163.com>` | 建议改成 GitHub noreply 邮箱再提交，避免暴露个人邮箱 |
| 目录体积 | `radio-recorder/` 709 MB（`bin/` 654 MB、`recordings/` 55 MB）；`release/` 21 MB（`_staging/` 19 MB） | 必须靠忽略规则排除，否则超出 GitHub 单文件 100 MB 限制 |
| 已有忽略规则 | `radio-recorder/.gitignore` 已排除 `config.json`、`runtime.json`、`alerts.json`、`epg-cache.json`、`recordings/`、`logs/`、`bin/*.exe`、`*.zip`、`release/` | 子目录已安全；根目录原来没有忽略文件 |
| 隐私扫描 | 未发现真实 Token / 密码；本机绝对路径出现在**已被忽略**的 `config.json`、`runtime.json`、`logs/`，以及根目录旧脚本 `record_fm990.bat` | 旧脚本已加入根目录忽略规则 |

我已在本机新建两个准备文件（只新增，未删除、未改动任何现有项目文件）：

- `C:/Users/barry/WorkBuddy/2026-11-14-21-06-10/.gitignore`
- `C:/Users/barry/WorkBuddy/2026-11-14-21-06-10/.gitattributes`（保证 `.bat` 用 CRLF，其他文本用 LF）

**我尚未执行 `git init`，也尚未创建任何远端仓库或推送。** 创建远端仓库属于外部动作，需你确认仓库名与公开/私有属性后我才会做。

---

## 2. 安全红线：这些绝不能进仓库

1. `radio-recorder/config.json`、`runtime.json`、`alerts.json`、`epg-cache.json` —— 含本机 `D:\FMRecording`、任务排期、可能填写的 Webhook 地址。
2. `radio-recorder/recordings/` 下所有录音，以及 `logs/` 下所有日志 —— 含本机绝对路径。
3. `radio-recorder/bin/*.exe`、`*.dll`、`bin/ffmpeg-location.json`、`bin/ffmpeg-env.bat` —— 体积大、许可证独立、含本机路径。
4. `release/` 整个目录，尤其 `_staging/` 和 8 个历史 `.zip` —— 发布包改走 GitHub Releases。
5. `.workbuddy/` —— WorkBuddy 项目数据，**只忽略，不删除**。
6. 根目录 `record_fm990.bat` —— 硬编码 `C:\ffmpeg\bin`、`D:\Radio\FM990`。
7. 任何 `.env`、`*.pem`、`*.key`、Token、Webhook 完整 URL。

操作禁令：**不要**用 `git add -f` 强行添加被忽略文件；**不要**用 `git push --force`（除非处理误提交密钥且已明确确认）；提交前**必须**看一遍 `git status --short`。

---

## 3. 方案 A：我自动处理

### 3.1 需要你先确认的三件事

1. 仓库名（建议 `shanghai-fm-recorder`）与归属（建议 `BarryXiao55`）。
2. 可见性：公开（public）还是私有（private）。
3. 是否把工作区根目录的两份中文文档一并入库：`FM990录制台-运行与功能操作手册.md`、`FM990网络电台录制调研报告.md`（默认入库，它们是项目资料，不含凭据）。

### 3.2 我会按顺序执行的操作

```bash
cd /c/Users/barry/WorkBuddy/2026-11-14-21-06-10

# 1) 取 GitHub noreply 邮箱，避免提交里出现 test-qa@163.com
gh api user --jq .id
# 假设输出为 12345678，则：
git config user.name "barryxiao"
git config user.email "12345678+barryxiao@users.noreply.github.com"

# 2) 初始化并暂存
git init -b main
git add -A

# 3) 安全复核：确认敏感文件不在暂存区
git status --short
git diff --cached --stat
git check-ignore -v radio-recorder/config.json radio-recorder/runtime.json radio-recorder/bin/ffmpeg.exe release/_staging 2>/dev/null || true

# 4) 本地提交
git commit -m "chore: initial import of Shanghai FM recorder v3.1.12"

# 5) 创建远端并推送（此步执行前我会停下等你确认）
gh repo create shanghai-fm-recorder --public --source=. --remote=origin --push

# 6) 发布包作为 Release 附件，而非仓库文件
gh release create v3.1.12 \
  release/shanghai-fm-recorder-v3.1.12-source.zip \
  release/shanghai-fm-recorder-v3.1.12-release.zip \
  --title "v3.1.12" \
  --notes-file release/RELEASE_NOTES.md
```

第 5 步若提示仓库名已存在，我会改为只读检查 `gh repo view BarryXiao55/shanghai-fm-recorder`，再执行 `git remote add origin <url>` 与 `git push -u origin main`，不会覆盖远端内容。第 6 步若 tag 已存在，会改用 `gh release upload`。

---

## 4. 方案 B：你手动处理

### 4.1 网页端建仓库

1. 浏览器打开 GitHub，登录 `BarryXiao55`，点右上角 `+` → `New repository`。
2. Repository name 填 `shanghai-fm-recorder`；Description 可填 `Zero-dependency local web app for lossless recording of Shanghai FM live streams`。
3. 选择 **Public** 或 **Private**。
4. **不要**勾选 `Add a README file`、`Add .gitignore`、`Choose a license` —— 本地已有这些文件，勾选会产生无关初始提交并可能需要合并。
5. 点 `Create repository`，复制页面给出的 HTTPS 地址，形如 `https://github.com/BarryXiao55/shanghai-fm-recorder.git`。

### 4.2 本地命令行提交与推送

在 Git Bash 中逐条执行（PowerShell 把 `cd` 那行换成 `cd "C:\Users\barry\WorkBuddy\2026-11-14-21-06-10"`）：

```bash
cd /c/Users/barry/WorkBuddy/2026-11-14-21-06-10

# 建议：用 GitHub noreply 邮箱，先取数字 ID
gh api user --jq .id
git config user.name "barryxiao"
git config user.email "<上一步输出的数字>+barryxiao@users.noreply.github.com"

git init -b main
git add -A

# 关键复核：此命令输出里不应出现 config.json / runtime.json / .exe / .zip / recordings / logs / release
git status --short
git diff --cached --stat

git commit -m "chore: initial import of Shanghai FM recorder v3.1.12"

git remote add origin https://github.com/BarryXiao55/shanghai-fm-recorder.git
git branch -M main
git push -u origin main
```

若网页端误勾了 README 导致推送被拒，先执行：

```bash
git pull --allow-unrelated-histories origin main
git push -u origin main
```

若认证弹窗要求密码：**不要输入 GitHub 账号密码**，使用 GitHub CLI 登录（`gh auth login`）或个人访问令牌（PAT）作为密码。

### 4.3 用命令行发 Release（可选，比网页拖拽更可复现）

```bash
cd /c/Users/barry/WorkBuddy/2026-11-14-21-06-10

gh release create v3.1.12 \
  release/shanghai-fm-recorder-v3.1.12-source.zip \
  release/shanghai-fm-recorder-v3.1.12-release.zip \
  --title "v3.1.12" \
  --notes-file release/RELEASE_NOTES.md
```

也可在网页端：`Releases` → `Draft a new release` → Tag `v3.1.12` → 拖入上述两个 zip → `Publish release`。

---

## 5. 上传后验证

```bash
cd /c/Users/barry/WorkBuddy/2026-11-14-21-06-10

# 1) 已跟踪文件清单中不应出现敏感项
git ls-files | grep -E '(^|/)(config\.json|runtime\.json|alerts\.json|epg-cache\.json)$|\.(exe|dll|zip|mp3|log)$|(^|/)(recordings|logs|release|_staging|\.workbuddy)/' || echo "OK: 无敏感文件"

# 2) 忽略规则确实生效
git check-ignore -v radio-recorder/config.json radio-recorder/bin/ffmpeg.exe release/_staging .workbuddy

# 3) 仓库体积与远端状态
git count-objects -vH
git status --short --branch
gh repo view --web
```

预期：`git ls-files` 只列出源码、文档、测试、`stations.json`、`config.example.json`、`LICENSE`、`README.md` 等；仓库 `size-pack` 约 1–2 MB；网页能看到 README 与两个 Release 附件。

---

## 6. 出错处理

| 情况 | 处理 |
|---|---|
| 误提交但未推送 | `git reset --soft HEAD~1`，补全 `.gitignore`，`git rm --cached <文件>`，重新提交 |
| 误提交且已推送 | **先轮换凭据**（Webhook / Token），再用 `git filter-repo --path <文件> --invert-paths` 清理历史；强推前必须明确确认，必要时联系 GitHub Support 清除缓存视图 |
| `.bat` 在 Windows 下换行异常 | 确认 `.gitattributes` 已提交；执行 `git add --renormalize . && git commit -m "chore: normalize line endings"` |
| 推送被拒（远端有 README） | 按 4.2 的 `git pull --allow-unrelated-histories` 处理 |
| 仓库名被占用 | 换仓库名，或只 `git remote add` 到现有仓库，不要覆盖 |

---

## 7. 下一步

若选择方案 A，请回复：仓库名、公开/私有、是否包含根目录两份中文文档。我会在本地完成初始化、复核与提交，并在创建远端仓库前停下来等你确认。
