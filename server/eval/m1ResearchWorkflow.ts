import type { AgentModelProvider } from "../../src/agent/contracts";
import { SkillRegistry } from "../../src/agent/skills";
import type { ArtifactContentStore } from "../../src/enterprise/artifactStore";
import type {
	ApprovalState,
	ArtifactVersionState,
	StageJobDispatch,
} from "../../src/enterprise/contracts";
import { EnterpriseKernelError } from "../../src/enterprise/contracts";
import {
	InMemoryStageJobQueue,
	type StageJob,
	type StageJobLease,
} from "../../src/enterprise/stageJobQueue";
import {
	expectedEvidenceReport,
	researchEvalRequest,
	scoreResearchTurn,
	type ResearchEvalReport,
} from "../../src/eval/researchFixture";
import type { AgentRuntimePort, RuntimeTurnResult } from "../../src/runtime/contracts";
import { RuntimeFailure } from "../../src/runtime/contracts";
import { BlackxAgentRuntime } from "../runtime/agentRuntime";
import { researchSourceTool } from "../runtime/researchTools";
import {
	StageJobScheduler,
	type StageJobHandlerResult,
	type StageJobRunResult,
} from "../workers/stageJobScheduler";

const scope = {
	tenantId: researchEvalRequest.tenantId,
	workspaceId: researchEvalRequest.workspaceId,
	runId: researchEvalRequest.runId,
};

const factLineage = {
	"runtime.session_role": 1,
	"runtime.recovery_basis": 1,
};

export type ResearchWorkflowEventType =
	| "stage.queued"
	| "stage.running"
	| "artifact.version_created"
	| "evaluation.completed"
	| "approval.requested"
	| "approval.resolved"
	| "stage.completed";

export interface ResearchEvaluationState {
	artifactId: string;
	artifactVersion: number;
	passed: boolean;
	reportRef: string;
	report: ResearchEvalReport;
}

export interface ResearchWorkflowState {
	runStatus: "running" | "waiting_approval" | "completed";
	stageStatus: "queued" | "running" | "evaluating" | "waiting_approval" | "passed" | "failed";
	artifact?: ArtifactVersionState;
	evaluation?: ResearchEvaluationState;
	approval?: ApprovalState & { resolvedBy?: string };
	events: ResearchWorkflowEventType[];
}

export function researchStageJob(): StageJobDispatch {
	return {
		...scope,
		jobId: "research-eval-research-001",
		stageId: researchEvalRequest.stageId,
		commandId: researchEvalRequest.idempotencyKey,
		correlationId: "eval-research-001-correlation",
		expectedVersion: 0,
		sessionId: "eval-research-001-session",
		maxFailures: 2,
		maxSlices: 4,
	};
}

export class ResearchFixtureWorker {
	private state: ResearchWorkflowState = {
		runStatus: "running",
		stageStatus: "queued",
		events: ["stage.queued"],
	};
	private runtimeResult?: RuntimeTurnResult;

	constructor(
		private readonly runtime: AgentRuntimePort,
		private readonly artifacts: ArtifactContentStore,
	) {}

	getState(): ResearchWorkflowState {
		return structuredClone(this.state);
	}

	getRuntimeResult(): RuntimeTurnResult | undefined {
		return this.runtimeResult && structuredClone(this.runtimeResult);
	}

