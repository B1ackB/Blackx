import type { FactVersionState } from "../enterprise/contracts";

export const solutionProposalSchemaVersion = "solution-proposal.v1";

export interface SuggestedRecommendation {
	topic: string;
	value: string;
	status: "suggested";
	rationale: string;
}

export interface SolutionProposalV1 {
	schemaVersion: typeof solutionProposalSchemaVersion;
	productType: "sealing_bag";
	title: string;
	summary: string;
	recommendations: SuggestedRecommendation[];
	verificationRequired: string[];
	factLineage: Record<string, number>;
}

export interface ProposalEvaluationIssue {
	code:
		| "invalid_json"
		| "schema_mismatch"
		| "fact_lineage_mismatch"
		| "authority_boundary_violation";
	message: string;
}

export interface ProposalEvaluationReport {
	schemaVersion: "proposal-evaluation.v1";
	passed: boolean;
	issues: ProposalEvaluationIssue[];
}

export const solutionProposalOutputSchema = {
	type: "object",
	properties: {
		schemaVersion: { type: "string", const: solutionProposalSchemaVersion },
		productType: { type: "string", const: "sealing_bag" },
		title: { type: "string", minLength: 1 },
		summary: { type: "string", minLength: 1 },
		recommendations: {
			type: "array",
			minItems: 1,
			items: {
				type: "object",
				properties: {
					topic: { type: "string", minLength: 1 },
					value: { type: "string", minLength: 1 },
					status: { type: "string", const: "suggested" },
					rationale: { type: "string", minLength: 1 },
				},
				required: ["topic", "value", "status", "rationale"],
				additionalProperties: false,
			},
		},
		verificationRequired: {
			type: "array",
			minItems: 1,
			items: { type: "string", minLength: 1 },
		},
		factLineage: {
			type: "object",
			additionalProperties: { type: "integer", minimum: 1 },
		},
	},
	required: [
		"schemaVersion",
		"productType",
		"title",
		"summary",
		"recommendations",
		"verificationRequired",
		"factLineage",
	],
	additionalProperties: false,
} as const;

const forbiddenAuthorityClaims = [
	"已验证",
	"已经验证",
	"生产就绪",
	"可直接生产",
	"保证合规",
	"保证通过",
];

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isFactLineage(value: unknown): value is Record<string, number> {
	return (
		isRecord(value) &&
		Object.entries(value).every(
			([key, version]) => key.length > 0 && Number.isInteger(version) && Number(version) > 0,
		)
	);
}

function isRecommendation(value: unknown): value is SuggestedRecommendation {
	if (!isRecord(value)) return false;
	return (
		Object.keys(value).length === 4 &&
		isNonEmptyString(value.topic) &&
		isNonEmptyString(value.value) &&
		value.status === "suggested" &&
		isNonEmptyString(value.rationale)
	);
}

function parseProposal(value: unknown): SolutionProposalV1 | undefined {
	if (!isRecord(value)) return undefined;
	if (
		Object.keys(value).length !== 7 ||
		value.schemaVersion !== solutionProposalSchemaVersion ||
		value.productType !== "sealing_bag" ||
		!isNonEmptyString(value.title) ||
		!isNonEmptyString(value.summary) ||
		!Array.isArray(value.recommendations) ||
		value.recommendations.length === 0 ||
		!value.recommendations.every(isRecommendation) ||
		!Array.isArray(value.verificationRequired) ||
		value.verificationRequired.length === 0 ||
		!value.verificationRequired.every(isNonEmptyString) ||
		!isFactLineage(value.factLineage)
	) {
		return undefined;
	}
	return value as unknown as SolutionProposalV1;
}

function sameLineage(
	actual: Record<string, number>,
	expected: Record<string, number>,
): boolean {
	const actualEntries = Object.entries(actual).sort(([left], [right]) => left.localeCompare(right));
	const expectedEntries = Object.entries(expected).sort(([left], [right]) => left.localeCompare(right));
	return JSON.stringify(actualEntries) === JSON.stringify(expectedEntries);
}

export function evaluateSolutionProposal(
	output: string,
	expectedFactLineage: Record<string, number>,
): { proposal?: SolutionProposalV1; report: ProposalEvaluationReport } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(output);
	} catch {
		return {
			report: {
				schemaVersion: "proposal-evaluation.v1",
				passed: false,
				issues: [{ code: "invalid_json", message: "Runtime output is not valid JSON" }],
			},
		};
	}

	const proposal = parseProposal(parsed);
	if (!proposal) {
		return {
			report: {
				schemaVersion: "proposal-evaluation.v1",
				passed: false,
				issues: [{ code: "schema_mismatch", message: "Runtime output does not match SolutionProposal v1" }],
			},
		};
	}

	const issues: ProposalEvaluationIssue[] = [];
	if (!sameLineage(proposal.factLineage, expectedFactLineage)) {
		issues.push({
			code: "fact_lineage_mismatch",
			message: "Proposal Fact lineage does not match the current Run state",
		});
	}
	const serialized = JSON.stringify(proposal);
	if (forbiddenAuthorityClaims.some((claim) => serialized.includes(claim))) {
		issues.push({
			code: "authority_boundary_violation",
			message: "Proposal claims verified or production-ready authority",
		});
	}
	return {
		proposal,
		report: {
			schemaVersion: "proposal-evaluation.v1",
			passed: issues.length === 0,
			issues,
		},
	};
}

export function createDeterministicProposal(
	facts: Record<string, FactVersionState>,
): SolutionProposalV1 {
	const factLineage = Object.fromEntries(
		Object.values(facts)
			.sort((left, right) => left.key.localeCompare(right.key))
			.map((fact) => [fact.key, fact.version]),
	);
	const factSummary = Object.values(facts)
		.sort((left, right) => left.key.localeCompare(right.key))
		.map((fact) => `${fact.key}=${String(fact.value)}${fact.unit ? ` ${fact.unit}` : ""} (${fact.status})`)
		.join("；");
	return {
		schemaVersion: solutionProposalSchemaVersion,
		productType: "sealing_bag",
		title: "封口袋结构化方案候选",
		summary: factSummary
			? `本方案仅基于当前记录事实形成候选方向：${factSummary}。`
			: "当前尚无已记录事实，本方案仅提供待确认的候选方向。",
		recommendations: [
			{
				topic: "袋型与封口方式",
				value: "根据内容物、渠道和设备条件完成选型",
				status: "suggested",
				rationale: "当前输出是方案阶段建议，不能替代人工和工厂确认。",
			},
			{
				topic: "材料结构",
				value: "根据阻隔目标、合规要求和试产结果确定结构",
				status: "suggested",
				rationale: "材料与生产参数必须由权威来源和确定性验证确认。",
			},
		],
		verificationRequired: [
			"确认成品尺寸、数量和权威刀模版本",
			"确认材料合规、阻隔目标与工厂设备参数",
			"在生产前执行确定性 Preflight 与人工审批",
		],
		factLineage,
	};
}
