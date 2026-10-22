# 功能开发完成后的发行验收

安排日期：2026-10-22。目标：GitHub 源码与 ARM64 DMG 预发行。原始延期依据见 [ADR-0002](adr/0002-defer-release-certification.md)，当前分发口径见 [ADR-0011](adr/0011-github-dmg-distribution.md)。不上架 App Store；正式签名、公证可选，不阻断 GitHub 预发行。

2026-10-22 更新：按 [ADR-0009](adr/0009-final-live-acceptance.md)，真实发送统一留至全部功能完成后验收，不阻断 M4 功能研发。

M4 功能版 0.4.0 已完成复盘、诊断、备份恢复、清理和重置的匿名验证及本机安装、升级和重启验证，保持完整 ad-hoc 签名。没有 Developer ID / 公证身份，未宣称通过默认 Gatekeeper。完整结果见 [M4 验证记录](m4-validation.md)。

## GitHub 预发行准备

- [x] 明确 ARM64 / macOS 13+ 范围、临时签名与真实发送待验收状态。
- [x] 安装说明包含单个 App 的“仍要打开”、模型配置、专用 Chrome 权限与扩展步骤。
- [x] 提供固定输入的 `release:prepare`，仅汇集发行附件，不上传本机配置或用户数据。
- [x] 原始需求中的简历背景资料保留本机，公开范围改用产品说明。
- [x] 完成最终发行目录检查，DMG SHA-256：`2ca012750e9223c5892bc7bbac22871497377f5a4754acd3d81cf7e1aac91cac`。
- [x] 首次提交 `f633665` 已推送到 `xiaoyu5/JobPilot`，发布 [v0.4.0 预发行版](https://github.com/xiaoyu5/JobPilot/releases/tag/v0.4.0)，共六个附件；未标为正式最新版。
- [x] 从 GitHub 下载六个附件，与本机文件及 SHA-256 清单逐一核对一致；只读扩展 ZIP 的内容和权限检查通过。

## 最终真实发送验收

- [x] 功能和匿名回归完成，安装最终候选版本 0.4.0。
- [x] 用当前冻结事实匹配真实岗位；最终只读预检确认身份可绑定、尚未沟通。JD 刷新使旧 82 分草稿失效，重新匹配为 83 分、无硬缺口并生成新待审核草稿；拒绝/去重及最终上下文仍须提交前复查。
- [ ] 在应用内确认具体目标、最终文案和两条消息额度。
- [ ] 点击“立即沟通”，核验平台默认招呼，再核验 AI 文案；分别记录两步结果及异常恢复。
- [ ] 对真实新提问验证已有会话回复；所选会话 Auto 独立授权、独立记录。

## 可选：Developer ID 正式签名

- [ ] 在发行环境准备有效的 Developer ID Application 身份及私钥。
- [ ] 对主程序、捆绑 Node 和完整 App 使用正式身份签名，验证 Hardened Runtime 与 Node JIT entitlement。
- [ ] 对最终 App 执行 `codesign --verify --deep --strict --verbose=2`，记录身份、Team Identifier 和验证结果。
- [ ] 记录最终 App / DMG 版本及 SHA-256；凭据通过本机 Keychain 或受保护的发行环境注入。

## 可选：Apple 公证与默认 Gatekeeper

- [ ] 使用发行凭据向 Apple 提交最终签名产物，保存公证请求 ID 及结果。
- [ ] 装订公证票据，执行 `xcrun stapler validate` 验证。
- [ ] 执行 `spctl --assess --type execute --verbose=2`，保存 Gatekeeper 结果。
- [ ] 对实际下载的最终发行产物验证首次启动。

## 干净 Apple Silicon 环境

- [ ] 使用独立干净 macOS 用户或 M1/M2 设备，不预装 Node / Rust，记录系统与硬件信息。
- [ ] 从最终 DMG 安装到 Applications，通过 Finder / Launch Services 正常打开，确认 App 和 Sidecar 可以运行；M3 开发机已在处理权限后复测正常启动通过，仍需在干净环境复验受保护目录访问与签名升级。
- [ ] 验证中断测试的窗口恢复状态不干扰真实 App，签名升级后的 Chrome 自动化权限提示可正确处理。
- [ ] 安装 Chrome 后验证专用 Profile、正常人工登录及账号状态读取；真实 BOSS 账号验证按单独授权执行。
- [ ] 使用用户配置的 Cockpit 地址、模型和凭据，验证模型响应与 JSON 检测。
- [ ] 从已安装 App 的资源运行 MCP stdio，验证 ping、status 与共享 Worker。
- [ ] 验证正常退出、意外终止、重启及 Chrome 关闭后的恢复；复验 AT-17 / AT-18。
- [ ] 完成最终版本所需的 AT-01–AT-18 验收，关联脱敏日志与发行结论。

本机 M0 的构建和安装证据见 [M0 验证记录](m0-validation.md)。可选正式签名、公证以及待完成的干净环境结果均据实记录；未做的项目不标为通过。
