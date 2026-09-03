# ADR-0005：Transactional Outbox 与 Stage Job 运维闭环

状态：Accepted
日期：2026-09-03
决策者：产品负责人

## 背景

ADR-0004 建立了带租约的 Stage Job Queue，但留下三个明确缺口：Run Event 与入队之间存在 dual-write 窗口；长 slice 没有租约续期和跨 Worker Contract；队列没有租户隔离的指标、DLQ 查询与受控 redrive。

## 决定

- `EnterpriseEventStore.append` 在同一次原子提交中写入 `stage.execution_requested` Event 和 `enterprise-outbox.v1` 消息。只有该提交成功后，Dispatcher 才能向 Stage Job Queue 投递。
- Dispatcher 使用 at-least-once delivery。Proposal Job ID 由 Tenant、Workspace、Run、Stage 和 Command 确定性派生；如果进程在 Queue `enqueue` 后、Outbox ACK 前崩溃，重放只会命中同一个 Job。
- Queue 租约支持心跳续期。每次 `renew`、`ack`、`checkpoint` 和 `fail` 都校验 `jobId + leaseId + leaseOwner` 及未过期时间；重新分配后，旧 Worker 的结果被拒绝为 `lease_lost`。
- 增加基于 Node 标准库 `node:sqlite` 的单主机持久 Adapter。SQLite 使用 WAL、`BEGIN IMMEDIATE`、0600 文件权限和事务化 claim；文件 Adapter 继续作为默认本地开发实现，内存 Adapter 用于离线测试。
- 增加租户/工作区范围内的 Queue 指标：ready、delayed、leased、completed、dead-letter、累计 deliveries、slices、failures、redrives 和最老排队时间。
- DLQ 只能通过独立 Operator Token 查询和 redrive。redrive 要求 Actor、原因、`expectedUpdatedAt` 乐观并发值，并保留累计失败、redrive 次数和最后一次人工操作记录；不得创建新的业务 Command 或 Session 身份。

## 替代方案

1. 先提交 Run Event，再直接调用 Queue：进程崩溃会永久漏单，拒绝采用。
2. 宣称 exactly-once delivery：外部系统和崩溃边界无法由当前单机实现证明，拒绝采用；当前语义是 at-least-once + 幂等消费。
3. 立即引入 Redis、BullMQ、Kafka 或 Temporal：当前单机吞吐没有证明需要新增基础设施，拒绝采用。
4. 把 Worker 数量等同于 Agent 数量：Worker 是执行资源，Agent 是有独立 Session、目标和聚合协议的语义实体，拒绝混淆。

## 影响与风险

- 每个执行请求会先增加一个可审计的 Run Event，因此 Queue payload 的 `expectedVersion` 是请求版本加一。
- SQLite Adapter 证明同一主机上多个 Worker 连接的事务 claim 和恢复契约，但当前实现把队列文档保存在单行中，写入会全局串行；它不是多主机分布式 Queue，也不是高吞吐生产终态。
- `node:sqlite` 在当前 Node 版本仍打印 experimental warning，因此只有显式选择 `BLACKX_STAGE_JOB_QUEUE_DRIVER=sqlite` 时才动态加载。若运行时或部署政策不接受该状态，应替换为固定版本、已审计的数据库 Driver。
- 心跳丢失后无法强制中止已经发出的 Provider 请求；Worker 会丢弃结果，Tool 副作用仍由 Tool Execution Ledger 幂等保护。
- Outbox 和业务 Event 已在本地 Event Store 原子提交，但生产数据库 Event Store、跨主机 Dispatcher ownership、Outbox 历史清理和告警仍未实现。

## 迁移与退出条件

- Event Store 文件 Schema 从 v2 读取兼容并在下一次写入升级为 v3；v3 同时持久化 `events` 与 `outbox`。
- 生产多主机部署前，以相同 `StageJobQueue` Contract 增加 PostgreSQL 或托管 Queue Adapter，并验证跨进程竞争、数据库断连、时钟偏差、Dispatcher 并发和容量指标。
- 固定回归必须覆盖 Event/Outbox 原子性、投递后 ACK 前崩溃、租约续期、重新分配、旧租约 fencing、累计失败指标、租户隔离和审计 redrive。
- Sub-agent、通用 Background Task 和 Agent Teams 不由本 ADR 引入；它们必须在单 Agent Baseline 上用固定 Eval 证明收益后单独决策。
