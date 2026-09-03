# Blackx 产品路线图

状态：M1 Frozen / M2 Scope Pending
更新日期：2026-09-03

本文把 [`architecture/principles.md`](architecture/principles.md) 的架构方向转成可执行顺序。路线图以完成证据为准，不以代码量或模型能够演示为准。

## 1. 当前判断

Blackx 已完成 M0 自研 Agent Core，并于 2026-09-03 冻结 M1 Durable Single-Agent Runtime。当前进入 M2 Scope Gate：先确定真实用户任务、最小 Tool、Artifact 和 Evaluator，再继续产品实现。

Print Proposal 已证明 Enterprise Kernel 可以承载一个领域纵向切片，并继续作为 Print Domain Pack 的参考实现和回归资产；它不再定义通用 M1/M2 的产品方向。新的具体产品想法在 M2 Scope Gate 冻结，在此之前不继续扩展包装功能，也不实现 RSI。

近期只解决两个问题：

1. 单 Agent 长任务能否在排队、分片、暂停、重试、崩溃和重复投递后保持唯一、可恢复的业务状态。
2. 现有 Runtime 能否支持一个有真实用户价值、结构化 Artifact 和固定 Eval 的产品闭环。

## 2. 当前产品边界

Agent Core 和 M1 保持行业无关。M2 的最终用户角色、任务、Artifact 和 Tool 集将在新的产品想法明确后冻结；在此之前采用 `Research Task → Evidence-backed Report Artifact` 作为参考 Fixture。

Print 保留为一个可选 Domain Pack。封口袋标准、Proposal、视觉和印前内容不删除，但不再阻塞通用 Runtime 或新产品里程碑。无论采用哪个领域，模型都不能创造权威事实、绕过审批或把生成内容直接标记为生产就绪。

## 3. 采用策略

Blackx 应用层和 Agent Core 采用 TypeScript。Harness 基线是项目自研的最小 Agent Core，通过 `AgentRuntimePort` 与 Enterprise Layer 隔离；不使用 Codex SDK，也不复制外部 Harness 源码。Core 只实现已由固定 Contract/Eval 证明必要的行业无关能力。

Online Eval 使用 API Key。模型能力通过 `AgentModelProvider` 接入，首个 Online Adapter 直接调用 Anthropic Messages compatible endpoint。Blackx 不对外暴露 Anthropic-compatible API，Provider DTO 不进入 Agent Loop 以外的业务层。

执行顺序：

```text
Blackx AgentRuntimePort
→ Self-owned Agent Loop
→ AgentModelProvider
→ Anthropic Messages Adapter
→ 固定 Contract Test 与行业无关 Runtime Eval
→ 识别真实缺口
→ 必要时增加 Port/Hook/Context Provider
→ Core 关键扩展才进入 ADR
```

不得在 Agent Core 中为任何 Workflow、Artifact、审批、领域 Tool 或业务 Prompt 增加条件分支。

## 4. 里程碑

### M0：Blackx Agent Core Baseline

目标：证明自研最小 Core 可以通过稳定 Port 重复执行、留证和恢复，而不是只完成一次模型 Demo。

主要交付物：

- `AgentRuntimePort`、顺序 Loop、观察型 Hook、Context、Skill、摘要 Compact，以及受 Approval/Audit 控制的强类型 Tool
- Session/ContextSnapshot Store Port、内存 Fake 与本地文件 Adapter
- Fake Model、Anthropic Model Provider 和统一错误/Usage/Event 映射
- Session 恢复、并发冲突、中断、超时、ContextSnapshot 和固定包装任务测试
- Baseline 报告与 Core 复杂度准入清单

详细验收见 [`milestone-0-agent-core.md`](milestone-0-agent-core.md)。

### M1：Durable Single-Agent Runtime

目标：证明行业无关的单 Agent 长任务可以排队、分片执行、持久恢复、重试、取消和审计，且业务状态不依赖聊天历史或单次进程。

M1 使用单机持久化、SQLite Queue 和行业无关固定 Fixture。多主机分布式基础设施不是 M1 完成条件。

详细验收见 [`milestone-1-durable-runtime.md`](milestone-1-durable-runtime.md)。原 Print Proposal 实现证据保留在 [`milestone-1-proposal-slice.md`](milestone-1-proposal-slice.md)。

### M2：首个真实产品纵向闭环

目标：确定一个用户、一项真实任务、一组最小 Tool、一个可交付 Artifact 和一个可重复 Evaluator，并从 UI 贯通输入、执行、恢复、确认和交付。

在产品 Scope 冻结前采用 `Research Task → Evidence-backed Report Artifact` 作为参考闭环；固定 10–20 个任务测量完成率、恢复率、证据质量、成本和耗时。

详细验收见 [`milestone-2-product-slice.md`](milestone-2-product-slice.md)。

### M3：Production Hardening

目标：在 M2 证明产品价值后，补全真实 Auth/RBAC、Audit、Secret、备份恢复、迁移、监控和部署能力。

