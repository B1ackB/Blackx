# 历史文档：可恢复 Proposal 纵向切片

状态：Superseded as M1 / Retained as Print Domain Reference
更新日期：2026-09-03

本文件保存已实现的 Print Proposal 纵向切片、测试证据和未完成领域工作。它不再定义通用 M1 的完成条件。当前 M1 见 [`milestone-1-durable-runtime.md`](milestone-1-durable-runtime.md)，当前 M2 见 [`milestone-2-product-slice.md`](milestone-2-product-slice.md)。

> Runtime 基线已切换为自研 `AgentRuntimePort`，详见 [`ADR-0001`](adr/0001-self-owned-agent-core.md)。

原状态：In Progress
前置条件：M0 自研 Agent Core 的相关 Contract 与离线回归通过

## 1. 用户结果

售前方案人员用自然语言、附件或已有项目资料提交一个包装客户 Brief。系统先提取带来源的候选 Fact，自动查询已连接的标准、材料、供应商和设备能力，再只追问阻断当前阶段的关键缺失项。系统区分已验证事实、未确认信息和模型建议，运行 Proposal Stage，生成结构化 `SolutionProposal` Artifact，完成确定性检查后请求 Approval A。进程中断后可以从 Event Store、Checkpoint 和 Artifact 恢复。

M1 的成功不是“模型回答了一份方案”，而是一个具体 Artifact Version 经过可追溯评测并进入明确审批状态。

## 2. 最小范围

包含：

- 一个租户、一个 Workspace 下的隔离路径，但所有核心标识均显式存在
- 一个已确认的封口袋产品类型；由 StandardsRouter 根据已验证适用性事实选择袋型/封口相关标准，不设置模型默认值
- Intake、Proposal、Evaluation、Approval A 四个阶段/节点
- `Project`、`Run`、`Stage`、`Fact`、`Artifact`、`ArtifactVersion`、`Approval`、`Evaluation`、`Event`、`ContextSnapshot`、`StandardRecord`、`ApplicableStandardsProfile`
- 内存 Fake Adapter 和一个实际持久化 Adapter
- 一个只读权威材料/工艺目录 Fake Tool
- `StandardsRegistryPort`、`MaterialCatalogPort`、`EquipmentCapabilityPort` 的最小契约和 Fake；缺少真实连接器时允许上传证据或人工确认
- 一个最小 API 或 CLI 入口，用于端到端验收

不包含：

- 图片生成、Artwork、Mockup
- 权威生产版式排版、PDF/X 和 Preflight
- 自动报价承诺
- 客户网页发布
- 多 Agent、多租户管理 UI 和 Codex Fork

## 3. 权威事实规则

Fact 至少包含：

```text
id
tenantId
workspaceId
projectId
type
value
unit
status: suggested | unverified | verified | rejected
sourceType
sourceRef
verifiedBy
verifiedAt
version
```

M1 先从自然语言和附件提取 StandardsRouter 所需的适用性事实：目标市场、预期用途、内容物类别、食品接触类型、材料家族、结构/复合方式、闭合特征、印刷方式、灌装/热处理/无菌要求和阻隔目标。提取结果必须保留原始来源；缺失或未确认时保持 `unverified`。Missing-Fact Policy 只对会阻断 Router 或显著改变方案的内容请求确认。

Router 选择当前有效标准后，由确定性规则派生标准要求。成品尺寸、方向、数量、具体材料牌号/层结构、生产设备设定、可印区域、颜色/品牌要求、交期、法定信息和权威生产版式仍来自客户、企业系统、供应商或测试证据。普通客户不需要预先提供工厂温度、压力、停留时间或线速；这些信息优先由设备/供应商/历史工单 Adapter 和试产证据获得。标准明确规定范围或最低要求时可以派生，不能用行业常见值补齐。

模型只能创建 `suggested` 或 `unverified` Fact。受权用户、权威 Adapter 或确定性 Standards Rule Engine 可以产生 `verified` 转换事件；标准派生必须记录标准版本、条款、规则版本和全部输入 Fact Version。

## 4. Artifact 与 Approval

M1 的输出 Artifact：

- `CustomerBrief`
- `ApplicableStandardsProfile`
- `StandardRequirementSet`
- `PrintProductSpec`
- `SolutionProposal`
- `ProposalEvaluationReport`

每个 Artifact Version 必须记录：

