import type { ArtifactContentStore } from "../../src/enterprise/artifactStore";
import { ArtifactStoreError } from "../../src/enterprise/artifactStore";
import type { ProposalRunState } from "../../src/enterprise/contracts";
import { ProposalRunEngine } from "../../src/enterprise/proposalRunEngine";
import { requiredRequirementFacts } from "../../src/manufacturing/requirementBrief";
import type {
	ConversationSummary,
	ConversationView,
	RequirementBriefMetricsSeriesView,
	RequirementBriefMetricsView,
	RequirementBriefRunMetricsPoint,
	RequirementBriefWorkspaceView,
} from "../../src/runtime/conversationContracts";
import type { RuntimeUsage } from "../../src/runtime/contracts";
import {
	ProposalWorkspaceApiController,
	ProposalWorkspaceValidationError,
} from "../enterprise/proposalWorkspaceApi";
import { ConversationApiController } from "../runtime/conversationApi";
import { FileConversationAttachmentStore } from "../runtime/conversationAttachments";
import { StageJobOutbox } from "../workers/stageJobOutbox";
import { StageJobScheduler } from "../workers/stageJobScheduler";

function industryFact(payload: unknown, _conversation: ConversationView) {
	if (
		!payload ||
		typeof payload !== "object" ||
		Array.isArray(payload) ||
		!("industry" in payload) ||
		(payload.industry !== "print" && payload.industry !== "furniture")
	) {
		throw new ProposalWorkspaceValidationError("industry must be print or furniture");
	}
	return [{
		key: "industry",
		value: payload.industry,
		status: "verified" as const,
		sourceType: "human_confirmation" as const,
		sourceRef: `ui:industry:${payload.industry}`,
	}];
}

export class RequirementBriefWorkspaceApiController extends ProposalWorkspaceApiController {
	constructor(
		conversations: ConversationApiController,
		private readonly requirementEngine: ProposalRunEngine,
		private readonly requirementArtifacts: ArtifactContentStore,
		outbox: StageJobOutbox,
		private readonly requirementScheduler: StageJobScheduler,
		attachments?: FileConversationAttachmentStore,
		private readonly now: () => string = () => new Date().toISOString(),
	) {
		super(conversations, requirementEngine, requirementArtifacts, outbox, requirementScheduler, {
			responseKey: "requirementBrief",
			requestErrorCode: "invalid_requirement_brief_request",
			failureCode: "requirement_brief_workspace_failed",
			runPrefix: "requirement",
			stageId: "requirement-brief",
			jobPrefix: "requirement",
			evaluationArtifactId: "requirement-brief-evaluation",
			protectedFactKeys: ["industry", "customer_brief", "customer_attachments"],
			startFacts: (payload, conversation, scope) => {
				const facts = industryFact(payload, conversation);
				const attachmentScope = {
					tenantId: scope.tenantId,
					workspaceId: scope.workspaceId,
					conversationId: conversation.conversationId,
				};
				const digest = attachments?.digest(attachmentScope);
				if (!digest) return facts;
				return [...facts, {
					key: "customer_attachments",
					value: digest,
					status: "unverified" as const,
					sourceType: "source_document" as const,
					sourceRef: `conversation:${conversation.conversationId}:attachments:${digest}`,
				}];
			},
		});
	}

