# JobPilot macOS 安装说明

当前版本：0.4.0 预发行版，支持 macOS 13 及以上的 Apple Silicon Mac（M 系列）。Intel Mac 暂不支持。App 自带 Node，无需安装 Node、Rust 或单独运行服务器；BOSS 功能需要自行安装 Google Chrome。

## 下载与安装

从 <https://github.com/xiaoyu5/JobPilot/releases> 下载 `JobPilot_0.4.0_aarch64.dmg` 和 `SHA256SUMS.txt`。如需只读连接扩展，另下载 `JobPilot_BOSS_Reader_0.1.2.zip`。

可在下载目录核对 DMG 的 SHA-256：

```sh
shasum -a 256 JobPilot_0.4.0_aarch64.dmg
```

结果应与同一发行版 `SHA256SUMS.txt` 中对应文件的一行相同。打开 DMG，将 JobPilot 拖到“应用程序”目录，再从 Finder 启动。更新前退出旧版应用，替换 App 即可；用户数据位于 `~/Library/Application Support/io.jobpilot.desktop`，不在 App 内。

当前使用临时（ad-hoc）签名，未做 Apple 公证。首次打开可能提示无法验证开发者或无法检查恶意软件。确认文件来自本仓库后，先尝试打开一次，再进入“系统设置 → 隐私与安全性 → 仍要打开”，按系统提示确认。只为这个 App 设置例外，无需关闭系统门禁。Apple 操作说明：<https://support.apple.com/zh-cn/102445>。

## 首次配置

1. 在“设置”填写自己的 OpenAI 兼容 Base URL、模型及可选 API Key，保存后测试连接。也可以加载自己的 `.env` 文件；App 后续自动读取，API Key 可在界面修改，不使用钥匙串保存。不要填写开发者的本机地址；`localhost` 指你自己的 Mac。
2. 导入 DOCX 或文字型 PDF 简历，逐条核对事实并确认，再冻结版本。App 不会自动确认经历。
3. 在“设置”保存 BOSS 只读授权，点击“打开 BOSS 登录”，在专用 Chrome 手动登录。允许 macOS 的 Chrome 自动化权限；在 Chrome 顶部“显示 → 开发者”开启“允许来自 Apple 事件的 JavaScript”。遇到验证码时手动处理。
4. 保存关键词及手动选好筛选条件的 BOSS 搜索页链接，执行只读搜索。先运行 Dry Run，检查匹配和审核队列。

## 可选只读扩展

部分页面需要扩展提供当前渲染组件的招聘人标识。解压 `JobPilot_BOSS_Reader_0.1.2.zip`，保留解压目录；在 **JobPilot 专用 Chrome** 中打开 `chrome://extensions`，开启“开发者模式”，选择“加载已解压的扩展程序”，选中包含 `manifest.json` 的 `JobPilot-BOSS-Reader` 目录。

回到 BOSS 的岗位或会话页，点击拼图菜单中的“JobPilot BOSS 只读连接”，再点击“连接当前页面（只读）”。刷新页面后需重新连接。扩展仅使用 `activeTab` 和 `scripting`，不读取 Cookie、不发消息；安装与连接由你手动完成。连接不代表授权发送。

## 当前验收范围

默认 Preview，真实发送、首联 Auto 和聊天 Auto 均关闭。只读采集、模型匹配、草稿审核、已有会话分类、复盘及数据管理已有验证；真实首联、真实回复和 Auto 仍待最终验收。本预发行版不宣称真实发送已通过。

“立即沟通”一经点击，平台就会自动发送默认招呼。随后发送 AI 文案会形成两条消息。已有会话若已拒绝则停止联系，等待对方回复时不重复追问。启用任何真实发送前，请在 App 中核对目标、文案、时段和额度。

## 数据与问题诊断

“数据与诊断”可导出脱敏诊断 JSON、创建私密备份和恢复。分享问题时优先提供脱敏诊断；不要上传 `.env`、SQLite 备份、Chrome Profile、原始简历或聊天截图中的个人信息。私密备份含个人数据，应由自己保管。

本机安装、重启及捆绑运行时检查已通过；独立干净 Mac / 新用户环境和从 GitHub 实际下载后的首次安装仍待实测。
