# M1 验证记录

日期：2026-10-22。基线：本机冻结 PRD v1.0 §14（含私人履历，未公开）；公开范围见 [产品说明](product-scope.md)。

**M1 本机、匿名流程及真实 BOSS 登录/只读采集已通过；最终安装包、单实例及真实登录态重启复用均已复验通过。** 用户已授权只读验证、不发送消息。正式签名、公证与干净环境验证按 [ADR-0002](adr/0002-defer-release-certification.md) 延后至功能开发完成后的 M4。

## 自动验证

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| TypeScript | 通过 | `npm run typecheck` |
| 自动测试 | 16/16 通过 | `npm test`，包含 SQLite 重启/去重、中断恢复、逐条确认/编辑失效/冻结/版本冲突、DOCX/PDF 来源、BOSS DOM 夹具、挑战与空白页识别、私有 IPC、LLM 兼容与脱敏；额外检查搜索链接令牌不入库、JD 范围只包含当前任务发现的岗位 |
| 专用 Profile 匿名状态保存 | 匿名实测通过 | `tests/boss.test.ts`：真实 Chrome 两次独立启动；拦截测试域的 Cookie / localStorage 正常落盘恢复；不访问外网，不导出真实 Cookie |
| 原生 Keychain | 通过 | Rust release `keychain_round_trip` 使用唯一匿名测试账号，完成真实 macOS Keychain 存/读/删；未使用用户 Key |
| 捆绑 Worker 集成 | 通过 | `npm run smoke:m1`：捆绑 Node 解析 DOCX/PDF，独立解析线程、审核冻结、20 条岗位去重、配置/事实/方案/岗位重启保存、MCP 共享数据、Auto 拒绝 |
| 五页 UI | 通过 | `npm run verify:ui`：实际 Worker + SQLite，导入/审核/冻结、配置保存、20 条匿名岗位、详情、时间线、亮暗主题和 900px 最小宽度；无页面异常 |
| App / DMG | 通过（本机开发包） | `npm run desktop:build -- --ci`，0.1.0 ARM64，包含 Node 与原生浏览器助手，完整 ad-hoc 签名 |
| DMG 复制安装与资源 | 通过（当前开发机） | `npm run verify:installer`，覆盖真实发行资源中的 DOCX/PDF 解析、SQLite 重启、Chrome、MCP 和退出清理 |

UI 测试只模拟文件选择和 Keychain 原生桥，所有业务读写调用真实 Worker；不能将此项写成原生 UI 的人工验收。Keychain 另有真实原生测试。截图位于忽略提交的 `.local/qa/m1-*.png`，全部使用匿名数据。

捆绑 Node 的 SQLite API 带实验性提示，采用固定版本并通过真实发布资源验证。无效 PDF 的拒绝用例会输出 `Indexing all PDF objects`，该用例应失败解析而非生成事实。

## 真实 BOSS 验证（已跑通）

用户授权：仅岗位搜索与 JD 读取，不发送消息；随后明确批准 macOS Apple Events 自动化权限，限定 JobPilot 专用 Profile 的 BOSS 只读范围。

用户手动打开 `https://www.zhipin.com/web/user/` 后仍加载并回到空白页；应用改为首页入口、启用 Chrome sandbox、新建业务标签页后，仍观测到：

```text
https://www.zhipin.com/
https://www.zhipin.com/shenzhen/
about:blank
```

最后一次状态是 `UNKNOWN`，traceId `98134e7c-31dc-46b3-9ee9-3b70ab26c085`；脱敏导航 traceId `59139e5a-1710-416c-9646-418913765604`。主页短暂显示登录入口不能证明登录成功。已修正“头像占位被误判为已登录”的识别逻辑；安全验证优先判定，未知状态不允许采集。

以上为首轮失败记录，保留用于追溯。后续定位到 BOSS 安全脚本进行浏览器环境探测；具体触发项未逆向。普通 Chrome 使用同一专用目录后，用户确认“页面正常，已登录”。

按用户明确批准的 [ADR-0004](adr/0004-boss-native-chrome.md)，改用 Chrome 自带的 macOS Apple Events 接口，只寻址专用目录对应的已校验进程，不枚举其他浏览器。用户开启 Chrome 顶部菜单的 JavaScript 权限后，原生状态返回 `LOGGED_IN`。

真实新版卡片使用 `.job-card-wrap` 外层及 `.job-card-footer .boss-name` 公司字段。已按实际结构修正，加入完全匿名的同构夹具；解析不再重复处理嵌套的 `.job-card-box`。页面读取脚本独立打包，限制 256 KiB，并校验搜索条件与目标岗位 URL，防止切页未完成时错存上一页。没有修改浏览器指纹、网站安全脚本或验证结果，也没有导出 Cookie。

## 真实通过证据

- 首条真实岗位/JD：runId `6e594fc3-2898-4de0-9539-fbbf63608d23`，`COMPLETED`，完成事件 traceId `c3b88692-1752-45fe-9527-f46195443745`。
- 单次 20 个真实岗位/JD：runId `9c8aa6b6-bd6e-42d5-9cb8-4445c20ef5b2`，`COMPLETED`，完成事件 traceId `6fbb2223-1ce5-468a-89f2-1ab0285ce414`。
- 本机岗位池真实来源 `boss` 为 20 条，20 条均有 JD，20 个不同 JD 哈希；JD 长度 115–1638 字符；标题和公司字段缺失数为 0。已按岗位 ID 去重，首条复采没有额外增加总数。
- 全程未发送消息、未上传简历、未调用模型处理真实 JD。公开 DOM 尚未提供可识别的招聘人 ID，当前为 `null`；发送阶段需另行实现并核验，不能据此开放发送。
- 最终 DMG 复制安装通过：包含捆绑 Node、原生浏览器助手、DOCX/PDF 解析、SQLite 重启、Chrome 生命周期、MCP 和退出清理。首次普通 Chrome 启动时曾过早返回就绪，导致新 Profile 未完成初始化就被关闭；已改为检查 `NSRunningApplication.isFinishedLaunching` 后再返回，匿名全新目录与最终安装包均通过。
- 桌面单实例通过：官方 `tauri-plugin-single-instance=2.5.4` 首先注册，重复启动激活已有窗口并退出，Worker PID 不变。用户发现的第二个工作台已关闭；最终精确路径进程检查为 **1 个 App**。
- 真实 App / Chrome 关闭重开后无需再次扫码，状态返回 `LOGGED_IN`，traceId `c8a9d559-9481-4f31-89ab-21a891883da3`。
- 最终完整打包版本复采 1 条成功：runId `9c1d4c7d-26b2-4847-86b1-1b870344f008`，完成 traceId `fedf7068-307c-406c-b0d7-03c030cf80da`；岗位池仍为 **20 条真实岗位 / 20 份 JD**，证明配置、数据、登录态和去重均保留。最终 `mode=preview`、`sendingAvailable=false`、专用 Chrome 已打开。

M1 采用有上限的搜索页滚动读取，尚未实现跨页分页；备份恢复、导出、彻底清除属于后续数据管理工作。AI 评估/草稿为 M2，发送为 M3，M1 无发送能力。完整发行待办仍见 [发行验收清单](release-readiness.md)。
