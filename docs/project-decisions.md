# Blackx 已确认项目决策

状态：Accepted
确认日期：2026-08-26

本文记录当前已由产品负责人确认、后续规划和实现必须遵守的项目级决策。实现证据和版本升级记录仍进入对应里程碑 Decision Log。

## D1：首个包装品类为封口袋

首个 Domain Vertical 定位为封口袋，不再以折叠纸盒作为首个品类。

封口袋方案采用行业标准优先。标准元数据、适用范围、技术要求和试验方法进入版本化 `StandardsRegistry`；确定性 `StandardsRouter` 根据已验证的用途事实选择适用标准并生成 `ApplicableStandardsProfile`。详细规则见 [`sealing-bag-standards.md`](sealing-bag-standards.md)。

标准可以直接成为 Fact 的权威来源，但必须记录标准号、版本、有效日期、适用条款、派生规则和输入 Fact Version。标准规则只有在适用性输入完整且确定性匹配时才能产生 `verified` Fact。

内容物、预期用途、接触类型、加工条件、目标保质期、成品尺寸和数量等项目事实仍需来自客户、企业系统、供应商或测试。它们用于选择标准，不能由模型根据“封口袋”名称自动补全。这里的“来自客户”不等于要求客户逐字段手填：Blackx 应从自然语言和资料中提取候选 Fact，并只请求必要确认。标准只规定试验条件时，也不得把试验条件当作工厂生产设定。

## D2：Blackx 应用层采用 TypeScript

Blackx Enterprise Layer、Print Domain Pack、Port/Adapter、Schema 和测试采用 TypeScript。具体 Node.js、包管理器和构建工具版本在 M0 工程初始化时固定。

自研 Agent Core、Enterprise Layer、Domain Pack、Port/Adapter、Schema 和测试统一采用 TypeScript。

## D3：Harness 基线采用当前 OpenAI GitHub 开源 Codex（Superseded）

本决策已由 D7 和 [`ADR-0001`](adr/0001-self-owned-agent-core.md) 取代。历史版本信息保留用于说明先前基线和许可证审计，不再代表当前运行时依赖。

决策日查询到的最新稳定 Release 为：

```text
repository: https://github.com/openai/codex
release: rust-v0.149.1
tag object: 980a6d12110b110d29ec13bdcbe14011100b3566
commit: ff29a44391deccde0aba0f8390337d7f3c319ea4
observed_at: 2026-08-26 Asia/Shanghai
```

该 Commit 是 M0 的初始 Harness Baseline。生产和测试必须引用明确的 Release/Commit，不得配置为持续跟随 `main` 或“latest”。

采用该开源基线不等于立即 Fork：

1. 先使用官方 SDK/App Server 等公开边界完成 `CodexRuntimePort` Adapter。
2. 上游源码用于版本审计、构建复现、协议验证和缺口定位。
3. 只有满足 `AGENTS.md` P1.9 与 ADR 准入条件时才维护最小 Patch。

升级流程必须重新记录 Release、Commit、许可证/NOTICE、供应链清单，并运行 Runtime Contract Test、恢复测试、权限测试和固定 Print Eval。

## D4：采用 API Key 鉴权

Online Runtime 和模型 Provider 使用 API Key。Secret 只允许从进程环境或 Secret Manager 注入：

- 不写入仓库、项目级 Codex 配置、Prompt、Artifact、Event Payload 或普通日志
- 日志和错误必须对 Key、认证 Header 和上游响应中的敏感字段脱敏
- 不同 Provider 使用不同 Secret 名称和最小权限凭据
- 测试使用 Fake Credential；常规离线测试不得依赖真实 Key
- Key 轮换不得要求修改业务 Artifact 或 Domain 配置

初始环境变量名称候选为 `OPENAI_API_KEY` 和 `ANTHROPIC_API_KEY`；最终名称及 Secret Manager 映射在 M0 固定。

## D5：支持 Anthropic Messages 协议

Blackx 需要通过 Anthropic Messages 协议调用遵循该协议的上游模型端点，并把模型连接到自研 Agent Core。Blackx 不对客户或外部系统暴露 Anthropic-compatible API。该要求属于 Runtime Infrastructure Adapter，不属于 Enterprise Layer 或 Print Domain Pack。

当前 Codex 自定义 Model Provider 支持 `base_url`、环境变量 API Key 和自定义 Header，但官方配置的 `wire_api` 仅支持 OpenAI Responses。因此第一方案是独立兼容边界：

```text
Blackx RunEngine
→ AgentRuntimePort
→ Blackx Agent Core
→ Anthropic Model Provider Adapter
→ Anthropic Messages compatible endpoint
```

Adapter 必须双向映射并测试：

- system/user/assistant 内容与多模态内容块
- Tool 定义、Tool Call ID、参数和 Tool Result
- SSE 流式增量、完成状态、停止原因和中断
- Token/缓存 Usage、限流、认证、超时和上游错误
- Structured Output 的能力差异与降级行为
- 重试语义、幂等边界和是否可能重复副作用

不得把 Anthropic 请求/响应类型暴露给 RunEngine、Artifact、Workflow 或 Print Schema。Provider Adapter 必须通过 Model Provider Contract Test；协议差异不得泄漏进 Agent Loop。

## D6：Blackx 采用“行业版 Codex”的最少提问模式

Blackx 的核心体验是让用户表达包装业务目标，由系统调查标准、企业数据和工具证据后完成行业化工作，而不是把一张完整印刷工程参数表交给用户。

- 用户负责表达或确认内容物、用途、目标保质期、容量/尺寸、数量、市场、预算、交期和品牌硬约束等不可可靠推断的信息。
- Blackx 先从自然语言、附件、历史项目和企业系统提取 Fact，只对会阻断阶段或显著改变方案的缺失项提问。
- 袋型、封口方式、材料结构和工艺窗口可以由 Print Domain Pack 提出候选，但保持 `suggested`，直到权威规则、供应商/工厂数据、测试或专业人员验证。
- 热封温度、压力、停留时间和线速等工厂生产配方通常由设备能力档案、供应商数据、历史验证工单、MES 或试产提供，不要求普通客户预先输入，也不得由模型猜测。
- 行业能力通过 Print Domain Pack 的 Skill、Tool、Context Provider 与 Port/Adapter 连接 Agent Core；不得写入通用 Core。

详细交互和信息责任见 [`product-interaction-model.md`](product-interaction-model.md)。

## D7：自研 Blackx Agent Core

状态：Accepted
确认日期：2026-09-01
更新日期：2026-09-02

Blackx 不再以 Codex SDK 作为运行时基线。Agent Core 由项目自研，第一阶段固定实现：顺序 Agent Loop、观察型通用 Hook、显式 Tool Registry、ContextEngine、内存 SkillRegistry、确定性 Compact、Session/ContextSnapshot Store Port、内存 Fake、本地文件 Adapter、Fake Model 和 Anthropic Messages Provider Adapter。

Enterprise Layer 与 Print Domain Pack 边界保持不变。Agent Session 只作为 Runtime Resume Handle；Run、Stage、Fact、Artifact、Approval、Evaluation 和恢复仍由 Event Store 与 Checkpoint 决定。详细迁移记录见 [`ADR-0001`](adr/0001-self-owned-agent-core.md)。

## 尚未确认

- 封口袋首个验收 Fixture 的用途、内容物、接触类型和加工条件
- Node.js、包管理器与 Monorepo 工具的固定版本
- M1 的生产数据库与对象存储 Adapter
- OpenAI 与 Anthropic Online Eval 使用的具体模型和预算门槛
