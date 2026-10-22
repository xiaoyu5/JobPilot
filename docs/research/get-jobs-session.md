# get_jobs 登录态实现参考

日期：2026-10-22。参考来源：<https://github.com/loks666/get_jobs>；本次依用户指示重点核对 BOSS 登录凭据保存。原始 PRD 含私人履历，仅保留在本机。

阅读基线：[loks666/get_jobs](https://github.com/loks666/get_jobs)，commit `a78db87b1da539120eeb843e6ab2fc36998bc2c0`。

## 源码观察

| 环节 | 上游行为 | 源码位置 |
| --- | --- | --- |
| 浏览器持久化 | 以工作目录下的 `browser-data` 启动 persistent context，浏览器自行保存登录态 | [PlaywrightManager.java](https://github.com/loks666/get_jobs/blob/a78db87b1da539120eeb843e6ab2fc36998bc2c0/src/main/java/com/getjobs/worker/manager/PlaywrightManager.java#L304) |
| 标签页生命周期 | 新建各业务页，再关闭 context 自带的启动页；注释指出复用启动页曾导致加载与 DOM 操作卡住 | [标签页初始化](https://github.com/loks666/get_jobs/blob/a78db87b1da539120eeb843e6ab2fc36998bc2c0/src/main/java/com/getjobs/worker/manager/PlaywrightManager.java#L350) |
| Cookie 恢复 | 从数据库按平台读取 JSON，过滤 BOSS 域后注入 context，再打开站点 | [setupBossPlatform](https://github.com/loks666/get_jobs/blob/a78db87b1da539120eeb843e6ab2fc36998bc2c0/src/main/java/com/getjobs/worker/manager/PlaywrightManager.java#L493) |
| 登录后保存 | 识别未登录→已登录后，读取 context 的 BOSS Cookie，序列化 JSON 后按平台 upsert | [onLoginSuccess / saveBossCookiesToDatabase](https://github.com/loks666/get_jobs/blob/a78db87b1da539120eeb843e6ab2fc36998bc2c0/src/main/java/com/getjobs/worker/manager/PlaywrightManager.java#L1699)、[CookieService.java](https://github.com/loks666/get_jobs/blob/a78db87b1da539120eeb843e6ab2fc36998bc2c0/src/main/java/com/getjobs/application/service/CookieService.java) |

上游实际使用两层持久化：Chrome Profile 和额外的数据库 Cookie 副本。Cookie 存在不等于会话仍有效，仍需页面登录状态检查。

## JobPilot 的实现

按 PRD §11、§13，登录态仅存在应用专用 Chrome 目录。JobPilot 使用 `<appData>/chrome-profile` 和 persistent context，不复制日常 Profile，不读取账号密码，不把原始 Cookie 导出到 SQLite。正常关闭后再次打开同一目录即可复用浏览器会话；登录失效、安全验证和页面未知状态均停止采集。

采用独立实现的标签页交接：先新建 JobPilot 持有的页面，再关闭启动标签页，避免关闭最后一个标签导致 context 退出。浏览器操作在唯一 Worker 内串行执行。使用官方 Playwright 和已安装 Chrome，启用 Chromium sandbox。

没有采用上游的 patchright、自动化标识隐藏或其它指纹修改。参考阅读仅用于理解架构与生命周期，没有复制其源码或将该仓库作为依赖引入。上游 [LICENSE](https://github.com/loks666/get_jobs/blob/a78db87b1da539120eeb843e6ab2fc36998bc2c0/LICENSE) 为 PolyForm Noncommercial 1.0.0；处理方式遵循 PRD §13 的许可证隔离要求。

## 首轮排障记录

- 匿名页面测试已通过：向被本地拦截的测试域写入持久 Cookie / localStorage，正常关闭 Chrome，再以同一专用目录启动，状态仍存在。没有真实 Cookie 导出，也没有外网请求。
- 真实 BOSS 已获用户只读授权，但尚未完成登录：手工打开和应用导航均出现加载后跳回 `about:blank`。启用 sandbox、首页入口及新建业务标签页后仍复现。
- 最近一次脱敏导航为 `https://www.zhipin.com/` → `https://www.zhipin.com/shenzhen/` → `about:blank`。返回 `UNKNOWN`，没有记录为已登录，也没有启动真实采集或发送。
- 上游的启动页问题是排查线索，未证明是本机空白页的原因。本机尚缺少足以确定跳转原因的证据；真实登录后会话复用和真实岗位/JD 读取仍待验证。

实现与测试见 `packages/boss-adapter/src/index.ts`、`tests/boss.test.ts`；整体进展见 [M1 验证记录](../m1-validation.md)。

## 后续解决结果

普通 Chrome 使用同一专用 Profile 后，用户已成功登录。经用户明确批准，JobPilot 切换到 Chrome 原生 Apple Events 只读接口，并适配新版岗位卡片。真实 20 个岗位及 JD 已采集入库，未发送消息；不再使用 Playwright 启动真实 BOSS 会话。具体权限范围与实现见 [ADR-0004](../adr/0004-boss-native-chrome.md)，通过证据见 [M1 验证记录](../m1-validation.md)。首轮的空白页记录不是当前状态。
