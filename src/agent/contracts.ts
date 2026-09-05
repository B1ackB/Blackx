import type { ToolExecutionManifest } from "./sandbox";

export interface AgentToolCall {
	id: string;
	name: string;
	input: unknown;
}

export interface AgentImageAttachment {
	type: "image";
	name: string;
	mediaType: "image/gif" | "image/jpeg" | "image/png" | "image/webp";
	sourceRef: string;
	sha256: string;
	data?: string;
}

export interface AgentMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string;
	attachments?: AgentImageAttachment[];
	messageId?: string;
	createdAt?: string;
	toolCalls?: AgentToolCall[];
	toolCallId?: string;
	providerState?: unknown;
	pinned?: boolean;
	durable?: boolean;
}

export interface AgentUsage {
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	reasoningOutputTokens: number;
}

export interface AgentModelRequest {
	messages: readonly AgentMessage[];
	tools: readonly AgentToolDefinition[];
	reasoning?: "disabled";
	outputSchema?: Record<string, unknown>;
	fallbackOutput: string;
}

export interface AgentModelResponse {
	text: string;
	toolCalls: AgentToolCall[];
	providerState?: unknown;
	usage: AgentUsage;
}

export interface AgentModelProvider {
	generate(request: AgentModelRequest, signal?: AbortSignal): Promise<AgentModelResponse>;
	countTokens?(request: AgentModelRequest, signal?: AbortSignal): Promise<number>;
}

export interface AgentToolDefinition {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

interface AgentToolBase extends AgentToolDefinition {
	risk: "read" | "write" | "publish";
	idempotent: boolean;
	timeoutMs: number;
	maxResultChars: number;
	validate(input: unknown): boolean;
	createIdempotencyKey?(input: unknown, turnIdempotencyKey: string): string;
}

export interface AgentHostTool extends AgentToolBase {
	execution: "host";
	execute(input: unknown, context: AgentToolExecutionContext): Promise<unknown>;
}

export interface AgentSandboxedTool extends AgentToolBase {
	execution: "sandboxed";
	createManifest(input: unknown, context: AgentSandboxExecutionContext): ToolExecutionManifest;
}

export type AgentTool = AgentHostTool | AgentSandboxedTool;

export type AgentToolFailureCode =
	| "tool_not_allowed"
	| "tool_input_invalid"
	| "tool_not_idempotent"
	| "tool_idempotency_conflict"
	| "tool_approval_required"
	| "tool_approval_denied"
	| "tool_execution_store_required"
	| "tool_timeout"
	| "tool_cancelled"
	| "tool_resource_exhausted"
	| "tool_sandbox_policy_denied"
	| "tool_sandbox_unavailable"
	| "tool_execution_unknown"
	| "tool_execution_failed";

export interface AgentToolExecutionContext {
	tenantId: string;
	workspaceId: string;
	runId: string;
	stageId: string;
	actorId: string;
	executionId: string;
	toolCallId: string;
	idempotencyKey: string;
	approvalId?: string;
	signal: AbortSignal;
}

export interface AgentSandboxExecutionContext extends AgentToolExecutionContext {
	sandboxAttemptId: string;
}

export interface AgentToolExecution {
	toolCallId: string;
	tool: string;
	risk: AgentTool["risk"];
	status: "succeeded" | "failed" | "denied" | "unknown";
	idempotencyKey: string;
	approvalId?: string;
	failureCode?: AgentToolFailureCode;
	durationMs: number;
	resultTruncated: boolean;
	replayed: boolean;
}

export interface AgentToolExecutionKey {
	tenantId: string;
	workspaceId: string;
	tool: string;
	idempotencyKey: string;
}

export interface AgentToolExecutionRecord extends AgentToolExecutionKey {
	schemaVersion: "tool-execution.v1";
	runId: string;
	stageId: string;
	actorId: string;
	executionId: string;
	toolCallId: string;
	risk: "write" | "publish";
	status: "started" | "succeeded" | "unknown";
	approvalId: string;
	inputDigest: string;
	resultDigest?: string;
	result?: string;
	failureCode?: AgentToolFailureCode;
	startedAt: string;
	completedAt?: string;
}

export interface AgentToolExecutionStore {
	claim(record: AgentToolExecutionRecord): Promise<{ record: AgentToolExecutionRecord; duplicate: boolean }>;
	complete(
		key: AgentToolExecutionKey,
		completion: Pick<AgentToolExecutionRecord, "status" | "result" | "resultDigest" | "failureCode" | "completedAt">,
	): Promise<AgentToolExecutionRecord>;
	find(key: AgentToolExecutionKey): Promise<AgentToolExecutionRecord | undefined>;
}

export interface AgentToolApprovalPort {
	authorize(request: {
		tenantId: string;
		workspaceId: string;
		runId: string;
		stageId: string;
		actorId: string;
		executionId: string;
		tool: string;
		toolCallId: string;
		risk: "write" | "publish";
		input: unknown;
		idempotencyKey: string;
	}): Promise<{ approved: boolean; approvalId?: string }>;
}

export interface AgentToolAuditEvent {
	type: "tool.execution.started" | "tool.execution.completed";
	tenantId: string;
	workspaceId: string;
	runId: string;
	stageId: string;
	actorId: string;
	executionId: string;
	tool: string;
	toolCallId: string;
	risk: AgentTool["risk"];
	idempotencyKey: string;
	approvalId?: string;
	status?: AgentToolExecution["status"];
	failureCode?: AgentToolFailureCode;
	replayed?: boolean;
	occurredAt: string;
}

export interface AgentToolAuditPort {
	append(event: AgentToolAuditEvent): void | Promise<void>;
}

export interface AgentContextSummary {
	text: string;
	usage: AgentUsage;
}

export interface AgentContextSummarizer {
	summarize(messages: readonly AgentMessage[], signal?: AbortSignal): Promise<AgentContextSummary>;
}

export type AgentCoreFailureCode =
	| "model_failure"
	| "context_failure"
	| "budget_exceeded"
	| "permission_denied"
	| "max_iterations"
	| "infrastructure_failure";

export class AgentCoreError extends Error {
	constructor(
		readonly code: AgentCoreFailureCode,
		message: string,
		readonly retryable: boolean,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "AgentCoreError";
	}
}

export interface AgentSkill {
	name: string;
	version: string;
	description: string;
	instructions: string;
}

export interface AgentRunInput {
	tenantId: string;
	workspaceId: string;
	runId: string;
	stageId: string;
	actorId: string;
	executionId: string;
	idempotencyKey: string;
	instructions: readonly string[];
	skills: readonly AgentSkill[];
	history: readonly AgentMessage[];
	input: string;
	attachments?: readonly AgentImageAttachment[];
	resume?: boolean;
	allowedTools: readonly string[];
	policy: {
		sandboxMode: "read-only" | "workspace-write";
		approvalPolicy: "never" | "required";
	};
	outputSchema?: Record<string, unknown>;
	fallbackOutput: string;
}

export interface AgentRunResult {
	stopReason: "completed" | "slice_limit";
	finalText: string;
	messages: AgentMessage[];
	usage: AgentUsage;
	iterations: number;
	removedMessages: number;
	compactSummaries: number;
	toolExecutions: AgentToolExecution[];
}