	async executeLease(lease: StageJobLease): Promise<StageJobHandlerResult> {
		this.assertLease(lease);
		if (this.state.stageStatus === "waiting_approval" || this.state.stageStatus === "passed") {
			return { status: "completed" };
		}
		this.state.stageStatus = "running";
		if (!this.state.events.includes("stage.running")) this.state.events.push("stage.running");
		const result = await this.runtime.executeTurn({
			...researchEvalRequest,
			idempotencyKey: lease.commandId,
			sessionId: lease.sessionId,
			resume: "if-present",
		});
		if (result.status === "paused") {
			if (!result.sessionId) {
				throw new RuntimeFailure("invalid_output", "Research Runtime paused without a Session ID", false);
			}
			return {
				status: "paused",
				sessionId: result.sessionId,
				contextSnapshotId: result.contextSnapshotId,
			};
		}
		this.runtimeResult = result;
		this.state.stageStatus = "evaluating";
		const artifactVersion = 1;
		let content: unknown;
		let schemaVersion = "invalid-runtime-output.v1";
		try {
			content = JSON.parse(result.finalResponse);
			if (
				content &&
				typeof content === "object" &&
				!Array.isArray(content) &&
				(content as Record<string, unknown>).schemaVersion === "evidence-report.v1"
			) schemaVersion = "evidence-report.v1";
		} catch {
			content = { schemaVersion, rawOutput: result.finalResponse };
		}
		const contentRef = this.artifacts.putJson({
			...scope,
			artifactId: "evidence-report",
			artifactVersion,
		}, content);
		this.state.artifact = {
			artifactId: "evidence-report",
			version: artifactVersion,
			schemaVersion,
			contentRef,
			freshness: "fresh",
			inputFactVersions: factLineage,
			runtimeExecutionId: result.executionId,
			contextSnapshotId: result.contextSnapshotId,
		};
		this.state.events.push("artifact.version_created");

		const report = scoreResearchTurn(result);
		const reportRef = this.artifacts.putJson({
			...scope,
			artifactId: "research-evaluation",
			artifactVersion,
		}, report);
		this.state.evaluation = {
			artifactId: "evidence-report",
			artifactVersion,
			passed: report.passed,
			reportRef,
			report,
		};
		this.state.events.push("evaluation.completed");
		if (!report.passed) {
			this.state.stageStatus = "failed";
			throw new RuntimeFailure("invalid_output", "Research Artifact failed deterministic Evaluation", false);
		}

		this.state.runStatus = "waiting_approval";
		this.state.stageStatus = "waiting_approval";
		this.state.approval = {
			approvalId: `approval-${scope.runId}-evidence-report-v${artifactVersion}`,
			artifactId: "evidence-report",
			artifactVersion,
			status: "requested",
		};
		this.state.events.push("approval.requested");
		return { status: "completed" };
	}

	approve(input: {
		approvalId: string;
		artifactId: string;
		artifactVersion: number;
		actorId: string;
	}): ResearchWorkflowState {
		const approval = this.state.approval;
		if (this.state.stageStatus !== "waiting_approval" || !approval || !this.state.evaluation?.passed) {
			throw new EnterpriseKernelError("illegal_transition", "Research Artifact is not awaiting Approval");
		}
		if (
			input.approvalId !== approval.approvalId ||
			input.artifactId !== approval.artifactId ||
			input.artifactVersion !== approval.artifactVersion
		) {
			throw new EnterpriseKernelError(
				"artifact_version_mismatch",
				"Approval must bind the evaluated Research Artifact Version",
			);
		}
		this.state.approval = { ...approval, status: "approved", resolvedBy: input.actorId };
		this.state.events.push("approval.resolved");
		this.state.runStatus = "completed";
		this.state.stageStatus = "passed";
		this.state.events.push("stage.completed");
		return this.getState();
	}

	private assertLease(lease: StageJobLease): void {
		if (
			lease.stageId !== researchEvalRequest.stageId ||
			lease.tenantId !== scope.tenantId ||
			lease.workspaceId !== scope.workspaceId ||
			lease.runId !== scope.runId
		) {
			throw new RuntimeFailure("permission_denied", "Research Worker lease is outside the Fixture scope", false);
		}
	}
}

export interface ResearchWorkflowResult {
	job: StageJob;
	schedulerResult: StageJobRunResult;
	state: ResearchWorkflowState;
	runtimeResult: RuntimeTurnResult;
}

export async function runResearchWorkflow(
	runtime: AgentRuntimePort,
	artifacts: ArtifactContentStore,
): Promise<ResearchWorkflowResult> {
	const queue = new InMemoryStageJobQueue();
	const worker = new ResearchFixtureWorker(runtime, artifacts);
	const scheduler = new StageJobScheduler(queue, {
		workerId: "m1-research-worker",
		handlers: { research: (lease) => worker.executeLease(lease) },
	});
	const enqueued = queue.enqueue(researchStageJob());
	const schedulerResult = await scheduler.runNext();
	if (schedulerResult.status !== "completed") {
		throw new Error(`Research Fixture did not complete its Worker slice: ${schedulerResult.status}`);
	}
	const waiting = worker.getState();
	if (!waiting.approval) throw new Error("Research Fixture did not request Approval");
	const state = worker.approve({
		...waiting.approval,
		actorId: "m1-eval-approver",
	});
	const runtimeResult = worker.getRuntimeResult();
	if (!runtimeResult) throw new Error("Research Fixture did not retain its Runtime result");
	return {
		job: queue.get(enqueued.jobId)!,
		schedulerResult,
		state,
		runtimeResult,
	};
}

export function createOfflineResearchRuntime(): BlackxAgentRuntime {
	let modelCall = 0;
	const usage = {
		inputTokens: 100,
		cachedInputTokens: 0,
		outputTokens: 50,
		reasoningOutputTokens: 0,
	};
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
