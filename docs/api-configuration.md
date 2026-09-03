# API 配置与 Online Eval 指南

状态：可用于本地配置；DeepSeek Anthropic Contract 已通过
更新日期：2026-09-03

## 1. 配置原则

Blackx 当前支持两种 Runtime 模式：

| 模式 | 用途 | 所需 Secret |
| --- | --- | --- |
| `fake` | 常规离线测试与固定 Eval；Web Conversation API 会拒绝发送 | 无 |
| `anthropic` | Blackx Agent Core 直连 Anthropic Messages 端点 | `ANTHROPIC_API_KEY` |

API Key 只能进入服务端进程环境或 Secret Manager，不应：

- 粘贴到聊天正文；
- 写入 `.env.example`；
- 提交到 Git；
- 放入前端代码、Prompt、Artifact、Event 或普通日志。

当前项目不会自动读取 `.env` 文件。`.env.example` 只是变量名称示例，运行时必须通过终端环境或部署平台的 Secret 配置注入。

## 2. Anthropic Messages 兼容端点要求

目标端点至少需要兼容：

- `POST /v1/messages`；
- `x-api-key` 请求头；
- `anthropic-version: 2023-06-01` 请求头；
- 非流式 Messages JSON 响应；
- 你选择的模型 ID。

`ANTHROPIC_BASE_URL` 应填写服务根地址，不要以 `/v1` 结尾。Blackx 会自行追加 `/v1/messages`。

例如官方端点的根地址形式为：

```text
https://api.anthropic.com
```

第三方兼容服务必须以其实际文档为准。如果鉴权头、路径或响应字段不同，不能仅靠改环境变量接入，需要增加对应 Adapter 配置和 Contract Test。

DeepSeek Anthropic 兼容端点示例：

```bash
export BLACKX_RUNTIME_MODE=anthropic
export ANTHROPIC_BASE_URL="https://api.deepseek.com/anthropic"
export ANTHROPIC_MODEL="deepseek-v4-flash"
```

DeepSeek 默认返回 thinking block。Blackx 将完整 assistant content 作为 Provider opaque state 保存，并在同一模型的 Tool Loop 下一轮原样回传；不会把 thinking 内容提升为权威事实或暴露到 `model.after`、Runtime 响应和 Artifact。用于 ContextSnapshot 的内部 `model.before` 事件包含该状态，日志型 Hook 必须丢弃它。

## 3. 在本机安全注入 Anthropic 配置

在项目目录打开一个新的 `zsh` 终端：

```bash
export BLACKX_RUNTIME_MODE=anthropic
export ANTHROPIC_BASE_URL="你的服务根地址"
export ANTHROPIC_MODEL="端点实际支持的模型 ID"
read -s "ANTHROPIC_API_KEY?Anthropic API Key: "
export ANTHROPIC_API_KEY
npm run dev
```

`read -s` 输入时终端不会显示 Key。服务启动后，预期看到类似：

```text
Blackx listening on http://127.0.0.1:5173 (blackx-agent)
```

`blackx-agent` 表示 Agent Loop、Hook、Context、Skill 和 Compact 由 Blackx 自研 Core 驱动；模型请求由 Anthropic Provider Adapter 发出。

## 4. 健康检查

在第二个终端执行：

```bash
curl http://127.0.0.1:5173/api/runtime/health
```

健康接口只证明服务端 Runtime Adapter 已启动，不证明目标模型、结构化输出、Tool 或恢复链路已经验证。

Web UI 使用以下服务端会话接口，并固定携带 Tenant、Workspace 和 Actor Header：

```text
GET  /api/conversations
POST /api/conversations
GET  /api/conversations/{conversationId}
POST /api/conversations/{conversationId}/messages
POST /api/conversations/{conversationId}/background-tasks
GET  /api/conversations/{conversationId}/background-tasks
GET  /api/background-tasks/{taskId}
GET  /api/conversations/{conversationId}/cron-schedules
```

消息接口只接受 `blackx-agent` Runtime；Fake 模式返回 `real_provider_required`。服务端会先把用户消息写入 Agent Session，再调用模型，因此页面可以立即乐观显示消息，失败或刷新时也不会依赖浏览器 `localStorage`。同一会话只允许一个进行中的 Turn。

Background Task POST 接受与普通消息相同的 `{ messageId, content }`，返回 `202`。公开状态不回传消息正文，只包含 Task、Conversation、Message ID、Queue 状态、投递/失败计数和脱敏失败分类。任务 payload 受 64 KiB 上限约束并纳入 jobId 幂等冲突判断；Scheduler 以 at-least-once 语义执行，同一个 `messageId` 保证 Crash 重放不会重复追加用户消息或重复已完成的模型 Turn。当前 UI 对同一会话一次只提交一个后台消息，但其他会话可以继续交互。

普通 Conversation Turn 还会向实际模型暴露受控的 `background_task_create/status/cancel` 和 `cron_create/list/pause/resume`。写 Tool 必须通过服务端预授权 Policy、Audit 与 Execution Ledger；模型文本本身不构成授权。Cron 必须使用 IANA timezone、至少间隔 5 分钟并明确 `maxRuns`（1–100）。默认文件为 `.blackx-data/cron-schedules.json`，可用 `BLACKX_CRON_SCHEDULE_PATH` 覆盖。

