import type {
	AgentContextSummarizer,
	AgentMessage,
	AgentModelProvider,
	AgentRunInput,
	AgentRunResult,
	AgentTool,
	AgentToolApprovalPort,
	AgentToolAuditPort,
	AgentToolExecution,
	AgentToolExecutionContext,
	AgentToolExecutionRecord,
	AgentToolExecutionStore,
	AgentToolFailureCode,
	AgentUsage,
} from "./contracts";
import { AgentCoreError } from "./contracts";
import { compactSummaryPrefix, ContextEngine } from "./context";
import { AgentHooks } from "./hooks";
import type {
	SandboxedToolExecutorPort,
	ToolExecutionManifest,
	ToolExecutionResult,
} from "./sandbox";
import { ModelContextSummarizer } from "./summarizer";

const emptyUsage = (): AgentUsage => ({
	inputTokens: 0,
	cachedInputTokens: 0,
	outputTokens: 0,
	reasoningOutputTokens: 0,
});

function addUsage(total: AgentUsage, next: AgentUsage): void {
	total.inputTokens += next.inputTokens;
	total.cachedInputTokens += next.cachedInputTokens;
	total.outputTokens += next.outputTokens;
	total.reasoningOutputTokens += next.reasoningOutputTokens;
}

export async function abortable<Value>(promise: Promise<Value>, signal: AbortSignal): Promise<Value> {
	if (signal.aborted) throw signal.reason;
	return new Promise<Value>((resolve, reject) => {
		const aborted = () => reject(signal.reason);
		signal.addEventListener("abort", aborted, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
	});
}

function toolOutput(value: unknown, maxChars: number): { text: string; truncated: boolean } {
	let output: string;
	if (typeof value === "string") output = value;
	else {
		try {
			output = JSON.stringify(value) ?? "Tool returned no serializable result";
		} catch {
			output = "Tool returned a non-serializable result";
		}
	}
	return output.length <= maxChars
		? { text: output, truncated: false }
		: { text: `${output.slice(0, maxChars)}\n[tool result truncated]`, truncated: true };
}

function toolFailure(code: AgentToolFailureCode, message: string): string {
	return JSON.stringify({ ok: false, error: { code, message } });
}

function validToolInput(tool: AgentTool, input: unknown): boolean {
	try {
		return tool.validate(input);
	} catch {
		return false;
	}
}

function validSandboxManifest(
	manifest: ToolExecutionManifest,
	tool: AgentTool,
	context: AgentToolExecutionContext & { sandboxAttemptId: string },
): boolean {
	return manifest.schemaVersion === "tool-execution-manifest.v1" &&
		manifest.attemptId === context.sandboxAttemptId &&
		manifest.tenantId === context.tenantId &&
		manifest.workspaceId === context.workspaceId &&
		manifest.runId === context.runId &&
		manifest.stageId === context.stageId &&
		manifest.executionId === context.executionId &&
		manifest.toolCallId === context.toolCallId &&
		manifest.tool.name === tool.name &&
		manifest.tool.version.trim().length > 0 &&
		manifest.sandboxProfile === "blackx-local-tool-sandbox.v1" &&
		manifest.command.executable.trim().length > 0 &&
		manifest.command.workingDirectory.trim().length > 0 &&
		Array.isArray(manifest.command.argv) && manifest.command.argv.every((value) => typeof value === "string") &&
		manifest.paths.temporaryDirectory.trim().length > 0 &&
		Array.isArray(manifest.paths.readOnly) && manifest.paths.readOnly.every((value) => value.trim().length > 0) &&
		Array.isArray(manifest.paths.writable) && manifest.paths.writable.every((value) => value.trim().length > 0) &&
		Object.entries(manifest.environment).every(([key, value]) => key.trim().length > 0 && typeof value === "string") &&
		Array.isArray(manifest.network.allowedDomains) &&
		(manifest.network.mode === "allowlist" || manifest.network.allowedDomains.length === 0) &&
		manifest.network.allowedDomains.every((value) => value.trim().length > 0) &&
		manifest.limits.timeoutMs === tool.timeoutMs &&
		manifest.limits.maxStdoutBytes > 0 &&
		manifest.limits.maxStderrBytes > 0 &&
		manifest.limits.maxOutputFiles >= 0 &&
		manifest.limits.maxOutputBytes >= 0 &&
		manifest.idempotencyKey === context.idempotencyKey &&
		manifest.approvalId === context.approvalId;
}

function safeOutputPath(value: string): boolean {
	return value.length > 0 &&
		!value.startsWith("/") &&
		!value.startsWith("\\") &&
		!value.includes("\0") &&
		!value.split(/[\\/]/).includes("..");
}

function validSandboxResult(result: ToolExecutionResult, manifest: ToolExecutionManifest): boolean {
	const environmentKeys = Object.keys(manifest.environment).sort();
	const reportedEnvironmentKeys = [...result.sandbox.permissions.environmentKeys].sort();
	const outputBytes = result.outputs.reduce((total, output) => total + output.size, 0);
	return result.schemaVersion === "tool-execution-result.v1" &&
		result.attemptId === manifest.attemptId &&
		result.sandbox.profile === manifest.sandboxProfile &&
		result.sandbox.platform.trim().length > 0 &&
		result.sandbox.permissions.readOnlyPaths === manifest.paths.readOnly.length &&
		result.sandbox.permissions.writablePaths === manifest.paths.writable.length &&
		result.sandbox.permissions.network === manifest.network.mode &&
		JSON.stringify(reportedEnvironmentKeys) === JSON.stringify(environmentKeys) &&
		Number.isFinite(result.durationMs) && result.durationMs >= 0 &&
		Number.isFinite(Date.parse(result.startedAt)) &&
		Number.isFinite(Date.parse(result.completedAt)) &&
		new TextEncoder().encode(result.stdout.text).length <= manifest.limits.maxStdoutBytes &&
		new TextEncoder().encode(result.stderr.text).length <= manifest.limits.maxStderrBytes &&
		result.outputs.length <= manifest.limits.maxOutputFiles &&
		outputBytes <= manifest.limits.maxOutputBytes &&
		result.outputs.every((output) =>
			safeOutputPath(output.path) &&
			Number.isSafeInteger(output.size) && output.size >= 0 &&
			output.mimeType.trim().length > 0 &&
			/^[a-f0-9]{64}$/.test(output.sha256)
		) &&
		(result.status !== "succeeded" || result.exitCode === 0);
}

function sandboxFailure(status: Exclude<ToolExecutionResult["status"], "succeeded">): {
	code: AgentToolFailureCode;
	message: string;
} {
	switch (status) {
		case "timed_out": return { code: "tool_timeout", message: "Sandboxed Tool execution timed out" };
		case "cancelled": return { code: "tool_cancelled", message: "Sandboxed Tool execution was cancelled" };
		case "resource_exhausted": return { code: "tool_resource_exhausted", message: "Sandboxed Tool exceeded a resource limit" };
		case "policy_denied": return { code: "tool_sandbox_policy_denied", message: "Sandbox policy denied Tool execution" };
		case "sandbox_unavailable": return { code: "tool_sandbox_unavailable", message: "Native Tool Sandbox is unavailable" };
		case "failed": return { code: "tool_execution_failed", message: "Sandboxed Tool execution failed" };
	}
}

function nestedCode(error: unknown): string | undefined {
	let current = error;
	for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
		if ("code" in current && typeof current.code === "string") return current.code;
		current = current.cause;
	}
	return undefined;
}

