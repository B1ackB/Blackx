import { describe, expect, it } from "vitest";
import {
	createDeterministicProposal,
	evaluateSolutionProposal,
} from "./solutionProposal";

const facts = {
	quantity: {
		key: "quantity",
		version: 1,
		value: 10_000,
		unit: "bags",
		status: "unverified" as const,
		sourceType: "user_input" as const,
		sourceRef: "message-1",
	},
};

describe("SolutionProposal v1", () => {
	it("creates and accepts a deterministic suggested-only candidate", () => {
		const proposal = createDeterministicProposal(facts);
		const evaluated = evaluateSolutionProposal(
			JSON.stringify(proposal),
			{ quantity: 1 },
		);

		expect(evaluated.report).toEqual({
			schemaVersion: "proposal-evaluation.v1",
			passed: true,
			issues: [],
		});
		expect(evaluated.proposal?.recommendations.every(
			(recommendation) => recommendation.status === "suggested",
		)).toBe(true);
	});

	it("rejects stale Fact lineage", () => {
		const proposal = createDeterministicProposal(facts);
		proposal.factLineage.quantity = 2;

		expect(evaluateSolutionProposal(
			JSON.stringify(proposal),
			{ quantity: 1 },
		).report).toMatchObject({
			passed: false,
			issues: [{ code: "fact_lineage_mismatch" }],
		});
	});

	it("rejects production authority claims even when the schema is valid", () => {
		const proposal = createDeterministicProposal(facts);
		proposal.summary = "该方案生产就绪";

		expect(evaluateSolutionProposal(
			JSON.stringify(proposal),
			{ quantity: 1 },
		).report).toMatchObject({
			passed: false,
			issues: [{ code: "authority_boundary_violation" }],
		});
	});
});
