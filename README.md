# Blackx

Blackx 是一个拥有自研 Agent Core、面向可验证交付物的长任务 Agent 产品。Agent Core 与当前 M1 保持行业无关；Print 作为已存在的 Domain Pack 和纵向回归资产保留。

当前阶段：M0 Agent Core、M1 Durable Single-Agent Runtime 和 M2 Requirement Brief 工程基线已冻结。M2 的 10 个固定正式链路任务、6 个合成售前样例、真实 DeepSeek 浏览器闭环和跨 Run 指标已经留证；没有真实 Print/Furniture 目标用户参与，因此产品可用性、返工改善和付费意愿仍未验证。当前可进入 M3 本地 Native Tool Sandbox 与产品安全加固，但在对外试点、产品价值声明或 RSI 前必须补做真实用户验证。

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
npm run eval:m2
```

`npm run eval:m1` 会离线贯通 Queue → Worker → Artifact Version → Evaluation → Approval → Stage Gate。M1 真实 DeepSeek Gate 使用 `npm run eval:m1-online`，走同一条企业链路，并要求模型先调用固定只读 Source Tool，再生成经过确定性 Schema、Citation 和 Fact Lineage 检查的 Evidence Report。

`npm run eval:m2` 验证 `requirement-brief.v1` 产品 Contract：固定 5 个 Print 与 5 个 Furniture 售前需求任务，并检查必填缺口、Fact 来源权威性、下一步动作和 Artifact 审批资格。

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
- [M2：定制制造需求澄清与审批闭环](docs/milestone-2-product-slice.md)
- [M2：合成用户验证样例与证据边界](docs/evidence/m2-synthetic-user-validation-2026-09-05.md)
- [M3：Local Product Hardening 与 Native Sandbox Gate](docs/milestone-3-production-hardening.md)
- [历史 Print Proposal 纵向切片](docs/milestone-1-proposal-slice.md)