async function digest(value: string): Promise<string> {
	const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return `sha256:${Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function receipt(records: readonly AgentToolExecutionRecord[]): AgentMessage {
	return {
		role: "user",
		content: [
			"[Deterministic tool execution receipts; authoritative values come from the execution ledger]",
			JSON.stringify(records.map((record) => ({
				actorId: record.actorId,
				executionId: record.executionId,
				tool: record.tool,
				toolCallId: record.toolCallId,
				idempotencyKey: record.idempotencyKey,
				status: record.status,
				approvalId: record.approvalId,
				inputDigest: record.inputDigest,
				resultDigest: record.resultDigest,
				failureCode: record.failureCode,
			}))),
		].join("\n"),
		pinned: true,
		durable: true,
	};
}

export interface AgentLoopOptions {
	provider: AgentModelProvider;
	tools?: readonly AgentTool[];
	hooks?: AgentHooks;
	context?: ContextEngine;
	summarizer?: AgentContextSummarizer;
	approval?: AgentToolApprovalPort;
	audit?: AgentToolAuditPort;
	executions?: AgentToolExecutionStore;
	sandboxedToolExecutor?: SandboxedToolExecutorPort;
	maxIterations?: number;
	maxToolExecutions?: number;
	maxInputTokens?: number;
	compactTriggerTokens?: number;
	compactTargetTokens?: number;
	now?: () => string;
}

export class AgentLoop {
	private readonly tools: Map<string, AgentTool>;
	private readonly hooks: AgentHooks;
	private readonly context: ContextEngine;
	private readonly summarizer: AgentContextSummarizer;
	private readonly maxIterations: number;
	private readonly maxToolExecutions: number;
	private readonly maxInputTokens: number;
	private readonly compactTriggerTokens: number;
	private readonly compactTargetTokens: number;
	private readonly now: () => string;

	constructor(private readonly options: AgentLoopOptions) {
		this.tools = new Map((options.tools ?? []).map((tool) => [tool.name, tool]));
		this.hooks = options.hooks ?? new AgentHooks();
		this.context = options.context ?? new ContextEngine();
		this.summarizer = options.summarizer ?? new ModelContextSummarizer(options.provider);
		this.maxIterations = options.maxIterations ?? 32;
		this.maxToolExecutions = options.maxToolExecutions ?? 64;
		this.maxInputTokens = options.maxInputTokens ?? 100_000;
		this.compactTriggerTokens = options.compactTriggerTokens ?? Math.floor(this.maxInputTokens * 0.7);
		this.compactTargetTokens = options.compactTargetTokens ?? Math.floor(this.maxInputTokens * 0.45);
		this.now = options.now ?? (() => new Date().toISOString());
	}

	private modelRequest(messages: readonly AgentMessage[], tools: readonly AgentTool[], input: AgentRunInput) {
		return {
			messages,
			tools,
			outputSchema: input.outputSchema,
			fallbackOutput: input.fallbackOutput,
		};
	}

	private async countTokens(messages: readonly AgentMessage[], tools: readonly AgentTool[], input: AgentRunInput, signal?: AbortSignal) {
		const request = this.modelRequest(messages, tools, input);
		if (!this.options.provider.countTokens) return Math.ceil(this.context.size(messages) / 4);
		try {
			return await this.options.provider.countTokens(request, signal);
		} catch (error) {
			throw new AgentCoreError("model_failure", "Model token count failed", true, { cause: error });
		}
	}

	async run(input: AgentRunInput, signal?: AbortSignal): Promise<AgentRunResult> {
		const allowedTools = input.allowedTools.map((name) => {
			const tool = this.tools.get(name);
			if (!tool) throw new AgentCoreError("permission_denied", `Unknown allowed tool: ${name}`, false);
			return tool;
		});
		let messages = this.context.compile(input);
		let removedMessages = 0;
		const usage = emptyUsage();
		let compactSummaries = 0;
		const toolExecutions: AgentToolExecution[] = [];
		const compact = async (maxChars?: number): Promise<{ estimatedTokens: number; removedMessages: number }> => {
			await this.hooks.emit({ name: "compact.before", runId: input.runId, messageCount: messages.length });
			const compacted = this.context.compact(messages, maxChars);
			let summary = "";
			if (compacted.removedMessages > 0 && compacted.summaryIndex !== undefined) {
				try {
					const result = await this.summarizer.summarize(compacted.removed, signal);
					summary = result.text.slice(0, 1_200);
					addUsage(usage, result.usage);
					compacted.messages[compacted.summaryIndex] = {
						role: "user",
						content: `${compactSummaryPrefix}\n${summary}`,
					};
					compactSummaries += 1;
				} catch (error) {
					throw new AgentCoreError("context_failure", "Context summarization failed", true, { cause: error });
				}
			}
			messages = compacted.messages;
			removedMessages += compacted.removedMessages;
			const estimatedTokens = await this.countTokens(messages, allowedTools, input, signal);
			await this.hooks.emit({
				name: "compact.after",
				runId: input.runId,
				removedMessages: compacted.removedMessages,
				summary,
				estimatedTokens,
			});
			return { estimatedTokens, removedMessages: compacted.removedMessages };
		};
		try {
			await this.hooks.emit({ name: "loop.started", runId: input.runId });
			for (let iteration = 1; iteration <= this.maxIterations; iteration += 1) {
				if (signal?.aborted) throw signal.reason;
				let estimatedTokens = await this.countTokens(messages, allowedTools, input, signal);
				const estimatedByChars = !this.options.provider.countTokens && this.context.needsCompact(messages);
				if (estimatedByChars || estimatedTokens >= this.compactTriggerTokens) {
					const targetChars = estimatedByChars
						? undefined
						: Math.floor(this.context.size(messages) * this.compactTargetTokens / Math.max(estimatedTokens, 1));
					estimatedTokens = (await compact(targetChars)).estimatedTokens;
				}
				if (estimatedTokens > this.maxInputTokens) {
					throw new AgentCoreError("budget_exceeded", "Context exceeds the model input token budget", false);
				}

				let response;
				for (let attempt = 1; attempt <= 2; attempt += 1) {
					await this.hooks.emit({
						name: "model.before",
						runId: input.runId,
						iteration,
						attempt,
						messages: messages.map((message) => ({ ...message })),
						estimatedTokens,
					});
					try {
						response = await this.options.provider.generate(this.modelRequest(messages, allowedTools, input), signal);
						break;
					} catch (error) {
						if (attempt === 1 && nestedCode(error) === "context_window_exceeded") {
							const targetChars = Math.min(
								Math.floor(this.context.size(messages) * this.compactTargetTokens / Math.max(estimatedTokens, 1)),
								Math.floor(this.context.size(messages) * 0.5),
							);
							const compacted = await compact(targetChars);
							if (compacted.removedMessages > 0) {
								estimatedTokens = compacted.estimatedTokens;
								continue;
							}
						}
						throw new AgentCoreError("model_failure", "Model provider call failed", true, { cause: error });
					}
				}
				if (!response) throw new AgentCoreError("model_failure", "Model provider call failed", true);
				addUsage(usage, response.usage);
				await this.hooks.emit({
					name: "model.after",
					runId: input.runId,
					iteration,
					response: {
						text: response.text,
						toolCalls: response.toolCalls.map((call) => ({ ...call })),
						usage: { ...response.usage },
					},
				});
				messages.push({
					role: "assistant",
					content: response.text,
					createdAt: this.now(),
					toolCalls: response.toolCalls,
					...(response.providerState === undefined ? {} : { providerState: response.providerState }),
				});

				if (response.toolCalls.length === 0) {
					if (!response.text.trim()) throw new Error("Model completed without a final response");
					await this.hooks.emit({ name: "loop.completed", runId: input.runId, iterations: iteration });
					return {
						stopReason: "completed",
						finalText: response.text,
						messages,
						usage,
						iterations: iteration,
						removedMessages,
						compactSummaries,
						toolExecutions,
					};
				}
				if (toolExecutions.length + response.toolCalls.length > this.maxToolExecutions) {
					throw new AgentCoreError("budget_exceeded", `Agent loop exceeded ${this.maxToolExecutions} Tool executions`, false);
				}

				const receiptRecords: AgentToolExecutionRecord[] = [];
				for (const call of response.toolCalls) {
					await this.hooks.emit({ name: "tool.before", runId: input.runId, iteration, call: { ...call } });
					const tool = this.tools.get(call.name);
					const startedAt = Date.now();
					let idempotencyKey = `${input.idempotencyKey}:${call.id}`;
					let status: AgentToolExecution["status"] = "failed";
					let failureCode: AgentToolFailureCode | undefined;
					let approvalId: string | undefined;
					let output = toolFailure("tool_execution_failed", "Tool execution did not produce a result");
					let resultTruncated = false;
					let replayed = false;
					if (!tool || !allowedTools.includes(tool)) {
						failureCode = "tool_not_allowed";
						status = "denied";
						output = toolFailure(failureCode, `Tool is not allowed: ${call.name}`);
					} else if (!validToolInput(tool, call.input)) {
						failureCode = "tool_input_invalid";
						output = toolFailure(failureCode, `Tool input validation failed: ${call.name}`);
					} else {
						if (tool.risk !== "read") {
							if (tool.idempotent && tool.createIdempotencyKey) {
								try {
									idempotencyKey = tool.createIdempotencyKey(call.input, input.idempotencyKey);
								} catch (error) {
									throw new AgentCoreError("infrastructure_failure", "Tool idempotency key generation failed", false, { cause: error });
								}
							}
							if (!tool.idempotent || !tool.createIdempotencyKey || !idempotencyKey.trim() || idempotencyKey.length > 256) {
								failureCode = "tool_not_idempotent";
							} else if (!this.options.executions) {
								failureCode = "tool_execution_store_required";
							} else if (
								input.policy.sandboxMode !== "workspace-write" ||
								input.policy.approvalPolicy !== "required" ||
								!this.options.approval ||
								!this.options.audit
							) {
								failureCode = "tool_approval_required";
							} else {
								let decision;
								try {
									decision = await this.options.approval.authorize({
										tenantId: input.tenantId,
										workspaceId: input.workspaceId,
										runId: input.runId,
										stageId: input.stageId,
										actorId: input.actorId,
										executionId: input.executionId,
										tool: tool.name,
										toolCallId: call.id,
										risk: tool.risk,
										input: call.input,
										idempotencyKey,
									});
								} catch (error) {
									throw new AgentCoreError("infrastructure_failure", "Tool approval lookup failed", true, { cause: error });
								}
								if (
									!decision.approved ||
									!decision.approvalId?.trim() ||
									decision.approvalId.length > 128
								) failureCode = "tool_approval_denied";
								else approvalId = decision.approvalId;
							}
							if (failureCode) {
								status = "denied";
								output = toolFailure(failureCode, `Tool side effect denied: ${tool.name}`);
							}
						}
					}
					if (tool && !failureCode) {
						let ledgerRecord: AgentToolExecutionRecord | undefined;
						if (tool.risk !== "read") {
							try {
								await this.options.audit?.append({
									type: "tool.execution.started",
									tenantId: input.tenantId,
									workspaceId: input.workspaceId,
									runId: input.runId,
									stageId: input.stageId,
									actorId: input.actorId,
									executionId: input.executionId,
									tool: tool.name,
									toolCallId: call.id,
									risk: tool.risk,
									idempotencyKey,
									approvalId,
									occurredAt: this.now(),
								});
								const inputDigest = await digest(JSON.stringify(call.input) ?? "undefined");
								const claimed = await this.options.executions!.claim({
									schemaVersion: "tool-execution.v1",
									tenantId: input.tenantId,
									workspaceId: input.workspaceId,
									runId: input.runId,
									stageId: input.stageId,
									actorId: input.actorId,
									executionId: input.executionId,
									tool: tool.name,
									toolCallId: call.id,
									risk: tool.risk,
									idempotencyKey,
									approvalId: approvalId!,
									inputDigest,
									status: "started",
									startedAt: this.now(),
								});
								ledgerRecord = claimed.record;
								if (claimed.duplicate) {
									replayed = true;
									if (ledgerRecord.inputDigest !== inputDigest) {
										status = "denied";
										failureCode = "tool_idempotency_conflict";
										output = toolFailure(failureCode, "Idempotency key was already used with different Tool input");
									} else if (ledgerRecord.status === "succeeded" && ledgerRecord.result !== undefined) {
										output = ledgerRecord.result;
										status = "succeeded";
									} else {
										status = "unknown";
										failureCode = "tool_execution_unknown";
										output = toolFailure(failureCode, "Earlier Tool execution has an uncertain side effect and requires reconciliation");
									}
								}
							} catch (error) {
								if (error instanceof AgentCoreError) throw error;
								throw new AgentCoreError("infrastructure_failure", "Tool execution ledger write failed", true, { cause: error });
							}
						}
						const timeout = new AbortController();
						let timer: ReturnType<typeof setTimeout> | undefined;
						try {
							if (!replayed) {
								timer = setTimeout(() => timeout.abort(new Error("tool_timeout")), tool.timeoutMs);
								const toolSignal = signal
									? AbortSignal.any([signal, timeout.signal])
									: timeout.signal;
								const executionContext: AgentToolExecutionContext = {
									tenantId: input.tenantId,
									workspaceId: input.workspaceId,
									runId: input.runId,
									stageId: input.stageId,
									actorId: input.actorId,
									executionId: input.executionId,
									toolCallId: call.id,
									idempotencyKey,
									approvalId,
									signal: toolSignal,
								};
								if (tool.execution === "host") {
									const result = toolOutput(
										await abortable(tool.execute(call.input, executionContext), toolSignal),
										tool.maxResultChars,
									);
									output = result.text;
									resultTruncated = result.truncated;
									status = "succeeded";
								} else if (!this.options.sandboxedToolExecutor) {
									failureCode = "tool_sandbox_unavailable";
									status = "failed";
									output = toolFailure(failureCode, "Native Tool Sandbox is unavailable");
								} else {
									const sandboxContext = {
										...executionContext,
										sandboxAttemptId: crypto.randomUUID(),
									};
									const manifest = tool.createManifest(call.input, sandboxContext);
									if (!validSandboxManifest(manifest, tool, sandboxContext)) {
										failureCode = "tool_sandbox_policy_denied";
										status = "denied";
										output = toolFailure(failureCode, "Sandboxed Tool manifest failed Host validation");
									} else {
										const sandboxResult = await abortable(
											this.options.sandboxedToolExecutor.execute(manifest, toolSignal),
											toolSignal,
										);
										if (!validSandboxResult(sandboxResult, manifest)) {
											failureCode = "tool_execution_failed";
											status = tool.risk === "read" ? "failed" : "unknown";
											output = toolFailure(failureCode, "Sandboxed Tool result failed Host validation");
										} else if (sandboxResult.status === "succeeded") {
											const result = toolOutput(sandboxResult, tool.maxResultChars);
											output = result.text;
											resultTruncated = result.truncated;
											status = "succeeded";
										} else {
											const failure = sandboxFailure(sandboxResult.status);
											failureCode = failure.code;
											status = sandboxResult.status === "policy_denied"
												? "denied"
												: sandboxResult.status === "sandbox_unavailable" || tool.risk === "read"
													? "failed"
													: "unknown";
											output = toolFailure(failure.code, failure.message);
										}
									}
								}
							}
						} catch (error) {
							if (signal?.aborted) throw signal.reason;
							if (error instanceof AgentCoreError) throw error;
							failureCode = timeout.signal.aborted
								? "tool_timeout"
								: tool.execution === "sandboxed"
									? "tool_sandbox_unavailable"
									: "tool_execution_failed";
							status = tool.risk === "read" ? "failed" : "unknown";
							output = toolFailure(
								failureCode,
								failureCode === "tool_timeout"
									? "Tool execution timed out"
									: failureCode === "tool_sandbox_unavailable"
										? "Native Tool Sandbox failed"
										: "Tool execution failed",
							);
						} finally {
							if (timer) clearTimeout(timer);
						}
						if (tool.risk !== "read" && ledgerRecord && !replayed) {
							try {
								ledgerRecord = await this.options.executions!.complete(ledgerRecord, {
									status: status === "succeeded" ? "succeeded" : "unknown",
									result: output,
									resultDigest: await digest(output),
									...(failureCode ? { failureCode } : {}),
									completedAt: this.now(),
								});
							} catch (error) {
								throw new AgentCoreError("infrastructure_failure", "Tool execution ledger completion failed", true, { cause: error });
							}
						}
						if (ledgerRecord) receiptRecords.push(ledgerRecord);
					}
					messages.push({ role: "tool", content: output, toolCallId: call.id });
					const execution: AgentToolExecution = {
						toolCallId: call.id,
						tool: call.name,
						risk: tool?.risk ?? "read",
						status,
						idempotencyKey,
						approvalId,
						failureCode,
						durationMs: Math.max(0, Date.now() - startedAt),
						resultTruncated,
						replayed,
					};
					toolExecutions.push(execution);
					if (tool && tool.risk !== "read" && this.options.audit) {
						try {
							await this.options.audit.append({
								type: "tool.execution.completed",
								tenantId: input.tenantId,
								workspaceId: input.workspaceId,
								runId: input.runId,
								stageId: input.stageId,
								actorId: input.actorId,
								executionId: input.executionId,
								tool: call.name,
								toolCallId: call.id,
								risk: tool.risk,
								idempotencyKey,
								approvalId,
								status,
								failureCode,
								replayed,
								occurredAt: this.now(),
							});
						} catch (error) {
							throw new AgentCoreError("infrastructure_failure", "Tool audit write failed", true, { cause: error });
						}
					}
					await this.hooks.emit({ name: "tool.after", runId: input.runId, iteration, call: { ...call }, failed: status !== "succeeded" });
				}
				if (receiptRecords.length > 0) messages.push(receipt(receiptRecords));
			}
			return {
				stopReason: "slice_limit",
				finalText: "",
				messages,
				usage,
				iterations: this.maxIterations,
				removedMessages,
				compactSummaries,
				toolExecutions,
			};
		} catch (error) {
			await this.hooks.emit({ name: "loop.failed", runId: input.runId, error });
			throw error;
		}
	}
}
