# Blackx 开发优先级约束

本文件约束所有在本仓库中工作的开发者和 Coding Agent。开始设计、实现、重构或评审前必须先阅读本文件。

Blackx 的产品目标是以自研 Agent Core 构建面向企业的多模态长任务 Agent 产品：

- `Blackx Agent Core` 提供 Agent Loop、Model Provider、Hook、Tool、Session、Context、Skill 与 Compact 等行业无关能力。
- `Blackx Enterprise Layer` 提供 Durable Workflow、Artifact、Approval、Evaluation、Policy、Event Store、Tenant 与 Audit 等企业能力。
- `Blackx Print` 是第一个印刷行业 Domain Pack，负责印刷方案、包装视觉、印前文件和质量检查。

Blackx 自研最小 Agent Core，但不重复实现模型 Provider、存储和平台已经可靠提供的通用能力。Core 保持行业无关，印刷规则只能通过 Enterprise Layer 与 Domain Pack 接入。

详细原则见 [`docs/architecture/principles.md`](docs/architecture/principles.md)。

## 约束优先级

发生冲突时按以下顺序执行：

1. **P0：安全、事实、数据与不可逆操作约束**
2. **P1：产品与核心架构约束**
3. **P2：可靠性、测试与可观测性约束**
4. **P3：扩展性、体验与性能优化约束**

低优先级规则不得覆盖高优先级规则。P0 不得通过普通实现决策绕过；P1 例外必须新增 Architecture Decision Record（ADR），说明原因、范围、风险和退出方案。

## P0：不可违反

### P0.1 权威事实不得由模型创造

- 产品尺寸、材料、数量、价格、认证、刀模版本、出血、印刷工艺、色彩配置、条码和法定信息必须来自权威数据源或人工确认。
- 模型建议必须保持 `suggested` 或 `unverified` 状态，经过明确确认后才能成为 `verified`。
- 权威事实、品牌硬规则、审批结论和安全策略不得由摘要模型重写。

### P0.2 危险和不可逆操作必须受控

- 发布网页、发送客户、删除素材、覆盖已批准交付物、修改权威事实、提交生产和高额消费操作默认需要审批。
- 模型输出不构成权限或审批。
- 所有外部副作用必须具有幂等键和完整审计记录。

### P0.3 企业数据必须隔离

- 企业资源必须具有明确的 `tenantId`、`workspaceId` 和所有权。
- 数据库、对象存储、缓存、检索、日志、Secret 和模型上下文必须遵守同一租户边界。
- 外部网页、PDF、文档和知识库内容默认不可信，不得改变权限和系统策略。
- Secret 不得进入 Prompt、Artifact、普通日志或模型响应。

### P0.4 印刷生产精度不得交给生成模型保证

- AI 可负责创意、方案、文案、视觉概念和评价。
- 尺寸、刀模、文字、Logo、条码、出血、PDF/X、ICC Profile、字体、专色与 Preflight 必须由确定性工具处理和验证。
- AI 生成图片不得直接标记为生产就绪印刷文件。
- 第一阶段不允许模型生成权威生产刀模。

### P0.5 参考代码必须保持来源合规

- 外部 Harness 仓库只作为行为、测试和失败场景参考；不得成为未审计的生产源码来源。
- 引入 SDK、CLI、协议库或源码前必须固定版本、记录许可证，并进入依赖清单和供应链审计。
- `temp/claude-code-best/` 仅用于架构学习、行为参考和失败场景研究。
- 禁止直接复制、改写后复制或以其逆向/反编译源码作为 Blackx 的生产实现基础。
- 从外部 Harness 获取的设计启发必须采用 clean-room 方式独立实现。
- 引入依赖前必须确认许可证、来源、商业使用限制和数据政策。

## P1：核心架构约束

### P1.1 Artifact-first

- 业务状态以 `Project`、`Run`、`Stage`、`Fact`、`Artifact`、`ArtifactVersion`、`Approval`、`Evaluation`、`Event` 和 `ContextSnapshot` 为中心。
- 聊天记录只表示交互和执行轨迹，不得作为唯一业务状态或交付物存储。
- 所有重要输出必须形成结构化、版本化、可追溯的 Artifact。

### P1.2 Agent Core、Enterprise Layer 与 Domain Pack 严格分离

