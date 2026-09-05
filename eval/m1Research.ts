import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FileArtifactContentStore } from "../server/artifacts/fileArtifactStore";
import {
	createOfflineResearchRuntime,
	runResearchWorkflow,
} from "../server/eval/m1ResearchWorkflow";
import { createRuntime } from "../server/runtime/createRuntime";
import { researchSourceTool } from "../server/runtime/researchTools";

const online = process.argv.includes("--online");
const temporaryDirectory = mkdtempSync(join(tmpdir(), "blackx-m1-eval-"));
try {
	const runtime = online
		? createRuntime({
			...process.env,
			BLACKX_RUNTIME_MODE: "anthropic",
			BLACKX_AGENT_STATE_PATH: join(temporaryDirectory, "agent"),
		}, { tools: [researchSourceTool] }).runtime
		: createOfflineResearchRuntime();
	const workflow = await runResearchWorkflow(
		runtime,
		new FileArtifactContentStore(join(temporaryDirectory, "artifacts")),
	);
	const report = {
		contract: "blackx-m1-durable-runtime-v1",
		mode: online ? "online" : "offline",
		model: online ? process.env.ANTHROPIC_MODEL : "scripted-fake",
		...workflow.state.evaluation!.report,
		pipeline: {
			jobStatus: workflow.job.status,
			artifact: workflow.state.artifact,
			evaluation: {
				passed: workflow.state.evaluation!.passed,
				reportRef: workflow.state.evaluation!.reportRef,
			},
			approval: workflow.state.approval,
			stageStatus: workflow.state.stageStatus,
			events: workflow.state.events,
		},
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
