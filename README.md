# dsh-feishu-channel

在飞书中驱动本机 DeepSeek Harness Agent。插件使用飞书官方 WebSocket 长连接接收事件，再经 Open API 回发文本；本机不监听公网端口。

当前版本支持：

- 绑定项目目录后复用同一个 DSH Agent 会话；桌面端可以看到同一 session。
- 同一 chat 的普通 prompt 按 FIFO 顺序执行，阶段摘要和最终结果回发飞书。
- `/project`、`/new`、`/status`、`/cancel`、`/approve`、`/deny`、`/help`。
- 高风险工具调用的一次性审批。审批默认 10 分钟过期，取消、断线或插件停止时按拒绝处理。
- 重启后恢复已保存 session；恢复失败不会静默创建替代 session，请使用 `/new` 显式重置。

## 凭证

App ID 和 App Secret 只通过 DSH 凭据服务读取，插件配置和状态文件只保存引用，不保存凭证值：

```bash
dsh credentials set FEISHU_APP_ID <your-app-id>
dsh credentials set FEISHU_APP_SECRET <your-app-secret>
```

默认引用名必须保持为 `FEISHU_APP_ID` 和 `FEISHU_APP_SECRET`。凭证引用只允许环境变量格式的名称，例如 `feishu.app_id` 不合法。

## 配置

在 web profile 的 Cordis patch 中为插件配置显式白名单和允许的项目根目录。所有列表默认为空，空列表会拒绝来源或项目绑定：

```yaml
- insert:
    - id: feishu-channel
      name: dsh-feishu-channel
      config:
        allowedOpenIds: [ou_example]
        allowedChatIds: [oc_example]
        allowedProjectRoots:
          - /Users/example/Projects
        agentPreset: restricted
```

私聊至少需要 `allowedOpenIds`。群聊同时需要发送者的 `open_id` 和群的 `chat_id`。项目路径必须是允许根目录内的已有目录，插件会按真实路径检查符号链接和路径边界；不会默认放行当前目录、用户目录或整个文件系统。

群聊回复默认只发给通过白名单的发送者，避免群内其他成员旁观 Agent 输出。确实需要共享群聊结果时，显式设置 `groupOutputMode: group`，并确认群成员都属于可信输出受众。未授权事件不会回发拒绝消息，以避免身份探测和出站队列消耗。

可选配置包括 `stateFile`、`groupOutputMode`、`approvalTimeoutMs`、`progressIntervalMs`、`maxProgressMessages`、`maxPromptLength`、`maxQueuedPrompts`、`maxOutboundQueue`、`maxOutboundTextLength`、`maxOutboundChunks`、`dedupeCapacity`、`dedupeTtlMs`、`agentOperationTimeoutMs`、`whenIdleTimeoutMs` 和 `cancelTimeoutMs`。数值配置有保守上限，`maxQueuedPrompts` 默认是 8，`maxOutboundQueue` 默认是 64，`maxOutboundTextLength` 默认是 12000，`maxOutboundChunks` 默认是 4，`stateFile` 只能落在 `$DSH_HOME/cache` 内。

## 使用

```text
/project /absolute/path/to/project
/status
请修改一个文件并运行测试
/cancel
/approve <id>
/deny <id>
/new
/help
```

普通文本必须先绑定项目。控制命令不会进入 prompt 队列。未知 slash 文本按普通 prompt 处理。工具参数、文件内容、环境变量和完整模型流不会自动发送到飞书，只回传阶段摘要和最终文本。

## 安全边界

白名单成员拥有所选 Agent preset 在本机上的全部能力，应把飞书接入视为把终端交给白名单成员。建议使用受限 preset，并只配置必要的 `allowedProjectRoots`。插件创建或恢复会话前会强制使用 `workspace-write` 与 `ask`；已有但无法证明由插件管理的 live Agent 不会被复用，请使用 `/new`。

文件删除、外部写入、发布推送、强制 Git 操作、系统级或高权限命令需要一次性审批；未知工具、无法判断的命令和越出项目目录的访问会拒绝。审批 token 只能由原 chat 使用一次，不能跨 chat 复用。

如果 App Secret 曾经出现在聊天、日志或屏幕中，应立即在飞书开放平台轮换 App Secret，然后通过 DSH 凭据服务写入新值，并重启 web profile。不要把新旧密钥写进插件配置、状态文件或 README。

## 人工冒烟

插件测试只使用假的 Agent 和 Lark 输出，不会自动向飞书发送消息。真实验证需由用户在已授权 chat 中手动发送：绑定项目、执行只读任务、触发并批准/拒绝高风险操作、取消运行、`/new`、重启恢复，以及未授权来源拒绝。

## License

MIT
