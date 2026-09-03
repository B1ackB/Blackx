import { ContextEngine } from "../src/agent/context";
import { SkillRegistry } from "../src/agent/skills";
import { InMemoryAgentStateStore } from "../src/agent/state";
import { AnthropicMessagesClient } from "../server/anthropic/client";
import { BlackxAgentRuntime } from "../server/runtime/agentRuntime";
import { AnthropicModelProvider } from "../server/runtime/anthropicModelProvider";

class ContractCheckError extends Error {
	constructor(readonly check: string) {
		super(`Anthropic contract check failed: ${check}`);
		this.name = "ContractCheckError";
	}
}

function check(value: unknown, name: string): asserts value {
	if (!value) throw new ContractCheckError(name);
}

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required");
const baseUrl = process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com";
const model = process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001";
const state = new InMemoryAgentStateStore();
const scope = {
	tenantId: "contract-tenant",
	workspaceId: "contract-workspace",
	runId: "anthropic-contract-v1",
	sessionId: `anthropic-contract-${crypto.randomUUID()}`,
};
state.save(scope, 0, [
	{ role: "user", content: "Historical transient note. ".repeat(200) },
	{ role: "assistant", content: "Acknowledged; this remains unverified history." },
], new Date().toISOString());
const provider = new AnthropicModelProvider(
	new AnthropicMessagesClient({ baseUrl, apiKey }),
	model,
	4_096,
);
const runtime = new BlackxAgentRuntime({
	provider,
	tools: [{
		name: "contract_probe",
		description: "Return the supplied nonce. Call this tool exactly once when explicitly requested.",
		inputSchema: {
			type: "object",
			properties: { nonce: { type: "string" } },
			required: ["nonce"],
			additionalProperties: false,
		},
		risk: "read",
		idempotent: true,
		timeoutMs: 5_000,
		maxResultChars: 1_000,
		validate: (input) => Boolean(input) && typeof input === "object" && (input as { nonce?: unknown }).nonce === "blackx-m0",
		execute: async () => ({ ok: true, nonce: "blackx-m0" }),
	}],
	context: new ContextEngine(900),
	skills: new SkillRegistry(),
	sessions: state,
	snapshots: state,
	maxInputTokens: 8_000,
	compactTriggerTokens: 800,
	compactTargetTokens: 500,
});
try {
	const result = await runtime.executeTurn({
		...scope,
		stageId: "provider-contract",
		actorId: "contract-runner",
		idempotencyKey: "anthropic-contract-v1",
		contextSnapshotId: `anthropic-contract-${crypto.randomUUID()}`,
		input: [
			"This is a provider contract test.",
			"Call contract_probe exactly once with nonce blackx-m0.",
			"After receiving the tool result, answer with a short confirmation.",
		].join("\n"),
		allowedTools: ["contract_probe"],
		fallbackOutput: "contract fallback must not be used",
		policy: { sandboxMode: "read-only", approvalPolicy: "never", timeoutMs: 120_000 },
	});
	const completedTool = result.events.find((event) => event.type === "tool.completed");
	const completedTurn = result.events.find((event) => event.type === "turn.completed");
	const compacted = result.events.find((event) => event.type === "context.compacted");
	check(completedTool?.status === "succeeded", "tool.completed");
	check(completedTurn, "turn.completed");
	check(compacted, "compact.event");
	check(compacted.summaries >= 1, "compact.summary");
	check(result.usage && result.usage.inputTokens > 0 && result.usage.outputTokens > 0, "usage.nonzero");
	check(result.contextSnapshotId, "context.snapshot");
	const snapshot = state.read(scope, result.contextSnapshotId);
	check(snapshot.estimatedTokens > 0, "token-count.persisted");
	const providerStatePersisted = state.load(scope).messages.some((message) => (
		message.role === "assistant" && message.providerState !== undefined
	));
	check(providerStatePersisted, "thinking.provider-state.persisted");
	console.log(JSON.stringify({
		contract: "anthropic-messages-m0-v1",
		passed: true,
		model,
		toolStatus: completedTool.status,
		compactSummaries: compacted.summaries,
		iterations: completedTurn?.iterations,
		modelCalls: result.events.filter((event) => event.type === "context.snapshot.saved").length,
		providerStatePersisted,
		usage: result.usage,
		estimatedTokens: snapshot.estimatedTokens,
	}, null, 2));
} catch (error) {
	let providerCode: string | undefined;
	let providerStatus: number | undefined;
	let adapterStatus: number | undefined;
	let contractCheck: string | undefined;
	let current: unknown = error;
	for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
		if ("code" in current && typeof current.code === "string") providerCode = current.code;
		if (current instanceof ContractCheckError) contractCheck = current.check;
		if ("providerStatus" in current && typeof current.providerStatus === "number") {
			providerStatus = current.providerStatus;
		}
		if ("adapterStatus" in current && typeof current.adapterStatus === "number") {
			adapterStatus = current.adapterStatus;
		}
		current = current.cause;
	}
	console.error(JSON.stringify({
		contract: "anthropic-messages-m0-v1",
		passed: false,
		model,
		failure: {
			code: error instanceof Error && "code" in error ? error.code : "contract_failed",
			providerCode,
			providerStatus,
			adapterStatus,
			contractCheck,
		},
	}, null, 2));
	process.exitCode = 1;
}
