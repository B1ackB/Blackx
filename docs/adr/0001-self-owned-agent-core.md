# ADR-0001：Blackx 采用自研 Agent Core

状态：Accepted
日期：2026-09-01
更新：2026-09-02
决策者：产品负责人

## 背景

Blackx 原 P1.9 以官方 Codex SDK 为 Harness 基线。产品负责人最新决定不采用 Codex SDK，而是将 Agent Loop、Hook、Context、Skill 与 Compact 作为 Blackx 的核心工程能力自研。该决定改变 P1 Runtime 基线，因此通过本 ADR 显式记录。

## 决定

- 删除 `@openai/codex-sdk` 运行时依赖和 `CodexSdkRuntime`。
- 以 `AgentRuntimePort` 隔离 Enterprise Layer 与自研 Agent Core。
- Core 第一版只实现顺序 Agent Loop、只读 Tool、观察型 Hook、内存 SkillRegistry、确定性 Context Compact，以及具有内存 Fake 和本地文件 Adapter 的 Session/ContextSnapshot Store Port。
- Model Provider 通过 `AgentModelProvider` 接入；首个 Online Adapter 直接调用 Anthropic Messages Client。
- Event Store、Artifact、Approval、Evaluation、Checkpoint、Tenant 和 Audit 继续属于 Enterprise Layer。
- Print Skill 只提供阶段内指令，不得拥有状态转换、权限或权威事实。

## 替代方案

1. 继续使用 Codex SDK：成熟度更高，但不能体现 Blackx 对 Agent Loop 和 Context 生命周期的核心所有权。
2. Fork Codex：能力完整，但同步、许可证、构建和补丁维护成本超过当前最小闭环需要。
3. 自研最小 Core：当前采用。能力较少，但边界可解释、可离线测试，并能按固定 Eval 演进。

## 影响与风险

- Blackx 自己承担 Loop 终止、Tool 安全、Context 完整性、Compact、Session 恢复、Provider 错误和可观测性责任。
- 本地文件 Session Store 支持进程对象重建后的恢复和 revision 冲突检测，但不是生产数据库；Proposal Worker 仍依赖 Event Store、Artifact 和 Runtime Checkpoint 恢复业务状态。
- 每次 Model 调用前保存不可变 ContextSnapshot，Artifact 只持有其引用；Snapshot 不得成为修改权威事实的旁路。
- 当前 Hook 只观察并顺序执行，不能修改权威事实、权限或 Tool 结果。
- 当前没有生产级写入 Tool、Sandbox、跨主机 Session 租约、并行 Tool 或流式增量。

## 验证

- Fake Model 离线执行一次完整 Turn。
- 固定测试覆盖 Model → Tool → Model 循环、Hook 顺序、Tool 校验、超时、取消、Session 跨 Runtime 恢复、并发 revision、损坏数据拒绝、Model 前 ContextSnapshot 和成对 Compact。
- 原 Proposal Worker 的五个 Crash Injection 恢复测试继续通过。
- 类型检查、离线测试、固定 Print Eval 和生产构建必须通过。

## 迁移与退出条件

旧 Runtime Checkpoint 中的 `codex-sdk` Adapter、`threadId` 以及 `proposal-runtime-checkpoint.v1` 不自动迁移；当前未进入生产，测试数据应重新创建。若未来固定 Eval 证明自研 Core 在安全、恢复或成本上无法达到门槛，可通过新 ADR 替换具体 Core，但不得改变 Enterprise Layer 与 Domain Pack 边界。
