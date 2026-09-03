import type {
	AgentContextSummarizer,
	AgentMessage,
	AgentModelProvider,
	AgentTool,
	AgentToolApprovalPort,
	AgentToolAuditPort,
	AgentToolExecutionStore,
} from "../../src/agent/contracts";
import { AgentCoreError } from "../../src/agent/contracts";
import { ContextEngine } from "../../src/agent/context";
import { AgentHooks } from "../../src/agent/hooks";
import { AgentLoop } from "../../src/agent/loop";
import { SkillRegistry } from "../../src/agent/skills";
import {
	AgentStateStoreError,
	InMemoryAgentStateStore,
	type AgentSessionStore,
	type ContextSnapshotStore,
} from "../../src/agent/state";
import type {
	AgentRuntimePort,
	RuntimeHealth,
	RuntimeTraceStore,
	RuntimeTurnRequest,
	RuntimeTurnResult,
} from "../../src/runtime/contracts";
import { RuntimeFailure } from "../../src/runtime/contracts";
import { AnthropicCompatibilityError } from "../anthropic/client";

export interface BlackxAgentRuntimeOptions {
	provider: AgentModelProvider;
	skills: SkillRegistry;
	tools?: readonly AgentTool[];
	hooks?: AgentHooks;
	context?: ContextEngine;
	summarizer?: AgentContextSummarizer;
	approval?: AgentToolApprovalPort;
	audit?: AgentToolAuditPort;
	executions?: AgentToolExecutionStore;
	sessions?: AgentSessionStore;
	snapshots?: ContextSnapshotStore;
	traces?: RuntimeTraceStore;
	maxIterations?: number;
	maxToolExecutions?: number;
	maxInputTokens?: number;
	compactTriggerTokens?: number;
	compactTargetTokens?: number;
	now?: () => string;
	clockMs?: () => number;
}

function classifyFailure(error: unknown, timedOut: boolean, cancelled: boolean): RuntimeFailure {
	if (error instanceof RuntimeFailure) return error;
	if (timedOut) return new RuntimeFailure("timeout", "Agent turn timed out", true, { cause: error });
	if (cancelled) return new RuntimeFailure("cancelled", "Agent turn cancelled", false, { cause: error });
	let cause: unknown = error;
	for (let depth = 0; depth < 4 && cause instanceof Error; depth += 1) {
		if (cause instanceof AnthropicCompatibilityError) {
			if (cause.code === "context_window_exceeded") {
				return new RuntimeFailure("budget_exceeded", "Model context window was exceeded", false, { cause: error });
			}
			if (cause.code === "output_limit" || cause.code === "refusal") {
				return new RuntimeFailure("invalid_output", "Model did not produce a complete usable response", cause.code === "output_limit", { cause: error });
			}
			if (cause.providerStatus === 401 || cause.providerStatus === 403) {
				return new RuntimeFailure("authentication", "Model provider authentication failed", false, { cause: error });
			}
			if (cause.providerStatus === 429) {
				return new RuntimeFailure("rate_limit", "Model provider rate limited", true, { cause: error });
			}
			const status = cause.providerStatus ?? cause.adapterStatus;
			return new RuntimeFailure("model_failure", "Model provider request failed", Boolean(status && status >= 500), { cause: error });
		}
		cause = cause.cause;
	}
	if (error instanceof AgentCoreError) {
		return new RuntimeFailure(error.code, error.message, error.retryable, { cause: error });
	}
	if (error instanceof AgentStateStoreError) {
		if (error.code === "conflict") {
			return new RuntimeFailure("session_conflict", error.message, true, { cause: error });
		}
		return new RuntimeFailure("context_failure", error.message, error.code === "unavailable", { cause: error });
	}
	const message = error instanceof Error ? error.message : "Agent execution failed";
	if (message.includes("without a final response")) {
		return new RuntimeFailure("invalid_output", message, true, { cause: error });
	}
	return new RuntimeFailure("execution_failed", "Agent execution failed", true, { cause: error });
}