- 输入 Fact Version
- 上游 Artifact Version
- Runtime/模型和 Tool 证据
- 生成时间与所有者
- Schema 版本
- Evaluation 结果
- 当前 `fresh | stale` 状态

Approval A 必须绑定 `SolutionProposal` 的具体 Version。任何被依赖 Fact 或 Artifact 变化，都必须产生事件、传播 `stale`，并使旧 Approval 不再满足 Stage Gate。

## 5. 状态机

建议最小状态：

```text
Run: created → running → waiting_approval → completed
                    ↘ failed / cancelled

Stage: pending → running → evaluating → waiting_approval → passed
                     ↘ retryable_failed / failed / cancelled

Approval: requested → approved | rejected | cancelled | superseded
```

所有转换通过命令校验并追加 Event；非法转换必须返回强类型错误。模型 Turn 完成只允许触发 `ExecutionCompleted`，不能直接把 Stage 标记为 `passed`。

## 6. 事件与幂等

关键事件：

- ProjectCreated
- FactRecorded / FactVerified / FactRejected
- StandardProfileSelected / StandardRequirementDerived / StandardProfileSuperseded
- RunCreated / RunStarted
- StageStarted
- RuntimeExecutionLinked
- ArtifactVersionCreated
- EvaluationCompleted
- ApprovalRequested / ApprovalResolved / ApprovalSuperseded
- ArtifactMarkedStale
- StageCompleted
- RunCompleted

每个外部命令携带幂等键。Artifact Version 创建、Approval 处理和 Stage 恢复必须测试重复投递。Event Store 使用聚合版本或等价并发控制拒绝冲突写入。

## 7. Context 规则

M1 的 ContextEngine 可以很小，但不能跳过：

```text
稳定系统策略
+ 当前 Stage 定义
+ Verified Fact
+ 明确标注的 Unverified Fact
+ Applicable Standards Profile 与条款引用
+ 相关 Artifact 索引/摘要
+ 允许 Tool Schema
+ 预算和完成输出 Schema
```

不把全部聊天历史或 Artifact 二进制直接传给 Runtime。每次执行保存 `ContextSnapshot` 的引用、输入摘要、Token 估算和保留项；权威事实不由摘要改写。

## 8. 失败与恢复演练

至少在以下故障点注入失败：

1. StageStarted 后、Runtime 调用前。
2. Runtime 完成后、Artifact Version 持久化前。
3. Artifact 已创建后、Evaluation 前。
4. ApprovalRequested 后、人工响应前。
5. Approval 已处理但 Worker 尚未确认 Stage Gate。

恢复验收：

- 重放后状态唯一且合法
- 已完成的昂贵调用不会无条件重复
- 不产生重复 Artifact Version 或重复 Approval
- Runtime resume handle 丢失时可以按 Policy 新建执行，而不丢业务状态
- 每次恢复产生关联 Event 和可观察指标

## 9. 端到端验收场景

### 正常路径

提交完整 Brief → 验证 Fact → 生成 Proposal → 确定性评测通过 → Approval A 批准 → Run 完成。

### 信息缺失

提交缺用途/接触类型/加工条件 Brief → Intake Extractor 与 Domain Port 先尝试补齐 → Missing-Fact Policy 只询问剩余阻断项 → StandardsRouter 在仍不完整时返回 incomplete → 不派生标准要求 → Proposal Stage 被 Gate 阻止或输出明确缺失项 → 不得请求最终审批。

### 标准适用性

输入“夹链结构 + 食品直接接触 + 塑料复合材料”等已验证事实 → Router 分别评估 `BB/T 0014-2011`、食品接触安全标准和复合膜袋标准 → 保存选择与拒绝理由 → 模型不能增加未选标准。

### 标准版本切换

使用 Fake Clock 在 2027-02-01 前后执行相同适用性输入 → `GB/T 21302-2007` 与 `GB/T 21302-2026` 按有效期切换 → 未完成下游 Artifact 正确标记 stale → 历史 Artifact 保留原标准 Lineage。

### 版本失效

批准 Proposal v1 → 修改已验证数量 Fact → Proposal v1 标记 stale → Approval v1 superseded → 重新生成并审批 v2。

### Crash Recovery

在固定故障点终止 Worker → 新 Worker 重放 Event → 恢复 Stage → 不重复副作用 → 产出相同业务状态。

### 租户边界

