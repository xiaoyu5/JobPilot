# M3 验证记录

本页为 0.3.0 历史记录；两条首次沟通、已有会话 WAITING / REJECTED 的真实只读验证，以及启动权限修复的最新结果见 [0.3.1 增补记录](m3.1-validation.md)。

日期：2026-10-22。版本：0.3.0，ARM64。范围：PRD v1.0 §8–14、AT-08–AT-14。**受控发送基础设施及匿名验收已实现；真实 BOSS 首次沟通与发送验收尚未完成。** 真实账号目前仅获用户只读授权，没有发送任何消息。设计见 [ADR-0007](adr/0007-m3-controlled-sending.md)。

## 实现与自动验证

| 项目 | 证据 |
| --- | --- |
| AT-08 授权与串行发送 | 真实发送默认关闭；GUI 规则确认、Review 最终文本确认、单次计划限时/版本绑定；Auto 单独明确启用，重启关闭；发送并发 1 |
| 限额与时段 | 单次/每日条数、最小 15 秒间隔、每日轮次、指定时区和允许时段；意图预占额度，最后一个额度可正常提交；慢页面编辑不会缩短相邻实际提交间隔 |
| AT-09 双重去重 | 岗位与招聘人唯一索引；重复排队、已发送、处理中、待核验及人工跳过均不能自动重发 |
| AT-10 不确定结果 | 页面 mutation 前先写 SEND_INTENT；点击前写阶段；点击异常或进程中断锁定 NEEDS_VERIFY；核验只读，不重新提交 |
| 人工核验 | 人工确认与页面自动确认状态分离；“未发出并跳过”保留锁；核验与计数在事务内更新 |
| AT-11 验证与登录 | 挑战、登录失效、身份不符均在点击前阻断；不做验证绕过 |
| AT-12 DOM 变化 | 未知入口不点击；测试中的“立即沟通”点击次数为零；身份/文案/短时动作权限每次重新检查 |
| AT-13 模型中断 | 每条操作前检查模型服务，不可用时保留检查点，浏览器写入为零，恢复须再次确认 |
| AT-14 休眠和 Chrome 关闭 | 时间跳变或 Chrome 关闭停止；重启保存剩余队列并撤销 Auto；重新授权后仅处理未产生意图条目 |
| 事实与文案 | 分数不足、硬缺口、编辑后未审计、事实失效、演示来源均阻断；不改写用户项目或工作经历 |
| GUI / MCP 边界 | 普通 IPC token、错误 GUI capability、任意 payload 均不能开启 Auto 或确认发送；仅原生界面注入会话 capability |
| `.env` 回归 | API Key 可以在应用内修改；即使只更换 Key 也撤销旧发送授权；不回显、写入 DB 或访问 Keychain |

`npm run check`：TypeScript、**41/41 自动测试**、Worker 生产构建、UI 生产构建通过。M3 测试使用临时数据库、匿名模型与发送传输夹具；DOM 测试拦截全部目标页面为本机匿名 HTML，不访问真实 BOSS 站点。

`npm run verify:ui`、`npm run verify:ui:m2`、`npm run verify:ui:m3` 全部通过：原有导入/事实审核/搜索/匹配/Dry Run 回归，以及发送限制确认、最终文本弹窗、未勾选禁用、一次确认发送、一次结果不确定、人工处理且无补发、急停、亮暗主题与 900px 窗口。界面测试使用实际 Worker、SQLite 和 IPC；原生 GUI capability 在测试桥中模拟，发送对象全为匿名夹具。截图位于 gitignored `.local/qa/m3-*.png`。

`npm run smoke:m2` 通过：实际捆绑 Node/Worker、MCP 10 工具、匿名匹配 90 分、67 字符 PASS 草稿、Dry Run、重启缓存；真实发送 0 条。

## 安装包与升级

