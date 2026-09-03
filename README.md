# Blackx

Blackx 是一个拥有自研 Agent Core、面向可验证交付物的长任务 Agent 产品。Agent Core 与当前 M1 保持行业无关；Print 作为已存在的 Domain Pack 和纵向回归资产保留。

当前阶段：M0 Agent Core 与 M1 Durable Single-Agent Runtime 已冻结，并分别通过 DeepSeek Anthropic-compatible Online Gate。自研 Core 已覆盖 Loop、Hook、Context、Skill、Compact、强类型 Tool、持久 Session/ContextSnapshot；Durable Runtime 已覆盖状态机、事件重放、幂等命令、Artifact/Fact Version、Worker slice、Transactional Outbox、单主机 SQLite Queue、Background/Cron、Crash Recovery、持久 Trace 和审批绑定。当前进入 M2 Scope Gate；多主机生产存储和受控 RSI 不在当前实现范围。

## 本地演示

```bash
source ~/.zshrc
npm install
npm run eval:anthropic-contract
BLACKX_RUNTIME_MODE=anthropic npm run dev
```

浏览器打开 Vite 输出的本地地址。左侧可以创建和选择服务端会话；发送消息后，用户消息立即显示，模型回复完成后写回同一个持久 Agent Session。Agent 可在普通 Loop 中自主调用受控 Background/Cron Tools；用户无需选择另一种发送模式。Background Job 进入持久 Stage Job Queue，Cron Schedule 进入独立持久 Store，用户可以切换或新建会话。Conversation API 明确拒绝 Fake Runtime，必须配置 `ANTHROPIC_API_KEY`、`ANTHROPIC_BASE_URL` 和 `ANTHROPIC_MODEL` 并用 `BLACKX_RUNTIME_MODE=anthropic` 启动。

Provider 只运行在 Node.js 服务端；浏览器不会读取 API Key。模型可以在 Proposal Stage 内生成结构化候选建议，但不能创建已验证 Fact、直接改变 Artifact 状态或绕过确定性评测与审批。

固定离线评测可独立运行：

```bash
npm run eval:offline
npm run eval:m1
```

M1 真实 DeepSeek Gate 使用 `npm run eval:m1-online`。它要求模型先调用固定只读 Source Tool，再生成经过确定性 Schema、Citation 和 Fact Lineage 检查的 Evidence Report。

Anthropic Messages Provider Adapter 已具备离线 Contract Test 和明确的能力矩阵；DeepSeek `deepseek-v4-flash` 已通过带 thinking 回传的真实 Tool Loop Contract。官方 Anthropic 端点仍被账户状态阻塞，且兼容 Contract 通过不等于生产完成能力。

真实 Provider Contract 使用 `npm run eval:anthropic-contract`，同时验证 Token Count、摘要 Compact 和 Model → Tool → Model。只有脚本输出 `passed: true` 才算 M0 Online Gate 通过。

Web UI 已移除 `LocalEventStore`、客户端事实投影和本地恢复模拟；实时主链路为 `UI → Conversation API → BlackxAgentRuntime → Context/Skill/Loop → Anthropic-compatible Provider → FileAgentStateStore`。模型可在 Loop 内通过受控 Tool 创建 Background Job 或有限 Cron Schedule，Dispatcher 再把到期 occurrence 投入同一个 Stage Job Queue。Enterprise Kernel 另提供原子 Event Store、Transactional Outbox、SQLite 单主机多 Worker Adapter、指标与 DLQ redrive。当前 Cron 不是任意脚本执行器，也不是 Sub-agent 或多主机分布式 Queue。

## 文档入口

- [开发约束](AGENTS.md)
- [API 配置与 Online Eval 指南](docs/api-configuration.md)
- [架构原则](docs/architecture/principles.md)
- [已确认项目决策](docs/project-decisions.md)
- [产品交互与信息责任模型](docs/product-interaction-model.md)
- [首个纵向切片演示手册](docs/demo-walkthrough.md)
- [Runtime 集成边界](docs/runtime-integration.md)
- [Anthropic Messages 出站兼容矩阵](docs/anthropic-compatibility.md)
- [封口袋标准权威与派生规则](docs/sealing-bag-standards.md)
- [产品路线图](docs/roadmap.md)
- [M0：Blackx Agent Core](docs/milestone-0-agent-core.md)
- [M1：Durable Single-Agent Runtime](docs/milestone-1-durable-runtime.md)
- [M2：首个真实产品纵向闭环](docs/milestone-2-product-slice.md)
- [历史 Print Proposal 纵向切片](docs/milestone-1-proposal-slice.md)