## 5. 运行固定 Online Eval

保持 Blackx 服务运行，在第二个终端执行：

```bash
BLACKX_EVAL_BASE_URL=http://127.0.0.1:5173 npm run eval:online

# 直接验证自研 Core 的 Anthropic Token Count、摘要 Compact 和 Tool Loop
npm run eval:anthropic-contract
```

`eval:anthropic-contract` 在未配置时默认使用官方 `https://api.anthropic.com` 与 `claude-haiku-4-5-20251001`，但生产或长期回归应显式固定 `ANTHROPIC_BASE_URL` 和 `ANTHROPIC_MODEL`。失败报告只保留标准化 Runtime/Provider code 和状态，不输出 API Key 或 Provider 原始正文。`providerStatus` 表示真实上游 HTTP 状态，`adapterStatus` 表示 Adapter 在 HTTP 成功后产生的本地 Contract 状态。

当前固定封口袋 Fixture 检查：

- 返回值符合 `assistantMessage` JSON Schema；
- 没有把待确认参数升级为“已验证”或“生产就绪”；
- 回复保留明确的待确认边界；
- 存在 Session、Message 和 Turn 完成证据；
- 报告包含标准化 Usage，但不包含 API Key。

只有报告中的 `passed` 为 `true`，才能把该 Fixture 记为通过。一次文本返回成功不等于整个兼容路径通过。

## 6. 结束后清除当前终端变量

停止服务后执行：

```bash
unset ANTHROPIC_API_KEY ANTHROPIC_BASE_URL ANTHROPIC_MODEL
unset BLACKX_RUNTIME_MODE
```

这只会清除当前终端会话中的变量，不会撤销或轮换服务商侧的 Key。若 Key 曾经出现在聊天、Shell 历史、日志或 Git 中，应立即在服务商后台吊销并重新生成。

## 7. 启动 Online Eval

完成环境配置后，只需告诉开发 Agent：

```text
Anthropic API 环境变量已配置完成，请执行 Blackx Agent Core Online Eval。
```

不要在消息中附带 Key。执行时只验证变量是否存在，只报告“已设置/未设置”，不得打印变量值。

## 8. 当前能力边界

已完成：

- Agent Core 与 Anthropic Messages 的离线协议映射测试；
- 服务端 Key 边界；
- 文本、Function Tool、Tool Result、JSON Schema、Usage 映射；
- Agent Loop、Hook、Context、Skill 和 Compact 离线测试；
- 固定离线 Print Eval。

DeepSeek `deepseek-v4-flash` 已具备真实 API 证据：

- Token Count；
- 摘要 Compact；
- thinking block 跨 Tool Call/Result 原样回传；
- Session Context Snapshot 与 Usage。

仍需真实 API 证据：

- Session start / continue / resume；
- 限流、超时、中断和错误映射；
- 原生逐 Token 流；
- Token、成本与 P50/P95 延迟。

M0 Anthropic-compatible Online Contract 已通过；在上述证据完成前，生产可用性仍保持 `Unverified`。

## 9. Proposal Run 命令 API

新的 Enterprise Kernel API 默认关闭。启用本地命令和查询时，应分别注入普通命令 Token 与 Worker Token：

```bash
read -s "BLACKX_COMMAND_API_TOKEN?Command API Token: "
export BLACKX_COMMAND_API_TOKEN
read -s "BLACKX_WORKER_API_TOKEN?Worker API Token: "
export BLACKX_WORKER_API_TOKEN
read -s "BLACKX_OPERATOR_API_TOKEN?Operator API Token: "
export BLACKX_OPERATOR_API_TOKEN
export BLACKX_EVENT_STORE_PATH=".blackx-data/events.json"
export BLACKX_ARTIFACT_STORE_PATH=".blackx-data/artifacts"
export BLACKX_STAGE_JOB_QUEUE_PATH=".blackx-data/stage-jobs.json"
export BLACKX_STAGE_JOB_QUEUE_DRIVER="file"
npm run dev
```

- `BLACKX_COMMAND_API_TOKEN`：创建 Run、启动/重启 Stage、记录 Fact Version、处理 Approval 和查询状态。
- `BLACKX_WORKER_API_TOKEN`：仅供受信服务调用服务端 Proposal Worker，或提交 Runtime、Artifact 与确定性 Evaluation 证据。
- `BLACKX_OPERATOR_API_TOKEN`：仅供受信运维服务查询 Queue 指标、检查 DLQ 和执行带审计信息的 redrive。
- Worker 与 Operator Token 必须不同且至少为 32 字节；配置相同或过短时服务拒绝启动。Command Token 也应独立配置。
- 每个请求都必须携带 `x-blackx-tenant-id` 和 `x-blackx-workspace-id`；普通命令与查询还必须携带 `x-blackx-actor-id`。
- Worker 命令的事件 Actor 固定为 `blackx-worker`，不能通过请求头冒充其他 Actor。
- Token 只进入 `Authorization: Bearer ...`，不会写入 Event、Artifact、日志或 Model Provider 请求。
- 默认事件文件为 `.blackx-data/events.json`，Artifact 内容目录为 `.blackx-data/artifacts`，Stage Job Queue 为 `.blackx-data/stage-jobs.json`，均已被 Git 忽略。它们用于本地开发和跨进程恢复验证，不是生产数据库、对象存储或分布式队列。
- 当前 Event Store 文档 Schema 为 v3，在同一原子文件中保存 Event 与 Outbox；读取兼容 v2 并在下一次写入升级。早期 v1 本地试验文件没有足够数据可自动补齐，读取时会 fail-closed。需要保留旧试验数据时应先备份，再显式迁移或改用新的本地路径。
- 当前普通命令仍使用共享服务 Token，`x-blackx-actor-id` 是受信调用方声明，不等于完整用户身份认证或 RBAC。

