import { createHash } from "node:crypto";
import type { ArtifactContentStore } from "../../src/enterprise/artifactStore";
import { ArtifactStoreError } from "../../src/enterprise/artifactStore";
import type { AggregateScope, ProposalRunState } from "../../src/enterprise/contracts";
import { EnterpriseKernelError } from "../../src/enterprise/contracts";
import { ProposalRunEngine } from "../../src/enterprise/proposalRunEngine";
import { StageJobQueueError } from "../../src/enterprise/stageJobQueue";
import type {
	ConversationView,
	ProposalWorkspaceView,
} from "../../src/runtime/conversationContracts";
import type {
	ConversationApiContext,
	ConversationApiResponse,
} from "../runtime/conversationApi";
import { ConversationApiController } from "../runtime/conversationApi";
import { StageJobOutbox } from "../workers/stageJobOutbox";
import { StageJobScheduler } from "../workers/stageJobScheduler";

class ProposalWorkspaceValidationError extends Error {}

class ConversationAccessError extends Error {
	constructor(readonly response: ConversationApiResponse) {
		super("Conversation is unavailable");
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredId(value: unknown, name: string, maximumLength = 128): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > maximumLength ||
		!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
	) {
		throw new ProposalWorkspaceValidationError(`${name} is invalid`);
	}
	return value;
}

function requestId(payload: unknown): string {
	if (!isRecord(payload)) {
		throw new ProposalWorkspaceValidationError("Request payload must be an object");
	}
	return requiredId(payload.requestId, "requestId", 64);
}

function decision(payload: unknown): "approved" | "rejected" {
	if (!isRecord(payload) || (payload.decision !== "approved" && payload.decision !== "rejected")) {
		throw new ProposalWorkspaceValidationError("decision is invalid");
	}
	return payload.decision;
}

function runId(scope: Omit<AggregateScope, "runId">, conversationId: string): string {
	const digest = createHash("sha256")
		.update(`${scope.tenantId}\u0000${scope.workspaceId}\u0000${conversationId}`)
		.digest("hex")
		.slice(0, 32);
	return `proposal-${digest}`;
}

export class ProposalWorkspaceApiController {
	constructor(
		private readonly conversations: ConversationApiController,
		private readonly engine: ProposalRunEngine,
		private readonly artifacts: ArtifactContentStore,
		private readonly outbox: StageJobOutbox,
		private readonly scheduler: StageJobScheduler,
	) {}

	get(context: ConversationApiContext, conversationId: unknown): ConversationApiResponse {
		return this.respond(() => {
			const { scope } = this.target(context, conversationId);
			const state = this.engine.load(scope);
			return {
				status: 200,
				body: { proposal: state.aggregateVersion === 0 ? null : this.view(state) },
			};
		});
	}

	start(
		context: ConversationApiContext,
		conversationId: unknown,
		payload: unknown,
	): ConversationApiResponse {
		return this.respond(() => {
			const id = requestId(payload);
			const { scope, conversation } = this.target(context, conversationId);
			const actorId = requiredId(context.actorId, "actorId");
			const messages = conversation.messages.filter((message) => message.role === "user");
			if (messages.length === 0) {
				throw new ProposalWorkspaceValidationError("Conversation has no user message to propose from");
			}
			const brief = messages.map((message) => message.content).join("\n\n");
			if (brief.length > 32_000) {
				throw new ProposalWorkspaceValidationError("Conversation brief is too large");
			}
			const correlationId = `${id}:proposal`;
			let state = this.engine.load(scope);
			if (state.aggregateVersion === 0) {
				state = this.engine.create({
					...scope,
					actorId,
					commandId: `${id}:create`,
					correlationId,
					expectedVersion: 0,
				});
			}
			if (state.stageStatus === "pending") {
				state = this.engine.startProposal({
					...scope,
					actorId,
					commandId: `${id}:start`,
					correlationId,
					expectedVersion: state.aggregateVersion,
				});
			}

			const factCommandId = `${id}:fact`;
			const sourceRef = `conversation:${conversation.conversationId}:revision:${conversation.revision}`;
			if (this.engine.hasCommand(scope, factCommandId)) {
				const existing = state.facts.customer_brief;
				if (existing?.value !== brief || existing.sourceRef !== sourceRef) {
					throw new EnterpriseKernelError(
						"concurrency_conflict",
						"requestId is already bound to another Conversation snapshot",
					);
				}
			} else {
				state = this.engine.recordFactVersion({
					...scope,
					actorId,
					commandId: factCommandId,
					correlationId,
					expectedVersion: state.aggregateVersion,
					factKey: "customer_brief",
					factVersion: (state.factVersions.customer_brief ?? 0) + 1,
					value: brief,
					status: "unverified",
					sourceType: "user_input",
					sourceRef,
				});
			}
			if (state.stageStatus === "revision_required" || state.stageStatus === "retryable_failed") {
				state = this.engine.restartProposal({
					...scope,
					actorId,
					commandId: `${id}:restart`,
					correlationId,
					expectedVersion: state.aggregateVersion,
				});
			}

			const workerCommandId = `${id}:execute`;
			if (state.stageStatus !== "running" && !this.engine.hasCommand(scope, workerCommandId)) {
				throw new EnterpriseKernelError(
					"illegal_transition",
					"Proposal cannot start from the current state",
				);
			}
			this.outbox.requestProposal({
				...scope,
				commandId: workerCommandId,
				correlationId,
				expectedVersion: state.aggregateVersion,
			});
			this.outbox.dispatchOne();
			return { status: 202, body: { proposal: this.view(this.engine.load(scope)) } };
		});
	}

