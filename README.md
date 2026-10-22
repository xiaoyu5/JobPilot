# JobPilot

本地运行的 AI 求职工作台，产品范围见 [产品说明](docs/product-scope.md)。当前为 **M4 / 0.4.2，预发行版**：包含真实登录/只读采集、事实匹配和草稿审核、受控首联与已有会话回复、复盘统计、脱敏诊断、私密备份恢复及数据清理。默认 Preview，真实发送与两种 Auto 关闭。按用户决定，真实发送统一留到全部功能完成后的最终验收，先匹配岗位，再确认“立即沟通 → 默认招呼 → AI 文案”，应用层匹配与事实补充见 [0.4.2 验证记录](docs/m4.2-validation.md)，正文稳定性修复见 [0.4.1 记录](docs/m4.1-validation.md)。详见 [ADR-0009](docs/adr/0009-final-live-acceptance.md) 和 [M4 验证记录](docs/m4-validation.md)。M3 功能与匿名验证已完成，真实只读证据见 [标识关联与幂等验证](docs/m3.3-validation.md)。

**真实 BOSS 登录与 20 个岗位/JD 的只读采集已通过。** 使用专用 Profile 的普通 Chrome 和 macOS 原生接口，配置与数据保存在本机。验证证据见 [M1 验证记录](docs/m1-validation.md)，权限与实现见 [ADR-0004](docs/adr/0004-boss-native-chrome.md)。

