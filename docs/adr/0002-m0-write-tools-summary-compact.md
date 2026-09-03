# ADR-0002：M0 冻结写入 Tool 与摘要 Compact

状态：Accepted
日期：2026-09-02
决策者：产品负责人

## 背景

M0 原范围只允许只读 Tool 和确定性删除式 Compact。产品负责人决定 M0 在冻结前必须证明两项通用 Harness 能力：经过审批、幂等和审计控制的写入 Tool，以及真正生成摘要的 Compact。该决定扩大 Agent Core 的关键边界，因此单独记录 ADR。

## 决定

- read Tool 继续由 Runtime Policy 和 Tool Registry 控制。
- write/publish Tool 默认拒绝。只有请求显式使用 `workspace-write + required`、受信 `AgentToolApprovalPort` 返回非空 Approval ID、`AgentToolAuditPort` 可用、Tool 声明幂等并根据业务输入生成确定性幂等键时，Core 才执行副作用。
- 幂等键不得依赖模型生成的 Tool Call ID；模型只提供候选参数，Tool 实现负责从 Turn Key 和业务参数派生稳定键。
- Audit 在副作用前记录 started，结束后记录 completed；前置审计失败时不得执行 Tool。完成审计失败时返回可重试基础设施失败，Tool 使用相同幂等键处理重投。
- Tool 校验、拒绝、超时和执行失败以结构化 Tool Result 返回模型，同时进入结构化 Runtime Event。
- Compact 只摘要被淘汰的 transient 消息。稳定策略、当前输入、Skill 和 pinned 权威内容不进入摘要源。
- 摘要以普通 user-memory 消息重新注入，固定带有 `Unverified compact summary` 边界，不得作为 system 指令或覆盖权威事实、政策、权限、审批和生产状态。
- Anthropic Provider 使用官方 Token Count 端点检查输入预算；ContextSnapshot v2 保存实际估算 Token。

## 替代方案

1. 将写入 Tool 推迟到 M1：实现更少，但不能满足本次冻结要求。
2. 把 Approval 放入 Prompt 或请求正文：容易被模型或调用方伪造，违反 P0，拒绝采用。
3. 由 Core 自己拥有业务 Approval 状态机：会破坏 Core/Enterprise 分层，拒绝采用。
4. 继续只删除旧消息：确定性更强，但不满足摘要 Compact 要求。

## 影响与风险

- Core 只消费 Approval/Audit Port，不创建业务审批；生产 Adapter 仍属于 Enterprise Layer。
- 摘要需要额外 Model Call、Token、延迟和失败路径，Usage 必须计入 Turn。
- 摘要可能遗漏信息，因此原始 Session、ContextSnapshot 和 Artifact 仍是追溯来源；摘要不是权威状态。
- 副作用完成后 Audit completed 写入失败仍存在崩溃窗口；稳定业务幂等键是重投安全的必要条件。
- M0 只证明离线 Fake Approval/Audit Contract，不宣称已有生产权限系统或审计数据库。

## 验证与退出条件

- 默认策略、缺少 Approval/Audit、非幂等 Tool、拒绝审批均不执行副作用。
- 被批准的写入 Tool 收到稳定幂等键和 Approval ID，前后 Audit 事件完整。
- Tool Failure、Runtime Failure、Token Budget 和摘要 Compact 均有离线回归。
- 真实 Anthropic Contract 必须完成 Token Count、摘要 Compact、Tool Call/Result 和最终回复；账户或网络错误不得算通过。
- 若固定 Eval 证明模型摘要没有带来足够保留收益，后续 ADR 可回退为确定性 Compact，但不得删除原始快照和权威边界。
