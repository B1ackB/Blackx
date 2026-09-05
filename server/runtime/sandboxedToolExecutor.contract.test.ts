import { describe, expect, it } from "vitest";
import type {
	AgentModelProvider,
	AgentSandboxedTool,
} from "../../src/agent/contracts";
import { SkillRegistry } from "../../src/agent/skills";
import type {
	ToolExecutionManifest,
	ToolExecutionResult,
} from "../../src/agent/sandbox";
import { BlackxAgentRuntime } from "./agentRuntime";
import { FakeSandboxedToolExecutor } from "./fakeSandboxedToolExecutor";

const usage = {
	inputTokens: 1,
	cachedInputTokens: 0,
	outputTokens: 1,
	reasoningOutputTokens: 0,
};

const request = {
	tenantId: "tenant-1",
	workspaceId: "workspace-1",
	runId: "run-1",
	stageId: "requirement-brief",
	actorId: "user-1",
	idempotencyKey: "turn-1",
	input: "Inspect the asset",
	allowedTools: ["asset_metadata_inspect"],
	fallbackOutput: "done",
	policy: {
		sandboxMode: "read-only" as const,
		approvalPolicy: "never" as const,
		timeoutMs: 1_000,
	},
};

function sandboxTool(overrides: Partial<AgentSandboxedTool> = {}): AgentSandboxedTool {
	const timeoutMs = overrides.timeoutMs ?? 50;
	const tool: AgentSandboxedTool = {
		name: "asset_metadata_inspect",
		description: "Inspect untrusted asset metadata in the Native Tool Sandbox.",
		inputSchema: {
			type: "object",
			properties: { path: { type: "string" } },
			required: ["path"],
			additionalProperties: false,
		},
		execution: "sandboxed",
		risk: "read",
		idempotent: true,
		timeoutMs,
		maxResultChars: 4_000,
		validate: (input) => Boolean(input) && typeof input === "object" &&
			(input as { path?: unknown }).path === "assets/input.png",
		createManifest: (input, context) => ({
			schemaVersion: "tool-execution-manifest.v1",
			attemptId: context.sandboxAttemptId,
			tenantId: context.tenantId,
			workspaceId: context.workspaceId,
			runId: context.runId,
			stageId: context.stageId,
			executionId: context.executionId,
			toolCallId: context.toolCallId,
			tool: { name: tool.name, version: "1.0.0" },
			sandboxProfile: "blackx-local-tool-sandbox.v1",
			command: {
				executable: "/usr/bin/sips",
				argv: ["-g", "pixelWidth", String((input as { path: string }).path)],
				workingDirectory: "/workspace",
			},
			paths: {
				readOnly: ["/workspace/assets/input.png"],
				writable: [],
				temporaryDirectory: "/workspace/.blackx-tmp/attempt",
			},
			environment: { LANG: "C" },
			network: { mode: "deny-all", allowedDomains: [] },
			limits: {
				timeoutMs: tool.timeoutMs,
				maxStdoutBytes: 8_192,
				maxStderrBytes: 8_192,
				maxOutputFiles: 0,
				maxOutputBytes: 0,
			},
			idempotencyKey: context.idempotencyKey,
			approvalId: context.approvalId,
		}),
	};
	return { ...tool, ...overrides };
}

function result(manifest: ToolExecutionManifest, overrides: Partial<ToolExecutionResult> = {}): ToolExecutionResult {
	return {
		schemaVersion: "tool-execution-result.v1",
		attemptId: manifest.attemptId,
		status: "succeeded",
		exitCode: 0,
		startedAt: "2026-09-05T00:00:00.000Z",
		completedAt: "2026-09-05T00:00:00.010Z",
		durationMs: 10,
		stdout: { text: "pixelWidth: 1024", truncated: false },
		stderr: { text: "", truncated: false },
		outputs: [],
		sandbox: {
			profile: manifest.sandboxProfile,
			platform: "fake",
			permissions: {
				readOnlyPaths: manifest.paths.readOnly.length,
				writablePaths: manifest.paths.writable.length,
				network: manifest.network.mode,
				environmentKeys: Object.keys(manifest.environment),
			},
		},
		...overrides,
	};
}

