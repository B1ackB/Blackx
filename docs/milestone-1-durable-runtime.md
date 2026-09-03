# M1：Durable Single-Agent Runtime

状态：Scope Frozen / DeepSeek Online Gate Passed
更新日期：2026-09-03
冻结日期：2026-09-03
前置条件：M0 Agent Core 已冻结，相关 Contract、离线回归与 DeepSeek Online Contract 通过

## 1. 用户结果

M1 证明 Blackx 能在不依赖聊天窗口、单次进程或模型记忆的前提下持续执行一个长任务。任务可以排队、分片运行、暂停、恢复、重试和取消；每次重要状态变化都有持久事件，最终产生可追溯的 Artifact 或结构化 Failure。

M1 的成功不是“模型回答成功”，而是同一个行业无关 Fixture 在正常执行、重复投递和进程崩溃后都得到唯一且合法的业务状态。

## 2. 最小范围

包含：

- 单 Agent、单 Stage、单机部署
- 显式 `tenantId`、`workspaceId`、`runId`、`stageId`、`sessionId` 和 `correlationId`
- Run/Stage 状态机、Event Store、Checkpoint、Artifact Version、Fact Version、Evaluation 和 Approval
- 持久队列、Worker lease、execution slice、continuation、退避、DLQ 和有限 Cron
- Transactional Outbox、确定性 Job ID、幂等命令和 lease fencing
- ContextSnapshot、Skill、Hook、Compact 和强类型 Tool Policy
- 内存 Fake、本地文件 Adapter 与单主机 SQLite Queue Adapter
- 一个行业无关的固定 Fixture：`Research Task → Evidence-backed Report Artifact`

不包含：

- 多主机分布式 Queue 或自研分布式存储
- PostgreSQL、对象存储和托管 Queue 的生产 Adapter
- 多 Agent、Agent Teams 或自治 RSI
- 通用插件市场、任意脚本执行器或生产 Shell Tool
- 面向外部用户的 SLA、计费或高可用承诺

## 3. 行业无关验收 Fixture

固定任务输入一组可离线读取的资料和一个研究问题。Agent 必须：

1. 从输入中记录带来源的候选 Fact。
2. 只使用允许的只读 Tool 获取证据。
3. 生成版本化 `evidence_report` Artifact。
4. 由确定性 Evaluator 检查必填结构、来源引用和 Fact Lineage。
5. 在需要时请求绑定具体 Artifact Version 的人工 Approval。
6. 在相同幂等键、Worker 重启或重复投递下不产生重复副作用。

该 Fixture 只验证 Runtime Contract，不决定 M2 的最终产品方向。现有 Print Proposal Slice 作为 Domain Adapter 和历史回归保留，不再定义 M1 是否完成。

## 4. 状态与持久化边界

```text
Run: created → running → waiting_approval → completed
                    ↘ retryable_failed / failed / cancelled

Stage: pending → queued → running → evaluating → waiting_approval → passed
                         ↘ paused / retryable_failed / failed / cancelled

Job: queued → leased → completed
             ↘ queued / dead_letter / cancelled
```

- Agent Session 是 Runtime continuation，不是 Run 或 Stage 的权威状态。
- Event Store、Checkpoint 和 Artifact 是恢复依据。
- Tool receipt、幂等键、Approval 绑定和权威 Fact 不得由 Compact 删除或改写。
- 模型结束一轮只表示 execution slice 结束，不能直接完成 Stage。

## 5. 失败与恢复 Gate

至少覆盖：

1. Stage 已开始、Runtime 调用前崩溃。
2. Provider 返回后、Checkpoint 持久化前崩溃。
3. Artifact 创建后、Evaluation 前崩溃。
4. Approval 请求后、人工响应前中断。
5. Approval 已处理、Worker 尚未确认 Stage Gate 时崩溃。
6. Worker lease 过期、旧 Worker 迟到提交。
7. 可重试 Failure 达到预算后进入 DLQ，并可由受权 Operator redrive。

