import { expect, it } from "vitest";
import { RuntimeActivityStore } from "./runtimeActivity";
it("isolates live output by tenant/workspace/run and removes closed subscribers", () => {
	const store = new RuntimeActivityStore();
	const scope = { tenantId: "t", workspaceId: "w", runId: "r" };
	const events: unknown[] = [];
	const stop = store.subscribe(scope, (event) => events.push(event));
	const event = { executionId: "x", phase: "model" as const, updatedAt: "now", partialText: "hello" };
	store.observe({ ...scope, tenantId: "other" }, event);
	expect(events).toEqual([]); expect(store.get(scope)).toBeNull();
	store.observe(scope, event); expect(events).toEqual([event]);
	stop(); store.observe(scope, { ...event, phase: "failed", partialText: undefined });
	expect(events).toHaveLength(1); expect(store.get(scope)?.partialText).toBeUndefined();
});

it("keeps partial model text transient when a live turn is cancelled", async () => {
	const { BlackxAgentRuntime } = await import("./agentRuntime");
	const { InMemoryAgentStateStore } = await import("../../src/agent/state");
	const { SkillRegistry } = await import("../../src/agent/skills");
	const sessions = new InMemoryAgentStateStore(); const store = new RuntimeActivityStore();
	let started!: () => void; const streaming = new Promise<void>((resolve) => { started = resolve; });
	let release!: () => void; const pending = new Promise<void>((resolve) => { release = resolve; });
	const controller = new AbortController();
	const scope = { tenantId: "t", workspaceId: "w", runId: "r", sessionId: "s" };
	const runtime = new BlackxAgentRuntime({ sessions, snapshots: sessions, skills: new SkillRegistry(), onActivity: (scope, event) => store.observe(scope, event), provider: { async generate(request) {
		await request.onText?.("unfinished preview"); started(); await pending;
		return { text: "late final answer", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, reasoningOutputTokens: 0 } };
	} } });
	const turn = runtime.executeTurn({ ...scope, actorId: "a", stageId: "conversation", idempotencyKey: "m1", instructions: [], skills: [], input: "Read document", fallbackOutput: "", policy: { sandboxMode: "read-only", approvalPolicy: "never", timeoutMs: 10_000 } }, controller.signal);
	await streaming;
	expect(store.get(scope)?.partialText).toBe("unfinished preview");
	controller.abort(); await expect(turn).rejects.toMatchObject({ code: "cancelled" }); release();
	expect(store.get(scope)).toMatchObject({ phase: "failed" }); expect(store.get(scope)?.partialText).toBeUndefined();
	expect(sessions.load(scope).messages.some((message) => message.role === "assistant")).toBe(false);
});
