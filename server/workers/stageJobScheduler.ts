import { ArtifactStoreError } from "../../src/enterprise/artifactStore";
import { EnterpriseKernelError } from "../../src/enterprise/contracts";
import {
	StageJobQueueError,
	type StageJob,
	type StageJobLease,
	type StageJobQueue,
	type StageJobQueueMetrics,
} from "../../src/enterprise/stageJobQueue";
import { RuntimeFailure } from "../../src/runtime/contracts";
import {
	ProposalWorker,
	type ProposalWorkerCommand,
} from "./proposalWorker";
import { proposalStageJob } from "./stageJobOutbox";

export type StageJobRunResult =
	| { status: "idle" | "busy" }
	| { status: "completed" | "paused" | "retry_scheduled" | "dead_letter"; job: StageJob };

export interface StageJobHandlerResult {
	status: "completed" | "paused";
	sessionId?: string;
	contextSnapshotId?: string;
}

export type StageJobHandler = (lease: StageJobLease) => Promise<StageJobHandlerResult>;

export interface StageJobSchedulerOptions {
	workerId: string;
	leaseMs?: number;
	pollIntervalMs?: number;
	maxFailures?: number;
	maxSlices?: number;
	priority?: number;
	heartbeatMs?: number;
	handlers?: Readonly<Record<string, StageJobHandler>>;
	dispatchOutbox?: () => unknown;
	onError?: (error: unknown) => void;
}

function safeFailure(error: unknown): { code: string; message: string; retryable: boolean } {
	if (error instanceof RuntimeFailure) {
		return { code: error.code, message: error.message, retryable: error.retryable };
	}
	if (error instanceof ArtifactStoreError) {
		return {
			code: error.code,
			message: error.message,
			retryable: error.code === "artifact_store_unavailable",
		};
	}
	if (error instanceof EnterpriseKernelError) {
		return {
			code: error.code,
			message: error.message,
			retryable: error.code === "event_store_unavailable",
		};
	}
	return {
		code: "worker_execution_failed",
		message: "Stage Job Worker execution failed",
		retryable: true,
	};
}

export class StageJobScheduler {
	private readonly leaseMs: number;
	private readonly pollIntervalMs: number;
	private readonly maxFailures: number;
	private readonly maxSlices: number;
	private readonly priority: number;
	private readonly heartbeatMs: number;
	private running = false;
	private stopRequested = false;
	private timer?: NodeJS.Timeout;

	constructor(
		private readonly queue: StageJobQueue,
		private readonly proposalWorker: ProposalWorker,
		private readonly options: StageJobSchedulerOptions,
	) {
		this.leaseMs = options.leaseMs ?? 135_000;
		this.pollIntervalMs = options.pollIntervalMs ?? 250;
		this.maxFailures = options.maxFailures ?? 5;
		this.maxSlices = options.maxSlices ?? 32;
		this.priority = options.priority ?? 0;
		this.heartbeatMs = options.heartbeatMs ?? Math.max(250, Math.floor(this.leaseMs / 3));
		if (![this.leaseMs, this.pollIntervalMs, this.maxFailures, this.maxSlices, this.heartbeatMs].every(
			(value) => Number.isInteger(value) && value > 0,
		) || this.heartbeatMs >= this.leaseMs || !Number.isInteger(this.priority) || options.workerId.length === 0) {
			throw new Error("Stage Job Scheduler configuration is invalid");
		}
	}

	getJob(
		jobId: string,
		scope: { tenantId: string; workspaceId: string },
	): StageJob | undefined {
		const job = this.queue.get(jobId);
		return job?.tenantId === scope.tenantId && job.workspaceId === scope.workspaceId
			? job
			: undefined;
	}

	metrics(scope: { tenantId: string; workspaceId: string }): StageJobQueueMetrics {
		return this.queue.metrics(scope);
	}

	deadLetters(scope: { tenantId: string; workspaceId: string }): StageJob[] {
		return this.queue.listDeadLetters(scope);
	}

