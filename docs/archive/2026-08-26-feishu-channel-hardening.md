# Feishu 加固完成记录

> 状态：`Completed with verification notes`
>
> 原始计划日期：2026-08-26
>
> 完成验证日期：2026-08-31
>
> 当前验证基线：`d56b13f2e`（`codex/feishu-channel` 的当前提交）
>
> 当前收尾分支：`codex/feishu-channel-closeout`

本记录归档原 Feishu channel 加固计划。技术实现和本地自动验证已经完成；真实飞书人工冒烟尚未执行，因此本记录不宣称已经完成真实环境端到端验证。当前分支以既有加固提交 `d56b13f2e` 为基线，只包含本轮验证补强，不重写既有加固提交，也不包含凭据、消息正文、工具参数或环境变量。

## 目标与范围

本轮收尾聚焦以下事项：

- 将加固计划转为可审计的完成记录。
- 补齐 WebSocket 启动失败回归测试。
- 统一本地与 CI 的覆盖率执行方式，并设置防回退门槛。
- 保留真实飞书人工冒烟和已知限制的明确记录。

本轮没有新增飞书命令或消息类型，没有改变权限模型、审批协议或状态文件格式，没有重构核心 Agent 模块，也没有发布 npm 包。

## 实现与提交映射

以下提交均可从当前仓库的 Git 对象中追溯。表中保留原加固方案要求的主要实现节点；`d56b13f2e` 是本轮收尾分支的验证基线。

| 计划任务 | 提交 | 代码或文档证据 |
| --- | --- | --- |
| 权限、发送重试、generation、状态恢复、dedupe TTL、WS readiness、包元数据等核心加固 | `d8c33d772` | `lib/agent-driver.js`、`lib/index.js`、`lib/risk-policy.js`、`lib/session-map.js` 及对应测试 |
| 队列和 reset barrier 生命周期补强 | `bd85f6769` | `lib/agent-driver.js`、`lib/prompt-queue.js`、`lib/session-map.js` 及 Agent 测试 |
| 异步接收者和权限验证补强 | `f69042fdb` | `lib/agent-driver.js`、`lib/approval-bridge.js`、`lib/message-router.js`、`lib/progress-relay.js` 及隔离测试 |
| Git 元数据、输出边界、群聊发送者隔离 | `025bd2611` | `lib/index.js`、`lib/message-router.js`、`lib/risk-policy.js` 及边界测试 |
| Agent 生命周期、权限作用域、项目路径、进度状态、最终结果发送 | `2fe8ec190` | 相关 `lib/` 模块和 `test/` 回归套件 |
| 剩余竞态、输入边界、CI 和仓库级安全文档 | `d56b13f2e` | 当前分支基线，包含 `.github/workflows/ci.yml`、`SECURITY.md`、`CONTRIBUTING.md` 及额外回归测试 |

## 证据状态

### 当前代码和自动测试证据

- [x] 未授权事件默认静默丢弃，群聊输出和审批绑定到授权 sender。
- [x] 项目路径、Git 元数据、权限 preset、审批 token、session 恢复和 Agent 生命周期具备回归测试。
- [x] FIFO、取消、reset barrier、generation、dedupe TTL、出站串行发送、重试、队列上限和输出截断具备回归测试。
- [x] WebSocket readiness 只在 handshake 回调后记录；`WSClient.start()` rejection 只记录有界且脱敏的启动失败，并在 cleanup 时关闭客户端。
- [x] npm 包使用 allowlist，测试文件和 `docs/` 不进入发布包。
- [x] 本轮新增测试覆盖 `WSClient.start()` rejection，且不依赖真实网络、不写入 trace 或秘密。

### 无法从仓库证明的过程

- [~] 历史每个测试是否严格先经历 RED，再进入 GREEN，现有 Git 历史无法完整证明。
- [~] 本轮新增的 WS 启动失败测试用于补充已有行为的回归证据，首次运行即通过；没有伪造历史 RED 记录。

### 仍需人工执行

- [ ] 真实飞书冒烟用例 A–G 尚未执行：访问控制、项目绑定、普通任务 FIFO、高风险审批、取消与重置、重启恢复、出站失败。
- [ ] 因此真实飞书连接、真实 DSH Agent、真实权限 preset 和真实出站 API 的端到端结果仍未确认。

## 自动验证记录

验证工作树以 `d56b13f2e` 为基线，包含本轮验证改动。命令和结果如下：

| 检查 | 结果 |
| --- | --- |
| `npm ci` | 通过；安装锁定依赖，发现 0 个漏洞 |
| `npm test` | 通过，214/214 |
| `node --test test/credentials.test.mjs` | 通过，56/56 |
| `npm run test:coverage` | 通过，214/214；行 95.44%，分支 87.54%，函数 86.76% |
| 覆盖率门槛 | 通过；行 90%，分支 80%，函数 85% |
| `for file in lib/*.js; do node --check "$file"; done` | 通过 |
| `npm audit --omit=dev --audit-level=low` | 通过；0 个漏洞 |
| `npm pack --dry-run --json` | 通过；17 个 allowlist 文件，包含 `LICENSE`、`README.md`、`package.json`、`cordis.patch.yml` |
| `git diff --check` | 通过 |

覆盖率脚本固定为：

```bash
node --experimental-test-coverage --test-coverage-lines=90 --test-coverage-branches=80 --test-coverage-functions=85 --test "test/*.test.mjs"
```

CI 使用 `npm run test:coverage`，并同时执行语法检查、生产依赖审计和发布包内容检查。覆盖率报告只输出到 CI 日志，不生成需要提交的仓库产物。

## 真实飞书冒烟记录规则

真实冒烟执行时只记录用例名称、时间、脱敏环境标识、通过/失败、脱敏错误码和后续修复状态。测试必须使用专用 App、最小白名单、临时测试项目和受限 Agent preset。

不得记录或提交 App ID、App Secret、token、Cookie、`open_id`、`chat_id` 原值、完整消息正文、完整工具参数、环境变量或本机敏感路径。冒烟发现的问题必须先补充最小自动回归测试，再实施最小修复并重新执行完整质量门禁。

## 已知限制

- 当前收尾分支为 `codex/feishu-channel-closeout`，目标基线为 `codex/feishu-channel`；本分支已包含 `d56b13f2e`，不会覆盖目标分支已有提交。
- 自动测试使用 SDK 和 Agent 的替身，不能代替真实飞书长连接、权限配置、网络重试和真实 DSH 运行时验证。
- 覆盖率门槛用于阻止回退，不代表所有安全路径均已覆盖，也不作为安全质量本身的替代品。
