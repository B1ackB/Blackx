import { ModelTelemetryStore } from "./modelTelemetry";
import { RuntimeActivityStore } from "./runtimeActivity";
import { resolve } from "node:path";
import { SkillRegistry } from "../../src/agent/skills";
import { printSkills } from "../../src/print/skills";
import { manufacturingSkills } from "../../src/manufacturing/skills";
import type { AgentTool, AgentToolApprovalPort } from "../../src/agent/contracts";
import type { SandboxedToolExecutorPort } from "../../src/agent/sandbox";
import type { AgentRuntimePort } from "../../src/runtime/contracts";
import { AnthropicMessagesClient } from "../anthropic/client";
import { BlackxAgentRuntime, type BlackxAgentRuntimeOptions } from "./agentRuntime";
import { AnthropicModelProvider } from "./anthropicModelProvider";
import { FakeAgentRuntime } from "./fakeAgentRuntime";
import { FileAgentStateStore } from "./fileAgentStateStore";
import { MacOsSeatbeltSandboxedToolExecutor } from "./macOsSeatbeltSandboxedToolExecutor";

export interface RuntimeServices {
	runtime: AgentRuntimePort;
	state: FileAgentStateStore;
	activity: RuntimeActivityStore;
	telemetry: ModelTelemetryStore;
}

export interface RuntimeServicesOptions {
	tools?: readonly AgentTool[];
	approval?: AgentToolApprovalPort;
	sandboxedToolExecutor?: SandboxedToolExecutorPort;
	autonomouslyApprovedTools?: ReadonlySet<string>;
	resolveImageAttachment?: BlackxAgentRuntimeOptions["resolveImageAttachment"];
}

export function validateAnthropicBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(
      "ANTHROPIC_BASE_URL must be a plain http(s) URL without Markdown link syntax",
    );
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("ANTHROPIC_BASE_URL must use http or https");
  }
  return value.replace(/\/$/, "");
}

export function createRuntime(
	environment: NodeJS.ProcessEnv,
	options: RuntimeServicesOptions = {},
): RuntimeServices {
  const activity = new RuntimeActivityStore();
	const telemetry = new ModelTelemetryStore(resolve(environment.BLACKX_AGENT_STATE_PATH ?? ".blackx-data/agent", "model-calls"), (environment.BLACKX_RUNTIME_MODE ?? "fake") === "anthropic" ? environment.ANTHROPIC_MODEL ?? "unconfigured" : "fake");
  const mode = environment.BLACKX_RUNTIME_MODE ?? "fake";
	const state = new FileAgentStateStore(environment.BLACKX_AGENT_STATE_PATH ?? ".blackx-data/agent");
	const sandboxedToolExecutor = options.sandboxedToolExecutor ?? (process.platform === "darwin"
		? new MacOsSeatbeltSandboxedToolExecutor({
			workspaceRoot: resolve(environment.BLACKX_WORKSPACE_ROOT ?? "."),
		})
		: undefined);
  if (mode === "fake") {
		return {
			runtime: new FakeAgentRuntime({
				sessions: state,
				snapshots: state,
				tools: options.tools,
				sandboxedToolExecutor,
				resolveImageAttachment: options.resolveImageAttachment,
			}),
			state,
			activity,
			telemetry,
		};
  }

  if (mode === "anthropic") {
    const apiKey = environment.ANTHROPIC_API_KEY;
    const configuredBaseUrl = environment.ANTHROPIC_BASE_URL;
    const model = environment.ANTHROPIC_MODEL;
    if (!apiKey || !configuredBaseUrl || !model) {
      throw new Error(
        "BLACKX_RUNTIME_MODE=anthropic requires ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL and ANTHROPIC_MODEL",
      );
    }
    const baseUrl = validateAnthropicBaseUrl(configuredBaseUrl);
		return {
			runtime: new BlackxAgentRuntime({
				telemetry,
				onActivity: (scope, event) => activity.observe(scope, event),
				provider: new AnthropicModelProvider(
					new AnthropicMessagesClient({ baseUrl, apiKey }),
					model,
				),
				skills: new SkillRegistry([...printSkills, ...manufacturingSkills]),
				tools: options.tools,
				sandboxedToolExecutor,
				resolveImageAttachment: options.resolveImageAttachment,
				approval: {
					authorize: async (request, signal) => options.autonomouslyApprovedTools?.has(request.tool)
						? { approved: true, approvalId: `policy:${request.tool}:v1` }
						: options.approval?.authorize(request, signal) ?? { approved: false },
				},
				audit: state,
				sessions: state,
				snapshots: state,
				traces: state,
				executions: state,
			}),
			state,
			activity,
			telemetry,
		};
  }

  throw new Error(`Unsupported BLACKX_RUNTIME_MODE: ${mode}`);
}
