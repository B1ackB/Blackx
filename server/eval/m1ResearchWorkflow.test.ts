import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryStageJobQueue } from "../../src/enterprise/stageJobQueue";
import { expectedEvidenceReport } from "../../src/eval/researchFixture";
import type { AgentRuntimePort } from "../../src/runtime/contracts";
import { FileArtifactContentStore } from "../artifacts/fileArtifactStore";
import { StageJobScheduler } from "../workers/stageJobScheduler";
import {
	ResearchFixtureWorker,
	createOfflineResearchRuntime,
	researchStageJob,
} from "./m1ResearchWorkflow";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("M1 industry-neutral Research workflow", () => {
	it("runs Queue -> Worker -> ArtifactVersion -> Evaluation -> Approval", async () => {
		const directory = mkdtempSync(join(tmpdir(), "blackx-m1-research-"));
		directories.push(directory);
		const artifacts = new FileArtifactContentStore(directory);
		const queue = new InMemoryStageJobQueue();
		const worker = new ResearchFixtureWorker(createOfflineResearchRuntime(), artifacts);
		const scheduler = new StageJobScheduler(queue, {
			workerId: "research-worker",
			handlers: { research: (lease) => worker.executeLease(lease) },
		});
		const enqueued = queue.enqueue(researchStageJob());
		expect(queue.enqueue(researchStageJob())).toEqual(enqueued);
		expect(queue.list()).toHaveLength(1);

		expect(await scheduler.runNext()).toMatchObject({
			status: "completed",
			job: { jobId: enqueued.jobId, stageId: "research", status: "completed" },
		});
		const waiting = worker.getState();
		expect(waiting).toMatchObject({
			runStatus: "waiting_approval",
			stageStatus: "waiting_approval",
			artifact: {
				artifactId: "evidence-report",
				version: 1,
				contentRef: "artifact://evidence-report/v1",
				inputFactVersions: {
					"runtime.session_role": 1,
					"runtime.recovery_basis": 1,
				},
			},
			evaluation: {
				artifactId: "evidence-report",
				artifactVersion: 1,
				passed: true,
				reportRef: "artifact://research-evaluation/v1",
			},
			approval: {
				artifactId: "evidence-report",
				artifactVersion: 1,
				status: "requested",
			},
		});
		expect(artifacts.readJson({
			tenantId: enqueued.tenantId,
			workspaceId: enqueued.workspaceId,
			runId: enqueued.runId,
			artifactId: "evidence-report",
			artifactVersion: 1,
		})).toEqual(expectedEvidenceReport);
		expect(() => worker.approve({
			approvalId: waiting.approval!.approvalId,
			artifactId: "evidence-report",
			artifactVersion: 2,
			actorId: "m1-eval-approver",
		})).toThrow("Approval must bind the evaluated Research Artifact Version");

		const completed = worker.approve({
			...waiting.approval!,
			actorId: "m1-eval-approver",
		});
		expect(completed).toMatchObject({
			runStatus: "completed",
			stageStatus: "passed",
			approval: { status: "approved", resolvedBy: "m1-eval-approver" },
		});
		expect(completed.events).toEqual([
			"stage.queued",
			"stage.running",
			"artifact.version_created",
			"evaluation.completed",
			"approval.requested",
			"approval.resolved",
			"stage.completed",
		]);
		expect(queue.list()).toHaveLength(1);
		expect(queue.get(enqueued.jobId)).toMatchObject({
			status: "completed",
			deliveryCount: 1,
			sliceCount: 1,
		});
	});

	it("does not request Approval when deterministic Evaluation fails", async () => {
		const directory = mkdtempSync(join(tmpdir(), "blackx-m1-research-failed-"));
		directories.push(directory);
		const runtime: AgentRuntimePort = {
			health: async () => ({ adapter: "fake", online: true }),
			executeTurn: async (request) => ({
				executionId: "failed-research-execution",
				adapter: "fake",
				status: "completed",
				sessionId: request.sessionId,
				contextSnapshotId: "failed-research-context",
				finalResponse: JSON.stringify({ schemaVersion: "unsupported.v1" }),
				events: [],
			}),
		};
		const artifacts = new FileArtifactContentStore(directory);
		const queue = new InMemoryStageJobQueue();
		const worker = new ResearchFixtureWorker(runtime, artifacts);
		const scheduler = new StageJobScheduler(queue, {
			workerId: "research-worker",
			handlers: { research: (lease) => worker.executeLease(lease) },
		});
		queue.enqueue(researchStageJob());

		expect(await scheduler.runNext()).toMatchObject({
			status: "dead_letter",
			job: { lastFailure: { code: "invalid_output", retryable: false } },
		});
		const failed = worker.getState();
		expect(failed).toMatchObject({
			stageStatus: "failed",
			artifact: { artifactId: "evidence-report", version: 1 },
			evaluation: { passed: false },
			events: [
				"stage.queued",
				"stage.running",
				"artifact.version_created",
				"evaluation.completed",
			],
		});
		expect(failed.approval).toBeUndefined();
	});
});
