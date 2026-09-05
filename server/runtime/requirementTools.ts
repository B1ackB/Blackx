import type { AgentHostTool } from "../../src/agent/contracts";
import { ProposalRunEngine } from "../../src/enterprise/proposalRunEngine";
import { requirementBriefFixtures } from "../../src/manufacturing/requirementBrief.fixtures";
import { FileConversationAttachmentStore } from "./conversationAttachments";

const sources = Object.fromEntries(requirementBriefFixtures.map((fixture) => [
	fixture.fixtureId,
	{ industry: fixture.industry, content: fixture.input },
]));

function validInput(value: unknown): value is { sourceId: string } {
	return value !== null && typeof value === "object" && !Array.isArray(value) &&
		"sourceId" in value && typeof value.sourceId === "string" && value.sourceId in sources;
}

export const projectSourceReadTool: AgentHostTool = {
	name: "project_source_read",
	description: "Read one customer Brief from the fixed M2 Requirement Brief evaluation corpus.",
	inputSchema: {
		type: "object",
		properties: { sourceId: { enum: Object.keys(sources) } },
		required: ["sourceId"],
		additionalProperties: false,
	},
	execution: "host",
	risk: "read",
	idempotent: true,
	timeoutMs: 1_000,
	maxResultChars: 4_000,
	validate: validInput,
	execute: async (input) => {
		const { sourceId } = input as { sourceId: string };
		return { sourceId, ...sources[sourceId] };
	},
};

export function createProjectSourceReadTool(
	engine: ProposalRunEngine,
	attachments?: FileConversationAttachmentStore,
): AgentHostTool {
	return {
		name: "project_source_read",
		description: "Read the tenant-scoped customer brief and selected industry for the current Requirement Brief Run.",
		inputSchema: {
			type: "object",
			properties: { sourceId: { const: "customer-brief" } },
			required: ["sourceId"],
			additionalProperties: false,
		},
		execution: "host",
		risk: "read",
		idempotent: true,
		timeoutMs: 1_000,
		maxResultChars: 48_000,
		validate: (input) => Boolean(
			input &&
			typeof input === "object" &&
			!Array.isArray(input) &&
			"sourceId" in input &&
			input.sourceId === "customer-brief",
		),
		execute: async (_input, context) => {
			const state = engine.load(context);
			const brief = state.facts.customer_brief;
			const industry = state.facts.industry;
			const attachmentFact = state.facts.customer_attachments;
			if (!brief || !industry || industry.status !== "verified") {
				throw new Error("Requirement Brief source is incomplete");
			}
			const conversationId = /^conversation:(.+):revision:\d+$/.exec(brief.sourceRef)?.[1];
			const attachmentScope = conversationId ? {
				tenantId: state.tenantId,
				workspaceId: state.workspaceId,
				conversationId,
			} : undefined;
			if (
				attachments &&
				attachmentScope &&
				attachmentFact &&
				attachments.digest(attachmentScope) !== attachmentFact.value
			) {
				throw new Error("Requirement Brief attachment snapshot changed; start a new review");
			}
			const attachmentList = attachments && attachmentScope && attachmentFact
				? attachments.list(attachmentScope)
				: [];
			return {
				sourceId: "customer-brief",
				industry: industry.value,
				content: brief.value,
				sourceRef: brief.sourceRef,
				attachments: attachmentList.map((attachment) => ({
					attachmentId: attachment.attachmentId,
					name: attachment.name,
					mediaType: attachment.mediaType,
					sha256: attachment.sha256,
					sourceRef: attachment.sourceRef,
					modelInput: attachment.modelInput,
				})),
				textAttachments: attachments && attachmentScope && attachmentFact
					? attachments.readText(
						attachmentScope,
						Math.max(0, 32_000 - String(brief.value).length),
					)
					: [],
			};
		},
	};
}
