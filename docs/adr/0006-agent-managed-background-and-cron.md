# ADR-0006：Agent 管理的 Background Task 与持久 Cron

状态：Accepted
日期：2026-09-03
决策者：产品负责人

## 背景

手动选择后台模式只证明 UI 可以把消息交给 Queue，不能证明 Agent 会在 Loop 内自主判断任务是否应异步或定时执行。让模型直接创建线程、操作进程计时器或运行 cron shell 会绕过 Tool Policy、租户隔离、预算、幂等和审计。

## 决定

- Agent 只能通过强类型 Tool Call 管理后台能力：`background_task_create/status/cancel` 与 `cron_create/list/pause/resume`。模型负责提出动作和参数；服务端 allowlist、Schema、Policy、Approval Port、Audit Port 和 Tool Execution Ledger 决定是否执行。
- Conversation Turn 只向模型暴露上述工具。写工具使用 `workspace-write + required`，由服务端固定的 bounded-automation policy 授权并生成 Approval ID；授权来自产品配置，不来自模型文本。
- Agent 创建的 Background Task 延迟 5 秒首次领取，避免与创建它的父 Turn 竞争同一个 Session；随后复用 Stage Job Queue 的租约、退避、DLQ 和消息幂等恢复。只允许取消尚未领取的 Job。
- Cron Schedule 是独立持久状态，不依赖进程内 timer。Dispatcher 扫描到期 Schedule，用 `scheduleId + scheduledAt` 派生确定性 occurrence，再先入队、后 ACK Schedule。因此崩溃最多导致同一 Job 被重复投递，不会漏单。
- Cron 只允许投递注册的 `conversation.message.v1` Background Job，不允许 shell、URL callback 或任意代码。每个 Schedule 必须指定 IANA timezone、至少间隔 5 分钟、`maxRuns` 为 1–100；达到上限自动完成。
- Cron 表达式解析固定使用 `croner@10.0.1`。来源为 `Hexagon/croner`，MIT License，包本身零运行时依赖；版本在 `package.json` 和 lockfile 中精确固定。

## 替代方案

1. 模型直接控制 Worker/Timer：无法恢复和审计，拒绝采用。
2. 手写 Cron 和 DST 解析：边界错误风险高于一个固定、无传递依赖的小型库，拒绝采用。
3. 立即引入 Temporal、BullMQ 或云调度服务：当前单机闭环尚未证明需要，暂不采用。
4. 无限 recurring schedule：会产生无界模型成本，拒绝采用。

## 影响与风险

- 当前 bounded-automation policy 是产品级预授权，不是逐次人工确认。生产多租户版本必须把它替换为 Tenant capability、预算配额和可撤销授权。
- File Cron Store 适合本地单机恢复，不提供跨主机 claim；多副本 Dispatcher 依赖确定性 Job ID 防重复，但仍需生产数据库锁和指标。
- 已领取的 Background Job 目前不能强制中止 Provider 请求；取消只作用于 queued 状态。
- Cron 的 post-enqueue ACK 提供 at-least-once，而不是 exactly-once。模型调用和写 Tool 的副作用仍必须分别使用 Session/Tool Ledger 幂等。

## 退出条件

- 跨主机部署前增加数据库 Schedule Store、Dispatcher ownership、延迟与漏触发告警。
- 开放无限 Cron、高频 Cron、外部发送或发布类任务前，必须增加显式人工审批、Tenant 预算和消费上限。
- 若未来引入通用 Workflow Scheduler，以相同 Schedule/Occurrence 幂等 Contract 迁移，不让 Domain Pack 依赖 Croner 类型。
