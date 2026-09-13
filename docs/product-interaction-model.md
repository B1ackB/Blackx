# Packx 产品交互与信息责任模型

状态：Print Domain Reference / M2 Shared Interaction Accepted
更新日期：2026-09-04

## 1. 产品定位

Packx 当前是以自研 Agent Core 驱动的包装需求与交付物 Agent。M2 面向包装企业的售前/跟单人员，生成带来源与版本的 Requirement Brief。页面直接进入包装任务，不再选择行业；本文件后续包装字段作为 Print Domain Pack 的详细参考，继续遵守来源、人工确认和最少提问原则。

用户表达业务目标、上传已有资料并确认关键约束；Packx 使用包装行业知识、权威标准、企业数据和确定性工具完成调查、提出方案、解释风险并生成可追溯 Artifact。Packx Agent Core 负责通用 Agent Loop、Session、模型调用、Hook、Tool、Context、Skill 和 Compact，不承载包装行业条件分支。

产品承诺是：**用户负责意图与最终确认，Packx 负责行业化调查、推理、工具执行和证据组织。**

## 2. “需要项目输入”不等于“要求用户逐字段手填”

项目事实必须有权威来源，但来源可以是：

- 用户在自然语言 Brief、邮件、附件、图片或历史项目中表达的信息
- 已授权的 CRM、ERP、MIS、PIM、MES、供应商目录或材料数据库
- 设备能力档案、已验证历史工单、实验室报告和试产结果
- 受权人员对 Packx 提取结果的确认

Packx 应先提取候选 Fact、标注来源和置信度，再查询已有数据，只对仍会阻断方案或显著改变结果的缺失项提问。不得因为底层 Schema 需要结构化字段，就把同样复杂度转嫁给终端用户。

## 3. 信息责任分层

| 层级 | 典型信息 | 默认责任 | Fact 状态 |
| --- | --- | --- | --- |
| 用户意图与不可推断约束 | 内容物、用途、目标保质期、容量/成品尺寸、数量、目标市场、预算、交期、品牌要求 | 用户表达或确认；Packx 可从资料中提取 | 提取后先 `unverified`，确认后 `verified` |
| 系统检索的权威事实 | 当前适用标准、法规要求、现有 SKU、材料 TDS、供应商能力、工厂设备能力、历史验证结果 | 对应权威 Adapter/Registry 提供 | 来源、版本和适用范围通过校验后可 `verified` |
| 工程建议 | 袋型、封口方式、候选材料结构、阻隔指标、测试计划、候选工艺窗口 | Print Domain Pack、Agent 与确定性工具联合产生 | 默认 `suggested`；不能自动升级为生产事实 |
| 生产验证事实 | 具体材料牌号/批次、热封温度、压力、停留时间、线速、张力和最终生产配方 | 工厂、供应商数据、MES/工艺库、试产或专业人员确认 | 有验证证据后才可 `verified` |

内容物、目标保质期、尺寸和数量通常属于用户意图，但用户可以只用一句话描述，或上传已有文件，由 Packx 提取并请求一次确认。工厂温度、压力和线速通常不应要求品牌客户提供，也不应由模型猜测；应从工厂侧权威数据与验证流程获得。

## 4. 最少提问交互循环

```text
自然语言 Brief / 附件 / 历史项目
→ Intake Extractor 生成带来源的候选 Fact
→ StandardsRouter 与企业 Adapter 自动补齐可查询事实
→ Missing-Fact Policy 判断哪些缺失会阻断当前阶段
→ 只询问不可推断的关键问题
→ 生成带假设、证据和风险的 SolutionProposal
→ 用户或专业人员审批具体 Artifact Version
```

提问优先级：

1. 安全、法规、食品接触和目标市场等不能猜测的事实。
2. 会改变袋型、材料结构、阻隔目标或成本级别的事实。
3. 当前阶段完成证据所必需的事实。
4. 可由系统查询、计算或在后续阶段确认的内容不提前打断用户。

系统可以输出多个带条件的方案，例如“若目标保质期为 12 个月，则需要完成相应阻隔验证；若为 3 个月，可评估更简单结构”，但必须显式保留假设，不得把条件方案冒充已验证结论。

## 5. 能力放置位置

### Packx Agent Core

- Agent Loop、Session/Turn、Hook、Context、Skill、Compact 和 Runtime 事件
- 模型调用、Tool Call、Sandbox 和 MCP 等通用 Harness 能力
- 不加入封口袋、材料、标准、设备或审批业务分支

### Packx Enterprise Layer

- Run/Stage、Artifact、Fact、Approval、Evaluation 和 Event Store
- ContextEngine、租户、权限、审计、幂等、恢复和 Secret 管理
- 只表达通用的权威性、状态和流程规则，不包含印刷公式

### Packx Print Domain Pack

- 包装 Brief Schema、缺失事实策略和行业化 Skill
- StandardsRegistry/Router、Material/Barrier/Seal Evaluator
- 材料、供应商、设备、历史工单、实验室和 Preflight Port
- 袋型、材料结构、测试计划和工艺窗口的候选生成与确定性校验

这意味着包装能力应“连接到 Harness 的 Tool/Skill/Context 边界”，而不是“写进 Harness Core”。若某家企业没有 MES 或材料目录连接器，系统降级为请求工厂/供应商上传数据或人工确认，而不是生成一个看似专业的默认值。

## 6. 首批 Domain Port

M1 优先定义稳定接口和 Fake，真实连接器按客户环境逐步接入：

- `StandardsRegistryPort`：标准版本、条款、有效期和适用范围
- `MaterialCatalogPort`：材料牌号、结构、TDS 与合规证据
- `SupplierCapabilityPort`：供应商可供材料、尺寸和加工能力
- `EquipmentCapabilityPort`：设备范围、已验证工艺窗口和限制
- `HistoricalJobPort`：相似已批准工单与验证结果
- `LabEvidencePort`：阻隔、热合、密封和迁移等测试证据

Port 返回的数据必须携带来源、版本、时间、租户和适用条件；Print Domain Pack 不直接依赖某个厂商的 ERP/MES 类型。

## 7. 示例体验

用户可以只说：

> 为中国市场的 250g 咖啡豆做一款可重复封口袋，目标保质期 12 个月，首单 1 万个，品牌稿件稍后提供。

Packx 应自动完成：提取并请求确认关键事实、查询适用标准与企业材料/设备能力、提出候选袋型和材料结构、列出必须验证的阻隔与密封证据，并生成版本化方案。它只在缺少例如灌装方式、目标尺寸或工厂能力且这些事实确实会改变方案时追问。

Packx 不应要求用户预先填写热封温度、压力和线速；在进入生产验证前，再从工厂工艺库、材料供应商数据和试产结果中确定这些值。
