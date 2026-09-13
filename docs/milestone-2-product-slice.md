# M2：包装需求澄清与审批闭环

当前范围以 [ADR-0010](adr/0010-packaging-product-focus.md) 为准：仅包装行业。下文真实模型和合成验证的历史记录保留原始范围，不作为包装真实用户验证。

状态：Engineering Baseline Frozen / Synthetic Validation Passed / Real User Validation Not Performed
更新日期：2026-09-05
前置条件：M1 Durable Single-Agent Runtime 完成

## 1. 用户与问题

首个目标用户是包装企业的售前或跟单人员。他们每天需要把客户在聊天、邮件和附件中的零散描述转成可交给包装工程、设计或报价人员继续处理的需求单。

当前损失不是“不会生成漂亮方案”，而是：

- 需求散落在对话和文件中，来源与确认状态不清楚
- 尺寸、数量、交期、交付地点等关键字段遗漏后才被发现
- 销售口头确认和工程输入版本不一致
- 需求变化后，旧方案、报价或审批仍可能被继续使用

M2 首个高频任务冻结为：

> 从客户 Brief 和已授权资料中整理字段级需求，指出阻断项，只追问必要问题，并生成一个可确认、可版本化、可审批的 Requirement Brief。

## 2. 产品闭环

```text
售前创建需求任务并输入客户 Brief
→ Source Tool 读取对话或附件
→ Agent 只提出带来源的候选 Fact
→ 用户确认或拒绝关键 Fact
→ Worker 生成 RequirementBrief Artifact Version
→ Deterministic Evaluator 检查 Schema、必填缺口、来源与权威边界
→ 只有 approvalEligible 的 Artifact Version 可以请求 Approval
→ 用户批准具体版本
→ 形成可交给工程、设计或报价阶段的已冻结需求单
```

包装业务复用 Enterprise Workflow 和 `requirement-brief.v1` Contract。包装必填字段、Skill 和 Evaluator 规则由 Print Domain Pack 提供，不进入 Agent Core；家具工作流已退出当前产品范围。

## 3. 输入、Fact 与 Artifact

M2 支持自然语言客户 Brief 与会话附件。附件通过租户、Workspace、Conversation 三层隔离的文件 Adapter 持久化，上传请求具有幂等 ID；纯文本、Markdown、CSV 和 JSON 内容会作为 `source_document/unverified` 来源进入下一次 Requirement Brief。用户可以为下一条会话消息选择最多 8 张 PNG、JPEG、WebP 或 GIF，Requirement Worker 则读取创建需求单时冻结的图片快照；Runtime 只在模型调用前重水化 Base64，Session、ContextSnapshot 和 Trace 只保存 `sourceRef`、SHA-256、MIME 与文件名。PDF/OCR、音频解析和真实 ERP、MES、CRM 连接仍不在当前 Baseline 内。

所有 Fact 包含：

- 稳定 Key、单调递增 Version、标量 Value 和可选 Unit
- `suggested | unverified | verified` 状态
- `user_input | source_document | enterprise_source | human_confirmation | model_output` 来源类型
- 可审计 `sourceRef`
- Enterprise Store 中的版本、Actor 和时间

模型和普通用户输入不得直接生成 `verified` Fact；只有企业权威来源或人工确认可以验证。

唯一交付 Artifact 为 `requirement-brief.v1`：

- `industry: print`（当前代表包装，保留内部标识以兼容已有记录）
- 标题和客户目标
- 当前字段级 Fact Snapshot
- 阻断当前阶段的 `missingRequiredFacts`
- 明示假设
- `clarify | confirm_facts | ready_for_approval` 下一步动作

Artifact Version 不得覆盖。Fact 变化后，依赖旧 Fact Version 的 Artifact 变为 `stale`，绑定旧版本的 Approval 失效。

## 4. Domain Pack Baseline

Print 的首批阻断字段：

```text
product_type, quantity, dimensions, target_market,
target_delivery, delivery_location, artwork_status
```

这些字段只决定 Requirement Brief 是否可以进入审批，不代表完整生产 Schema。包装材料、结构刀模和 PDF/X 等仍属于后续工程阶段，不由 M2 Requirement Brief 或生成模型保证。

