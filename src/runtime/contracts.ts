export type RuntimeAdapterKind = "fake" | "blackx-agent" | "client-fallback";

export type RuntimeFailureCode =
  | "authentication"
  | "rate_limit"
	| "model_failure"
  | "timeout"
  | "cancelled"
  | "invalid_output"
	| "context_failure"
	| "budget_exceeded"
	| "permission_denied"
	| "max_iterations"
	| "session_conflict"
	| "infrastructure_failure"
  | "runtime_unavailable"
  | "execution_failed";

export interface RuntimeUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export type RuntimeExecutionEvent =
	| { type: "session.started"; sessionId: string }
	| { type: "turn.started" }
	| { type: "context.snapshot.saved"; snapshotId: string; iteration: number }
	| { type: "context.compacted"; removedMessages: number; summaries: number }
	| { type: "message.completed"; text: string }
	| { type: "tool.started"; tool: string; toolCallId: string; risk: "read" | "write" | "publish"; idempotencyKey: string }
	| {
		type: "tool.completed";
		tool: string;
		toolCallId: string;
		risk: "read" | "write" | "publish";
		status: "succeeded" | "failed" | "denied" | "unknown";
		failureCode?: string;
		durationMs: number;
		resultTruncated: boolean;
		replayed: boolean;
	}
	| { type: "turn.checkpointed"; reason: "iteration_slice_limit"; iterations: number }
	| { type: "turn.completed"; usage: RuntimeUsage; iterations: number }
  | { type: "turn.failed"; message: string };

export interface RuntimeTurnRequest {
  tenantId: string;
  workspaceId: string;
  runId: string;
  stageId: string;
	actorId: string;
  idempotencyKey: string;
	contextSnapshotId?: string;
	sessionId?: string;
	resume?: boolean | "if-present";
	instructions?: string[];
	skills?: string[];
	allowedTools?: string[];
  input: string;
  outputSchema?: Record<string, unknown>;
  fallbackOutput: string;
  policy: {
		sandboxMode: "read-only" | "workspace-write";
		approvalPolicy: "never" | "required";
    timeoutMs: number;
  };
}

export interface RuntimeTurnResult {
  executionId: string;
  adapter: RuntimeAdapterKind;
	status: "completed" | "paused";
	sessionId?: string;
	contextSnapshotId?: string;
  finalResponse: string;
  events: RuntimeExecutionEvent[];
  usage?: RuntimeUsage;
}

export interface RuntimeHealth {
	adapter: RuntimeAdapterKind;
	online: boolean;
	coreVersion?: string;
}

export interface AgentRuntimePort {
  health(): Promise<RuntimeHealth>;
  executeTurn(
    request: RuntimeTurnRequest,
    signal?: AbortSignal,
  ): Promise<RuntimeTurnResult>;
}

export class RuntimeFailure extends Error {
  readonly code: RuntimeFailureCode;
  readonly retryable: boolean;

  constructor(
    code: RuntimeFailureCode,
    message: string,
    retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RuntimeFailure";
    this.code = code;
    this.retryable = retryable;
  }
}