	metricsSeries(context: Parameters<ConversationApiController["list"]>[0]) {
		return this.respond(() => {
			const response = this.conversations.list(context);
			if (response.status !== 200) return response;
			const conversations = (response.body as { conversations: ConversationSummary[] }).conversations;
			const points = conversations.flatMap((conversation): RequirementBriefRunMetricsPoint[] => {
				const { scope } = this.target(context, conversation.conversationId);
				const state = this.requirementEngine.load(scope);
				if (state.aggregateVersion === 0) return [];
				const events = this.requirementEngine.readEvents(state);
				const first = events[0];
				const last = events.at(-1);
				if (!first || !last) return [];
				const terminal = events.findLast((event) =>
					event.data.type === "stage.completed" || event.data.type === "stage.cancelled",
				);
				const industry = state.facts.industry?.value;
				return [{
					runId: state.runId,
					conversationId: conversation.conversationId,
					...(industry === "print" || industry === "furniture" ? { industry } : {}),
					stageStatus: state.stageStatus,
					evaluationPassed: state.evaluation?.passed ?? null,
					approvalEligible: Boolean(state.approval),
					startedAt: first.occurredAt,
					updatedAt: last.occurredAt,
					...(terminal ? { completedAt: terminal.occurredAt } : {}),
					metrics: this.metrics(state),
				}];
			}).sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt));
			return {
				status: 200,
				body: { requirementBriefMetrics: this.summarize(points) },
			};
		});
	}

	protected override view(state: ProposalRunState): RequirementBriefWorkspaceView {
		return {
			...super.view(state),
			metrics: this.metrics(state),
		};
	}

	private metrics(state: ProposalRunState): RequirementBriefMetricsView {
		const industry = state.facts.industry?.value;
		const required = industry === "print" || industry === "furniture"
			? requiredRequirementFacts[industry]
			: [];
		const confirmedRequiredFacts = required.filter((key) => state.facts[key]?.status === "verified").length;
		const missingRequiredFacts = required.filter((key) => {
			const fact = state.facts[key];
			return !fact || fact.status === "rejected";
		});
		const checkpoints = state.proposalVersions
			.filter((artifact) => artifact.artifactId === "requirement-brief")
			.map((artifact) => this.readCheckpointMetrics(state, artifact.version))
			.filter((checkpoint) => checkpoint !== undefined);
		const rawCandidateFacts = checkpoints.reduce(
			(total, checkpoint) => total + (checkpoint.rawCandidateFactCount ?? 0),
			0,
		);
		const canonicalCandidateFacts = checkpoints.reduce(
			(total, checkpoint) => total + (checkpoint.canonicalCandidateFactCount ?? 0),
			0,
		);
		const toolExecutionCount = checkpoints.reduce(
			(total, checkpoint) => total + (checkpoint.toolExecutionCount ?? 0),
			0,
		);
		const toolFailureCount = checkpoints.reduce(
			(total, checkpoint) => total + (checkpoint.toolFailureCount ?? 0),
			0,
		);
		const usages = checkpoints.flatMap((checkpoint) => checkpoint.usage ? [checkpoint.usage] : []);
		const usage = usages.length > 0
			? usages.reduce<RuntimeUsage>((total, current) => ({
				inputTokens: total.inputTokens + current.inputTokens,
				cachedInputTokens: total.cachedInputTokens + current.cachedInputTokens,
				outputTokens: total.outputTokens + current.outputTokens,
				reasoningOutputTokens: total.reasoningOutputTokens + current.reasoningOutputTokens,
			}), { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 })
			: null;
		const durations = checkpoints.flatMap((checkpoint) =>
			checkpoint.runtimeDurationMs === undefined ? [] : [checkpoint.runtimeDurationMs],
		);
		const jobs = this.requirementScheduler.jobsForRun(state);
		const deliveryCount = jobs.reduce((total, job) => total + job.deliveryCount, 0);
		const totalFailureCount = jobs.reduce((total, job) => total + job.totalFailureCount, 0);
		const recoveryCount = jobs.reduce((total, job) => total + job.recoveryCount, 0);
		const modelCandidates = new Map<string, { value: string | number | boolean; unit?: string }>();
		for (const event of this.requirementEngine.readEvents(state)) {
			if (event.data.type === "fact.version_recorded" && event.data.sourceType === "model_output") {
				modelCandidates.set(event.data.factKey, { value: event.data.value, unit: event.data.unit });
			}
		}
		const confirmedCandidates = [...modelCandidates].filter(([key, candidate]) => {
			const current = state.facts[key];
			return current?.status === "verified" &&
				Object.is(current.value, candidate.value) && current.unit === candidate.unit;
		}).length;
		const artifactMetrics = state.proposalVersions
			.filter((artifact) => artifact.artifactId === "requirement-brief")
			.map((artifact) => this.readArtifactMetrics(state, artifact.version));
		const artifactFactCount = artifactMetrics.reduce((total, metrics) => total + metrics.facts, 0);
		const sourcedArtifactFacts = artifactMetrics.reduce((total, metrics) => total + metrics.sourcedFacts, 0);
		return {
			schemaVersion: "requirement-brief-metrics.v1",
			canonicalFactHitRate: rawCandidateFacts > 0
				? canonicalCandidateFacts / rawCandidateFacts
				: null,
			confirmedCandidateAccuracy: modelCandidates.size > 0
				? confirmedCandidates / modelCandidates.size
				: null,
			sourceCoverageRate: artifactFactCount > 0
				? sourcedArtifactFacts / artifactFactCount
				: null,
			canonicalCandidateFacts,
			rawCandidateFacts,
			confirmationRate: required.length > 0 ? confirmedRequiredFacts / required.length : 0,
			confirmedRequiredFacts,
			requiredFacts: required.length,
			missingRequiredFacts,
			clarificationRounds: this.requirementEngine.readEvents(state)
				.filter((event) => event.data.type === "stage.input_required").length,
			clarificationQuestions: artifactMetrics.reduce(
				(total, metrics) => total + metrics.missingRequiredFacts,
				0,
			),
			artifactVersions: state.proposalVersions.filter(
				(artifact) => artifact.artifactId === "requirement-brief",
			).length,
			cancelled: state.stageStatus === "cancelled",
			queue: {
				deliveryCount,
				sliceCount: jobs.reduce((total, job) => total + job.sliceCount, 0),
				failureCount: jobs.reduce((total, job) => total + job.failureCount, 0),
				totalFailureCount,
				recoveryCount,
				failureRate: deliveryCount > 0 ? totalFailureCount / deliveryCount : null,
				recoveryRate: deliveryCount > 0 ? recoveryCount / deliveryCount : null,
			},
			runtime: {
				latencyMs: durations.length > 0 ? durations.reduce((total, duration) => total + duration, 0) : null,
				usage,
				costUsd: null,
				costStatus: "unconfigured",
				toolExecutionCount,
				toolFailureCount,
				toolFailureRate: toolExecutionCount > 0 ? toolFailureCount / toolExecutionCount : null,
			},
		};
	}

	private readCheckpointMetrics(
		state: ProposalRunState,
		artifactVersion: number,
	): {
		runtimeDurationMs?: number;
		usage?: RuntimeUsage;
		rawCandidateFactCount?: number;
		canonicalCandidateFactCount?: number;
		toolExecutionCount?: number;
		toolFailureCount?: number;
	} | undefined {
		let value: unknown;
		try {
			value = this.requirementArtifacts.readJson({
				...state,
				artifactId: "requirement-runtime-checkpoint",
				artifactVersion,
			});
		} catch (error) {
			if (error instanceof ArtifactStoreError && error.code === "artifact_not_found") return undefined;
			throw error;
		}
		if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
		return value as {
			runtimeDurationMs?: number;
			usage?: RuntimeUsage;
			rawCandidateFactCount?: number;
			canonicalCandidateFactCount?: number;
			toolExecutionCount?: number;
			toolFailureCount?: number;
		};
	}

	private readArtifactMetrics(
		state: ProposalRunState,
		artifactVersion: number,
	): { facts: number; sourcedFacts: number; missingRequiredFacts: number } {
		const value = this.requirementArtifacts.readJson({
			...state,
			artifactId: "requirement-brief",
			artifactVersion,
		});
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			return { facts: 0, sourcedFacts: 0, missingRequiredFacts: 0 };
		}
		const record = value as { facts?: unknown; missingRequiredFacts?: unknown };
		const facts = Array.isArray(record.facts) ? record.facts : [];
		return {
			facts: facts.length,
			sourcedFacts: facts.filter((fact) =>
				Boolean(fact) && typeof fact === "object" && !Array.isArray(fact) &&
				typeof (fact as { sourceRef?: unknown }).sourceRef === "string" &&
				Boolean((fact as { sourceRef: string }).sourceRef.trim()),
			).length,
			missingRequiredFacts: Array.isArray(record.missingRequiredFacts)
				? record.missingRequiredFacts.length
				: 0,
		};
	}

	private summarize(points: RequirementBriefRunMetricsPoint[]): RequirementBriefMetricsSeriesView {
		const average = (values: number[]) => values.length > 0
			? values.reduce((total, value) => total + value, 0) / values.length
			: null;
		const evaluated = points.filter((point) => point.evaluationPassed !== null);
		const usages = points.flatMap((point) => point.metrics.runtime.usage ? [point.metrics.runtime.usage] : []);
		const usage = usages.length > 0
			? usages.reduce<RuntimeUsage>((total, current) => ({
				inputTokens: total.inputTokens + current.inputTokens,
				cachedInputTokens: total.cachedInputTokens + current.cachedInputTokens,
				outputTokens: total.outputTokens + current.outputTokens,
				reasoningOutputTokens: total.reasoningOutputTokens + current.reasoningOutputTokens,
			}), { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 })
			: null;
		return {
			schemaVersion: "requirement-brief-metrics-series.v1",
			generatedAt: this.now(),
			points,
			totals: {
				runs: points.length,
				passed: points.filter((point) => point.stageStatus === "passed").length,
				needsInput: points.filter((point) => point.stageStatus === "needs_input").length,
				waitingApproval: points.filter((point) => point.stageStatus === "waiting_approval").length,
				cancelled: points.filter((point) => point.stageStatus === "cancelled").length,
				active: points.filter((point) => ["pending", "running", "evaluating", "revision_required", "retryable_failed"].includes(point.stageStatus)).length,
				artifactVersions: points.reduce((total, point) => total + point.metrics.artifactVersions, 0),
				clarificationRounds: points.reduce((total, point) => total + point.metrics.clarificationRounds, 0),
				clarificationQuestions: points.reduce((total, point) => total + point.metrics.clarificationQuestions, 0),
			},
			rates: {
				workflowCompletion: points.length > 0
					? points.filter((point) => ["needs_input", "waiting_approval", "passed"].includes(point.stageStatus)).length / points.length
					: null,
				evaluationPass: evaluated.length > 0
					? evaluated.filter((point) => point.evaluationPassed).length / evaluated.length
					: null,
				approvalEligibility: points.length > 0
					? points.filter((point) => point.approvalEligible).length / points.length
					: null,
				stagePass: points.length > 0
					? points.filter((point) => point.stageStatus === "passed").length / points.length
					: null,
			},
			averages: {
				canonicalFactHitRate: average(points.flatMap((point) =>
					point.metrics.canonicalFactHitRate === null ? [] : [point.metrics.canonicalFactHitRate],
				)),
				confirmedCandidateAccuracy: average(points.flatMap((point) =>
					point.metrics.confirmedCandidateAccuracy === null ? [] : [point.metrics.confirmedCandidateAccuracy],
				)),
				sourceCoverageRate: average(points.flatMap((point) =>
					point.metrics.sourceCoverageRate === null ? [] : [point.metrics.sourceCoverageRate],
				)),
				confirmationRate: average(points.map((point) => point.metrics.confirmationRate)),
				runtimeLatencyMs: average(points.flatMap((point) =>
					point.metrics.runtime.latencyMs === null ? [] : [point.metrics.runtime.latencyMs],
				)),
			},
			queue: (() => {
				const deliveries = points.reduce((total, point) => total + point.metrics.queue.deliveryCount, 0);
				const failures = points.reduce((total, point) => total + point.metrics.queue.totalFailureCount, 0);
				const recoveries = points.reduce((total, point) => total + point.metrics.queue.recoveryCount, 0);
				return {
					deliveries,
					slices: points.reduce((total, point) => total + point.metrics.queue.sliceCount, 0),
					failures,
					recoveries,
					failureRate: deliveries > 0 ? failures / deliveries : null,
					recoveryRate: deliveries > 0 ? recoveries / deliveries : null,
				};
			})(),
			runtime: {
				usage,
				toolExecutions: points.reduce((total, point) => total + point.metrics.runtime.toolExecutionCount, 0),
				toolFailures: points.reduce((total, point) => total + point.metrics.runtime.toolFailureCount, 0),
				toolFailureRate: (() => {
					const executions = points.reduce((total, point) => total + point.metrics.runtime.toolExecutionCount, 0);
					const failures = points.reduce((total, point) => total + point.metrics.runtime.toolFailureCount, 0);
					return executions > 0 ? failures / executions : null;
				})(),
				costUsd: null,
				costStatus: "unconfigured",
			},
		};
	}
}
