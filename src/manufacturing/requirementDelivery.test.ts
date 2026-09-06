import { describe, expect, it } from "vitest";
import { createRequirementBrief } from "./requirementBrief";
import { compareRequirementVersions, deliveryHtml, deliveryMarkdown, type RequirementDelivery } from "./requirementDelivery";

function fixture(): RequirementDelivery {
	return { schemaVersion: "requirement-delivery.v1", runId: "run-a", version: 1, status: "draft", createdAt: "2026-09-05T00:00:00Z", sources: [], citations: {}, content: createRequirementBrief({ industry: "print", title: "<script>untrusted()</script>", customerGoal: "客户需求", facts: [{ key: "quantity", version: 1, value: 5000, status: "unverified", sourceType: "model_output", sourceRef: "runtime:a" }] }) };
}

describe("requirement delivery", () => {
	it("escapes source HTML and labels drafts and outdated versions explicitly", () => {
		const delivery = fixture();
		expect(deliveryHtml(delivery)).not.toContain("<script>");
		expect(deliveryHtml(delivery)).toContain("&lt;script&gt;");
		expect(deliveryMarkdown(delivery)).toContain("待确认草稿");
		expect(deliveryMarkdown(delivery)).not.toContain("<script>");
		delivery.status = "stale";
		expect(deliveryHtml(delivery)).toContain("历史或已失效版本");
		expect(deliveryHtml(delivery)).not.toContain("当前版本已批准");
	});
	it("shows changed values and confirmations across immutable versions", () => {
		const before = fixture().content;
		const after = structuredClone(before);
		after.facts[0] = { ...after.facts[0]!, value: 6000, version: 2, status: "verified" };
		expect(compareRequirementVersions(before, after)).toMatchObject([{ key: "quantity", before: { value: 5000, status: "unverified" }, after: { value: 6000, status: "verified" } }]);
		expect(before.facts[0]!.value).toBe(5000);
		expect(compareRequirementVersions(before, structuredClone(before))).toEqual([]);
	});
});