	redrive(
		jobId: string,
		scope: { tenantId: string; workspaceId: string },
		request: {
			expectedUpdatedAt: string;
			actorId: string;
			reason: string;
			additionalSlices?: number;
		},
	): StageJob | undefined {
		if (!this.getJob(jobId, scope)) return undefined;
		return this.queue.redrive(jobId, request);
	}

	enqueueProposal(command: ProposalWorkerCommand): StageJob {
		return this.queue.enqueue(proposalStageJob(command, {
			priority: this.priority,
			maxFailures: this.maxFailures,
			maxSlices: this.maxSlices,
		}));
	}

	async runNext(): Promise<StageJobRunResult> {
		if (this.running) return { status: "busy" };
		this.running = true;
		let lease = undefined as ReturnType<StageJobQueue["claim"]>;
		try {
			this.options.dispatchOutbox?.();
			lease = this.queue.claim(this.options.workerId, this.leaseMs);
			if (!lease) return { status: "idle" };
			const handler = this.handlerFor(lease);
			if (!handler) {
				const job = this.queue.fail(lease, {
					code: "unsupported_stage",
					message: `No Worker is registered for stage ${lease.stageId}`,
					retryable: false,
				});
				return { status: "dead_letter", job };
			}

			let activeLease = lease;
			let heartbeatError: unknown;
			const heartbeat = setInterval(() => {
				try {
					activeLease = this.queue.renew(activeLease, this.leaseMs);
				} catch (error) {
					heartbeatError = error;
				}
			}, this.heartbeatMs);
			let result: StageJobHandlerResult;
			try {
				result = await handler(activeLease);
			} finally {
				clearInterval(heartbeat);
			}
			if (heartbeatError) throw heartbeatError;
			if (result.status === "paused") {
				if (!result.sessionId) {
					throw new RuntimeFailure("invalid_output", "Paused Stage Job omitted sessionId", false);
				}
				const job = this.queue.checkpoint(activeLease, {
					sessionId: result.sessionId,
					contextSnapshotId: result.contextSnapshotId,
				});
				return { status: job.status === "dead_letter" ? "dead_letter" : "paused", job };
			}
			return { status: "completed", job: this.queue.ack(activeLease) };
		} catch (error) {
			if (!lease || error instanceof StageJobQueueError && error.code === "lease_lost") throw error;
			const failure = safeFailure(error);
			const delayMs = failure.retryable
				? Math.min(30_000, 250 * 2 ** lease.failureCount)
				: 0;
			const job = this.queue.fail(lease, { ...failure, delayMs });
			return {
				status: job.status === "dead_letter" ? "dead_letter" : "retry_scheduled",
				job,
			};
		} finally {
			this.running = false;
		}
	}

	private handlerFor(lease: StageJobLease): StageJobHandler | undefined {
		if (lease.stageId !== "proposal") return this.options.handlers?.[lease.stageId];
		return async (job) => this.proposalWorker.executeSlice(
			{
				tenantId: job.tenantId,
				workspaceId: job.workspaceId,
				runId: job.runId,
				commandId: job.commandId,
				correlationId: job.correlationId,
				expectedVersion: job.expectedVersion,
			},
			{ sessionId: job.sessionId, resume: "if-present" },
		);
	}

	start(): () => void {
		if (this.timer) return () => this.stop();
		this.stopRequested = false;
		const tick = async () => {
			if (this.stopRequested) return;
			let delay = this.pollIntervalMs;
			try {
				const result = await this.runNext();
				if (result.status !== "idle" && result.status !== "busy") delay = 0;
			} catch (error) {
				this.options.onError?.(error);
			} finally {
				if (!this.stopRequested) this.timer = setTimeout(tick, delay);
			}
		};
		this.timer = setTimeout(tick, 0);
		return () => this.stop();
	}

	stop(): void {
		this.stopRequested = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
	}
}
