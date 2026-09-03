import { describe, expect, it } from "vitest";
import type { RuntimeTurnResult } from "../runtime/contracts";
import { expectedEvidenceReport, scoreResearchTurn } from "./researchFixture";

function result(finalResponse = JSON.stringify(expectedEvidenceReport)): RuntimeTurnResult {
	return {
		executionId: "execution-a",
		adapter: "fake",
		status: "completed",
		sessionId: "session-a",
		contextSnapshotId: "context-a",
		finalResponse,
		events: [
			{ type: "session.started", sessionId: "session-a" },
			{ type: "turn.started" },
			{ type: "tool.completed", tool: "research_source_read", toolCallId: "tool-a", risk: "read", status: "succeeded", durationMs: 1, resultTruncated: false, replayed: false },
			{ type: "tool.completed", tool: "research_source_read", toolCallId: "tool-b", risk: "read", status: "succeeded", durationMs: 1, resultTruncated: false, replayed: false },
			{ type: "turn.completed", usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0 }, iterations: 2 },
		],
	};
}

describe("scoreResearchTurn", () => {
	it("accepts the exact source-backed artifact", () => {
		expect(scoreResearchTurn(result()).passed).toBe(true);
	});

	it("rejects an unsupported fact even when the JSON is valid", () => {
		const report = structuredClone(expectedEvidenceReport);
		report.facts[0]!.sourceIds = ["source-recovery"];
		expect(scoreResearchTurn(result(JSON.stringify(report)))).toMatchObject({
			passed: false,
			checks: expect.arrayContaining([expect.objectContaining({ name: "fact_lineage", passed: false })]),
		});
	});
});