- 默认库 v2 → v3 迁移成功，升级前后全部岗位、事实和审核队列记录摘要相同：20 个岗位、39 条已确认事实、冻结 v44、1 条审核草稿；没有代用户确认经历或文案。
- `jobpilot.pre-m3.sqlite` 迁移备份权限 0600；默认发送意图 0、真实发送未启用、Auto 关闭，`.env` 自动加载成功。
- 升级基线与只读复测摘要在 gitignored `.local/qa/m3-before.json` 和 `m3-real-readonly.json`，只保存计数、哈希和脱敏状态，不含原始履历、Cookie 或 Key。
- `npm run desktop:build`：App 133.92 MiB / DMG 42.77 MiB，版本 0.3.0，完整 ad-hoc 签名。
- `npm run verify:installer`：最终 DMG 校验、只读挂载后复制到临时安装目录、深层签名结构、系统 PATH 下捆绑 Node、DOCX/PDF 线程、MCP、.env 配置、匹配/草稿/队列、默认发送关闭及 GUI 授权边界、单实例与退出/重启均通过；没有在测试中访问真实账号。
- 最终 DMG SHA-256：`8a7f332a0a80875124ae951548400ae501081e0169fbed91748efb3175a8f204`。
- 最终 App 在用户完成权限设置后，通过 macOS Launch Services 正常启动并建立唯一 Worker，原数据和 `.env` 再次验证通过；真实发送与 Auto 关闭，发送意图为 0。BOSS 显示 LOGGED_IN，真实岗位/JD 读取成功。

正式 Developer ID 签名、公证和干净设备验证按既定决定留至 M4，不以本机 ad-hoc 验证替代。

## 真实账号限制

最终真实环境复测及启动排查：

- **自动化权限已解决**。用户开启 JobPilot 的 Chrome 权限后，最初直接启动的实例仍失败；仅筛选 JobPilot 的系统权限日志显示，其 responsible application 为启动终端。退出该实例、改由 macOS Launch Services 启动同一最终版本后，只读复测通过。没有为终端增加权限，没有重置系统权限或重新签名。此前只读授权保持有效，不自动扩大为发送授权。
- 安装/中断回归后的正常启动，AppKit 在 `promptToIgnorePersistentStateWithCrashHistory` / `NSAlert.runModal` 等待处理“重新打开上次窗口”的系统提示，尚未进入 Worker 启动。进程调用栈已定位；这不是 Keychain 调用。使用 Apple 的 [恢复状态隔离选项](https://developer.apple.com/library/archive/releasenotes/AppKit/RN-AppKitOlderNotes/) 直接启动最终 App 后已建立 Worker，不修改用户数据库或全局系统偏好；测试脚本后续采用同一隔离参数，避免复用真实窗口状态。

- 历史 Launch Services 启动曾出现 Sidecar setup 失败；本轮用户处理权限后，以正常启动方式复测已建立 Worker，当前不再阻塞。不将历史失败原因确定为单一因素；M4 仍需干净环境和签名升级复验。

当前实际阻断：真实岗位页面 `identityBound=false`、`recruiterKnown=false`、`composerReady=false`、`canOpenPreview=false`；未找到可靠招聘人标识与明确的可编辑招呼语入口。现有岗位快照刷新后，旧审核草稿被标为失效，真实 `send.prepare` 返回 `CONSENT_REQUIRED` 和 `DRAFT_STALE`。没有批准或重建该草稿，没有创建发送意图，没有发送消息。脱敏结构诊断和门禁代码保存在 gitignored `.local/qa/m3-real-diagnostics.json`。

重复只读复测可使用 `node --import tsx scripts/m3-readonly-smoke.ts --recheck`；首次迁移审核保持独立，不把后续正常的岗位快照刷新误报为迁移损坏。

当前真实账号授权仅涵盖搜索和 JD 读取。M3 不会代为开启真实发送规则、降低阈值、批准经历或确认文案。有限真实发送需要用户核对具体接收岗位、最终文本及额度后在 GUI 明确确认。

首次沟通入口存在重要未验证边界：“立即沟通”可能直接发送平台默认招呼语，当前适配器只处理可靠身份、唯一可见编辑器或明确编辑预览入口。无法确认这些条件时会停止，而不会点击该入口。因此不能将匿名夹具通过写成真实 BOSS 自定义首次招呼语全链路通过。

参考的协议链接为 PRD 中的 [BOSS 用户协议](https://www.zhipin.com/web/common/protocol/protocol-2019-09-30.html)，不能据此推断当前平台许可。未复制 `get_jobs` 受限许可代码，未访问私有接口、提取 Cookie 或规避验证。