发行目标为 [GitHub Releases](https://github.com/xiaoyu5/JobPilot/releases)，无需上架 App Store。当前 DMG 采用临时（ad-hoc）签名，未做 Apple 公证，首次打开可能需要手动允许；安装与配置见 [macOS 安装说明](docs/install-macos.md)。按 [ADR-0011](docs/adr/0011-github-dmg-distribution.md)，正式签名、公证为可选改进，真实发送和干净环境待验收项见 [发行验收清单](docs/release-readiness.md)。M3 的授权与恢复设计见 [ADR-0007](docs/adr/0007-m3-controlled-sending.md)。M2 验收见 [验证记录](docs/m2-validation.md)，策略及限制见 [ADR-0005](docs/adr/0005-m2-matching-and-review.md)。

## 开发

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

产物在 `apps/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/`。构建后执行 `npm run release:prepare`，检查 DMG、包内版本与签名结构、捆绑 Node 和扩展权限，将 DMG、只读扩展 ZIP、安装说明及校验清单汇集至 `.local/releases/0.4.2/`。此命令不启动 App、不连接 BOSS，也不上传文件；已存在的发行目录不会覆盖。源码与发行准备说明见 [GitHub 发布](docs/github-release.md)。

`verify:installer` 校验并以只读方式挂载 DMG，将 App 复制到临时目录，再运行发布包检查；不会写入 `/Applications`。这不替代干净用户环境和 Gatekeeper 验收。

## 验证

```sh
# Worker、SQLite、事实审核、解析、浏览器和兼容服务夹具
npm test
# 捆绑 Node + DOCX/PDF 解析线程 + SQLite 重启 + MCP
npm run smoke:m1
# 真实 Worker 的五页 UI 集成；先另开终端运行桌面前端 dev server
npm run dev --workspace @jobpilot/desktop
npm run verify:ui
npm run verify:ui:m2
npm run verify:ui:m3
npm run verify:ui:chat
npm run verify:ui:m4
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

桌面“设置”页可选择或粘贴 `.env` / `.env.local` 的完整路径并加载；也可直接修改地址、模型和 API Key，点击保存写入同一文件。新建配置默认保存在本机数据目录的 `.env`。Key 输入框留空保留现值，勾选可清除；已保存 Key 不回显。文件使用 0600 权限并原子替换，数据库只记录路径及非敏感模型参数。后续启动自动读取，无钥匙串交互。格式参见 [.env.example](.env.example)。Cockpit 可能将必要 JD 和已确认事实转发至远程模型。

简历从系统文件选择器导入，支持 DOCX 和文字型 PDF。提取条目默认待审核，可逐条确认、修正、移除，再冻结已确认版本；修改会撤销原确认。原件不复制入库，提取文本和来源保留在本机。

BOSS 需要在“设置”保存只读授权，再打开专用 Chrome 手动登录。首次使用需允许 macOS 控制 Chrome，并在 Chrome 顶部菜单“显示 → 开发者”开启“允许来自 Apple 事件的 JavaScript”。会话由浏览器自动保存在独立 Profile，下次打开复用；不会将 Cookie 另存到 SQLite。保存关键词及你手动选择好筛选条件的 BOSS 搜索页链接后，可开始只读任务。M1 有上限地滚动搜索页并采集 JD，不跨页无限采集，遇到登录失效、验证或未知结构时停止。

在总览选择真实或匿名岗位池，再点击“开始 Dry Run”，最多处理 20 条本机岗位。也可在岗位详情逐条匹配、生成并加入审核队列。只有当前已冻结事实才能参与匹配；必要文本发送至你配置的模型服务，Cookie、联系方式和原始附件不参与。城市/薪资规则默认不限，阈值和 50–100 字符话术范围可在设置调整。

草稿保留完整事实及限定语，模型选择证据与礼貌表达。事实太长或编辑加入未确认经历会阻断；请先在事实库核对并整理精炼条目。修改事实、JD、模型配置或规则后，旧结果与审核状态失效。队列里的“已审核”仅为本地记录。连接失败、模型输出无效和人工暂停均保留已完成结果。

M3 发送前，在“设置 → 受控发送”确认真实发送开关、阈值、限额和时段。在审核队列检查具体岗位与最终文案，再勾选确认；有任一阻断条件时不能提交。Auto 另行启用，只在当前会话生效，MCP 不能代为授权。急停为顶部按钮或 ⌘.；已经提交的动作不可撤回。

首次“立即沟通”会发送平台默认招呼，按用户选择，再发送确认过的 AI 文案，共占两条额度；两步分别确认，部分成功保留记录，不重复默认招呼。“继续沟通”进入已有会话。只有可见页面确定确认了对应消息才记为已发。结果不明或中断会锁定为待人工核验，不自动重发；在队列底部可只读核验，或在 BOSS 页面人工查看后确认结果。未识别到可靠目标身份或明确编辑框时停止。真实首次沟通适配和发送需要有限的授权验收；匿名测试不代表已在真实账号验证。

“会话助手”先读取专用 Chrome 当前选中的会话，区分已拒绝、等待对方回复、有新问题及需人工处理。已拒绝的招聘人持续停止联系；已发出的消息不重复追问。对方的新提问可引用已确认事实准备回复；薪资、面试、联系方式、附件及不明确内容转人工。自动回复需另行勾选具体会话并确认启用，按对方消息 ID 去重。模型只接收最新脱敏问题和必要事实，不接收聊天全文或联系人列表。历史不完整、身份不明或结构变化时停止，详见 [ADR-0008](docs/adr/0008-existing-conversations.md)。

同一招聘人在已绑定页面上明确关联过的业务标识会保留，页面暂时缺少某个标识或应用重启后，拒绝记录与发送去重仍有效。已有会话中的平台默认招呼也算已建立联系，通过已知标识关联到新岗位时转会话助手，不重复首联；仅有相同姓名或公司不会合并身份。

当前 Chrome 的 Apple Events 接口不能访问页面自身的组件标识；没有可靠 DOM 标识时不会发送。可选的 [BOSS 只读连接](extensions/boss-reader/README.md) 需用户手动加载并点击当前页面，不会自动安装或授权发送。它只有 activeTab/scripting 临时权限，无网络、Cookie 和消息发送操作；真实站点不暴露所需字段时仍会停止。

本机开发版建议从个人应用目录启动，配置使用 Application Support 中的 `.env`，避免每次构建后重新询问 Documents 权限。旧项目中的配置可保留作开发用途，但应用内修改的是设置页显示的当前配置路径。正式签名为可选发行改进。

“求职复盘”可手动标记真实回复、拒绝、邀面和备注。回复率与邀面率以 JobPilot 已确认首联的岗位数为分母，两条首联只算一个岗位；平台 PK 卡、未确认发送及其它历史沟通不进入这个分母。页面确认、仅人工确认和部分完成分别展示，结果标记不会被当作自动采集的已读状态。拒绝标记会保留停止联系锁，修改统计标记不解除它。

“数据与诊断”提供脱敏 JSON 诊断、私密 SQLite 备份、恢复和岗位清理。诊断仅导出状态、计数、事件类型和 traceId，省略原始事件文字、简历/JD、聊天、备注、路径、URL 和凭据。私密备份可能包含个人信息，保存为 0600，可通过原生“另存到…”保存到应用目录之外；不包含 API Key 文件、原始附件或 Chrome 登录目录。

恢复只接受当前 SQLite v5 的 JobPilot 备份，检查结构、完整性、哈希和时效，显示恢复范围并在确认后重启执行。当前数据先留一份私密备份，备份之后产生的联系锁和拒绝记录继续保留；发送、Auto 及 BOSS 访问授权关闭，模型凭据不从备份恢复。恢复校验失败时，保持健康的当前库可打开并提示处理。默认按 90 天预览过期岗位，保留天数可修改，清理前显示确切数量；已沟通、已排队、有发送或结果记录的岗位保留。清除全部本机数据需输入确认文字并重启，包含应用内备份和专用 Profile；外部另存的备份、原始简历及外部 `.env` 不删除。设计见 [ADR-0010](docs/adr/0010-m4-data-and-review.md)。

## MCP

先启动桌面程序或 `npm run worker`，再使用 stdio 配置（请替换绝对路径）：

```json
{
  "mcpServers": {
    "jobpilot": {
      "command": "/absolute/path/JobPilot/apps/desktop/src-tauri/binaries/jobpilot-node-aarch64-apple-darwin",
      "args": ["/absolute/path/JobPilot/dist/worker/index.mjs", "--mode", "mcp"]
    }
  }
}
```

已安装 App 同样可使用 `Contents/MacOS/jobpilot-node` 和 `Contents/Resources/worker/index.mjs`，无需独立安装 Node。非默认数据目录需在两种启动模式中同时加 `--data-dir <path>`。十个工具为 `jobpilot.status`、`jobpilot.start_run`、`jobpilot.search`、`jobpilot.list_jobs`、`jobpilot.analyze`、`jobpilot.draft_greeting`、`jobpilot.queue`、`jobpilot.dry_run`、`jobpilot.get_run`、`jobpilot.pause_run`。MCP 不会自动启动第二个 Worker，搜索复用桌面保存的只读授权；Auto 未在 GUI 授权时返回 CONSENT_REQUIRED；有效授权后仅能按当前规则启动一轮，无法通过 MCP 开启或扩大权限。

默认数据目录为 `~/Library/Application Support/io.jobpilot.desktop`，目录内有 `jobpilot.sqlite`、socket、私有令牌和专用 Chrome Profile。测试使用 `/tmp` 下的独立目录并清理。请勿提交 Profile、Cookie、Token、密钥、私密备份或原始简历。迁移前依次保存 `jobpilot.pre-m2.sqlite`、`jobpilot.pre-m3.sqlite`、`jobpilot.pre-m3.1.sqlite` 和 `jobpilot.pre-m4.sqlite`；这些升级回退快照保留原版本结构。当前版本导出的 v5 备份通过“数据与诊断”恢复。

架构选择见 [ADR-0001](docs/adr/0001-m0-runtime.md) 和 [ADR-0003](docs/adr/0003-m1-data-and-credentials.md)；技术基线见 [M0 验证记录](docs/m0-validation.md)。
