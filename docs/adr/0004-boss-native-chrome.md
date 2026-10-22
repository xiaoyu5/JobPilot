# ADR-0004 · BOSS 普通 Chrome 与 macOS 原生只读接口

日期：2026-10-22。状态：已实施，用户已批准限定范围的原生只读权限；真实登录、20 条岗位/JD、重启复用及最终安装包验证通过。

## 证据

同一 JobPilot 专用 Profile 在 Playwright 启动时加载 BOSS 后跳回 `about:blank`。脱敏网络调用栈显示，BOSS 的 `zhipin-geek/security/121/geek/index.js` 发起浏览器环境探测，包括扩展探测和本机健康检查；未证实具体哪一项导致清空页面。

改为不连接调试协议的普通 Chrome 后，用户已确认“页面正常，已登录”。因此目录和凭据持久化本身可用，原来的启动/控制方式无法完成当前真实站点流程。继续试探标志隐藏、脚本替换或 Cookie 注入不符合 PRD。

## 决策

采用 Chrome 自带的 Apple Events 接口，通过 macOS 原生进程地址定位专用 Chrome，支持打开岗位搜索页、读取 DOM 和滚动当前结果页。使用原生接口不改写 `navigator.webdriver`、用户代理、网站脚本、验证结果或浏览器指纹，不使用 patchright 或 stealth。

应用需要明确的系统自动化权限和 Chrome 的“允许来自 Apple 事件的 JavaScript”设置。系统权限本身允许控制 Chrome；JobPilot 的实现进一步限制操作范围：

- 只读取 `<appData>/chrome-profile/SingletonLock` 所对应的进程，并验证其可执行路径和精确 `--user-data-dir` 参数；不枚举全局标签页，不读取日常 Profile。
- 原生请求直接发往该 PID，只处理专用实例的前台窗口、当前标签页。
- 导航只允许 BOSS 官网的登录、搜索和岗位路径；读取脚本在执行前及执行时都核对官方域名。
- 读取脚本随签名 App 打包，返回岗位字段与登录状态；不读 Cookie、密码或聊天。原生助手没有消息发送操作，不接收来自网页的任意代码。
- 所有真实读取仍经过 Worker 的只读授权和单任务门槛；未知结构、安全验证、登录失效与权限拒绝均停止。

原生 Swift 助手公开 `read / navigate / scroll` 三种页面操作及 `ready` 启动元数据检查；8 秒 Apple Event 超时，IPC 结果上限 900k，Node 子进程 12 秒超时。Playwright 继续用于匿名 DOM 测试，不用于当前真实 BOSS 登录。

## 权限与审批

本轮自动审批拒绝了应用构建，理由是新增 Apple Events entitlement 和原生助手会增加对已登录 Chrome 的系统级访问能力，现有 BOSS 只读授权未明确涵盖这一具体权限。在用户明确批准前，不重试被拒绝的构建，不执行真实原生读取，也不改用其它方式绕过审批。

用户批准后，构建可审查的 App，再由 macOS / Chrome 的实际权限入口授权。拒绝授权时应用应明确报错，不把未读取当作成功。

用户随后明确回复“允许，限定上述只读范围”，批准新增权限及继续构建、实测；该授权不包括消息发送或日常 Profile 访问。

实现：`native/browser/main.swift`、`packages/boss-adapter/src/native.ts`、`packages/boss-adapter/src/snapshot.ts`。Chrome 协议依据当前已安装浏览器的 `Contents/Resources/scripting.sdef`；进程地址依据 Apple [NSAppleEventDescriptor(processIdentifier:)](https://developer.apple.com/documentation/foundation/nsappleeventdescriptor/init(processidentifier:))。

## 最终验证

16 项匿名自动测试、真实单次 20 个岗位及 JD、App/Chrome 退出重开免扫码、最终 DMG 复制安装和桌面单实例均已通过。具体 runId 和 traceId 见 [M1 验证记录](../m1-validation.md)。公开页面没有可识别的招聘人 ID 时保留 `null`，发送仍不可用。
