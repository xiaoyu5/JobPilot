# ADR-0006：本机 .env 配置和应用内 API Key 修改

日期：2026-10-22。状态：实施。用户明确选择 `.env` 替代 Keychain，并要求应用内可以修改 API Key。此决定取代 ADR-0003 和 ADR-0005 的 Keychain 约定；已完成的 M1 验证记录保留为历史证据。

应用不再调用 Keychain API，也不删除系统中已有项目。Rust 仅负责文件选择和私有 IPC，Worker 读取已选择的 `.env` / `.env.local`。默认新文件位于 JobPilot 本机数据目录的 `.env`；用户也可选择现有文件，数据库仅记录路径及非敏感模型参数。当前用户沿用项目 gitignored `.env.local`。

配置变量为 `OPENAI_BASE_URL`、`OPENAI_MODEL`、`OPENAI_API_KEY`，可选 `OPENAI_TIMEOUT_MS`、`OPENAI_ALLOW_LAN`。使用 Node `parseEnv` 解析，绝不通过 shell 执行。文件上限 64 KiB；模型端点沿用 localhost 默认边界。加载失败只影响模型动作，主窗口、岗位和事实库继续可用。

设置保留密码输入框。保存时新 Key 替换现值；空输入保留，明确勾选则清除。Key 从不回显、写入 SQLite、状态或日志。Worker 仅将其保存在内存并加到模型请求头。重启自动读取已存文件；外部修改后可在设置重新加载。

写入使用同目录唯一临时文件、0600 权限、fsync 和原子 rename，先验证最终文本，再替换。保留无关环境变量及注释。`.env*` 在 Git 中忽略，不进入 App 资源或发布包。此方案将 API Key 以用户明确选择的本机文本形式保存；文件本身应妥善保管。

测试覆盖带引号、美元符号、井号和反引号的 Key，空值保留、明确清除、重启加载、配置损坏/超限、失败时 App 可用，以及 Key 不出现在返回值或数据库。发行测试使用临时 `.env`，不再创建跨应用钥匙串记录或触发密码提示。
