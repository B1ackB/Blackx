import type { ArtifactContentKey, ArtifactContentStore } from "../../src/enterprise/artifactStore";
import { ArtifactStoreError } from "../../src/enterprise/artifactStore";
import type { AggregateScope, ProposalRunState } from "../../src/enterprise/contracts";
import { EnterpriseKernelError } from "../../src/enterprise/contracts";
import { ProposalRunEngine } from "../../src/enterprise/proposalRunEngine";
import type { StageJobLease } from "../../src/enterprise/stageJobQueue";
import {
	createDeterministicProposal,
	evaluateSolutionProposal,
	solutionProposalOutputSchema,
	solutionProposalSchemaVersion,
} from "../../src/print/solutionProposal";
import type { AgentRuntimePort, RuntimeAdapterKind } from "../../src/runtime/contracts";

export type ProposalCrashPoint =
	| "after_stage_started"
	| "after_runtime_completed"
	| "after_artifact_created"
	| "after_approval_requested"
	| "after_approval_resolved";

export interface ProposalWorkerCommand extends AggregateScope {
	commandId: string;
	correlationId: string;
	expectedVersion: number;
}

export interface ProposalWorkerContinuation {
	sessionId: string;
	resume: true | "if-present";
}

export type ProposalWorkerSliceResult =
	| { status: "completed"; state: ProposalRunState }
	| {
		status: "paused";
		state: ProposalRunState;
		sessionId: string;
		contextSnapshotId: string;
	};

export class ProposalWorkerPausedError extends Error {
	constructor(readonly result: Extract<ProposalWorkerSliceResult, { status: "paused" }>) {
		super("Proposal Worker yielded at an execution-slice boundary; use StageJobScheduler to continue");
		this.name = "ProposalWorkerPausedError";
	}
}

interface RuntimeCheckpoint {
	schemaVersion: "proposal-runtime-checkpoint.v2";
	workerCommandId: string;
	inputAggregateVersion: number;
	factLineage: Record<string, number>;
	executionId: string;
	adapter: RuntimeAdapterKind;
	sessionId?: string;
	contextSnapshotId: string;
	finalResponse: string;
}