`blackx-requirement-brief` Skill 明确限制模型只能返回包装 Canonical Key。Worker 在写入 Event Store 前将少量常见别名确定性归一化，例如 `packaging_type → product_type`、`quantity_reference → quantity`；无法映射的概括字段不进入业务 Fact，Evaluator 也拒绝 Artifact 中的非 Canonical Key。

## 5. Tool Baseline

M2 最多注册四个受控 Tool：

1. `project_source_list`：只读，列出本任务允许读取的对话和附件来源。
2. `project_source_read`：只读，按 Source ID 读取受租户隔离的内容。
3. `enterprise_catalog_search`：只读，通过 Domain Adapter 查询已授权目录；无连接器时返回明确不可用，不生成替代事实。
4. `requirement_fact_propose`：写入，只能保存 `suggested/unverified` 候选 Fact；使用幂等键，人工确认仍走独立 API。

Artifact、Evaluation、Approval 和 Workflow 状态不是模型 Tool，由 RunEngine/Worker 确定性管理。

## 6. Deterministic Evaluation 与 Approval

`requirement-brief-evaluation.v1` 至少检查：

- Schema、行业、标题和客户目标合法
- Fact Key 唯一，Value、Unit、来源和状态合法
- `verified` Fact 只来自企业权威来源或人工确认
- 声明的缺失字段与 Domain Pack 必填字段一致
- 下一步动作与实际缺口/确认状态一致

Evaluator 的 `passed` 表示 Artifact 内部一致；只有不存在缺失字段、所有必填 Fact 均已验证时，`approvalEligible` 才为 `true`。Approval 必须绑定具体 Artifact ID 和 Version，不能由模型代替用户批准。

## 7. 固定 Eval Baseline

当前固定 10 个包装离线 Task，报告标识为 `blackx-m2-packaging-workflow-baseline-v3`，覆盖：

- 完整且已确认，可进入 Approval
- 缺少尺寸、稿件状态或交付地点，需要澄清
- 关键字段已提取但未确认，需要 Fact Confirmation
- 模型输出试图直接产生 Verified Fact 时失败
- 声明缺口或下一步动作与事实不一致时失败

运行：

```bash
npm run eval:m2
```

该 Baseline 已冻结 Product Contract 和 Deterministic Evaluator。10 个固定任务现在全部使用文件 Event Store、Transactional Outbox、文件 Queue、正式 `RequirementBriefWorker`、真实 Packx Agent Loop、租户 Source Tool、文件 Artifact Store、Evaluation 和版本 Approval Gate；不再存在另一套 Fixture Worker 状态机。4 个完整任务批准具体 Artifact v1 后进入 `passed`，6 个有缺口或待确认任务由同一 Gate 停在 `needs_input`。

持久集成测试覆盖：首次生成停在 `needs_input`，服务端补充并确认全部必填 Fact，生成 Artifact v2，Evaluation 允许审批，批准具体版本后通过 Stage Gate；用同一 Event Store 重建 RunEngine 后状态保持一致。

以下为 2026-09-04 跨行业版本的历史浏览器验收，保留原始范围，不代表当前包装产品的真实用户验证：

- 用户消息先乐观显示，再收到 DeepSeek 实际回复
- 家具 Requirement Job 从 `queued` 进入 `leased` 并最终 `completed`
- 实际模型候选 Fact 保持 `model_output/unverified`
- 人工确认生成新 Fact Version，使旧 Artifact stale 并进入 `revision_required`
- 浏览器刷新后 Run、Fact、Artifact 和 Evaluation 状态从服务端恢复
- queued 或 leased Job 可取消；leased Runtime 通过 AbortSignal 协作终止，`stage.cancelled` 在刷新后保持终态
- 一条全新 Furniture Run 从真实 DeepSeek 提取 7/7 Canonical Fact，经逐项人工确认、Artifact v2、确定性 Evaluation、版本绑定 Approval 和 Stage Gate 后进入 `passed`
- `requirement-brief-metrics.v1` 从持久 Runtime Checkpoint、Event Store 和整条 Run 的 Queue Jobs 聚合 Canonical 命中率、Fact 确认率、缺失字段、澄清轮次、Token、延迟、失败、恢复和取消状态
- Provider 在 Artifact v2 阶段发生的两次可重试输出失败在最终 Approval Gate 和服务重启后仍保留；未配置模型价格时成本明确为 `unconfigured`，不伪造金额

