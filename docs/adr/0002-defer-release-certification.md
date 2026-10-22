# ADR-0002 · 正式发行验证延后至功能开发完成

状态：已接受。日期：2026-10-22。决策来源：用户明确要求“正式签名、公证及干净环境验证记录下在功能开发完后再去落实”。

后续调整：[ADR-0011](0011-github-dmg-distribution.md) 将发行目标确定为 GitHub DMG，正式签名与公证改为可选；干净环境继续单列待验收。以下保留原阶段决策。

## 决策

M0 的开发出口采用本机技术验证：捆绑 Node 的 Tauri 发布包能够启动、独立 Chrome Profile 可用、Cockpit 文本与 JSON 实测通过、MCP stdio 可用，以及 Sidecar 退出与重启检查通过。

以下三项移至功能开发完成后的 M4 发行验收，不再阻断 M1–M3 功能研发：

1. Developer ID 正式签名及嵌套 Node Sidecar 的签名验证。
2. Apple Notarization、公证票据装订与 Gatekeeper 验证。
3. 没有 Node/Rust 的干净 Apple Silicon 用户环境安装与运行验收。

原始 PRD 和开发交接文档保留为冻结基线；其 M0 发行门槛以本决策作阶段性调整。M0 本机验证的实测证据仍记录于 [M0 验证记录](../m0-validation.md)，以上待办集中记录于 [发行验收清单](../release-readiness.md)。

## 验收口径

M0 本机技术验收和正式发行验收分别记录。完整 ad-hoc 签名、当前开发机的 DMG 复制安装结果可用于 M0 技术结论；正式发行状态须在 M4 清单及相应实机证据齐备后确认。