恢复验收：

- 重放后状态唯一且合法
- 已提交的昂贵调用和写入 Tool 不重复副作用
- Artifact Version 和 Approval 不重复创建
- 过期 lease 的 Worker 不能覆盖新 Worker 结果
- 恢复次数、耗时和最终结果可查询

## 6. M1 存储决策

M1 接受单机持久化实现：

- Event、Session、Checkpoint 和 Artifact：本地原子文件 Adapter
- Stage Job Queue：SQLite 单主机多 Worker Adapter
- 测试：内存 Fake

M1 不自研分布式数据库、共识协议、对象存储或消息队列。所有调用继续经过 Port，并保持幂等、乐观并发、租户键和可迁移 Schema，使 M3 可以替换为成熟的生产组件。

只有满足任一条件时才启动生产存储 Adapter：

- 同一环境需要两个或以上主机同时执行 Worker
- 服务运行在无持久本地磁盘的平台
- 需要滚动发布、自动故障转移或跨可用区恢复
- 外部用户数据需要正式备份、保留期和恢复目标
- 单机吞吐、容量或锁竞争被测量为瓶颈

## 7. 完成定义

- 行业无关 Fixture 的 Tool Loop、结构化 Artifact 和来源 Lineage 通过；通用 Queue/Runtime Contract 覆盖重复投递和暂停续跑；现有 Worker 参考切片覆盖五个持久化 Crash Injection
- Runtime Contract、Failure、权限、租户边界和 Compact 保留测试通过
- Queue lease、心跳、fencing、退避、DLQ、redrive 和 Outbox 重放测试通过
- Fact/Artifact Version、Lineage、stale 传播和 Approval 绑定测试通过
- 可查询 Agent Turn、Model Call、Tool Call、Token、延迟、重试、压缩和恢复指标
- 固定 DeepSeek Online Eval 可重复运行并保存证据
- 类型检查、生产构建、文档和 Schema 同步
- Core 与 Fixture/Domain 之间没有行业条件分支

## 8. 完成证据

截至 2026-09-03，已有：

- 自研 Agent Core 与真实 DeepSeek Anthropic-compatible Tool Loop
- 持久 Session、ContextSnapshot、摘要 Compact 和 execution slice continuation
- Event/Artifact/Checkpoint 文件 Store、Transactional Outbox 和单主机 SQLite Queue
- lease、续租、fencing、退避、DLQ、redrive、Background Task 与有限 Cron
- Artifact/Evaluation/Approval/Fact Version 及依赖失效
- Web → API → Runtime → Worker → Artifact → Evaluation → Approval → Stage Gate 真链路
- 五个固定 Crash Injection 回归
- 持久 `runtime-trace.v1`，包含脱敏 Agent/Model/Tool/Compact 事件、Usage、延迟和 Failure
- Stage Job 持久恢复次数、过期 lease、检测延迟和租户范围汇总指标
- 行业无关 `durable-research-runtime-v1` 离线与 DeepSeek Online Gate
- 29 个测试文件、137 个测试、类型检查和生产构建通过

完整证据见 [`evidence/m1-durable-runtime-2026-09-03.md`](evidence/m1-durable-runtime-2026-09-03.md)。

## 9. 冻结后的限制

- Provider 成功到本地 Trace/Checkpoint 写入之间仍有崩溃窗口；这阻塞生产级 exactly-once 声明，但不阻塞单机 M1。M3 必须取得 Provider 去重证据或采用生产事务型 Worker。
- Operator Queue/DLQ 已有受保护 API；图形运维页面属于 M2 产品体验。
- PostgreSQL、对象存储、多主机 Queue、Sub-agent、Agent Teams 和 RSI 不属于 M1。

M1 已满足冻结条件。后续只有固定 Eval 证明存在行业无关缺口时才重新打开 Core/Runtime 范围。
