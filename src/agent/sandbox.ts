export type ToolSandboxStatus =
	| "succeeded"
	| "failed"
	| "timed_out"
	| "cancelled"
	| "resource_exhausted"
	| "policy_denied"
	| "sandbox_unavailable";

export interface ToolExecutionManifest {
	schemaVersion: "tool-execution-manifest.v1";
	attemptId: string;
	tenantId: string;
	workspaceId: string;
	runId: string;
	stageId: string;
	executionId: string;
	toolCallId: string;
	tool: {
		name: string;
		version: string;
	};
	sandboxProfile: "blackx-local-tool-sandbox.v1";
	command: {
		executable: string;
		argv: readonly string[];
		workingDirectory: string;
	};
	paths: {
		readOnly: readonly string[];
		writable: readonly string[];
		temporaryDirectory: string;
	};
	environment: Readonly<Record<string, string>>;
	network: {
		mode: "deny-all" | "allowlist";
		allowedDomains: readonly string[];
	};
	limits: {
		timeoutMs: number;
		maxStdoutBytes: number;
		maxStderrBytes: number;
		maxOutputFiles: number;
		maxOutputBytes: number;
	};
	idempotencyKey: string;
	approvalId?: string;
}

export interface ToolExecutionOutput {
	path: string;
	size: number;
	mimeType: string;
	sha256: string;
}

export interface ToolExecutionResult {
	schemaVersion: "tool-execution-result.v1";
	attemptId: string;
	status: ToolSandboxStatus;
	exitCode: number | null;
	startedAt: string;
	completedAt: string;
	durationMs: number;
	stdout: { text: string; truncated: boolean };
	stderr: { text: string; truncated: boolean };
	outputs: readonly ToolExecutionOutput[];
	sandbox: {
		profile: ToolExecutionManifest["sandboxProfile"];
		platform: string;
		terminationReason?: string;
		permissions: {
			readOnlyPaths: number;
			writablePaths: number;
			network: ToolExecutionManifest["network"]["mode"];
			environmentKeys: readonly string[];
		};
	};
}

export interface SandboxedToolExecutorPort {
	execute(manifest: ToolExecutionManifest, signal: AbortSignal): Promise<ToolExecutionResult>;
}
