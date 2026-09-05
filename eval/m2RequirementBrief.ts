import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runM2RequirementWorkflow } from "../server/eval/m2RequirementWorkflow";

const directory = mkdtempSync(join(tmpdir(), "blackx-m2-requirement-eval-"));
try {
	const report = await runM2RequirementWorkflow(directory);
	console.log(JSON.stringify(report, null, 2));
	if (!report.passed) process.exitCode = 1;
} finally {
	rmSync(directory, { recursive: true, force: true });
}