- Blackx Agent Core 只提供行业无关的 Harness 能力；不得出现 Blackx Workflow、Artifact 或租户业务规则。
- Blackx Enterprise Layer 不得出现 PDF/X、刀模、印刷工艺、ICC Profile、印刷报价公式等行业逻辑。
- Print Domain Pack 通过公开的 Domain SDK 注册 Schema、Workflow、Tool、Skill、Evaluator、Policy 和 Artifact Type。
- 新行业不得通过修改 Agent Core 或 Enterprise Layer 中的印刷条件分支接入。

### P1.3 Workflow 控制业务，Agent 控制阶段内执行

- 程序决定阶段顺序、必填输入、预算、工具范围、审批点、质量门槛、最大重试和发布权限。
- Agent 只在阶段边界内自主选择分析、探索、创意和工具调用方式。
- Agent 不得自行跳过审批、Preflight、安全规则、预算限制或完成证据。

### P1.4 RunEngine 与 Agent Runtime 分离

- `RunEngine` 负责项目、阶段、审批、恢复、预算和完成判定。
- Agent Runtime 负责一次阶段执行中的 Session、Turn、模型与工具循环。
- Agent Session 的开始、继续或恢复不得直接等价为 Run 或 Stage 状态转换。
- Blackx 必须通过 `AgentRuntimePort` 调用自研 Core；Domain Pack 不得直接依赖模型厂商消息类型。
- Context、Tool、Workflow、Artifact、Approval、Evaluation 与 Event Store 必须保持独立职责。
- 禁止继续构造承担所有职责的超大 `QueryEngine` 或全局上下文对象。

### P1.5 外部能力必须通过 Port/Adapter

- Agent Runtime、模型、图片、浏览器、PDF、存储、队列、可观测性和企业系统必须通过稳定接口接入。
- Domain 与 Blackx Enterprise Layer 不得直接依赖某个模型厂商的消息类型。
- 每个外部 Port 必须存在可用于离线测试的 Fake 实现。

### P1.6 显式状态机与事件

- Run、Stage、Approval、Artifact 和 Tool Execution 必须使用显式有限状态机。
- 不得使用松散布尔值组合表达关键状态。
- 状态转换必须通过事件持久化，并拒绝非法转换。
- 模型结束一轮不等于 Stage 或 Run 完成；完成必须有程序可验证的证据。

### P1.7 上下文必须通过 ContextEngine 构建

- 模型调用不得直接传入全部历史消息。
- ContextEngine 必须区分稳定策略、权威事实、阶段状态、Artifact 索引、工作记忆和工具结果。
- 上下文处理顺序为：外置大内容 → 清理旧工具结果 → 淘汰过期信息 → Stage Snapshot → 保留近期内容 → 必要时摘要压缩。
- 每次压缩必须可追溯、可评测，并记录压缩前后成本与保留内容。

### P1.8 Artifact 版本和依赖不可省略

- Artifact Version 不得原地覆盖。
- Approval 必须绑定具体 Artifact Version；版本变化后旧审批失效。
- Artifact 必须记录来源事实、来源 Artifact、模型、工具和生成时间。
- 上游事实或 Artifact 变化后，下游依赖必须被标记为 `stale` 并重新验证。

### P1.9 最小自研 Core 与 Provider-first

Agent Core 能力扩展必须按以下顺序评估：

1. 删除需求或使用现有标准库。
2. 配置、Instructions、Skill 或 Tool。
3. Blackx Port/Adapter、Hook、Context Provider 或 Tool Policy。
4. 固定版本的外部 Provider/协议能力。
5. 带 ADR 的通用 Agent Core 扩展。

- 不得仅为某个印刷品类增加 Agent Core 条件分支。
- Hook 默认只观察，不得静默修改权威事实、权限、审批或 Tool 结果。
- Skill 只提供阶段内指令，不拥有 Workflow 状态转换或权限。
- 新的 Loop、Compact、多 Agent、并行和自动修复策略必须通过固定 Eval 证明收益。

## P2：工程质量约束

### P2.1 长任务必须可恢复

- 所有长任务必须支持取消、暂停、恢复、重试、重放、超时和 Worker Crash Recovery。
- 恢复依赖 Event Store、Checkpoint 和 Artifact，不依赖模型记忆。
- 昂贵或有副作用的工具必须在重试和重复投递下保持幂等。

### P2.2 Tool 必须强类型且受策略控制

每个 Tool 必须定义：

- 输入与输出 Schema
- 风险等级
- 只读/写入/发布属性
- 幂等性
- 并发属性
- 超时和重试策略
- 最大结果大小
- 权限和审批策略

