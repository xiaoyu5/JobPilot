# MCP 接入

JobPilot 提供 stdio MCP 网关，与桌面应用共享同一个 Worker、岗位池、事实库和任务状态。先启动桌面应用；网关不会自行创建第二个 Worker，离线时返回 WORKER_OFFLINE。

## 已安装 App

在兼容客户端中添加以下配置，替换 App 的完整路径：

```json
{
  "mcpServers": {
    "jobpilot": {
      "command": "/absolute/path/JobPilot.app/Contents/MacOS/jobpilot-node",
      "args": [
        "/absolute/path/JobPilot.app/Contents/Resources/worker/index.mjs",
        "--mode",
        "mcp"
      ]
    }
  }
}
```

App 自带 Node，无需单独安装。若使用非默认数据目录，桌面 Worker 与网关必须同时使用 `--data-dir <path>` 指向同一目录。默认目录为 `~/Library/Application Support/io.jobpilot.desktop`。

## 从源码运行

按[开发指南](development.md)准备 Sidecar 并执行 `npm run build`，启动桌面应用后，可使用仓库中的运行时和构建资源：

```json
{
  "mcpServers": {
    "jobpilot": {
      "command": "/absolute/path/JobPilot/apps/desktop/src-tauri/binaries/jobpilot-node-aarch64-apple-darwin",
      "args": [
        "/absolute/path/JobPilot/dist/worker/index.mjs",
        "--mode",
        "mcp"
      ]
    }
  }
}
```

## 工具

| 工具 | 用途 |
| --- | --- |
| `jobpilot.status` | 读取 Worker、浏览器和模型状态 |
| `jobpilot.start_run` | 按已保存方案启动预览任务，或在 GUI 已授权后启动一轮 Auto |
| `jobpilot.search` | 按已保存方案只读采集岗位与 JD |
| `jobpilot.list_jobs` | 分页查询本机岗位池 |
| `jobpilot.analyze` | 使用已冻结事实匹配岗位 |
| `jobpilot.draft_greeting` | 生成并审计招呼语，不发送 |
| `jobpilot.queue` | 将有效草稿加入本地审核队列 |
| `jobpilot.dry_run` | 对本机岗位池匹配、生成并排队，不操作浏览器或发送 |
| `jobpilot.get_run` | 查询进度和任务事件 |
| `jobpilot.pause_run` | 请求暂停任务，已提交的动作不能撤回 |

## 授权范围

搜索复用桌面保存的只读访问授权。匹配和草稿将必要文本发送到用户配置的模型服务，工具结果不授予发送权限。

MCP 不能启用或扩大真实发送、Auto、时段和限额，也不能代替具体文案的 GUI 确认。只有用户已经在桌面明确授权当前会话 Auto 时，才可通过 `start_run` 按既有限制启动一轮。停止、重启、配置变化或撤销授权后，需要用户在桌面重新启用。

首次沟通、已有会话以及待核验处理方式见[使用指南](usage.md)。