满足多实例、无本地持久盘、故障转移或外部用户数据等升级条件时，通过现有 Port 接入成熟组件：PostgreSQL 保存权威元数据，S3-compatible Store 保存 Artifact，成熟 Queue 或 PostgreSQL Job Table 调度 Worker。不得自研分布式数据库或共识协议。

### M4：受控 RSI 实验

目标：允许上层 RSI Controller 提议候选改动，但只能在隔离环境中执行固定 Eval，并经过审批、Canary 和可回滚发布。

RSI 不得修改自己的权限、安全策略、预算、审批要求或基准 Eval；在 M2、M3 未完成前不进入实现。

## 5. 近期执行队列

只把 M1 和 M2 Scope Gate 放入近期队列：

| 顺序 | 工作包 | 产出 | 完成证据 |
| --- | --- | --- | --- |
| 1 | 收口当前 Fact 变更 | 字段级来源、版本、确认/拒绝、依赖失效 | 类型、测试、构建与浏览器回归通过 |
| 2 | 行业无关 Runtime Fixture | Research Task → Evidence Report | 正常、重复投递、Compact 和 Crash 回归通过 |
| 3 | 恢复可观测 | recovery event、次数、耗时和关联 Trace | 查询接口和固定回归通过 |
| 4 | Online Baseline | 可重复保存的 DeepSeek Contract/Eval | 同一 Fixture、模型和预算可比较 |
| 5 | M2 Scope Gate | 用户、任务、输入、Tool、Fact、Artifact、Evaluator、非目标 | 一份产品负责人确认的 Scope 文档 |
| 6 | M2 纵向切片 | UI → Runtime → Tool → Artifact → Eval → Approval/Delivery | 10–20 个固定 Eval 和真实浏览器验收 |

任何工作包若没有完成证据，不得仅以“已有界面”或“模型跑通”标记完成。

## 6. 暂缓事项

以下内容在 M2 证明单 Agent 产品闭环前不进入实现队列：

- 多 Provider 路由与外部 Harness Fork
- 多 Agent 和 Reviewer Agent
- 通用插件市场
- 多主机分布式 Queue 和自研分布式存储
- 自动发布高风险外部副作用
- 高级上下文压缩、模型路由和并行优化
- RSI、自我修改和自动发布候选代码

## 7. 关键决策点

已确认：

1. Blackx 应用层采用 TypeScript。
2. M0 Harness 基线为 Blackx 自研最小 Agent Core，不采用 Codex SDK。
3. Online Runtime 使用 API Key，并支持 Anthropic Messages 协议兼容路径。
4. M1/M2 采用行业无关 Runtime 和首个真实产品闭环；Print 保留为 Domain Pack 和回归资产。
5. RSI 位于 Harness 上层，必须晚于稳定产品 Baseline 和生产控制面。

仍需确认：

1. M2 的首个用户、任务、输入样例、最小 Tool、Artifact 和完成 Evaluator。
2. Node.js、包管理器和构建系统的固定版本。
3. M3 的 PostgreSQL、对象存储与 Queue 组合；M1/M2 默认不提前选择。
4. DeepSeek Online Eval 的固定模型、预算和基准保存格式。

技术栈、持久化和部署选择一旦影响 P1 分层或形成长期锁定，应新增 ADR；普通可逆实现选择记录在对应里程碑 Decision Log。

## 8. 风险与退出条件

| 风险 | 近期控制 | 退出/升级条件 |
| --- | --- | --- |
| 自研 Core 对长任务支撑不足 | 固定 Runtime Contract、行业无关 Eval 与 Crash 回归 | 达不到门槛时保留 Port，替换具体 Core 或模型，不污染产品层 |
| Agent Session 被误当作 Workflow 状态 | Run/Stage/Event 独立持久化 | 恢复测试无法仅靠业务事件完成时停止 M1 |
| 模型创造产品事实 | Fact 状态与来源校验 | 未验证事实进入已审批交付物即阻断 Stage |
| 过早扩展 Core | Provider-first Gate 与 Ponytail/YAGNI Review | 只有可复现的行业无关缺口和固定 Eval 收益才允许 ADR |
| Anthropic 协议差异 | 独立 Provider Adapter 与 Contract Test | 关键 Tool/Usage 语义无法保真时停止接入并评估替代 Provider |
| 先建分布式平台、没有产品闭环 | M1 单机持久化，M2 先验证用户价值 | 没有多主机或容量证据时停止基础设施扩张 |
| RSI 优化自身评分而非真实能力 | 固定不可变 Eval、隔离执行、人工审批和回滚 | M2/M3 未完成或无 Baseline 时禁止启用 RSI |

## 9. 路线图更新规则

- 每个里程碑完成时更新状态、证据链接、未解决风险和实际成本。
- 新复杂度必须附 Baseline 对比或明确的合规/可靠性必要性。
- 需求改变首个品类、审批责任、发布权限或生产边界时，先更新路线图和相关 ADR，再进入实现。

## 10. 协议参考

Anthropic Messages 的具体版本、Tool、认证和错误语义以目标 Provider 的官方协议文档为准；接入时必须固定版本并保存 Online Contract 证据。外部 Harness 只用于行为与失败场景研究，不进入生产源码。