async function abortable<Value>(promise: Promise<Value>, signal: AbortSignal): Promise<Value> {
	if (signal.aborted) throw signal.reason;
	return new Promise<Value>((resolve, reject) => {
		const aborted = () => reject(signal.reason);
		signal.addEventListener("abort", aborted, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
	});
}

export class BlackxAgentRuntime implements AgentRuntimePort {
	private readonly sessions: AgentSessionStore;
	private readonly snapshots: ContextSnapshotStore;
	private readonly executions: AgentToolExecutionStore;
	private readonly traces: RuntimeTraceStore;
	private readonly now: () => string;
	private readonly clockMs: () => number;

	constructor(private readonly options: BlackxAgentRuntimeOptions) {
		const memory = new InMemoryAgentStateStore();
		this.sessions = options.sessions ?? memory;
		this.snapshots = options.snapshots ?? memory;
		this.executions = options.executions ?? memory;
		this.traces = options.traces ?? memory;
		this.now = options.now ?? (() => new Date().toISOString());
		this.clockMs = options.clockMs ?? (() => Date.now());
	}

	async health(): Promise<RuntimeHealth> {
		return { adapter: "blackx-agent", online: true, coreVersion: "m0.1" };
	}

	async executeTurn(request: RuntimeTurnRequest, signal?: AbortSignal): Promise<RuntimeTurnResult> {
		if (![request.tenantId, request.workspaceId, request.runId, request.stageId, request.actorId, request.idempotencyKey].every((value) => value.trim())) {
			throw new RuntimeFailure("invalid_output", "Runtime identity and idempotency fields must be non-empty", false);
		}
		if (request.resume && !request.sessionId) {
			throw new RuntimeFailure("invalid_output", "Runtime resume requires a Session ID", false);
		}
		const timeout = new AbortController();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			timeout.abort(new Error("runtime_timeout"));
		}, request.policy.timeoutMs);
		const combinedSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
		const sessionId = request.sessionId ?? `session-${crypto.randomUUID()}`;
		const executionId = crypto.randomUUID();
		const startedAt = this.now();
		const startedMs = this.clockMs();
		let traceEvents: RuntimeTurnResult["events"] = [
			{ type: "session.started", sessionId },
			{ type: "turn.started" },
		];
		const snapshotBaseId = request.contextSnapshotId ?? `context-${executionId}`;
		const scope = {
			tenantId: request.tenantId,
			workspaceId: request.workspaceId,
			runId: request.runId,
			sessionId,
		};

		try {
			const session = this.sessions.load(scope);
			if (request.resume === true && session.revision === 0) {
				throw new RuntimeFailure("context_failure", "Runtime Session does not exist for resume", false);
			}
			const resuming = Boolean(request.resume && session.revision > 0);
			const skills = this.options.skills.resolve(request.skills ?? []);
			let removedMessages = 0;
			let finalContextSnapshotId: string | undefined;
			const observationEvents: RuntimeTurnResult["events"] = [];
			const observe = (event: RuntimeTurnResult["events"][number]) => {
				observationEvents.push(event);
				traceEvents.push(event);
			};
			const modelStarted = new Map<number, number>();
			const hooks = new AgentHooks(this.options.hooks);
			hooks.on("compact.after", (event) => {
				removedMessages += event.removedMessages;
				observe({
					type: "context.compacted",
					removedMessages: event.removedMessages,
					summaries: event.summary ? 1 : 0,
				});
			});
			hooks.on("model.before", (event) => {
				const snapshotId = `${snapshotBaseId}-i${event.iteration}${event.attempt > 1 ? `-retry${event.attempt}` : ""}`;
				const saved = this.snapshots.put({
					schemaVersion: "context-snapshot.v2",
					...scope,
					snapshotId,
					iteration: event.iteration,
					skills: skills.map((skill) => ({ name: skill.name, version: skill.version })),
					messages: event.messages.map((message) => ({ ...message })),
					estimatedChars: event.messages.reduce(
						(total, message) => total
							+ message.content.length
							+ JSON.stringify(message.toolCalls ?? []).length
							+ JSON.stringify(message.providerState ?? null).length,
						0,
					),
					estimatedTokens: event.estimatedTokens,
					removedMessages,
					createdAt: this.now(),
				});
				finalContextSnapshotId = saved.snapshotId;
				observe({ type: "context.snapshot.saved", snapshotId: saved.snapshotId, iteration: saved.iteration });
				modelStarted.set(event.iteration, this.clockMs());
				observe({ type: "model.started", iteration: event.iteration, attempt: event.attempt });
			});
			hooks.on("model.after", (event) => {
				const completedAt = this.clockMs();
				observe({
					type: "model.completed",
					iteration: event.iteration,
					durationMs: Math.max(0, completedAt - (modelStarted.get(event.iteration) ?? completedAt)),
					usage: { ...event.response.usage },
				});
			});
			const loop = new AgentLoop({
				provider: this.options.provider,
				tools: this.options.tools,
				context: this.options.context,
				summarizer: this.options.summarizer,
				approval: this.options.approval,
				audit: this.options.audit,
				executions: this.executions,
				maxIterations: this.options.maxIterations,
				maxToolExecutions: this.options.maxToolExecutions,
				maxInputTokens: this.options.maxInputTokens,
				compactTriggerTokens: this.options.compactTriggerTokens,
				compactTargetTokens: this.options.compactTargetTokens,
				now: this.now,
				hooks,
			});
			const result = await abortable(loop.run({
				tenantId: request.tenantId,
				workspaceId: request.workspaceId,
				runId: request.runId,
				stageId: request.stageId,
				actorId: request.actorId,
				executionId,
				idempotencyKey: request.idempotencyKey,
				instructions: request.instructions ?? [],
				skills,
				history: session.messages,
				input: resuming ? "" : request.input,
				resume: resuming,
				allowedTools: request.allowedTools ?? [],
				policy: request.policy,
				outputSchema: request.outputSchema,
				fallbackOutput: request.fallbackOutput,
			}, combinedSignal), combinedSignal);
			this.sessions.save(
				scope,
				session.revision,
				result.messages
					.filter((message) => !(message.role === "system" && message.pinned))
					.map((message) => ({
						...message,
						pinned: message.durable === true || (result.stopReason === "slice_limit" && message.pinned === true),
					})),
				this.now(),
			);
			const response: RuntimeTurnResult = {
				executionId,
				adapter: "blackx-agent",
				status: result.stopReason === "completed" ? "completed" : "paused",
				sessionId,
				contextSnapshotId: finalContextSnapshotId,
				finalResponse: result.finalText,
				events: [
					{ type: "session.started", sessionId },
					{ type: "turn.started" },
					...observationEvents,
					...result.toolExecutions.flatMap((execution) => [
						{
							type: "tool.started" as const,
							tool: execution.tool,
							toolCallId: execution.toolCallId,
							risk: execution.risk,
							idempotencyKey: execution.idempotencyKey,
						},
						{
							type: "tool.completed" as const,
							tool: execution.tool,
							toolCallId: execution.toolCallId,
							risk: execution.risk,
							status: execution.status,
							failureCode: execution.failureCode,
							durationMs: execution.durationMs,
							resultTruncated: execution.resultTruncated,
							replayed: execution.replayed,
						},
					]),
					...(result.stopReason === "completed"
						? [
							{ type: "message.completed" as const, text: result.finalText },
							{ type: "turn.completed" as const, usage: result.usage, iterations: result.iterations },
						]
						: [{ type: "turn.checkpointed" as const, reason: "iteration_slice_limit" as const, iterations: result.iterations }]),
				],
				usage: result.usage,
			};
			traceEvents = response.events;
			this.traces.putTrace({
				schemaVersion: "runtime-trace.v1",
				tenantId: request.tenantId,
				workspaceId: request.workspaceId,
				runId: request.runId,
				stageId: request.stageId,
				actorId: request.actorId,
				executionId,
				idempotencyKey: request.idempotencyKey,
				status: response.status,
				startedAt,
				completedAt: this.now(),
				durationMs: Math.max(0, this.clockMs() - startedMs),
				sessionId,
				contextSnapshotId: response.contextSnapshotId,
				events: response.events.map((event) => event.type === "message.completed"
					? { ...event, text: "[stored in session]" }
					: event),
				usage: response.usage,
			});
			return response;
		} catch (error) {
			const failure = classifyFailure(error, timedOut, Boolean(signal?.aborted));
			traceEvents = [...traceEvents, { type: "turn.failed", message: failure.message }];
			this.traces.putTrace({
				schemaVersion: "runtime-trace.v1",
				tenantId: request.tenantId,
				workspaceId: request.workspaceId,
				runId: request.runId,
				stageId: request.stageId,
				actorId: request.actorId,
				executionId,
				idempotencyKey: request.idempotencyKey,
				status: "failed",
				startedAt,
				completedAt: this.now(),
				durationMs: Math.max(0, this.clockMs() - startedMs),
				sessionId,
				events: traceEvents,
				failure: { code: failure.code, retryable: failure.retryable, message: failure.message },
			});
			throw failure;
		} finally {
			clearTimeout(timer);
		}
	}
}
