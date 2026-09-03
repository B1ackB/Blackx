# Blackx 产品路线图

状态：Draft
更新日期：2026-09-01

本文把 [`architecture/principles.md`](architecture/principles.md) 的架构方向转成可执行顺序。路线图以完成证据为准，不以代码量或模型能够演示为准。

## 1. 当前判断

Blackx 已明确产品边界、分层原则和首个包装印刷闭环，并已建立自研 Agent Core、Fake/Anthropic Model Provider、本地持久化 Session/ContextSnapshot、Web Demo、首批 Enterprise Kernel、本地 Event/Artifact Store、受控命令 API 和单 Proposal Worker。当前仍不是扩展功能阶段：真实 Provider Online 证据、生产数据库、Standards Router、Web 新链路接入和生产级 Crash Recovery 尚未完成，近期继续验证关键技术假设并贯通第一条可恢复纵向切片。

近期只解决两个问题：

1. 自研 Agent Core 能否以最小 Loop、Hook、Context、Skill、Compact 和 State Store 稳定支撑阶段内执行。
2. Blackx 能否用自己的 Event、Fact、Artifact、Approval 和状态机完成一个可恢复的包装方案阶段。

## 2. 已确认首个产品边界

首个包装品类为封口袋。行业标准是技术要求和试验方法的优先权威来源；系统通过确定性 Standards Registry/Router 按用途、接触类型、结构和加工条件选择适用标准。客户项目事实和工厂生产设定仍需权威输入或验证，不由模型或路线图自动推定，但产品采用最少提问模式：先从 Brief、附件、历史项目和企业系统提取，再只请求用户确认无法可靠推断且会改变结果的事实。详细规则见 [`product-interaction-model.md`](product-interaction-model.md)、[`project-decisions.md`](project-decisions.md) 和 [`sealing-bag-standards.md`](sealing-bag-standards.md)。

首个用户角色：印刷企业的售前方案人员或项目经理。
首个业务目标：把客户需求转换为一份结构化、可追溯、可审批的包装印刷方案，并逐步扩展到视觉、印前与交付。
第一阶段不包含：自动报价承诺、自动生成权威刀模或生产版式模板、直接提交生产、无人审批发布、多行业平台和多 Agent Swarm。

## 3. 采用策略

Blackx 应用层和 Agent Core 采用 TypeScript。Harness 基线是项目自研的最小 Agent Core，通过 `AgentRuntimePort` 与 Enterprise Layer 隔离；不使用 Codex SDK，也不复制外部 Harness 源码。Core 只实现已由固定 Contract/Eval 证明必要的行业无关能力。

Online Eval 使用 API Key。模型能力通过 `AgentModelProvider` 接入，首个 Online Adapter 直接调用 Anthropic Messages compatible endpoint。Blackx 不对外暴露 Anthropic-compatible API，Provider DTO 不进入 Agent Loop 以外的业务层。

执行顺序：

```text
Blackx AgentRuntimePort
→ Self-owned Agent Loop
→ AgentModelProvider
→ Anthropic Messages Adapter
→ 固定 Contract Test 与 Print Eval
→ 识别真实缺口
→ 必要时增加 Port/Hook/Context Provider
→ Core 关键扩展才进入 ADR
```

不得在 M0 或 M1 为 Workflow、Artifact、审批、印刷 Tool 或业务 Prompt 增加 Agent Core 行业分支。

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

### M1：可恢复 Proposal 纵向切片

目标：从结构化 Intake 贯通到 `SolutionProposal` 和 Approval A，证明业务状态不依赖 Agent Session 或聊天记录。

```text
Intake API
→ Verified Applicability Facts
→ StandardsRouter / ApplicableStandardsProfile
→ Standard-derived + Project Facts
→ RunEngine: Proposal Stage
→ AgentRuntimePort
→ SolutionProposal Artifact Version
→ Deterministic Evaluation
→ Approval A
→ Event Store / Resume
```

详细验收见 [`milestone-1-proposal-slice.md`](milestone-1-proposal-slice.md)。

### M2：Creative Artifact 切片

目标：在已审批方案上生成可版本化的文案、视觉方向、包装背景视觉和 Mockup。

关键 Gate：

- 生成内容只能消费已确认事实和 Approval A 绑定版本
- Logo、条码、法定文字保留为确定性图层或占位，不进入生成图
- 每次生成记录模型、Prompt/配置、输入 Artifact 和人工选择结果
- 视觉 Artifact 可重试、可比较，旧版本不被覆盖

### M3：确定性 Layout 与 Preflight

目标：基于人工或权威系统提供并验证的生产版式模板生成印前候选文件，输出机器可读 Preflight Report，并完成有限 Repair Loop。

关键 Gate：

- AI 不生成权威刀模或生产版式模板，不宣称生产精度
- Layout、出血、字体、条码、色彩、专色和 PDF/X 由确定性工具处理
- 每个问题有严重度、位置、规则、证据和可修复性
- 自动修复有次数上限；不可修复项转人工

### M4：首个完整闭环

目标：完成 Proposal Webpage、Approval B 和受控 Delivery，演示一次可验证的 Worker Crash Recovery。

闭环完成证据：

- 一个项目从 Intake 到 Delivery 的完整 Event Timeline
- 两个 Approval 均绑定具体 Artifact Version
- 上游 Fact 变更后下游正确标记 `stale`，旧审批失效
- Worker 在指定故障点中断后从 Event/Checkpoint/Artifact 恢复
- 发布和交付为审批后、带幂等键和审计记录的受控动作

