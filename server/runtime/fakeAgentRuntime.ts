import type { AgentModelProvider } from "../../src/agent/contracts";
import { SkillRegistry } from "../../src/agent/skills";
import type { AgentSessionStore, ContextSnapshotStore } from "../../src/agent/state";
import { printSkills } from "../../src/print/skills";
import { BlackxAgentRuntime } from "./agentRuntime";

const fakeProvider: AgentModelProvider = {
	async generate(request) {
		return {
			text: request.fallbackOutput,
			toolCalls: [],
			usage: {
				inputTokens: 0,
				cachedInputTokens: 0,
				outputTokens: 0,
				reasoningOutputTokens: 0,
			},
		};
	},
};

export class FakeAgentRuntime extends BlackxAgentRuntime {
	constructor(options: { sessions?: AgentSessionStore; snapshots?: ContextSnapshotStore } = {}) {
		super({ provider: fakeProvider, skills: new SkillRegistry(printSkills), ...options });
	}

	override async health() {
		return { adapter: "fake" as const, online: true, coreVersion: "m0.1" };
	}

	override async executeTurn(...parameters: Parameters<BlackxAgentRuntime["executeTurn"]>) {
		const result = await super.executeTurn(...parameters);
		return { ...result, adapter: "fake" as const };
	}
}
