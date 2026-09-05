# M2 Requirement Brief Contract Baseline Evidence

日期：2026-09-04，2026-09-05 补充统一链路与跨 Run 指标
结论：Engineering Baseline Frozen / Synthetic Validation Passed / Real User Validation Not Performed
Contract：`blackx-m2-requirement-workflow-baseline-v2`

## 已冻结范围

- 用户：印刷、包装和定制家具企业的售前/跟单人员
- 高频任务：把客户 Brief 和授权资料转成带来源、状态、版本、缺口和下一步动作的需求单
- Artifact：`requirement-brief.v1`
- Evaluator：`requirement-brief-evaluation.v1`
- Approval Gate：只有无阻断缺口且所有必填 Fact 已验证的具体 Artifact Version 才可审批
- 非目标：自动报价、生产参数、生产文件、多 Agent、RSI 和分布式平台

## 固定 Eval

```text
command: npm run eval:m2
fixtures: 10
print: 5
furniture: 5
passed: 10
approval eligible: 4
full check: 34 test files / 155 tests / typecheck / production build
```

覆盖完整已确认需求、缺少尺寸/稿件/安装/交付地点、关键字段待确认、模型伪造 Verified Fact，以及声明缺口和下一步动作不一致。

## 固定任务正式纵向链路

10 个固定任务全部使用真实 Blackx Agent Loop、固定 Model Provider 与正式 Product Worker，覆盖：

```text
Print customer Brief
→ project_source_read
→ Transactional Outbox
→ file-backed Stage Job Queue
→ generic Stage Job Scheduler
→ production RequirementBriefWorker
→ file-backed requirement-brief/v1
→ deterministic requirement-brief-evaluation/v1
→ version-bound Approval Gate 或 needs_input
```

Print 5 个、Furniture 5 个均使用同一个 Event Store、Queue Adapter、Worker 类型和状态机。4 个完整任务批准 Artifact v1 后进入 `passed`；6 个缺字段或待确认任务的 Evaluation 保持通过但 `approvalEligible=false`，由同一状态机进入 `needs_input`。每个任务同时断言 `project_source_read` 成功、ArtifactVersion 与 Evaluation Event 已持久化、Queue delivery 数与 Job 数一致。旧 `RequirementBriefFixtureWorker` 已删除。

## 持久产品链路

正式 Requirement Brief 不再使用 Fixture Worker 内存作为权威状态。新增链路复用同一个企业状态机语义，但使用独立 `requirement-*` Run 和 `requirement-brief` Stage：

```text
Conversation + industry selection
→ Event Store facts
→ transactional Outbox
→ Stage Job Queue / Scheduler
→ real Agent Runtime + tenant-scoped project_source_read
→ durable Runtime Checkpoint
→ RequirementBrief ArtifactVersion
→ deterministic Evaluation
→ needs_input or version-bound Approval
→ Stage Gate
```

持久集成测试验证重建 RunEngine 后 `needs_input`、Artifact v1 和 Event Version 可恢复；补齐并确认 Print 必填 Fact 后生成 Artifact v2、请求审批并完成 Gate。Fact 更新会使旧 Artifact stale 和旧 Approval superseded。

## 真实浏览器验收

2026-09-04 使用实际 DeepSeek Provider 完成一条全新 Furniture 链路：消息即时显示并收到真实回复，Requirement Job 经过 `queued → leased → completed`，模型提取 7/7 个 Canonical Fact 且全部保持 `model_output/unverified`。逐项人工确认后，Fact 变为 `human_confirmation/verified`，旧 Artifact stale；随后真实 Provider 生成 Artifact v2，确定性 Evaluation 允许审批，批准准确版本后 Run v34 进入 `passed`。

本次在线验收的最终可见指标为：Canonical 命中率 100%、Fact 确认率 100%（7/7）、缺失 Fact 0、澄清轮次 1、Artifact v2、累计 Runtime Token 1744/6794（input/output）、累计 Runtime 延迟 54308 ms、Queue Recovery 0、累计可重试失败 2。模型价格未配置，因此成本明确显示“未配置价格”，没有生成估算账单。服务重启并刷新页面后，Artifact、Approval、指标与两次历史失败仍从服务端持久状态恢复。

后续浏览器回归将同一 Run 取消为 Event Store 中的 `stage.cancelled`；刷新后保持 Run v17/已取消，Fact 表单和确认按钮均不可继续操作。队列测试同时覆盖 queued 取消和 leased Job 的 AbortSignal 协作终止。

Canonical 回归覆盖已知别名归一化、未知概括字段丢弃，以及 Evaluator 拒绝跨行业或非 Canonical Fact。Runtime 使用 `blackx-requirement-brief` Skill 约束 Print/Furniture 字段集合。

## 跨 Run 指标读模型

`GET /api/requirement-brief/metrics` 返回租户和 Workspace 隔离的 `requirement-brief-metrics-series.v1`。每个时间点绑定 `runId`、`conversationId`、行业、Stage 状态、开始/更新时间、Evaluation 与 Approval 结果和完整 Run 级指标；点按开始时间排序。

汇总指标包括 Stage/Evaluation/Approval 比率、Canonical 命中、最终人工确认且值未变化的候选准确率、Artifact Fact 来源覆盖率、Fact 确认率、澄清轮次与问题数、Artifact 版本、Queue delivery/slice/失败/恢复及对应比率、Tool 执行失败率、Runtime Token 与耗时。数据从 Conversation 索引、Event Store、Artifact、Runtime Checkpoint 和 Queue Job 现场派生，服务重启后仍可查询；测试覆盖两个 Run 的时间序列和跨租户空结果。

## 多模态输入回归

会话 UI 支持选择最多 8 张 PNG、JPEG、WebP 或 GIF 随下一条消息发送，也支持无文字的仅图片消息。图片在 Agent Core 中保持 Provider-neutral 引用，Anthropic Adapter 才转换为原生 `image/base64` 内容块。Requirement Worker 使用创建需求单时冻结的附件摘要，并在摘要变化时拒绝继续，避免把后续上传误混入已审查版本。

离线回归验证图片二进制只在模型调用期间重水化；持久 Agent Session、ContextSnapshot 和 Runtime Trace 不包含 Base64。该证据尚不代表 DeepSeek 兼容端点已经通过真实图片请求，在线多模态仍需独立 Gate。

## 当前证据边界

该结果证明 Product Contract、两类 Domain 必填字段和 Deterministic Evaluator 已冻结并可离线回归。它不证明以下能力已经完成：

- 真实 Print/Furniture 目标用户尚未完成走查
- 已有跨 Run 可追溯时间序列，但尚未积累足以判断长期趋势的真实用户样本，也没有看板告警或 Provider 账单对账

这些项目仍属于 M2 Product Validation Gate，不得用现有自动化和单次浏览器验收替代真实用户价值验证。

2026-09-05 产品负责人接受以合成样例关闭 M2 工程基线，样例与限制见 [`m2-synthetic-user-validation-2026-09-05.md`](m2-synthetic-user-validation-2026-09-05.md)。这不是对上述真实用户缺口的豁免或通过结论；真实用户验证作为显式 Validation Debt 保留，在对外试点、产品价值声明或 RSI 前必须补验。
