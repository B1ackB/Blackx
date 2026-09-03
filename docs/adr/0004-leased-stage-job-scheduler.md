# ADR-0004：带租约的 Stage Job 调度与 Slice 释放

状态：Accepted
日期：2026-09-03
决策者：产品负责人

后续：本 ADR 列出的 Outbox、续租、指标、DLQ 与单主机多 Worker 缺口已由 [`ADR-0005`](0005-transactional-outbox-and-queue-operations.md) 实现；多主机分布式 Queue 仍未完成。

## 背景

Agent Runtime 已能在 execution slice 边界保存 Session 并返回 `paused`，但 Proposal Worker 仍把一次 Runtime 调用假定为最终完成。这样既会把暂停结果误写为最终 Artifact，也会让上层缺少排队、Worker Crash Recovery、退避和下一 slice 调度。

## 决定

- Enterprise Layer 新增行业无关 `StageJobQueue` Port。Job 使用 `queued → leased → completed | queued | dead_letter` 显式状态机。
- 每次 Worker delivery 只执行一个 Runtime slice。Runtime 返回 `paused` 时，Queue 原子保存 `sessionId`、最后一个 `contextSnapshotId` 和 `sliceCount`，清除租约并重新进入 `queued`；当前 Worker 调用随即结束。
- Queue 使用 at-least-once delivery。`claim` 产生独立 `leaseId`、`leaseOwner` 与到期时间；`ack`、`checkpoint`、`fail` 必须携带当前租约，过期 Worker 的提交被 fencing 为 `lease_lost`。
- 租约过期视为一次可重试 Worker Failure，并由下一次 `claim` 回收。Runtime Failure 按现有 `retryable` 分类进入指数退避；不可重试或连续失败达到预算时进入 `dead_letter`。
- Proposal Job 使用由 Tenant、Workspace、Run、Stage 和 Command 派生的确定性 Job ID 与 Session ID。Runtime 使用 `resume: "if-present"`：首次 delivery 创建 Session，Crash 后重复 delivery 在 Session 已存在时续跑。
- 单 Job 默认最多 5 次连续失败、32 个 execution slice。成功完成一个 slice 会清零连续失败计数；超过总 slice 预算进入 `dead_letter`，避免无限自主循环。
- 本地 Adapter 使用原子 JSON 文件替换、0600 权限、单写者锁和损坏文档 fail-closed；30 秒以上的遗留锁可由新进程回收。生产部署通过同一 Port 替换为支持事务、唯一约束、可见性超时和 DLQ 的队列。
- `POST /api/proposal-runs/{runId}/execute-proposal` 改为幂等入队并返回 `202`。后台 scheduler 轮询执行；受 Worker Token 保护的 `GET /api/stage-jobs/{jobId}` 可查询状态，并强制 Tenant/Workspace 匹配。

## 替代方案

1. Worker 内部 `while` 连续 resume 到完成：仍长期占用 Worker，不能公平调度其他 Run，拒绝采用。
2. 立即引入 Redis、BullMQ 或 Temporal：当前单机纵向切片尚不需要新增基础设施与依赖，拒绝采用。
3. 只依赖进程内数组：无法证明进程重建后的排队与租约恢复，拒绝采用。
4. 使用 `workerId` 作为 ACK 凭证：Worker 重启或租约重新分配后可能提交旧结果，拒绝采用。

## 影响与风险

- Proposal Worker 保留同步 `execute` 作为测试与兼容入口；它在遇到 `paused` 时明确抛出 `ProposalWorkerPausedError`。生产路径只调用 `executeSlice`。
- 本地文件 Queue 是单主机开发 Adapter，不提供多主机共识、吞吐扩展、租约心跳、长期历史保留或独立运维面板。
- Event Store 提交 Stage 后再入队仍有 dual-write 窗口。进入数据库/消息队列阶段前必须实现 transactional outbox 或等价的原子 dispatch，不能把当前 HTTP 二次调用宣称为生产 exactly-once。
- Model Provider 返回后、Runtime 最终 Checkpoint 写入前仍需 Provider 幂等或事务化执行记录进一步缩小重复模型调用窗口。Tool 副作用继续由 Tool Execution Ledger 独立保护。

## 迁移与退出条件

- 现有 Worker 调用方必须接受 `202`，轮询 Job 状态或等待业务 Event，不再把 HTTP 返回当成 Stage 已完成。
- 固定回归必须覆盖幂等入队、paused 续排、同 Session 续跑、租约过期回收、旧租约 fencing、退避、DLQ、slice 总预算、文件重建和损坏队列 fail-closed。
- 引入生产 Queue Adapter 前，必须增加 transactional outbox、租约续期、队列延迟/深度/失败指标、DLQ 运维流程和跨实例 Contract Test。
