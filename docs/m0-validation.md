# M0 验证记录

验证日期：2026-10-21–22。基线：本机冻结 PRD v1.0 §14（含私人履历，未公开）；公开范围见 [产品说明](product-scope.md)。

**M0 本机技术验收通过，可进入 M1。按 2026-10-22 用户决策，正式签名、公证及干净环境安装验证延后到功能开发完成后的 M4，见 [ADR-0002](adr/0002-defer-release-certification.md) 和 [发行验收清单](release-readiness.md)。**

## 实测环境

- macOS 26.5.2（25F84），Apple Silicon / arm64。
- 开发机现有 Google Chrome，Node 22.23.2；Rust 1.99.1 安装在项目 `.tools/` 中。
- `security find-identity -v -p codesigning` 返回 **0 valid identities**。

## 证据与结论

| 项目 | 结果 | 验证方式 |
| --- | --- | --- |
| TypeScript 检查 | 通过 | `npm run typecheck` |
| 协议与服务夹具 | 6/6 通过 | `npm test`；包含模型列表失败、JSON 不合规、端点校验、脱敏、IPC 权限、单 Worker 和 Auto 拒绝 |
| Worker / React 构建 | 通过 | `npm run build` |
| M0 诊断界面 | 通过（浏览器预览） | 表单渲染、配置输入、预览中禁用 native 操作；无页面异常；截图在 `.local/qa/m0-ui.png` |
| 捆绑 Node ARM64 | 通过 | 官方 archive SHA-256 校验；不依赖系统 Node 启动 Worker |
| MCP SDK v2 stdio | 通过 | 真正客户端 initialize → listTools → status；同一 Worker PID；Auto 返回 CONSENT_REQUIRED |
| 独立 Chrome Profile | 通过 | 可见 Chrome 打开两次不重复创建；关闭后重新打开；专用 Preferences 文件落盘 |
| Cockpit 本机服务 | 通过 | 2026-10-22 使用用户本机配置实测：模型列表包含所选 `gpt-6.1-sol`，文本返回 `OK`，严格 JSON 输出校验通过，支持 `response_format=json_object`；本次探测 7210 ms |
| Tauri ARM64 App / DMG | 通过（本机开发包） | ARM64 App 125.49 MiB、DMG 39.60 MiB；完整 ad-hoc 签名 |
| 发布包 Sidecar 路径和退出重启 | 通过 | `npm run verify:bundle`：系统 PATH 下捆绑 Node 可运行；发布 App 启动 Worker / Chrome；发布资源中的 MCP 可调用；桌面进程终止后清理 Worker / Chrome；可重新启动 |
| 包签名结构 | 通过（ad-hoc） | `codesign --verify --deep --strict`；标记 adhoc,runtime；资源完整封装，非 Developer ID |
| DMG 挂载与复制安装 | 通过（当前开发机） | `npm run verify:installer`：磁盘映像校验有效，读取只读映像，复制至临时新路径，再通过签名、Node、Worker、Chrome、MCP ping/status 和退出重启检查 |
| Developer ID / Notarization | 延后至功能完成后的 M4 | 当前没有开发者签名证书或公证凭据；按用户决策记录为发行待办 |
| 干净 M1/M2 用户环境安装 | 延后至功能完成后的 M4 | 当前仅使用现有开发机；干净用户或设备验收已列入发行清单 |

首次在受限执行环境运行 socket 测试遇到 EPERM；允许本地 socket 后相同测试全部通过。这是测试执行环境权限限制。

首次包只有 linker-signed 签名，深度校验失败；已修复为显式 `APPLE_SIGNING_IDENTITY=-` 的完整 ad-hoc 签名。DMG 的 Finder 美化脚本在当前环境等待自动化授权；已使用官方支持的 `CI=true` 打包路径跳过美化，DMG 正常生成，无需 Finder 自动化权限。

复制安装的首轮测试使用 `/tmp` 符号链接路径启动，触发 Tauri 的 macOS executable-path 安全校验。验证脚本已在启动前使用 `realpath` 规范化 App 路径；复验全部通过，未放宽 Tauri 的安全特性。

Cockpit 首轮未带 Key 的探测返回 401；2026-10-22 用户填写本机 `.env.local` 后，使用真实凭据复验成功，未使用 mock 结果替代。复验同时通过捆绑 Node、单 Worker、MCP ping / status 和 Auto 拒绝检查。成功探测 traceId：`fca5f8ef-0813-4ae9-a296-b1be41c55fcd`。

开发验证配置 `.env.local` 仅保存在本机，权限 0600，并排除 Git 提交；实际端口与模型不固化为产品默认值。桌面窗口的 Key 输入仅用于本次测试，结束后清空，应用持久凭据将在 M1 接入 Keychain。

## 签名、公证与安装复验

已有 Developer ID 时，通过 Tauri 官方环境变量提供签名身份与公证凭据，再构建：

```sh
# 凭据在本机配置，不写入命令记录或仓库
npm run prepare:sidecar
npm run desktop:build -- --ci
npm run verify:bundle
codesign --verify --deep --strict --verbose=2 '<path>/JobPilot M0.app'
spctl --assess --type execute --verbose=2 '<path>/JobPilot M0.app'
xcrun stapler validate '<path>/JobPilot M0.app'
```

官方说明：[Tauri macOS 签名与公证](https://v2.tauri.app/distribute/sign/macos/)。ad-hoc 签名只能验证本机加载和包结构，不代表 Gatekeeper、Developer ID 或 Notarization 已通过。

在没有 Node/Rust 的干净 Apple Silicon 用户环境中，从 DMG 复制到 Applications，启动并逐项验证：窗口、Worker 状态、Chrome 专用 Profile、Cockpit 文本与 JSON、MCP status；关闭应用后确认 Worker 和专用 Chrome 退出，重新启动不会发生锁竞争。无需、也不应关闭 Gatekeeper 来宣称正式发行成功。

## M0 出口与后续安排

1. Cockpit 文本与严格 JSON 健康检查已通过。
2. 发布包 Node / Playwright 资源路径、MCP、独立 Profile、退出重启及 DMG 复制安装检查已通过。
3. 可进入 M1 的 SQLite、简历事实审核、持久配置及只读岗位流程研发。
4. Developer ID 签名、公证及干净环境验收在功能开发完成后，按 [发行验收清单](release-readiness.md) 执行并留存证据。

真实 BOSS 登录与只读采集另需用户授权。
