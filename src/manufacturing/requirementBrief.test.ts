import { describe, expect, it } from "vitest";
import { requirementBriefFixtures } from "./requirementBrief.fixtures";
import { evaluateRequirementBrief, normalizeRequirementFactKey } from "./requirementBrief";

describe("M2 Requirement Brief baseline", () => {
	it("keeps ten fixed Print and Furniture tasks on one deterministic contract", () => {
		expect(requirementBriefFixtures).toHaveLength(10);
		expect(new Set(requirementBriefFixtures.map((fixture) => fixture.industry))).toEqual(
			new Set(["print", "furniture"]),
		);
		for (const fixture of requirementBriefFixtures) {
			expect(evaluateRequirementBrief(fixture.artifact), fixture.fixtureId).toMatchObject({
				passed: true,
				approvalEligible: fixture.expectedApprovalEligible,
			});
		}
	});

	it("refuses to treat model output as a verified Fact", () => {
		const artifact = structuredClone(requirementBriefFixtures[0]!.artifact);
		artifact.facts[0] = {
			...artifact.facts[0]!,
			sourceType: "model_output",
			status: "verified",
		};

		expect(evaluateRequirementBrief(artifact)).toMatchObject({
			passed: false,
			approvalEligible: false,
			issues: expect.arrayContaining([expect.objectContaining({ code: "invalid_authority" })]),
		});
	});

	it("requires the declared gap and next action to match the actual Facts", () => {
		const artifact = structuredClone(requirementBriefFixtures[1]!.artifact);
		artifact.missingRequiredFacts = [];
		artifact.nextAction = "ready_for_approval";

		expect(evaluateRequirementBrief(artifact)).toMatchObject({
			passed: false,
			approvalEligible: false,
			issues: expect.arrayContaining([
				expect.objectContaining({ code: "missing_fact_mismatch" }),
				expect.objectContaining({ code: "invalid_next_action" }),
			]),
		});
	});

	it("normalizes known aliases and rejects non-canonical Artifact Facts", () => {
		expect(normalizeRequirementFactKey("furniture", "Product Type")).toBe("furniture_type");
		expect(normalizeRequirementFactKey("furniture", "quantity_reference")).toBe("quantity");
		expect(normalizeRequirementFactKey("furniture", "focus_areas")).toBeUndefined();

		const artifact = structuredClone(requirementBriefFixtures[5]!.artifact);
		artifact.facts.push({
			key: "focus_areas",
			version: 1,
			value: "尺寸与安装",
			status: "unverified",
			sourceType: "model_output",
			sourceRef: "runtime:test",
		});
		expect(evaluateRequirementBrief(artifact)).toMatchObject({
			passed: false,
			issues: expect.arrayContaining([expect.objectContaining({ code: "unsupported_fact" })]),
		});
	});
});