使用另一个 `tenantId` 请求读取 Project、Artifact、Event 或 Context → 全部被拒绝并记录脱敏审计事件。

## 10. 完成定义

- 类型检查、Schema 校验、单元和端到端测试通过
- 状态机非法转换、重复投递和五个恢复点均有回归测试
- Approval 绑定 Version，依赖变化能传播 stale
- StandardsRegistry、Router、有效期切换和标准派生 Lineage 测试通过
- Fake Model、Fake Runtime、Fake Tool、Fake Clock、固定 UUID 和内存 Event Store 可离线运行
- Online Runtime 不是常规测试的唯一依据
- Tenant/Workspace 边界和日志脱敏测试通过
- Event、Trace、Token、延迟、重试和恢复指标可查询
- 文档与 Schema 同步
- 没有印刷逻辑进入 Agent Core 或 Enterprise Layer
- Domain Pack 不直接依赖模型 Provider DTO

## 11. 2026-09-01 第一批 Enterprise Kernel 进度

本轮搭建与 React、Model Provider 和 Print Domain 解耦的 M1 业务内核；服务端恢复证据来自文件 Event/Artifact/Agent State Store，不把 Demo `localStorage` 当作业务持久化证据。

已实现：

- `ProposalRunEngine` 的显式 Run/Stage/Approval 状态投影
- append-only `EnterpriseEvent` 信封，显式携带 `tenantId`、`workspaceId`、`runId`、`commandId`、`correlationId`、`actorId` 和聚合版本
- `SolutionProposal` Artifact Version 元数据、输入 Fact Version Lineage、Evaluation Report 引用和 Runtime Execution 引用
- Approval A 精确绑定 Artifact ID 与 Version；错误版本审批被拒绝
- 依赖 Fact Version 变化触发 Artifact `stale`、Approval `superseded` 和 Stage `revision_required`
- 命令幂等去重、乐观并发冲突、跨 Tenant/Workspace 访问拒绝
- 只依赖 Event Stream 重放恢复相同业务状态
- Fake Clock 与固定 Event ID 的离线测试注入点
- 本地原子文件 Event Store：临时文件替换、0600 权限、单写者锁、逐事件 Payload 校验、版本连续性和损坏数据 fail-closed
- Event Store 文档 Schema v2，明确承载可恢复 Fact 数据；不把缺值的旧 v1 事件静默升级为权威事实
- 服务端 Proposal Run 命令/查询 API，所有访问强制 Tenant、Workspace、Actor 和 Bearer Token
- Runtime/Evaluation 完成命令使用独立 Worker Token，普通 Command Token 不能伪造评测通过
- 实际 HTTP 路径贯通 Fact → Worker Runtime/Artifact/Evaluation → Approval A → Worker Stage Gate，并可从同一 Event Store 恢复 `completed / aggregateVersion 9`
- Fact Event 现在持久化值、单位、`suggested | unverified | verified | rejected` 状态与来源，Worker 恢复时不依赖聊天记录
- `SolutionProposal v1` JSON Schema、确定性 fallback 和边界评测：只接受 `suggested` 推荐、当前 Fact Lineage，并拒绝“已验证/生产就绪”等越权声明
- 本地 Artifact 内容 Store：按 Tenant/Workspace/Run/Artifact Version 隔离，原子写入、0600 权限、同版本幂等写与冲突拒绝
- 单 Proposal Worker：从事件投影构建最小 Fact Snapshot，经 `AgentRuntimePort` 执行、保存 Proposal/Evaluation Artifact，并仅在评测通过后请求 Approval A
- 受 Worker Token 保护的 `POST /api/proposal-runs/{runId}/execute-proposal` 服务端入口；调用方不能提交模型输出或伪造 Evaluation 结果
- 已完成 Worker 命令重复投递回归：业务事件已提交后不会再次调用 Runtime
- Runtime Execution Checkpoint v2 复用现有 Artifact Store，保存输入聚合版本、Fact Lineage、Execution ID、Adapter、Resume Handle、ContextSnapshot 引用和结构化输出；Checkpoint 与 Worker Command 精确绑定
- Agent Session 按 Tenant/Workspace/Run/Session 文件持久化并使用 revision 并发控制；每次 Model 前保存不可变 ContextSnapshot，Artifact Version 记录最终 Snapshot 引用
- Worker 持久化边界拆为 Runtime、Artifact、Evaluation/Approval 三个幂等阶段命令，恢复时从最后一个已提交阶段继续
- Approval `approved` 与 `stage.completed` 分离；Worker 必须再次验证已批准 Artifact 仍为当前 `fresh` Version，才能确认 Stage Gate
- 五个固定 Crash Injection 回归均通过，并使用文件 Event/Artifact Store 模拟进程对象重建：StageStarted 后、Runtime 完成后、Artifact 创建后、ApprovalRequested 后、ApprovalResolved 后
- Runtime 完成后的恢复确认不会重复模型调用，Artifact/Approval 不产生重复版本
- `StageJobQueue` Port、内存 Fake 与原子文件 Adapter；Proposal 命令异步入队并以租约领取
- 每个 Worker delivery 只执行一个 Agent execution slice；`paused` 保存 Session continuation、释放租约并调度下一 slice
- 租约过期回收、lease fencing、Failure 退避、连续失败 DLQ 和总 slice 预算
- 后台单 Worker scheduler 与 Tenant/Workspace 隔离的 Job 状态查询 API
- Event 与 Outbox 原子提交、确定性 Job 的 at-least-once Dispatcher，以及 Queue enqueue 后、Outbox ACK 前崩溃重放
- 租约心跳续期、单主机 SQLite Adapter 和 memory/SQLite 多 Worker Contract Test
- Tenant/Workspace 隔离的 Queue 指标、Operator-only DLQ 查询与带 Actor/原因/乐观并发的 redrive
- Web 对话面通过同源服务端编排入口贯通 Conversation 快照 → Proposal Run → 后台 Worker → Artifact Version → Deterministic Evaluation → Approval A → Stage Gate；浏览器不接触 Command/Worker Token
- 通用字段级 Fact 生命周期已接入同源 API 与 Web：候选写入、版本递增、来源/Actor/时间、人工确认或拒绝，以及依赖 Artifact/Approval 的定向失效

