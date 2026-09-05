# M1 Durable Single-Agent Runtime Evidence

日期：2026-09-03；行业无关集成链补充验证：2026-09-04
结论：Passed
Contract：`blackx-m1-durable-runtime-v1`

## 固定 Fixture

```text
Research Task
→ deterministic Stage Job
→ generic Stage Job Scheduler
→ Research Fixture Worker
→ research_source_read(source-session)
→ research_source_read(source-recovery)
→ immutable Evidence Report Artifact v1
→ deterministic schema/source/lineage evaluation
→ version-bound Approval
→ passed Stage Gate
```

该 Fixture 不包含包装字段、Print Skill 或 Proposal Worker。输出只允许两个固定 Fact，并要求分别引用精确来源，同时保留 `fixture_sources_only` 限制。`StageJobScheduler` 已移除对 Proposal Worker 的构造依赖，只通过 `stageId → handler` 注册 Worker。

## 离线证据

```text
command: npm run eval:m1
mode: offline
adapter: blackx-agent
model: scripted-fake
passed: true
successful tool calls: 2
structured artifact: passed
fact lineage: passed
explicit evidence limit: passed
durable runtime evidence: passed
job status: completed
artifact: artifact://evidence-report/v1
evaluation: passed
evaluation report: artifact://research-evaluation/v1
approval: approved, bound to evidence-report v1
stage status: passed
```

集成测试还验证：同一个确定性 Job 重复入队不会产生第二个队列项；错误 Artifact Version 无法通过 Approval；Evaluation 失败会进入非重试 DLQ 且不会请求 Approval；Artifact、Evaluation、Approval 和 Stage Gate 的事件顺序固定。

失败路径首次运行还发现：Runtime 未返回 Usage 时，Evaluation Report 中的可选 `usage: undefined` 会被 JSON Artifact Store 拒绝，进而把 `invalid_output` 误分类为可重试的存储故障。评分边界现已在 Usage 缺失时省略该字段，并由同一失败链路测试覆盖。

全量工程检查：

```text
command: npm run check
test files: 30 passed
tests: 139 passed
typecheck: passed
production build: passed
```

全量测试包含 Runtime Contract、Failure 分类、权限、Tool 幂等、Compact、Session/ContextSnapshot、Fact/Artifact/Approval、Event/Outbox、Queue lease/fencing/retry/DLQ/redrive、单主机 SQLite 多 Worker、Background/Cron 和五个 Worker Crash Injection。

## DeepSeek Online Gate

```json
{
  "contract": "blackx-m1-durable-runtime-v1",
  "mode": "online",
  "model": "deepseek-v4-flash",
  "fixtureId": "durable-research-runtime-v1",
  "passed": true,
  "checks": [
    { "name": "structured_artifact", "passed": true },
    { "name": "source_tool_loop", "passed": true, "detail": "successful research_source_read calls: 2" },
    { "name": "fact_lineage", "passed": true },
    { "name": "explicit_limit", "passed": true },
    { "name": "durable_runtime_evidence", "passed": true }
  ],
  "adapter": "blackx-agent",
  "usage": {
    "inputTokens": 191,
    "cachedInputTokens": 1408,
    "outputTokens": 444,
    "reasoningOutputTokens": 0
  }
}
```

Online Gate 实际事件顺序包含两次 `model.started/model.completed`、两次 `tool.started/tool.completed`、不可变 Context Snapshot、Session 和 Turn completion。

该 Online 结果是 2026-09-03 的 Runtime Gate 证据。2026-09-04 已让 `eval:m1-online` 走同一条 Queue → Worker → Artifact → Evaluation → Approval 链路，但本次变更没有重新调用外部模型，因此不把旧结果升级为新的 Online 全链路验证。

## 本轮发现并修复的失败

第一次在加入持久 Runtime Trace 后重跑 Online Gate 时，成功 Tool Event 中的可选 `failureCode: undefined` 被文件 Store 的 canonical serializer 拒绝。修复在 Trace 持久化边界执行 JSON 规范化，并增加回归测试，确保可选未定义字段不导致已完成模型调用丢失 Trace。修复后使用同一 Fixture 重跑通过。

## 可观测性

- 每次 Runtime 执行持久化脱敏 `runtime-trace.v1`；模型正文仍保存在 Session，Trace 只记录 `[stored in session]`。
- Trace 包含 Agent/Model/Tool/Compact 事件、Usage、总耗时、Session、Context Snapshot 和结构化 Failure。
- `GET /api/conversations/{conversationId}/traces` 按 Tenant/Workspace/Conversation 查询。
- Stage Job 持久化 `recoveryCount`、恢复检测延迟和最后一次过期 lease 证据；Operator metrics 汇总 recovery 次数和检测延迟。

真实 HTTP smoke 使用独立临时端口和临时 Store 完成：

```text
POST /api/conversations
POST /api/conversations/{conversationId}/messages
GET  /api/conversations/{conversationId}/traces

provider: deepseek-v4-flash
turn status: completed
trace status: completed
context snapshot: present
model duration and usage: present
message body in trace: [stored in session]
```

Smoke 完成后已停止临时服务并删除临时数据目录。

## 接受的 M1 限制

- Provider 返回成功到本地 Trace/Checkpoint 写入之间仍有崩溃窗口。M1 保留相同 Runtime/Tool 幂等身份并记录风险；上线前需要 Provider 去重证据或生产事务型 Worker。该限制不影响单机开发基线，但阻塞生产级 exactly-once 声明。
- Queue/DLQ 已有 Operator-only API；图形运维页面移入 M2 产品体验，不属于 M1 Runtime Contract。
- 多主机 Queue、PostgreSQL、对象存储、SLA、Sub-agent、Teams 和 RSI 不属于 M1。
