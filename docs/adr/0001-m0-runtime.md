# ADR-0001 · M0 本地运行与发行 Spike

状态：已实施；发行验收时间由 [ADR-0002](0002-defer-release-certification.md) 调整。日期：2026-10-21，更新：2026-10-22。

采用 Tauri 2 + React/TypeScript + Node Worker。M0 只提供运行诊断界面，不实现完整求职工作流。没有 BOSS 搜索、账号读取或消息发送能力。

## 版本与复现

- Node **22.23.2**（Maintenance LTS），与当前开发机一致；应用捆绑官方 darwin-arm64 运行时，不依赖用户 PATH。
- Tauri CLI / JS API **2.12.4**；Rust Tauri **2.12.5**、tauri-build **2.7.4**；Rust 依赖同时由精确版本声明和 `Cargo.lock` 固定。
- Rust **1.99.1**，由 `rust-toolchain.toml` 固定；本机工具链安装在忽略的 `.tools/` 内。
- Playwright Core **1.64.1**；只调用已安装的 Google Chrome，不下载第二份 Chromium。
- MCP SDK v2：`@modelcontextprotocol/server` / `client` **2.3.1**，真实 stdio transport。
- React **19.3.1**、Vite **8.3.5**、TypeScript **7.0.2**、Zod **4.6.7**。npm 的全部解析结果记录于 `package-lock.json`。

Node 下载的 SHA-256 固定在 `scripts/prepare-sidecar.mjs`；它来自官方版本发布清单。独立 Node 可执行文件列入 Tauri `externalBin`，Worker JS 和 Playwright driver 作为只读应用资源。不使用依赖单文件快照的 Node 打包器，避免 Playwright 资源路径与 ESM 加载问题。代价是发行包包含完整 Node 运行时。

## 进程与权限

Rust supervisor 使用绝对路径启动 Sidecar，移除 `NODE_OPTIONS` / `NODE_PATH`，不向 WebView 开放任意 shell。UI 仅允许 status、browser.open、browser.close、llm.test 四个 command。

唯一 Worker 使用 `proper-lockfile` 的原子目录锁和心跳。同一路径第二次启动只检查已有 Worker 并退出。强制终止留下的锁在 10 秒保护期后才允许恢复，避免活跃实例重叠。Worker 退出时关闭自己持有的 Chrome；Rust 在应用退出时请求 shutdown，最多等待 5 秒后终止子进程。Worker 额外每秒检查 supervisor PID，以处理桌面进程崩溃。

IPC 仅监听专用数据目录中的 Unix socket，目录权限 0700、socket / token 为 0600。随机 256-bit token 每次 Worker 启动时轮换。一个连接只处理一帧带 UUID requestId 的 JSON-RPC，帧上限 1 MiB，最多 32 条连接。M0 采用请求/响应，事件推送与重连留到 M1 的任务流程。

MCP 模式只注册 status 与 start_run（用于验证权限拒绝），通过同一 socket 调用 Worker，不持有浏览器。Auto 在 Worker 中固定返回 CONSENT_REQUIRED；其余任务模式返回 MILESTONE_UNAVAILABLE。PRD 其余工具随 M1–M3 实现，不宣称 M0 已支持。

## 浏览器与模型

Chrome 使用 `<appData>/chrome-profile`，从不读取日常 Chrome Profile。M0 只打开内存中的固定说明页，不访问真实 BOSS 账号。页面操作串行执行；需要用户单独授权后才能进行真实平台验证。

Cockpit 地址、模型和凭据均由用户填写，不预设端口。默认仅允许 localhost / loopback；明确勾选后可连接 RFC1918 IPv4。公网地址、自定义代理/请求头和 Responses 适配延后，不影响 M0 本机验证。

分别测试 `/models`、Chat Completions 与严格 `{ "ok": true }` JSON 输出。模型列表失败不阻止对话。仅在服务器以 400/422 拒绝 `response_format` 时重试普通 JSON 提示，记录兼容能力。请求不跟随重定向，响应限制 1 MiB，可超时和取消。Key 仅保存在本次测试的内存，测试后清空输入；M1 实现持久配置时必须接入 Keychain，禁止写入 JSON / SQLite。

## 发行门槛

M0 本机开发包使用 ad-hoc 签名验证可执行性。按 2026-10-22 用户决策，Developer ID 签名、Notarization、Gatekeeper 以及干净 M1/M2 用户环境安装延后到功能开发完成后的 M4 发行验收；M0 本机技术验证通过后可进入 M1。真实失败证据和待验项目记录在 `docs/m0-validation.md`，发行待办见 `docs/release-readiness.md`。

参考：[Tauri Sidecar](https://v2.tauri.app/develop/sidecar/)、[MCP v2 stdio](https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio.html)、[Node LTS](https://nodejs.org/en/about/previous-releases)、[OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)。OpenAI 格式文档仅定义兼容请求，Cockpit 能力以实测为准。
