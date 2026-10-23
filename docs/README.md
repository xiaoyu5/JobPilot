# JobPilot 文档

项目用途与功能介绍见[仓库 README](../README.md)。这里收录使用指南、开发说明、技术决策和验证记录。

## 使用与接入

| 文档 | 内容 |
| --- | --- |
| [macOS 安装与配置](install-macos.md) | 下载、首次启动、模型配置、Chrome 权限、可选扩展与企业微信 |
| [使用指南](usage.md) | 简历事实、岗位采集、匹配审核、首次/已有会话、发送恢复、复盘和数据管理 |
| [MCP 接入](mcp.md) | stdio 配置、十个工具、数据目录与桌面授权边界 |
| [产品范围](product-scope.md) | 当前支持范围、工作流程与实现边界 |

## 开发与发行

| 文档 | 内容 |
| --- | --- |
| [开发指南](development.md) | 环境准备、构建、匿名测试、UI 验证及本机目录 |
| [GitHub 发行](github-release.md) | App/DMG 与扩展打包、附件检查、源码和私密数据边界 |
| [发行验收清单](release-readiness.md) | 真实验收、可选签名/公证、独立干净环境待办 |
| [版本说明](releases/) | 每个发行版的用户可见变更 |
| [get_jobs 参考研究](research/get-jobs-session.md) | 会话保存与参考项目研究 |

## 里程碑与验证记录

功能实现、匿名测试与真实平台验证分别记录，不以其中一项代替其他项。

| 阶段 / 版本 | 主要范围 | 记录 |
| --- | --- | --- |
| M0 | Tauri、Sidecar、Worker、MCP 与打包基础 | [M0](m0-validation.md) |
| M1 | 事实审核、模型配置、登录与只读采集 | [M1](m1-validation.md) |
| M2 | 规则匹配、事实证据、草稿、审核与 Dry Run | [M2](m2-validation.md) |
| M3 | 受控首联、已有会话、幂等与中断处理 | [M3](m3-validation.md)、[M3.1](m3.1-validation.md)、[M3.2](m3.2-validation.md)、[M3.3](m3.3-validation.md) |
| M4 | 复盘、诊断、备份恢复和数据管理 | [M4](m4-validation.md) |
| 0.4.1 | JD 稳定性与失效草稿恢复 | [记录](m4.1-validation.md) |
| 0.4.2 | 应用交付能力匹配与手动事实 | [记录](m4.2-validation.md) |
| 0.4.3 | 企业微信单向待办通知 | [记录](m4.3-validation.md) |
| 0.4.4 | 新版简历、岗位字符、真实首次沟通与单条 AI 恢复 | [记录](m4.4-validation.md) |

0.4.4 已完成一次真实首次沟通验证：职位详情点击“立即沟通”发送平台默认招呼，适配修复后，经用户独立确认仅继续原 AI 文案，两个页面回执、原意图和额度均核对通过。“继续沟通”进入聊天消息页；已有会话回复与 Auto 的真实发送不在这次验收范围内。

## 技术决策

| ADR | 主题 |
| --- | --- |
| [0001](adr/0001-m0-runtime.md) | 桌面与运行时架构 |
| [0002](adr/0002-defer-release-certification.md) | 发行签名和干净环境验收安排 |
| [0003](adr/0003-m1-data-and-credentials.md) | 数据与凭据基础 |
| [0004](adr/0004-boss-native-chrome.md) | 专用 Chrome 与 Apple Events |
| [0005](adr/0005-m2-matching-and-review.md) | 匹配、事实审计与审核 |
| [0006](adr/0006-env-credentials.md) | `.env` 凭据配置 |
| [0007](adr/0007-m3-controlled-sending.md) | 受控发送与持久化意图 |
| [0008](adr/0008-existing-conversations.md) | 已有会话与身份关联 |
| [0009](adr/0009-final-live-acceptance.md) | 真实发送最终验收范围 |
| [0010](adr/0010-m4-data-and-review.md) | 复盘和本机数据管理 |
| [0011](adr/0011-github-dmg-distribution.md) | GitHub DMG 分发 |
| [0012](adr/0012-app-delivery-baseline.md) | 完整 App 交付能力的匹配解释 |
| [0013](adr/0013-wecom-review-notifications.md) | 企业微信通知 |
| [0014](adr/0014-resume-refresh-and-job-text.md) | 简历刷新与岗位数字字体 |
| [0015](adr/0015-start-chat-receipts-and-ai-followup.md) | 真实弹窗回执和未提交 AI 的独立续发 |

早期 ADR 反映当时的决策；后续变更和实际结果以较新 ADR、版本验证记录为准。原始需求含个人简历背景，仅保留在本机，不随公开仓库提供。