当前证据：

```text
offline tests: 132 passed
typecheck and production build: passed
fixed offline Print Eval: passed
protected HTTP command/query smoke: passed
protected async Stage Job HTTP smoke: 202 queued -> background completed -> Run waiting_approval
process restart recovery smoke: passed
real DeepSeek UI smoke: immediate user message -> model reply -> Proposal Artifact v2 -> deterministic evaluation -> Approval A -> Stage passed -> process restart recovery
self-owned Agent Core: no Codex SDK runtime dependency
```

仍未完成：

- StandardsRegistry/StandardsRouter 与权威 Fact 验证流
- Approval/Audit Port 的生产 Adapter 和完整可观测指标
- SQLite/PostgreSQL 等生产数据库 Event Store Adapter 和迁移策略
- Proposal 业务状态、Artifact、Evaluation 与 Approval A 已接入 Web；Queue 指标、DLQ 查询/Redrive 等 Operator 运维 UI 尚未实现
- 读取与拒绝访问的独立脱敏 Audit Store（当前只在写事件中记录 Actor）
- 可重复运行并记录基准数据的 DeepSeek Online Eval；当前已有一次真实浏览器端到端证据，但不替代固定 Fixture
- Artifact Store 的生产对象存储 Adapter、跨进程锁租约和孤儿 Artifact 回收策略
- 独立 `recovery.started/completed` 可观测事件与恢复次数、耗时指标；当前恢复复用相同 Correlation ID 和阶段事件，但还没有独立恢复指标
- Provider 返回成功到本地 Checkpoint 原子写入之间仍存在极小崩溃窗口；请求复用相同 Idempotency Key，但真实 Provider 是否去重仍需 Online Contract 证据或生产事务型 Worker
- Stage Job SQLite Adapter 只覆盖单主机多 Worker；多主机分布式 Queue、生产 Event Store、并发 Dispatcher ownership、Outbox 清理与告警仍未完成
- Agent-managed 会话 Background Task 与有限 Cron 已实现；任意脚本任务、Sub-agent 与 Agent Teams 尚未实现。Sub-agent/Teams 必须先定义独立 Session、目标、权限、预算和聚合 Contract，并用固定 Eval 证明优于单 Agent Baseline

因此该 Print Proposal Domain Slice 仍未完成自己的领域 Gate；这不改变通用 [`M1 Durable Single-Agent Runtime`](milestone-1-durable-runtime.md) 已冻结的状态，也不能据此宣称 Print 产品生产就绪。
