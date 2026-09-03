# M2：首个真实产品纵向闭环

状态：Planned
更新日期：2026-09-03
前置条件：M1 Durable Single-Agent Runtime 完成

## 1. 目标

把 M1 的行业无关 Runtime 用在一个真实、可重复验收的用户任务上。M2 不以“通用聊天 Agent”为目标，而以一个有明确输入、工具、Artifact、Evaluator 和完成 Gate 的闭环为目标。

在最终产品方向冻结前，采用以下参考闭环：

```text
用户提交研究目标和资料
→ Agent 提取带来源的候选 Fact
→ 使用受控检索/读取 Tool 收集证据
→ 生成 Evidence-backed Report Artifact
→ 确定性 Schema/Citation/Lineage Evaluation
→ 用户确认关键 Fact 或批准 Artifact Version
→ 导出或交付最终报告
```

产品负责人确认新的具体产品想法后，可以替换该 Fixture，但不得删除同等的事实、证据、评测、恢复和权限 Gate。

## 2. 最小产品范围

- 一个明确用户角色和一个高频任务
- 一种主要输入方式和一种可交付 Artifact
- 3–5 个受控 Tool；每个 Tool 有 Schema、风险、权限、超时、重试和结果大小限制
- 字段级 Fact 生命周期：来源、状态、版本、确认/拒绝和依赖失效
- 一个确定性 Evaluator；LLM Judge 只能补充，不能单独判定完成
- 一个必要的人工确认或 Approval Gate
- UI 支持创建任务、观察进度、查看 Artifact、处理确认以及重试/取消
- 10–20 个固定 Eval Task，用同模型、预算和工具集比较回归

不包含：

- 多 Agent、Agent Teams 或开放式 Agent Marketplace
- Agent 自行修改生产代码、Policy、Evaluator 或权限
- 自动发布高风险外部副作用
- 为尚未出现的规模提前建设分布式平台

## 3. 产品完成证据

- 至少 10 个固定任务可重复运行并生成符合 Schema 的 Artifact
- 完成率、证据引用率、工具失败率、恢复率、Token/成本和耗时有基线
- 未验证 Fact 不会被表示为权威结论
- Artifact 依赖变化后旧版本变为 `stale`，旧 Approval 失效
- 进程重启后任务可以继续，已完成副作用不重复
- 用户能从 UI 理解任务当前状态、失败原因和下一步动作
- 真实 Provider Eval 与离线 Fake Eval 分离
- 至少一次从创建任务到批准/交付 Artifact 的真实浏览器验收

## 4. M2 的存储边界

M2 默认仍允许单机部署，因为它的目标是验证产品价值而不是基础设施规模。必须保留：

- 持久备份和可执行恢复演练
- 数据 Schema 版本与迁移脚本
- 租户/Workspace 复合键
- 幂等写入和乐观并发
- Store/Queue/Object Port，不把本地路径泄漏到业务层

如果 M2 开始服务外部用户或部署为多实例，生产存储升级成为上线前 Gate：

```text
PostgreSQL          → Event、Run、Fact、Artifact metadata、Approval、Audit
S3-compatible store → Artifact body、附件和大 Tool Result
Managed Queue 或 PostgreSQL job table
                    → Worker delivery、lease、retry 和 DLQ
Transactional Outbox
                    → 数据提交与异步投递之间的一致性
```

Redis 不是默认依赖；只有缓存、短租约或限流指标证明需要时再引入。不得跨 PostgreSQL、对象存储和 Queue 追求全局分布式事务，使用版本化状态、Outbox、幂等消费者和补偿/回收任务收敛一致性。

## 5. M2 退出条件

出现以下任一情况时停止扩展框架，先修复产品闭环：

- 用户任务和 Artifact 无法清晰定义
- Evaluator 无法区分成功与“看起来不错”
- 新抽象不能提高固定 Eval 的完成率、恢复率或安全性
- Tool 权限或事实来源无法审计
- 单 Agent Baseline 尚未稳定，却开始增加多 Agent 或 RSI
