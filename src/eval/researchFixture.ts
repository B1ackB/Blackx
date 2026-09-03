import type { RuntimeTurnRequest, RuntimeTurnResult } from "../runtime/contracts";

export const researchSources = {
	"source-session": "Agent Session 只保存 Runtime continuation；Run、Stage 和完成状态必须由持久业务状态决定。",
	"source-recovery": "Worker 崩溃后从 Event Store、Checkpoint 和 Artifact 恢复；重复投递依靠幂等键和版本检查避免重复副作用。",
} as const;

export interface EvidenceReportV1 {
	schemaVersion: "evidence-report.v1";
	answer: string;
	facts: Array<{
		key: "runtime.session_role" | "runtime.recovery_basis";
		value: "continuation_not_authority" | "event_checkpoint_artifact";
		sourceIds: Array<keyof typeof researchSources>;
	}>;
	limitations: ["fixture_sources_only"];
}

export const expectedEvidenceReport: EvidenceReportV1 = {
	schemaVersion: "evidence-report.v1",
	answer: "Agent Session 负责执行续跑，业务恢复和完成判定由 Event Store、Checkpoint、Artifact、幂等键与版本检查共同保证。",
	facts: [
		{
			key: "runtime.session_role",
			value: "continuation_not_authority",
			sourceIds: ["source-session"],
		},
		{
			key: "runtime.recovery_basis",
			value: "event_checkpoint_artifact",
			sourceIds: ["source-recovery"],
		},
	],
	limitations: ["fixture_sources_only"],
};

export const evidenceReportSchema = {
	type: "object",
	properties: {
		schemaVersion: { const: "evidence-report.v1" },
		answer: { type: "string", minLength: 1 },
		facts: {
			type: "array",
			minItems: 2,
			maxItems: 2,
			items: {
				type: "object",
				properties: {
					key: { enum: ["runtime.session_role", "runtime.recovery_basis"] },
					value: { enum: ["continuation_not_authority", "event_checkpoint_artifact"] },
					sourceIds: {
						type: "array",
						minItems: 1,
						items: { enum: Object.keys(researchSources) },
					},
				},
				required: ["key", "value", "sourceIds"],
				additionalProperties: false,
			},
		},
		limitations: {
			type: "array",
			minItems: 1,
			maxItems: 1,
			items: { const: "fixture_sources_only" },
		},
	},
	required: ["schemaVersion", "answer", "facts", "limitations"],
	additionalProperties: false,
} as const;

export const researchEvalRequest = {
	tenantId: "eval-tenant",
	workspaceId: "eval-workspace",
	runId: "eval-research-001",
	stageId: "research",
	actorId: "eval-runner",
	idempotencyKey: "eval-research-001-turn-1",
	instructions: [
		"这是固定 M1 Runtime Eval。必须先调用 research_source_read 读取 source-session 和 source-recovery，再回答。",
		"只能使用 Tool 返回的证据；不得添加第三个 Fact，不得把 Agent Session 描述为业务权威状态。",
		"只返回符合 JSON Schema 的 Evidence Report，不要使用 Markdown 代码块。",
	],
	allowedTools: ["research_source_read"],
	input: "问题：Agent Session 在长任务恢复中负责什么？Worker 崩溃后由什么保证业务状态恢复且不重复副作用？",
	outputSchema: evidenceReportSchema,
	fallbackOutput: JSON.stringify(expectedEvidenceReport),
	policy: {
		sandboxMode: "read-only",
		approvalPolicy: "never",
		timeoutMs: 120_000,
	},
} satisfies RuntimeTurnRequest;

export interface ResearchEvalCheck {
	name: string;
	passed: boolean;
	detail: string;
}

export interface ResearchEvalReport {
	fixtureId: "durable-research-runtime-v1";
	passed: boolean;
	checks: ResearchEvalCheck[];
	adapter: string;
	usage?: RuntimeTurnResult["usage"];
}

export function scoreResearchTurn(result: RuntimeTurnResult): ResearchEvalReport {
	let report: EvidenceReportV1 | undefined;
	try {
		report = JSON.parse(result.finalResponse) as EvidenceReportV1;
	} catch {}
	const facts = new Map(report?.facts?.map((fact) => [fact.key, fact]));
	const sessionFact = facts.get("runtime.session_role");
	const recoveryFact = facts.get("runtime.recovery_basis");
	const completedTools = result.events.filter(
		(event) => event.type === "tool.completed" && event.tool === "research_source_read" && event.status === "succeeded",
	);
	const eventTypes = result.events.map((event) => event.type);
	const checks: ResearchEvalCheck[] = [
		{
			name: "structured_artifact",
			passed: report?.schemaVersion === "evidence-report.v1" && typeof report.answer === "string" && report.answer.length > 0,
			detail: report ? "Evidence Report JSON decoded" : "Final response is not valid JSON",
		},
		{
			name: "source_tool_loop",
			passed: completedTools.length === 2,
			detail: `successful research_source_read calls: ${completedTools.length}`,
		},
		{
			name: "fact_lineage",
			passed: facts.size === 2 &&
				sessionFact?.value === "continuation_not_authority" &&
				sessionFact.sourceIds.length === 1 && sessionFact.sourceIds[0] === "source-session" &&
				recoveryFact?.value === "event_checkpoint_artifact" &&
				recoveryFact.sourceIds.length === 1 && recoveryFact.sourceIds[0] === "source-recovery",
			detail: "Expected facts must cite their exact fixture sources",
		},
		{
			name: "explicit_limit",
			passed: report?.limitations?.length === 1 && report.limitations[0] === "fixture_sources_only",
			detail: "Report must retain the fixture-only evidence boundary",
		},
		{
			name: "durable_runtime_evidence",
			passed: Boolean(result.sessionId && result.contextSnapshotId) &&
				eventTypes.includes("session.started") &&
				eventTypes.includes("turn.completed"),
			detail: `events: ${eventTypes.join(" -> ")}`,
		},
	];
	return {
		fixtureId: "durable-research-runtime-v1",
		passed: checks.every((check) => check.passed),
		checks,
		adapter: result.adapter,
		usage: result.usage,
	};
}
