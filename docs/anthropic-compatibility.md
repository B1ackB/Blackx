# Anthropic Messages 出站兼容矩阵

状态：Offline Contract Implemented / DeepSeek Online Contract Passed
更新日期：2026-09-02

## 边界

```text
Blackx Agent Core
→ AgentModelProvider
→ AnthropicModelProvider
→ Anthropic Messages compatible provider
```

这是 Runtime Infrastructure Adapter，不是 Blackx 对外 API。`ANTHROPIC_API_KEY` 仅由服务端 Client 使用，不进入 Agent Session、ContextSnapshot、业务 Prompt、Artifact、Event 或浏览器。Agent Loop 由 Blackx 自研 Core 所有；Print Domain 和 Enterprise Layer 不引用 Anthropic DTO。

Provider 返回的 `thinking` / `redacted_thinking` content block 作为 opaque `providerState` 与 assistant 消息绑定，进入 Agent Session、ContextSnapshot 和用于快照的内部 `model.before` 事件，并在同一模型的下一次请求中原样回传。它不进入 `model.after`、Runtime 响应或 Artifact；日志型 Hook 必须丢弃该字段。Agent Core 不解析其中内容。

Compact Summarizer 是无 Tool 的辅助调用，显式请求 provider-neutral `reasoning: disabled`；Anthropic-compatible Adapter 将其映射为 `thinking: { type: "disabled" }`，避免摘要消耗主循环的 thinking 预算。主 Agent Loop 不设置该字段，仍保存并回传 Provider 的 signed thinking block。

## 当前能力矩阵

| 能力 | 状态 | 当前证据 / 限制 |
| --- | --- | --- |
| system | offline-supported | 映射为 Anthropic 顶层 `system` 文本块 |
| user / assistant 文本 | offline-supported | 映射为 Messages content text block |
| Tool schema | offline-supported | Tool Schema 映射为 `input_schema`，保留名称、描述和 strict |
| Tool Call / Result | offline-supported | Blackx Tool Call ID 映射为 `tool_use.id` / `tool_result.tool_use_id` |
| JSON Schema 输出 | provider-dependent | 同时发送 `output_config.format` 和系统约束；消费端仍做 Schema 校验和确定性 fallback |
| 文本与 Tool Use 输出 | offline-supported | 转成统一的 `AgentModelResponse`，Provider DTO 不向上泄漏 |
| Usage / Cache / Thinking | online-supported | 映射 input、output、cache read 与 thinking token；带签名的 thinking block 原样跨 Tool Loop 回传 |
| Token Count | online-supported | 使用 `POST /v1/messages/count_tokens`；DeepSeek 真实 Contract 已通过 |
| stop reason | offline-supported | context window、max tokens、refusal 和 pause turn 均映射为结构化 Runtime Failure |
| 流式输出 | supported（本地协议回归） | Agent 请求 SSE；逐步显示 text delta，重组 thinking/signature/tool input，完整 message_stop 后提交；JSON 兼容响应按整段展示。真实厂商当前端点仍需独立 Online Gate，见 ADR-0014。 |
| PNG / JPEG / WebP / GIF 图片输入 | offline-supported | `AgentMessage` 图片引用在调用前从租户附件 Store 重水化，并映射为 Anthropic `image/base64`；Base64 不进入 Session、ContextSnapshot 或 Trace；尚未经过 DeepSeek 在线图片 Gate |
| PDF、其他文件、音频 | unsupported | 文件可持久化和追溯，但尚无文档解析、OCR 或音频内容块 Adapter |
| 内建 Web/Search/Computer Tool | unsupported | 首个切片只接受注册的强类型 Tool |
| 限流、认证、取消 | offline-supported | 401/403、429、Provider 4xx/5xx 和 Abort 边界已映射；尚未逐类注入在线失败 |
| Session 恢复 | core-owned | Session/ContextSnapshot 由 Blackx Store 恢复，不依赖 Provider 会话 |

`offline-supported` 只表示映射和 Contract Test 通过，不表示任何第三方端点已经通过真实连接验证。

## 运行方式

启动兼容路径：

```bash
BLACKX_RUNTIME_MODE=anthropic \
ANTHROPIC_BASE_URL="通过安全环境注入" \
ANTHROPIC_MODEL="目标端点声明的模型 ID" \
ANTHROPIC_API_KEY="通过安全环境注入" \
npm run dev
```

在另一终端执行固定 Online Eval：

```bash
BLACKX_EVAL_BASE_URL=http://127.0.0.1:5173 npm run eval:online
```

报告只输出检查结果、Adapter 与标准化 Usage，不输出 Key 或 Provider 正文。真实 DeepSeek `deepseek-v4-flash` Contract 已验证摘要 Compact、带 thinking 的 Tool Call/Result 多轮循环、Token Count、Usage 与 Context Snapshot。DeepSeek 是当前唯一 Online Provider Gate；这份证据不代表生产就绪。

Failure 报告只把 Provider 实际 HTTP 状态记为 `providerStatus`；Adapter 在收到 HTTP 200 后发现响应不符合 Contract 时使用 `adapterStatus`，避免把本地合成的 502 误报为上游 HTTP 502。
