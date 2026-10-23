# GitHub 发行

仓库：<https://github.com/xiaoyu5/JobPilot>。当前目标为 0.5.1 预发行版，不上架 App Store；Developer ID 签名和 Apple 公证为可选改进。

## 准备文件

```sh
npm ci
npm run prepare:sidecar
npm run check
npm run desktop:build -- --ci
npm run verify:installer
npm run verify:bundle:m4
npm run release:prepare
```

安装和 bundle 冒烟会启动隔离测试 App；请先正常退出正在运行的实际 JobPilot，以免 macOS 单实例保护拦截测试。测试使用临时匿名数据，不使用真实账户。

`release:prepare` 对最终 DMG 作完整性检查，只读挂载并检查内部 App 的版本、完整签名结构、捆绑 Node 和资源文件名；检查只读扩展仅有 activeTab / scripting 权限。汇集以下固定输入至 gitignored `.local/releases/0.5.1/`：

- DMG；
- 独立可手动加载的只读扩展 ZIP；
- 安装说明及当前版本发布说明；
- `release-manifest.json` 和 `SHA256SUMS.txt`。

命令不启动 App、不访问 BOSS、不上传文件。已存在的发行目录不会覆盖；重建时先将旧目录移至别处。资源文件名检查不能替代完整内容审查；源码提交前仍需检查实际差异。

## 源码与附件边界

`.gitignore` 排除原始需求目录（含真实简历背景）、本机 `.env`、数据库、Chrome Profile、私密备份、证据日志和构建产物。不要使用 `git add -f` 绕过。公开产品说明位于 `docs/product-scope.md`，原始资料在本机保留。

只上传 `.local/releases/0.5.1/` 中的固定发行文件，不上传 `.local/` 其余内容。源码作为常规 Git 提交推送，DMG 和扩展 ZIP 作为 Release 附件。项目自身的开源许可证尚未选择；不自动替作者授予 MIT 等许可，第三方组件仍受各自许可证约束。

创建 GitHub **预发行版**时使用 `docs/releases/0.5.1.md` 的说明，按[验证记录](m5.1-validation.md)列明真实范围：一次受控首次沟通与独立 AI 恢复已通过；所选附件请求由用户人工处理，JobPilot 未提交聊天回复，已有会话回复与 Auto 仍待真实验收。上传后从 GitHub 下载并验证 SHA-256 与本机附件一致。上传校验不代替独立干净 macOS 首次安装验证。