function provider(assertToolResult?: (content: string) => void): AgentModelProvider {
	let calls = 0;
	return {
		async generate(modelRequest) {
			calls += 1;
			if (calls === 1) {
				return {
					text: "",
					toolCalls: [{ id: "tool-call-1", name: "asset_metadata_inspect", input: { path: "assets/input.png" } }],
					usage,
				};
			}
			assertToolResult?.(modelRequest.messages.at(-1)?.content ?? "");
			return { text: "done", toolCalls: [], usage };
		},
	};
}

describe("SandboxedToolExecutor contract", () => {
	it("routes a sandboxed Tool through a Host-validated immutable manifest", async () => {
		const executor = new FakeSandboxedToolExecutor(async (manifest) => result(manifest));
		const runtime = new BlackxAgentRuntime({
			provider: provider((content) => {
				expect(JSON.parse(content)).toMatchObject({
					status: "succeeded",
					stdout: { text: "pixelWidth: 1024" },
				});
			}),
			tools: [sandboxTool()],
			sandboxedToolExecutor: executor,
			skills: new SkillRegistry(),
		});

		const completed = await runtime.executeTurn(request);

		expect(completed.finalResponse).toBe("done");
		expect(executor.manifests).toHaveLength(1);
		expect(executor.manifests[0]).toMatchObject({
			schemaVersion: "tool-execution-manifest.v1",
			tenantId: request.tenantId,
			workspaceId: request.workspaceId,
			runId: request.runId,
			stageId: request.stageId,
			toolCallId: "tool-call-1",
			tool: { name: "asset_metadata_inspect", version: "1.0.0" },
			command: {
				executable: "/usr/bin/sips",
				argv: ["-g", "pixelWidth", "assets/input.png"],
				workingDirectory: "/workspace",
			},
			paths: {
				readOnly: ["/workspace/assets/input.png"],
				writable: [],
				temporaryDirectory: "/workspace/.blackx-tmp/attempt",
			},
			environment: { LANG: "C" },
			network: { mode: "deny-all", allowedDomains: [] },
			limits: { timeoutMs: 50 },
			idempotencyKey: "turn-1:tool-call-1",
		});
		expect(executor.manifests[0].attemptId).toEqual(expect.any(String));
		expect(executor.manifests[0].environment).not.toHaveProperty("ANTHROPIC_API_KEY");
	});

	it("fails closed when no Native Tool Sandbox executor is configured", async () => {
		let compiled = false;
		const tool = sandboxTool({
			createManifest: () => {
				compiled = true;
				throw new Error("must not compile");
			},
		});
		const runtime = new BlackxAgentRuntime({
			provider: provider((content) => {
				expect(JSON.parse(content)).toMatchObject({ error: { code: "tool_sandbox_unavailable" } });
			}),
			tools: [tool],
			skills: new SkillRegistry(),
		});

		const completed = await runtime.executeTurn(request);

		expect(compiled).toBe(false);
		expect(completed.events).toContainEqual(expect.objectContaining({
			type: "tool.completed",
			status: "failed",
			failureCode: "tool_sandbox_unavailable",
		}));
	});

	it("rejects a manifest that changes Host-owned identity before dispatch", async () => {
		const base = sandboxTool();
		const executor = new FakeSandboxedToolExecutor(async (manifest) => result(manifest));
		const runtime = new BlackxAgentRuntime({
			provider: provider((content) => {
				expect(JSON.parse(content)).toMatchObject({ error: { code: "tool_sandbox_policy_denied" } });
			}),
			tools: [sandboxTool({
				createManifest: (input, context) => ({
					...base.createManifest(input, context),
					workspaceId: "model-controlled-workspace",
				}),
			})],
			sandboxedToolExecutor: executor,
			skills: new SkillRegistry(),
		});

		await runtime.executeTurn(request);

		expect(executor.manifests).toHaveLength(0);
	});

	it("maps Sandbox timeout and aborts the executor signal", async () => {
		let aborted = false;
		const executor = new FakeSandboxedToolExecutor((_manifest, signal) => new Promise((_resolve, reject) => {
			signal.addEventListener("abort", () => {
				aborted = true;
				reject(signal.reason);
			}, { once: true });
		}));
		const runtime = new BlackxAgentRuntime({
			provider: provider((content) => {
				expect(JSON.parse(content)).toMatchObject({ error: { code: "tool_timeout" } });
			}),
			tools: [sandboxTool({ timeoutMs: 10 })],
			sandboxedToolExecutor: executor,
			skills: new SkillRegistry(),
		});

		await runtime.executeTurn(request);

		expect(aborted).toBe(true);
	});

	it("propagates user cancellation into the Sandbox process boundary", async () => {
		let started!: () => void;
		const executing = new Promise<void>((resolve) => { started = resolve; });
		let sandboxSignal: AbortSignal | undefined;
		const executor = new FakeSandboxedToolExecutor((_manifest, signal) => new Promise((_resolve, reject) => {
			sandboxSignal = signal;
			started();
			signal.addEventListener("abort", () => reject(signal.reason), { once: true });
		}));
		const controller = new AbortController();
		const runtime = new BlackxAgentRuntime({
			provider: provider(),
			tools: [sandboxTool()],
			sandboxedToolExecutor: executor,
			skills: new SkillRegistry(),
		});

		const turn = runtime.executeTurn(request, controller.signal);
		await executing;
		controller.abort(new Error("user_cancelled"));

		await expect(turn).rejects.toMatchObject({ code: "cancelled" });
		expect(sandboxSignal?.aborted).toBe(true);
	});

	it("replays a successful sandboxed write from the existing idempotency ledger", async () => {
		let modelCalls = 0;
		const writeTool = sandboxTool({
			risk: "write",
			createIdempotencyKey: () => "asset-metadata:stable",
		});
		const executor = new FakeSandboxedToolExecutor(async (manifest) => result(manifest));
		const runtime = new BlackxAgentRuntime({
			provider: {
				generate: async () => {
					modelCalls += 1;
					return modelCalls % 2 === 1
						? {
							text: "",
							toolCalls: [{ id: "write-call", name: writeTool.name, input: { path: "assets/input.png" } }],
							usage,
						}
						: { text: "done", toolCalls: [], usage };
				},
			},
			tools: [writeTool],
			sandboxedToolExecutor: executor,
			approval: { authorize: async () => ({ approved: true, approvalId: "approval-1" }) },
			audit: { append: async () => {} },
			skills: new SkillRegistry(),
		});
		const writeRequest = {
			...request,
			policy: {
				...request.policy,
				sandboxMode: "workspace-write" as const,
				approvalPolicy: "required" as const,
			},
		};

		await runtime.executeTurn({ ...writeRequest, sessionId: "write-session-1" });
		const replay = await runtime.executeTurn({ ...writeRequest, sessionId: "write-session-2" });

		expect(executor.manifests).toHaveLength(1);
		expect(executor.manifests[0].approvalId).toBe("approval-1");
		expect(replay.events).toContainEqual(expect.objectContaining({
			type: "tool.completed",
			status: "succeeded",
			replayed: true,
		}));
	});

	it("rejects an unsafe Sandbox output manifest without exposing stderr", async () => {
		const executor = new FakeSandboxedToolExecutor(async (manifest) => result(manifest, {
			stderr: { text: "secret-provider-detail", truncated: false },
			outputs: [{
				path: "../outside.txt",
				size: 1,
				mimeType: "text/plain",
				sha256: "a".repeat(64),
			}],
		}));
		const runtime = new BlackxAgentRuntime({
			provider: provider((content) => {
				expect(JSON.parse(content)).toMatchObject({ error: { code: "tool_execution_failed" } });
				expect(content).not.toContain("secret-provider-detail");
			}),
			tools: [sandboxTool()],
			sandboxedToolExecutor: executor,
			skills: new SkillRegistry(),
		});

		await runtime.executeTurn(request);
	});
});