### M5：企业化加固

目标：在首个闭环已稳定后补全 Tenant、RBAC、审计、对象存储、队列、可观测性和企业系统 Adapter。

M5 之前仍要在模型上下文、资源所有权和测试数据中保留 `tenantId` / `workspaceId` 边界；不得先用跨租户全局对象实现再计划重构。

## 5. 近期执行队列

只把 M0 和 M1 放入近期队列：

| 顺序 | 工作包 | 产出 | 完成证据 |
| --- | --- | --- | --- |
| 1 | 产品范围确认 | 首个品类、用户、自然语言输入样例、最少提问边界、非目标 | 一份已确认的 Scope 文档 |
| 2 | Core 基线 | 自研边界、依赖与供应链记录 | 可重建的依赖锁定与清单 |
| 3 | Runtime 契约 | Port 类型、事件、终止原因、错误分类 | Fake Runtime Contract Test |
| 4 | Provider Spike | Anthropic Adapter 与能力探针 | 同一 Fixture 可重复运行 |
| 5 | Runtime Eval | 固定包装任务和评分规则 | Baseline 报告，不只保存最终回答 |
| 6 | 标准与行业数据权威 | StandardsRegistry/Router、Domain Port、标准版本与设备/材料 Fake Fixture | 有效期、适用范围、来源和版本切换测试 |
| 7 | 业务 Schema | Project/Run/Stage/Fact/Artifact/Approval/Event | Schema 校验与非法状态测试 |
| 8 | Event Store | 追加事件、并发版本、重放 | Crash/Replay 离线测试 |
| 9 | Proposal Slice | Intake 到 Proposal Artifact | 端到端测试通过 |
| 10 | Approval A | 绑定 Artifact Version 的审批 | 版本变化后审批失效测试 |
| 11 | Recovery Demo | 固定故障点暂停与恢复 | 恢复后无重复副作用且结果可追溯 |

任何工作包若没有完成证据，不得仅以“已有界面”或“模型跑通”标记完成。

## 6. 暂缓事项

以下内容在 M1 通过前不进入实现队列：

- 多 Provider 路由与外部 Harness Fork
- 多 Agent 和 Reviewer Agent
- 通用插件市场或多行业 Domain Pack
- 复杂自动报价、JDF 或设备控制
- 自动发布客户网页或提交生产
- 高级上下文压缩、模型路由和并行优化
- 完整视觉编辑器和大规模素材管理

## 7. 关键决策点

已确认：

1. 首个包装品类为封口袋。
2. Blackx 应用层采用 TypeScript。
3. M0 Harness 基线为 Blackx 自研最小 Agent Core，不采用 Codex SDK。
4. Online Runtime 使用 API Key，并支持 Anthropic Messages 协议兼容路径。
5. Blackx 定位为包装行业版 Codex：用户表达意图并确认关键事实，系统负责行业调查和工具执行；包装能力不进入 Harness Core。

仍需确认：

1. 首个验收 Fixture 的用途、内容物、接触类型、加工条件和目标市场；StandardsRouter 据此确定袋型/封口相关标准候选。
2. Node.js、包管理器和构建系统的固定版本。
3. M1 的生产数据库、对象存储与队列 Adapter；核心测试继续保留内存 Fake，本地文件 Adapter 不冒充生产候选。
4. Proposal 的权威字段、建议字段和人工确认责任人。
5. Anthropic Messages 上游模型端点及 Online Eval 模型/预算。

技术栈、持久化和部署选择一旦影响 P1 分层或形成长期锁定，应新增 ADR；普通可逆实现选择记录在对应里程碑 Decision Log。

## 8. 风险与退出条件

| 风险 | 近期控制 | 退出/升级条件 |
| --- | --- | --- |
| 自研 Core 对长任务支撑不足 | 固定 Runtime Contract、Print Eval 与 Crash 回归 | 达不到门槛时保留 Port，替换具体 Core 或模型，不污染 Domain |
| Agent Session 被误当作 Workflow 状态 | Run/Stage/Event 独立持久化 | 恢复测试无法仅靠业务事件完成时停止 M1 |
| 模型创造产品事实 | Fact 状态与来源校验 | 未验证事实进入已审批交付物即阻断 Stage |
| 标准被错误套用或版本过期 | StandardsRouter、有效期和条款 Lineage | 适用性输入不完整或标准失效时阻断派生 |
| 过早扩展 Core | Provider-first Gate 与 Ponytail/YAGNI Review | 只有可复现的行业无关缺口和固定 Eval 收益才允许 ADR |
| Anthropic 协议差异 | 独立 Provider Adapter 与 Contract Test | 关键 Tool/Usage 语义无法保真时停止接入并评估替代 Provider |
| 先建平台、没有业务闭环 | 只排 M0/M1 近期队列 | 不产生可审批 Proposal Artifact 的抽象工作暂停 |
| 印刷精度被生成模型承担 | 权威生产版式模板与确定性 Tool | M3 前不宣称生产就绪 |

## 9. 路线图更新规则

- 每个里程碑完成时更新状态、证据链接、未解决风险和实际成本。
- 新复杂度必须附 Baseline 对比或明确的合规/可靠性必要性。
- 需求改变首个品类、审批责任、发布权限或生产边界时，先更新路线图和相关 ADR，再进入实现。

## 10. 协议参考

Anthropic Messages 的具体版本、Tool、认证和错误语义以目标 Provider 的官方协议文档为准；接入时必须固定版本并保存 Online Contract 证据。外部 Harness 只用于行为与失败场景研究，不进入生产源码。
