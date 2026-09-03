# M0 Anthropic Provider Contract Evidence — 2026-09-02

状态：DeepSeek Passed / Official Anthropic Out of Scope
已通过端点：`https://api.deepseek.com/anthropic`
已通过模型：`deepseek-v4-flash`

## Contract

命令：

```text
npm run eval:anthropic-contract
```

成功 Gate 必须在同一次真实执行中证明：

- 官方 Token Count 返回正数并进入 ContextSnapshot v2
- 被移除的 transient 历史生成一条非权威 Compact Summary
- 真实模型请求 `contract_probe`
- Harness 执行只读 Tool 并返回对应 Tool Call ID
- 真实模型收到 Tool Result 后输出最终文本
- Usage、ContextSnapshot 和结构化 Runtime Event 完整

## DeepSeek 真实 Contract 结果

DeepSeek 默认返回带签名的 thinking block。Blackx 将完整 assistant content 作为 opaque Provider State 保存，并在 Tool Result 后的下一次模型请求中原样回传。最终执行结果：

```json
{
	"contract": "anthropic-messages-m0-v1",
	"passed": true,
	"model": "deepseek-v4-flash",
	"toolStatus": "succeeded",
	"compactSummaries": 1,
	"iterations": 2,
	"modelCalls": 2,
	"providerStatePersisted": true,
	"usage": {
		"inputTokens": 345,
		"cachedInputTokens": 1536,
		"outputTokens": 126,
		"reasoningOutputTokens": 0
	},
	"estimatedTokens": 563
}
```

这证明同一次真实执行完成 Token Count、一次摘要 Compact、thinking + Tool Use、Tool Result、最终文本、Usage 和 ContextSnapshot。摘要调用显式禁用 thinking；主 Tool Loop 仍保留并持久化 signed thinking Provider State。`reasoningOutputTokens` 为 0 是因为该兼容响应未提供独立 thinking token 明细，不表示没有 thinking block。

## 官方 Anthropic 端点结果

网络限制解除后，请求成功到达 Anthropic 官方端点。端点返回：

```json
{
	"passed": false,
	"failure": {
		"providerCode": "invalid_request_error",
		"providerStatus": 400,
		"reason": "organization disabled"
	}
}
```

API Key 未写入命令、报告、日志或仓库。本结果只能证明网络、认证 Header 和错误映射链路到达真实端点，不能证明 Messages、Token Count、Tool Loop 或摘要 Compact 已通过真实模型。

## Provider Scope

DeepSeek Anthropic-compatible M0 Online Gate 已通过。DeepSeek 是当前唯一 Online Provider Gate；官方 Anthropic 端点结果只保留为历史诊断证据，不再作为 M0/M1 待办。
