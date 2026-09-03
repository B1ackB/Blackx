import type { AgentTool } from "../../src/agent/contracts";
import { researchSources } from "../../src/eval/researchFixture";

function validInput(value: unknown): value is { sourceId: keyof typeof researchSources } {
	return value !== null && typeof value === "object" && !Array.isArray(value) &&
		"sourceId" in value && typeof value.sourceId === "string" && value.sourceId in researchSources;
}

export const researchSourceTool: AgentTool = {
	name: "research_source_read",
	description: "Read one immutable source from the fixed M1 research evaluation corpus by sourceId.",
	inputSchema: {
		type: "object",
		properties: { sourceId: { enum: Object.keys(researchSources) } },
		required: ["sourceId"],
		additionalProperties: false,
	},
	risk: "read",
	idempotent: true,
	timeoutMs: 1_000,
	maxResultChars: 2_000,
	validate: validInput,
	execute: async (input) => {
		const { sourceId } = input as { sourceId: keyof typeof researchSources };
		return { sourceId, content: researchSources[sourceId] };
	},
};