生产 Runtime 不得依赖一个无边界的 Shell Tool 完成主要业务能力。

### P2.3 失败必须分类

- 不得静默吞错或用普通字符串承载关键失败。
- 至少区分模型、限流、结构化输出、Tool 校验、Tool 执行、权限、超时、上下文、预算、评测、审批和基础设施错误。
- 每类失败必须说明是否可重试、是否可降级、是否需要人工介入以及是否可能重复副作用。

### P2.4 离线测试优先

- 核心逻辑必须能使用 Fake Agent Runtime、Fake Model、Fake Tool、Fake Clock、固定 UUID 和内存 Event Store 离线测试。
- 单元测试不得依赖真实模型网络请求。
- 真实模型测试必须放入独立 Online Eval，不得成为常规测试唯一依据。
- Agent Core 与 Provider Adapter 变更必须通过 Runtime Contract Test、恢复测试、权限测试和固定 Harness Eval。

### P2.5 修复必须沉淀为回归资产

重要缺陷修复至少增加一种长期资产：

- 单元测试
- 集成测试
- Eval Fixture
- Schema 或 Tool Validation
- Policy
- 监控规则
- 架构文档

只修改 Prompt 而不增加回归证据，不能视为完整修复。

### P2.6 默认可观测

- Run、Stage、Agent Turn、Model Call、Tool Call、Evaluation 和 Approval 必须具备关联 ID。
- 记录 Token、成本、缓存、延迟、重试、压缩、Artifact 和恢复指标。
- 日志默认脱敏，禁止记录 Secret 和跨租户敏感内容。

### P2.7 完成定义

功能只有同时满足以下条件才算完成：

- 类型检查通过
- 相关单元和集成测试通过
- 失败路径已处理
- 恢复与幂等行为已考虑
- 权限与租户边界已考虑
- 可观测事件已添加
- 文档或 Schema 已同步
- 没有未说明的模型、厂商或行业耦合

## P3：演进约束

### P3.1 采用纵向切片

- 优先贯通 UI → API → Workflow → Agent → Tool → Artifact → Evaluation → Persistence。
- 不先建设长期没有业务闭环的通用框架。

### P3.2 先单 Agent，后多 Agent

- 在单 Agent Baseline 建立前不引入 Agent Swarm。
- 只有当子任务独立、可以结构化聚合、冲突可处理且评测证明收益时才拆分多 Agent。
- 业务角色不自动等于独立 Agent。

### P3.3 没有评测，不增加复杂度

- 多 Agent、新压缩策略、新模型路由、Reviewer、并行和自动修复必须与固定 Baseline 对比。
- Harness 对比必须尽量保持同模型、同任务和同预算。
- LLM Judge 不得作为印刷生产正确性的唯一证据。

### P3.4 首个闭环优先

在第一个包装印刷闭环稳定前，不优先扩展视频、插件市场、复杂 JDF、多行业、自动生产和通用 Agent 平台。

首个闭环目标：

```text
一个包装品类
→ 一套结构化印刷方案
→ 一组包装视觉与 Mockup
→ 一个基于权威刀模的印刷 PDF
→ 一份 Preflight 报告
→ 一个客户提案网页
→ 两个明确审批点
→ 一次可验证的中断恢复
```

## 开发任务执行顺序

每次实现或修改功能时依次执行：

1. 判断能力属于 Agent Core、Blackx Enterprise Layer 还是 Domain Pack。
2. 明确业务问题、输入、输出和完成证据。
3. 按 P1.9 选择最小 Core、配置、Skill、Hook 或 Adapter 落点。
4. 检查权威 Schema、状态机和依赖关系。
5. 设计事件、失败分类、幂等键和权限。
6. 实现最小纵向闭环。
7. 添加离线测试和回归 Fixture。
8. 验证类型、测试、恢复、租户边界和可观测性。
9. 检查上下文膨胀与 Artifact 可追溯性。
10. 最后才增加抽象、并行化、自动修复或 Agent 数量。

## 规则冲突与 ADR

当实现需求与本文件冲突时：

- 不得静默绕过规则。
- 必须指出冲突的规则编号和风险。
- P1 例外和 Agent Core 关键边界变化必须在 `docs/adr/` 新增 ADR，包含背景、决定、替代方案、影响、迁移策略和退出条件。
- 临时例外必须有到期条件和恢复计划。