	resolveApproval(
		context: ConversationApiContext,
		conversationId: unknown,
		payload: unknown,
	): ConversationApiResponse {
		return this.respond(() => {
			const id = requestId(payload);
			const selectedDecision = decision(payload);
			const { scope } = this.target(context, conversationId);
			const actorId = requiredId(context.actorId, "actorId");
			let state = this.engine.load(scope);
			const approval = state.approval;
			if (!approval || !state.currentProposal) {
				throw new EnterpriseKernelError("illegal_transition", "Proposal has no active approval");
			}
			const commandId = `${id}:approval`;
			if (this.engine.hasCommand(scope, commandId)) {
				if (approval.status !== selectedDecision) {
					throw new EnterpriseKernelError(
						"concurrency_conflict",
						"requestId is already bound to another approval decision",
					);
				}
			} else {
				state = this.engine.resolveApproval({
					...scope,
					actorId,
					commandId,
					correlationId: `${id}:proposal-approval`,
					expectedVersion: state.aggregateVersion,
					approvalId: approval.approvalId,
					artifactId: approval.artifactId,
					artifactVersion: approval.artifactVersion,
					decision: selectedDecision,
				});
			}
			if (selectedDecision === "approved") {
				this.outbox.requestProposal({
					...scope,
					commandId: `${id}:gate`,
					correlationId: `${id}:proposal-approval`,
					expectedVersion: state.aggregateVersion,
				});
				this.outbox.dispatchOne();
			}
			return { status: 202, body: { proposal: this.view(this.engine.load(scope)) } };
		});
	}

	private target(
		context: ConversationApiContext,
		conversationIdValue: unknown,
	): { scope: AggregateScope; conversation: ConversationView } {
		const tenantId = requiredId(context.tenantId, "tenantId");
		const workspaceId = requiredId(context.workspaceId, "workspaceId");
		const conversationId = requiredId(conversationIdValue, "conversationId");
		const response = this.conversations.get(context, conversationId);
		if (response.status !== 200) throw new ConversationAccessError(response);
		const conversation = (response.body as { conversation: ConversationView }).conversation;
		return {
			conversation,
			scope: {
				tenantId,
				workspaceId,
				runId: runId({ tenantId, workspaceId }, conversationId),
			},
		};
	}

	private view(state: ProposalRunState): ProposalWorkspaceView {
		const artifact = state.currentProposal
			? {
				content: this.artifacts.readJson({
					...state,
					artifactId: state.currentProposal.artifactId,
					artifactVersion: state.currentProposal.version,
				}),
			}
			: undefined;
		const evaluation = state.evaluation
			? {
				report: this.artifacts.readJson({
					...state,
					artifactId: "proposal-evaluation",
					artifactVersion: state.evaluation.artifactVersion,
				}),
			}
			: undefined;
		const job = state.lastJobId
			? this.scheduler.getJob(state.lastJobId, state)
			: undefined;
		return {
			runId: state.runId,
			state,
			artifact,
			evaluation,
			job: job && {
				jobId: job.jobId,
				status: job.status,
				failureCount: job.failureCount,
				lastFailure: job.lastFailure && {
					code: job.lastFailure.code,
					message: job.lastFailure.message,
				},
			},
		};
	}

	private respond(operation: () => ConversationApiResponse): ConversationApiResponse {
		try {
			return operation();
		} catch (error) {
			if (error instanceof ConversationAccessError) return error.response;
			if (error instanceof ProposalWorkspaceValidationError) {
				return { status: 400, body: { code: "invalid_proposal_request", message: error.message } };
			}
			if (error instanceof EnterpriseKernelError) {
				const status = error.code === "aggregate_access_denied"
					? 404
					: error.code === "concurrency_conflict"
						? 409
						: error.code === "illegal_transition" || error.code === "artifact_version_mismatch"
							? 422
							: 503;
				return { status, body: { code: error.code, message: error.message } };
			}
			if (error instanceof ArtifactStoreError) {
				return { status: 503, body: { code: error.code, message: error.message } };
			}
			if (error instanceof StageJobQueueError) {
				return {
					status: error.code === "job_conflict" || error.code === "invalid_job" ? 409 : 503,
					body: { code: error.code, message: error.message },
				};
			}
			return { status: 500, body: { code: "proposal_workspace_failed" } };
		}
	}
}