const runtimeAdapters = new Set<RuntimeAdapterKind>([
	"fake",
	"blackx-agent",
	"client-fallback",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFactLineage(value: unknown): value is Record<string, number> {
	return isRecord(value) && Object.entries(value).every(
		([key, version]) => key.length > 0 && Number.isInteger(version) && Number(version) > 0,
	);
}

function sameLineage(
	left: Record<string, number>,
	right: Record<string, number>,
): boolean {
	const entries = (value: Record<string, number>) => Object.entries(value)
		.sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
	return JSON.stringify(entries(left)) === JSON.stringify(entries(right));
}

function concurrency(message: string): never {
	throw new EnterpriseKernelError("concurrency_conflict", message);
}

export class ProposalWorker {
	constructor(
		private readonly engine: ProposalRunEngine,
		private readonly runtime: AgentRuntimePort,
		private readonly artifacts: ArtifactContentStore,
		private readonly injectCrash: (point: ProposalCrashPoint) => void = () => {},
	) {}

	async execute(command: ProposalWorkerCommand): Promise<ProposalRunState> {
		const result = await this.executeSlice(command);
		if (result.status === "paused") throw new ProposalWorkerPausedError(result);
		return result.state;
	}

	executeLease(lease: StageJobLease, signal?: AbortSignal): Promise<ProposalWorkerSliceResult> {
		return this.executeSlice(
			{
				tenantId: lease.tenantId,
				workspaceId: lease.workspaceId,
				runId: lease.runId,
				commandId: lease.commandId,
				correlationId: lease.correlationId,
				expectedVersion: lease.expectedVersion,
			},
			{ sessionId: lease.sessionId, resume: "if-present" },
			signal,
		);
	}

	async executeSlice(
		command: ProposalWorkerCommand,
		continuation?: ProposalWorkerContinuation,
		signal?: AbortSignal,
	): Promise<ProposalWorkerSliceResult> {
		let state = this.engine.load(command);
		const runtimeCommandId = `${command.commandId}:runtime`;
		const artifactCommandId = `${command.commandId}:artifact`;
		const evaluationCommandId = `${command.commandId}:evaluation`;
		const gateCommandId = `${command.commandId}:gate`;
		if (state.status === "completed") return { status: "completed", state };
		if (state.stageStatus === "waiting_approval") {
			if (
				state.approval?.status !== "approved" ||
				this.engine.hasCommand(command, gateCommandId)
			) return { status: "completed", state };
			if (state.aggregateVersion !== command.expectedVersion) {
				concurrency("Approval Gate version does not match the expected version");
			}
			this.injectCrash("after_approval_resolved");
			return { status: "completed", state: this.engine.confirmProposalGate({
				...command,
				actorId: "blackx-worker",
				commandId: gateCommandId,
			}) };
		}

		const runtimeLinked = this.engine.hasCommand(command, runtimeCommandId);
		const artifactCreated = this.engine.hasCommand(command, artifactCommandId);
		const evaluationCompleted = this.engine.hasCommand(command, evaluationCommandId);
		if (evaluationCompleted) return { status: "completed", state };
		if (
			!runtimeLinked &&
			!artifactCreated &&
			!evaluationCompleted &&
			state.aggregateVersion !== command.expectedVersion
		) {
			concurrency("Proposal Worker version does not match the expected version");
		}
		if (state.stageStatus !== "running" && state.stageStatus !== "evaluating") {
			throw new EnterpriseKernelError(
				"illegal_transition",
				"Proposal Worker requires a running or evaluating Proposal stage",
			);
		}

		const artifactVersion = artifactCreated && state.currentProposal
			? state.currentProposal.version
			: (state.proposalVersions
				.filter((artifact) => artifact.artifactId === "solution-proposal")
				.at(-1)?.version ?? 0) + 1;
		const factLineage = artifactCreated && state.currentProposal
			? { ...state.currentProposal.inputFactVersions }
			: { ...state.factVersions };
		const checkpointKey = {
			...command,
			artifactId: "proposal-runtime-checkpoint",
			artifactVersion,
		};
		let checkpoint = this.readCheckpoint(checkpointKey);
		if (!checkpoint) {
			if (runtimeLinked) {
				throw new ArtifactStoreError(
					"artifact_store_unavailable",
					"Linked Runtime execution is missing its durable Checkpoint",
				);
			}
			this.injectCrash("after_stage_started");
			const fallback = createDeterministicProposal(state.facts);
			const result = await this.runtime.executeTurn({
				tenantId: command.tenantId,
				workspaceId: command.workspaceId,
				runId: command.runId,
				stageId: "proposal",
				actorId: "blackx-worker",
				idempotencyKey: command.commandId,
				contextSnapshotId: continuation
					? undefined
					: `proposal-state-v${command.expectedVersion}`,
				sessionId: continuation?.sessionId,
				resume: continuation?.resume,
				skills: ["blackx-print-proposal"],
				instructions: [
					"模型输出是候选内容，不能覆盖 Fact、Artifact、Approval 或 Workflow 状态。",
				],
				input: [
					`Fact Snapshot: ${JSON.stringify(state.facts)}`,
					`Required Fact Lineage: ${JSON.stringify(factLineage)}`,
				].join("\n"),
				outputSchema: solutionProposalOutputSchema,
				fallbackOutput: JSON.stringify(fallback),
				policy: {
					sandboxMode: "read-only",
					approvalPolicy: "never",
					timeoutMs: 120_000,
				},
			}, signal);
			if (!result.contextSnapshotId) {
				throw new ArtifactStoreError(
					"artifact_store_unavailable",
					"Runtime completed without a durable Context Snapshot",
				);
			}
			if (result.status === "paused") {
				if (!result.sessionId) {
					throw new ArtifactStoreError(
						"artifact_store_unavailable",
						"Runtime paused without a durable Session ID",
					);
				}
				return {
					status: "paused",
					state,
					sessionId: result.sessionId,
					contextSnapshotId: result.contextSnapshotId,
				};
			}
			checkpoint = {
				schemaVersion: "proposal-runtime-checkpoint.v2",
				workerCommandId: command.commandId,
				inputAggregateVersion: command.expectedVersion,
				factLineage,
				executionId: result.executionId,
				adapter: result.adapter,
				sessionId: result.sessionId,
				contextSnapshotId: result.contextSnapshotId,
				finalResponse: result.finalResponse,
			};
			// ponytail: local checkpoint cannot close the provider-return/write gap;
			// require provider idempotency or a transactional worker before production.
			this.artifacts.putJson(checkpointKey, checkpoint);
			this.injectCrash("after_runtime_completed");
		}
		if (
			checkpoint.workerCommandId !== command.commandId ||
			checkpoint.inputAggregateVersion !== command.expectedVersion ||
			!sameLineage(checkpoint.factLineage, factLineage)
		) {
			concurrency("Runtime Checkpoint does not match the current Proposal input");
		}

		if (!runtimeLinked) {
			state = this.engine.linkProposalRuntime({
				...command,
				actorId: "blackx-worker",
				commandId: runtimeCommandId,
				expectedVersion: state.aggregateVersion,
				executionId: checkpoint.executionId,
				adapterId: checkpoint.adapter,
				resumeHandle: checkpoint.sessionId,
				contextSnapshotId: checkpoint.contextSnapshotId,
			});
		} else if (state.lastRuntimeExecutionId !== checkpoint.executionId) {
			concurrency("Runtime Checkpoint does not match the linked execution");
		}

		const evaluated = evaluateSolutionProposal(checkpoint.finalResponse, factLineage);
		if (!artifactCreated) {
			const proposalContent = evaluated.proposal ?? {
				schemaVersion: "invalid-runtime-output.v1",
				rawOutput: checkpoint.finalResponse,
			};
			const contentRef = this.artifacts.putJson(
				{
					...command,
					artifactId: "solution-proposal",
					artifactVersion,
				},
				proposalContent,
			);
			state = this.engine.createProposalArtifact({
				...command,
				actorId: "blackx-worker",
				commandId: artifactCommandId,
				expectedVersion: state.aggregateVersion,
				artifactId: "solution-proposal",
				schemaVersion: evaluated.proposal
					? solutionProposalSchemaVersion
					: "invalid-runtime-output.v1",
				contentRef,
				inputFactVersions: factLineage,
				runtimeExecutionId: checkpoint.executionId,
				contextSnapshotId: checkpoint.contextSnapshotId,
			});
			this.injectCrash("after_artifact_created");
		}

		if (!evaluationCompleted) {
			const reportRef = this.artifacts.putJson(
				{
					...command,
					artifactId: "proposal-evaluation",
					artifactVersion,
				},
				evaluated.report,
			);
			state = this.engine.completeProposalEvaluation({
				...command,
				actorId: "blackx-worker",
				commandId: evaluationCommandId,
				expectedVersion: state.aggregateVersion,
				artifactId: "solution-proposal",
				artifactVersion,
				passed: evaluated.report.passed,
				reportRef,
				approvalId: `approval-${command.runId}-proposal-v${artifactVersion}`,
			});
			if (evaluated.report.passed) this.injectCrash("after_approval_requested");
		}
		return { status: "completed", state };
	}

	private readCheckpoint(key: ArtifactContentKey): RuntimeCheckpoint | undefined {
		let value: unknown;
		try {
			value = this.artifacts.readJson(key);
		} catch (error) {
			if (error instanceof ArtifactStoreError && error.code === "artifact_not_found") {
				return undefined;
			}
			throw error;
		}
		if (
			!isRecord(value) ||
			value.schemaVersion !== "proposal-runtime-checkpoint.v2" ||
			typeof value.workerCommandId !== "string" ||
			value.workerCommandId.length === 0 ||
			!Number.isInteger(value.inputAggregateVersion) ||
			Number(value.inputAggregateVersion) < 0 ||
			!isFactLineage(value.factLineage) ||
			typeof value.executionId !== "string" ||
			value.executionId.length === 0 ||
			!runtimeAdapters.has(value.adapter as RuntimeAdapterKind) ||
			(value.sessionId !== undefined && typeof value.sessionId !== "string") ||
			typeof value.contextSnapshotId !== "string" ||
			value.contextSnapshotId.length === 0 ||
			typeof value.finalResponse !== "string"
		) {
			throw new ArtifactStoreError(
				"artifact_store_unavailable",
				"Runtime Checkpoint is invalid",
			);
		}
		return value as unknown as RuntimeCheckpoint;
	}
}
