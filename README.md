# Blackx

Blackx 是一个拥有自研 Agent Core、面向可验证交付物的长任务 Agent 产品。Agent Core 与当前 M1 保持行业无关；Print 作为已存在的 Domain Pack 和纵向回归资产保留。

当前产品仅面向包装行业的售前与跟单人员，帮助整理包装袋、纸盒、礼盒、运输包装和包装标签需求。M0 Agent Core、M1 Durable Runtime 和 M2 Requirement Brief 工程链路已建立；当前 M2 评测为 10 个包装案例。此前跨行业样例与真实模型浏览器记录仅作为历史证据，不代表当前包装产品已获真实用户验证。产品可用性、返工改善和付费意愿仍需包装目标用户验证。

2026-09-05 新增本地产品切片：lease 丢失与迟到提交保护、Host 会话身份绑定、真实 macOS `asset_metadata_inspect`、可折叠需求单工作区、安全 Markdown、停止/重试、附件来源页、版本比较以及 Markdown/HTML/JSON 导出。见[实施与验收记录](docs/evidence/local-product-slice-2026-09-05.md)。这是 M3 的一个已验证切片，完整 G0–G6 尚未通过。

## 本地演示

```bash
source ~/.zshrc
npm install
npm run eval:anthropic-contract
BLACKX_RUNTIME_MODE=anthropic npm run dev
```

浏览器打开 Vite 输出的本地地址。左侧可以创建、选择和删除服务端会话；删除需确认，会停止关联任务、暂停定时任务，并取消未完成的需求单。历史资料和已批准交付保留用于审计，普通工作台不再访问；具体语义见 [API 配置](docs/api-configuration.md)。发送消息后，用户消息立即显示，模型回复完成后写回同一个持久 Agent Session。Agent 可在普通 Loop 中自主调用受控 Background/Cron Tools；用户无需选择另一种发送模式。Background Job 进入持久 Stage Job Queue，Cron Schedule 进入独立持久 Store，用户可以切换或新建会话。消息接口明确拒绝 Fake Runtime，必须配置 `ANTHROPIC_API_KEY`、`ANTHROPIC_BASE_URL` 和 `ANTHROPIC_MODEL` 并用 `BLACKX_RUNTIME_MODE=anthropic` 启动；会话管理不需要真实模型。

请使用 Host 输出的 `http://127.0.0.1:<port>` 地址。`npm run dev` 会先编译原生解析器，需要 macOS 和 Apple Command Line Tools；Host 重启后刷新浏览器以取得新的本地会话凭据。PDF 最多解析 100 页 / 8,000 个字符，截断与无文字 PDF 会明确标记；图片当前只保证像素元数据解析。所有提取信息都需要人工确认。

不配置外部模型也可以验收完整工程链路：

```bash
npm ci
npm run check:local
# 或打开隔离测试页面（固定本地响应，临时数据，退出时清理）
npm run dev:fixture
```

页面使用顺序：发送客户需求并上传资料 → 打开“需求单”并生成 → 核对来源和字段 → 逐项确认 → 生成新版本 → 批准当前版本 → 导出。已经批准的任务保持只读；新的需求另建任务。打印版 HTML 可通过浏览器打印为 PDF，导出文件是需求记录，不是生产就绪文件。

右侧“工作区”提供三个页签：需求单、模型调用、文件。模型调用显示配置模型与响应模型、生成与 Token 计数请求次数、成功/失败/取消状态、响应耗时、Token 与缓存统计，可切换当前会话或需求单工作流。文件页支持工作目录/文档/桌面快捷入口、按需展开目录树、打开文本文件与会话快照，点击“交给 Agent”将路径放入聊天草稿。工作目录使用 `BLACKX_WORKSPACE_ROOT`（默认启动目录）。详细口径和验收见 [多功能工作区](docs/evidence/multifunction-workspace-2026-09-05.md)。

Agent 可以操作电脑上的真实文本文件。直接在对话中说“把包装需求保存到我的文档目录”或提供具体文件路径；Agent 查询本机位置并准备内容后，会自动展示“是否允许新建/修改/删除此文件？”的审批卡片，列出绝对路径和修改前后内容。**无需预先添加或授权目录；读取直接执行，所有新建、修改和删除必须逐次批准**。批准仅对这一次路径、内容和版本有效，随后直接操作原路径；拒绝或停止不会修改文件，修改和删除前保留备份。文本最多 128 KiB，二进制文档仍需专用工具。旧会话文件和历史快照也位于本机。见 [即时文件审批](docs/adr/0013-just-in-time-file-approval.md)。

Provider 只运行在 Node.js 服务端；浏览器不会读取 API Key。模型可以在 Proposal Stage 内生成结构化候选建议，但不能创建已验证 Fact、直接改变 Artifact 状态或绕过确定性评测与审批。

固定离线评测可独立运行：

```bash
npm run eval:offline
npm run eval:m1
npm run eval:m2
```

`npm run eval:m1` 会离线贯通 Queue → Worker → Artifact Version → Evaluation → Approval → Stage Gate。M1 真实 DeepSeek Gate 使用 `npm run eval:m1-online`，走同一条企业链路，并要求模型先调用固定只读 Source Tool，再生成经过确定性 Schema、Citation 和 Fact Lineage 检查的 Evidence Report。

`npm run eval:m2` 验证 `requirement-brief.v1` 包装产品 Contract：固定 10 个包装售前需求任务，检查必填缺口、Fact 来源权威性、下一步动作和 Artifact 审批资格。当前报告标识为 `blackx-m2-packaging-workflow-baseline-v3`，不能与旧跨行业基线混同。范围与旧数据兼容见 [ADR-0010](docs/adr/0010-packaging-product-focus.md)。

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
- [M2：包装需求澄清与审批闭环](docs/milestone-2-product-slice.md)
- [M2：合成用户验证样例与证据边界](docs/evidence/m2-synthetic-user-validation-2026-09-05.md)
- [M3：Local Product Hardening 与 Native Sandbox Gate](docs/milestone-3-production-hardening.md)
- [历史 Print Proposal 纵向切片](docs/milestone-1-proposal-slice.md)