推荐的最小调用顺序是：

```text
Command Token: create_run → start_proposal → record_fact_version
Worker Token:  POST /api/proposal-runs/{runId}/execute-proposal
Worker Token:  GET /api/stage-jobs/{jobId} → 等待 completed 或 dead_letter
Command Token: GET 状态 → resolve_approval
Worker Token:  POST /api/proposal-runs/{runId}/execute-proposal（确认 Stage Gate）
```

`record_fact_version` 请求必须携带 `factKey`、递增的 `factVersion`、`value`、可选 `unit` 和 `sourceRef`。普通命令入口会把它固定记录为 `status=unverified`、`sourceType=user_input`；客户端不能通过该入口自封为 `verified`。

Proposal Worker 请求体只接受执行信封：

```json
{
	"commandId": "execute-proposal-v1",
	"correlationId": "trace-001",
	"expectedVersion": 3
}
```

该 POST 先把 `stage.execution_requested` Event 与 Outbox 原子提交，再尽力立即投递，并返回 `202`。若 Queue 暂时不可用，响应会标记 `outbox_pending`，后台 Dispatcher 会重试；Queue enqueue 使用确定性 Job ID 去重。该调度 Event 会占用一个 Aggregate Version，因此 Job 内部的 `expectedVersion` 比请求值大一。后台 scheduler 通过租约领取 Job并在长 slice 中续租；每次 delivery 只执行一个 Runtime slice。Agent Core 返回 `paused` 时，Queue 保存同一 `sessionId` 与最后一个 `contextSnapshotId`、清除租约并排回队列，Worker 槽位立即释放；下一次领取用 `resume: "if-present"` 续跑。Runtime 最终完成后，Worker 保存 `proposal-runtime-checkpoint.v2`，再用三个幂等命令依次追加 Runtime、Artifact、Evaluation/Approval 事件。评测失败时保留候选与报告，Stage 进入 `retryable_failed`，不会创建 Approval。

Job 状态可通过同一 Tenant/Workspace 与 Worker Token 查询。`queued` 表示等待或退避，`leased` 表示某个 Worker 正在执行一个 slice，`completed` 表示本次 Worker 命令已提交，`dead_letter` 表示不可重试、连续失败或总 slice 预算耗尽。调用方随后仍需查询 Proposal Run 的业务状态；Job 完成不等于审批完成。

Operator API 使用相同 Tenant/Workspace Header、独立 Operator Token，并为 redrive 额外要求 `x-blackx-actor-id`：

```text
GET  /api/stage-jobs/metrics
GET  /api/stage-jobs/dead-letter
POST /api/stage-jobs/{jobId}/redrive
```

redrive 请求体必须包含当前 Job 的 `expectedUpdatedAt` 和人工原因 `reason`，可选 `additionalSlices` 为 1–32。它只允许重放当前租户/工作区中的 `dead_letter` Job，复用原 Job、Command 和 Session 身份，并记录 Actor、原因、时间与 redrive 次数。

`BLACKX_STAGE_JOB_QUEUE_DRIVER=file` 是默认本地 Adapter。设置为 `sqlite` 时，`BLACKX_STAGE_JOB_QUEUE_PATH` 应指向 `.sqlite` 文件；该实现支持单主机多 Worker 的事务 claim，但仍不是多主机分布式 Queue。当前 Node 的 `node:sqlite` 仍可能显示 experimental warning。

Approval `approved` 只表示人工决定已经持久化，Run 仍保持 `waiting_approval`。调用方读取最新 `aggregateVersion` 后，以新的 Worker `commandId` 再次调用同一路径；Worker 验证当前 Artifact 仍为 `fresh` 且审批绑定正确，追加 `stage.completed` 后才进入 `completed / passed`。

停止服务后清理当前终端中的权限变量：

```bash
unset BLACKX_COMMAND_API_TOKEN BLACKX_WORKER_API_TOKEN BLACKX_OPERATOR_API_TOKEN
unset BLACKX_EVENT_STORE_PATH BLACKX_ARTIFACT_STORE_PATH BLACKX_AGENT_STATE_PATH BLACKX_STAGE_JOB_QUEUE_PATH BLACKX_STAGE_JOB_QUEUE_DRIVER
```
