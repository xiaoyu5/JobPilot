# JobPilot 开发指南

以下命令均在仓库根目录执行。产品使用见[使用指南](usage.md)，技术决策和验证结果见[文档索引](README.md)。

## 环境与构建

要求 Apple Silicon Mac、Xcode Command Line Tools、Node **22.23.2**、Rust **1.99.1** 和 Google Chrome。首次执行：

```sh
npm ci
npm run prepare:sidecar
npm run check
npm run desktop:dev
```

`prepare:sidecar` 从 nodejs.org 下载并校验官方 ARM64 Node。若 Rust 安装在本项目 `.tools/cargo` / `.tools/rustup`，启动脚本自动选择它；其他环境使用正常的 rustup / cargo。

构建自带 Node 的 App 和 DMG：

```sh
npm run desktop:build -- --ci
npm run verify:bundle
npm run verify:installer
```

产物在 `apps/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/`。构建后执行 `npm run release:prepare`，检查 DMG、包内版本与签名结构、捆绑 Node 和扩展权限，将 DMG、只读扩展 ZIP、安装说明及校验清单汇集至 `.local/releases/0.4.4/`。此命令不启动 App、不连接 BOSS，也不上传文件；已存在的发行目录不会覆盖。源码与发行准备说明见 [GitHub 发布](github-release.md)。

`verify:installer` 校验并以只读方式挂载 DMG，将 App 复制到临时目录，再运行发布包检查；不会写入 `/Applications`。这不替代干净用户环境和 Gatekeeper 验收。

## 测试与验证

```sh
# Worker、SQLite、事实审核、解析、浏览器和兼容服务夹具
npm test
# 捆绑 Node + DOCX/PDF 解析线程 + SQLite 重启 + MCP
npm run smoke:m1
# 桌面 UI 集成；先另开终端运行桌面前端 dev server
npm run dev --workspace @jobpilot/desktop
npm run verify:ui
npm run verify:ui:m2
npm run verify:ui:m3
npm run verify:ui:chat
npm run verify:ui:m4
npm run verify:ui:notifications
npm run verify:ui:m4.4
npm run verify:ui:followup
npm run verify:ui:closeout
npm run verify:ui:chat-ack
# 发布版 App 的恢复/重置启动流程与两个 MCP 客户端兼容检查（匿名数据）
npm run verify:bundle:m4
# 捆绑 Worker + MCP 匹配/草稿/审核队列/Dry Run + 重启缓存
npm run smoke:m2
# 可选：使用 gitignored .env.local 的 Cockpit 配置验证匿名匹配与草稿
npm run smoke:m2 -- --live
# 隔离数据库中的匿名会话分类、事实回复及发送阻断；不连接 Chrome
npm run smoke:m3
# 可选：读取运行中桌面应用的 .env，使用真实 Cockpit 验证相同匿名场景
npm run smoke:m3 -- --live
# 捆绑 Node + MCP stdio；需先 npm run build
npm run smoke
# 打开专用 Chrome 验证窗口，不访问 BOSS
JOBPILOT_SMOKE_CHROME=1 npm run smoke
# 使用自己的 Cockpit 配置。API Key 可通过本机环境变量传入，勿写入仓库。
OPENAI_BASE_URL='<Cockpit Base URL>' OPENAI_MODEL='<模型名>' npm run smoke
```

## 本机数据与开发环境

默认数据目录为 `~/Library/Application Support/io.jobpilot.desktop`，保存 SQLite、私有 IPC 令牌、Socket、配置及专用 Chrome Profile。自动化测试使用 `/tmp` 下的独立匿名目录，避免连接真实账号。

日常安装版建议从个人应用目录启动，配置使用 Application Support 中的 `.env`，避免 Sidecar 工作目录落在 Documents。应用内修改的是设置页显示的配置路径，项目内的开发配置可独立保留。

不要提交 `.env`、Profile、Cookie、Token、密钥、私密备份或原始简历。升级前生成的 `jobpilot.pre-m2.sqlite`、`jobpilot.pre-m3.sqlite`、`jobpilot.pre-m3.1.sqlite`、`jobpilot.pre-m4.sqlite` 为旧结构回退快照；当前 v5 备份可通过“数据与诊断”恢复。

真实发送需在可见应用中明确确认，不能以匿名测试或脚本伪造 GUI 授权。首次“立即沟通”、已有会话回复和两种 Auto 的验证分别记录。安装、签名与独立干净环境范围见[发行验收清单](release-readiness.md)。