`requirement-brief-metrics-series.v1` 通过租户/Workspace 内的 Conversation 索引读取每条 Requirement Event Stream，按 Run 开始时间返回可恢复的时间序列，并聚合 Stage/Evaluation/Approval 比率、人工确认后的候选准确率、Artifact 来源覆盖率、Fact 确认率、澄清问题、Artifact 版本、Queue/Tool 失败率、恢复率、Token 和耗时。该读模型直接派生自现有权威记录，不复制一份会漂移的指标数据库；只有未来托管云出现多实例和查询瓶颈时才替换为索引化监控 Read Model。

## 8. M2 完成 Gate

- 10 个固定任务通过同一 Queue → Worker → Artifact → Evaluation → Approval 链路
- 至少一次真实 DeepSeek 任务从 Brief 生成 Artifact，并与离线 Fake Eval 分离
- UI 可以创建需求任务、查看进度、确认/拒绝 Fact、查看 Artifact 和 Evaluation、批准准确版本、重试或取消
- 取消只终止当前 Job 并写入事件，不删除 Fact、Artifact、Approval 或审计历史；用户可以显式重新审查并从现有版本继续
- UI 可以上传、持久化并重新读取会话图片/文件；文本附件进入 Requirement 来源，支持的栅格图片通过原生模型内容块进入会话与冻结的 Requirement 输入；PDF 和其他文件不得伪装为已被模型理解
- Artifact 依赖变化后旧版本 stale，旧 Approval superseded
- 进程重启后任务可继续，重复投递不重复写入
- 记录完成率、字段提取准确率、证据引用率、澄清问题数、工具失败率、恢复率、Token、成本和耗时
- 至少一次从创建任务到批准 Requirement Brief 的真实浏览器验收
- 包装企业真实目标用户完成任务走查，产品负责人确认该交付物确实能进入下一工作阶段

### Gate 结论

| 范围 | 状态 | 证据 |
| --- | --- | --- |
| Product Contract、正式纵向链路、恢复、权限和指标 | 完成并冻结 | `npm run eval:m2`、`npm run check`、本文件第 7 节 |
| 合成售前任务走查 | 通过 | [`evidence/m2-synthetic-user-validation-2026-09-05.md`](evidence/m2-synthetic-user-validation-2026-09-05.md) |
| 包装真实目标用户走查 | 未执行 | 没有真实用户参与，不得标记为通过 |

M2 工程基线据此标记完成并冻结，可以进入 Native Tool Sandbox、本地权限、Secret、备份恢复与发行等 M3 技术加固。该状态不等于产品价值验证完成，也不能用于宣称真实用户已经接受 Requirement Brief。

## 9. 存储与非目标

M2 继续采用 M1 的单机文件/SQLite Adapter。只有开始服务外部用户、多实例部署或出现无持久磁盘环境时，才进入 PostgreSQL、S3-compatible Store 和 Managed Queue 选型。

M2 不包含：

- 自动报价、生产排程或生产文件生成
- 多 Agent、Agent Teams、Reviewer Agent 或 RSI
- 任意 Shell Tool、开放式插件市场或自动发布
- 自研分布式数据库、对象存储或消息队列
- 同时扩展其他行业或建立完整包装工程知识库

如果 Requirement Brief 不能稳定减少售前到工程之间的返工，停止扩展框架，先重新验证用户、任务和 Artifact。

M2 已有工程与合成验证记录，当前产品和固定基线收敛为包装。明确遗留项是包装真实目标用户走查，以及在真实任务上积累足以判断长期质量趋势的样本；该遗留不阻塞 M3 安全加固，但阻塞对外试点结论、产品价值声明和 RSI。Provider 价格仍未配置，因此只记录 Token 与 `costStatus=unconfigured`，不伪造账单金额。
