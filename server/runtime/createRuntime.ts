import { SkillRegistry } from "../../src/agent/skills";
import { printSkills } from "../../src/print/skills";
import type { AgentTool } from "../../src/agent/contracts";
import type { AgentRuntimePort } from "../../src/runtime/contracts";
import { AnthropicMessagesClient } from "../anthropic/client";
import { BlackxAgentRuntime } from "./agentRuntime";
import { AnthropicModelProvider } from "./anthropicModelProvider";
import { FakeAgentRuntime } from "./fakeAgentRuntime";
import { FileAgentStateStore } from "./fileAgentStateStore";

export interface RuntimeServices {
	runtime: AgentRuntimePort;
	state: FileAgentStateStore;
}

export interface RuntimeServicesOptions {
	tools?: readonly AgentTool[];
	autonomouslyApprovedTools?: ReadonlySet<string>;
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
  const mode = environment.BLACKX_RUNTIME_MODE ?? "fake";
	const state = new FileAgentStateStore(environment.BLACKX_AGENT_STATE_PATH ?? ".blackx-data/agent");
  if (mode === "fake") {
		return { runtime: new FakeAgentRuntime({ sessions: state, snapshots: state }), state };
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
				provider: new AnthropicModelProvider(
					new AnthropicMessagesClient({ baseUrl, apiKey }),
					model,
				),
				skills: new SkillRegistry(printSkills),
				tools: options.tools,
				approval: {
					authorize: async (request) => options.autonomouslyApprovedTools?.has(request.tool)
						? { approved: true, approvalId: `policy:${request.tool}:v1` }
						: { approved: false },
				},
				audit: state,
				sessions: state,
				snapshots: state,
				traces: state,
				executions: state,
			}),
			state,
		};
  }

  throw new Error(`Unsupported BLACKX_RUNTIME_MODE: ${mode}`);
}
