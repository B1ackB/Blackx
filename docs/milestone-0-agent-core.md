# M0：Blackx Agent Core Baseline

状态：Scope Frozen / DeepSeek Online Contract Passed
冻结日期：2026-09-02
目标：建立可解释、可离线验证的自研 Agent 核心，不宣称生产就绪。

## 范围

M0 实现以下行业无关能力：

- `AgentRuntimePort` 与 Model Provider 边界
- 顺序 Agent Loop、32 次 Model 调用 execution slice、64 次 Tool 预算和 durable continuation
- 通用观察型 Hook
- 强类型 Tool 定义、输入校验、结构化 Failure、超时和结果边界
- 写入/发布 Tool 的默认拒绝、受信 Approval Port、确定性业务幂等键、Audit Port 和持久化 Tool Execution Store
- Context 编译、Skill 注册、真实 Token Count 和模型摘要 Compact
- Session Resume Handle、内存 Fake 与本地文件 Session Store
- 每次 Model 调用前的不可变 ContextSnapshot
- Fake Model、Anthropic Messages Provider
- 标准化 Runtime Event、Usage 和 Failure

不在 M0 实现：生产 Sandbox、具体业务写入 Tool、生产 Approval/Audit 数据库 Adapter、生产数据库 Session Adapter、并行 Tool、多 Agent、向量 Memory 和自动修复。

## 当前完成证据

- Model → Tool → Model 的两轮 Loop 离线测试
- Hook 注册顺序和生命周期离线测试
- 未知 Skill fail-closed
- Tool Call/Result 成对 Compact 测试
- 开放 Tool Batch 不被 Compact、durable Tool receipt 抗压缩测试
- 模型摘要 Compact 测试；摘要只消费被移除的 transient 消息，并显式标记为非权威内容
- Anthropic `/v1/messages/count_tokens` 离线 Contract，Token Budget Failure 和 ContextSnapshot Token 记录
- Runtime timeout/cancel 测试
- Session 跨 Runtime 对象重建恢复、乐观并发冲突和损坏数据 fail-closed 测试
- ContextSnapshot 在每次 Model 前保存、Tool Result 入快照及 Provider 失败前留证测试
- Skill 名称与版本、Compact 删除量和字符预算估算进入 ContextSnapshot
- Proposal Worker 五个 Crash Injection 回归
- 写入 Tool 默认拒绝；只有 `workspace-write + required approval + trusted Approval Port + Audit Port + Tool Execution Store + deterministic idempotency key` 同时成立时执行
- 成功写入重复投递只返回已记录结果，不重复副作用；Crash 遗留的未决幂等记录 fail-closed
- Runtime Request 的 `actorId` 贯穿 Approval、Tool Context、Audit 和幂等账本
- 32 轮边界返回 durable checkpoint；同一 Session resume 不重复用户输入
- Tool Failure 覆盖 not allowed、input invalid、not idempotent、approval required/denied、timeout 和 execution failed
- Runtime Failure 覆盖 model、context、budget、permission、max iterations、session conflict、authentication、rate limit 和 infrastructure
- 无 `@openai/codex-sdk` 运行时依赖
- DeepSeek `deepseek-v4-flash` 通过真实 Anthropic-compatible Contract：Token Count、摘要 Compact、带签名 thinking 回传、Tool Loop、Usage 和 ContextSnapshot 同次执行通过
- DeepSeek 是当前唯一 Online Provider Gate；官方 Anthropic 端点验证不属于 M0 完成条件，见 [`Contract Evidence`](evidence/m0-anthropic-contract-2026-09-02.md)

## 完成条件

- [x] 类型检查、全部离线测试、固定 Print Eval 和生产构建通过
- [x] 至少一个真实 Anthropic-compatible Provider Contract 成功通过
- [x] 结构化 Tool Execution Event、确定性幂等键、Approval Port 和 Audit Port 对写入 Tool 生效
- [x] Anthropic Token Count Contract、Token Budget 与摘要 Compact 离线 Eval 通过
- [x] 失败分类覆盖模型、Tool、Context、预算、权限和基础设施

架构变更依据见 [`ADR-0001`](adr/0001-self-owned-agent-core.md)、[`ADR-0002`](adr/0002-m0-write-tools-summary-compact.md) 与 [`ADR-0003`](adr/0003-durable-context-and-execution-slices.md)。M0 已满足冻结条件；后续 Provider 兼容性以实际产品需要和独立 Contract 为准。
