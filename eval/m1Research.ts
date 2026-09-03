import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentModelProvider } from "../src/agent/contracts";
import { SkillRegistry } from "../src/agent/skills";
import { expectedEvidenceReport, researchEvalRequest, scoreResearchTurn } from "../src/eval/researchFixture";
import { BlackxAgentRuntime } from "../server/runtime/agentRuntime";
import { createRuntime } from "../server/runtime/createRuntime";
import { researchSourceTool } from "../server/runtime/researchTools";

const usage = {
	inputTokens: 100,
	cachedInputTokens: 0,
	outputTokens: 50,
	reasoningOutputTokens: 0,
};

function offlineRuntime(): BlackxAgentRuntime {
	let modelCall = 0;
	const provider: AgentModelProvider = {
		async generate() {
			modelCall += 1;
			return modelCall === 1
				? {
					text: "",
					toolCalls: [
						{ id: "read-session", name: "research_source_read", input: { sourceId: "source-session" } },
						{ id: "read-recovery", name: "research_source_read", input: { sourceId: "source-recovery" } },
					],
					usage,
				}
				: { text: JSON.stringify(expectedEvidenceReport), toolCalls: [], usage };
		},
	};
	return new BlackxAgentRuntime({
		provider,
		skills: new SkillRegistry(),
		tools: [researchSourceTool],
		maxIterations: 4,
	});
}

const online = process.argv.includes("--online");
const temporaryDirectory = mkdtempSync(join(tmpdir(), "blackx-m1-eval-"));
try {
	const runtime = online
		? createRuntime({
			...process.env,
			BLACKX_RUNTIME_MODE: "anthropic",
			BLACKX_AGENT_STATE_PATH: join(temporaryDirectory, "agent"),
		}, { tools: [researchSourceTool] }).runtime
		: offlineRuntime();
	const result = await runtime.executeTurn(researchEvalRequest);
	const report = {
		contract: "blackx-m1-durable-runtime-v1",
		mode: online ? "online" : "offline",
		model: online ? process.env.ANTHROPIC_MODEL : "scripted-fake",
		...scoreResearchTurn(result),
	};
	const output = `${JSON.stringify(report, null, 2)}\n`;
	const reportPath = process.env.BLACKX_EVAL_REPORT_PATH;
	if (reportPath) {
		mkdirSync(dirname(reportPath), { recursive: true });
		writeFileSync(reportPath, output, { encoding: "utf8", mode: 0o600 });
	}
	console.log(output.trimEnd());
	if (!report.passed) process.exitCode = 1;
} finally {
	rmSync(temporaryDirectory, { recursive: true, force: true });
}
