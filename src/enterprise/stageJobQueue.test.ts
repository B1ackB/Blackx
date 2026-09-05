import { describe, expect, it } from "vitest";
import {
	InMemoryStageJobQueue,
	StageJobQueueError,
} from "./stageJobQueue";

function input(jobId = "job-a") {
	return {
		tenantId: "tenant-a",
		workspaceId: "workspace-a",
		runId: "run-a",
		stageId: "proposal",
		jobId,
		commandId: "command-a",
		correlationId: "trace-a",
		expectedVersion: 3,
		sessionId: "session-a",
	};
}

describe("InMemoryStageJobQueue", () => {
	it("enqueues idempotently and releases a paused slice for the next delivery", () => {
		let now = new Date("2026-09-03T00:00:00.000Z");
		let id = 0;
		const queue = new InMemoryStageJobQueue({
			now: () => now,
			nextId: () => `lease-${++id}`,
		});
		const enqueued = queue.enqueue(input());
		expect(queue.enqueue(input())).toEqual(enqueued);

		const first = queue.claim("worker-a", 1_000);
		expect(first).toMatchObject({ status: "leased", deliveryCount: 1, sliceCount: 0 });
		const paused = queue.checkpoint(first!, {
			sessionId: "session-a",
			contextSnapshotId: "context-a",
		});
		expect(paused).toMatchObject({
			status: "queued",
			deliveryCount: 1,
			sliceCount: 1,
			lastContextSnapshotId: "context-a",
		});

		now = new Date("2026-09-03T00:00:00.001Z");
		const second = queue.claim("worker-b", 1_000);
		expect(second).toMatchObject({ status: "leased", deliveryCount: 2, sliceCount: 1 });
		expect(queue.ack(second!)).toMatchObject({ status: "completed", sliceCount: 2 });
	});

	it("persists a bounded JSON payload and rejects an idempotency-key content change", () => {
		const queue = new InMemoryStageJobQueue();
		const first = queue.enqueue({
			...input("background-a"),
			payload: { type: "conversation.message.v1", content: "first" },
		});

		expect(first.payload).toEqual({ type: "conversation.message.v1", content: "first" });
		expect(() => queue.enqueue({
			...input("background-a"),
			payload: { type: "conversation.message.v1", content: "changed" },
		})).toThrowError(expect.objectContaining({ code: "job_conflict" }));
		expect(() => queue.enqueue({
			...input("background-large"),
			payload: { content: "x".repeat(66_000) },
		})).toThrowError(expect.objectContaining({ code: "invalid_job" }));
	});

	it("cancels a queued or leased job only inside the owning scope", () => {
		const queue = new InMemoryStageJobQueue();
		queue.enqueue(input("cancel-job"));
		expect(queue.cancel("cancel-job", input())).toMatchObject({ status: "cancelled" });
		expect(queue.claim("worker-a", 1_000)).toBeUndefined();
		expect(queue.metrics()).toMatchObject({ cancelled: 1, queued: 0 });
		expect(() => queue.cancel("cancel-job", {
			tenantId: "tenant-other",
			workspaceId: "workspace-a",
			runId: "run-a",
		})).toThrowError(expect.objectContaining({ code: "job_conflict" }));

		queue.enqueue({ ...input("cancel-leased"), commandId: "cancel-leased-command" });
		const leased = queue.claim("worker-a", 1_000)!;
		const cancelled = queue.cancel("cancel-leased", input());
		expect(cancelled).toMatchObject({ status: "cancelled" });
		expect(cancelled).not.toHaveProperty("leaseId");
		expect(cancelled).not.toHaveProperty("leaseOwner");
		expect(() => queue.ack(leased)).toThrowError(expect.objectContaining({ code: "lease_lost" }));
	});

	it("reclaims an expired lease and fences the stale worker", () => {
		let now = new Date("2026-09-03T00:00:00.000Z");
		let id = 0;
		const queue = new InMemoryStageJobQueue({
			now: () => now,
			nextId: () => `lease-${++id}`,
		});
		queue.enqueue(input());
		const stale = queue.claim("worker-a", 100)!;
		now = new Date("2026-09-03T00:00:00.101Z");
		const recovered = queue.claim("worker-b", 100)!;

		expect(recovered).toMatchObject({
			leaseOwner: "worker-b",
			failureCount: 1,
			recoveryCount: 1,
			totalRecoveryDetectionDelayMs: 1,
			lastRecovery: {
				previousLeaseOwner: "worker-a",
				expiredAt: "2026-09-03T00:00:00.100Z",
				recoveredAt: "2026-09-03T00:00:00.101Z",
				detectionDelayMs: 1,
			},
			lastFailure: { code: "worker_lease_expired" },
		});
		expect(() => queue.ack(stale)).toThrowError(
			expect.objectContaining<Partial<StageJobQueueError>>({ code: "lease_lost" }),
		);
		expect(queue.ack(recovered).status).toBe("completed");
		expect(queue.metrics()).toMatchObject({ recoveries: 1, recoveryDetectionDelayMs: 1 });
	});

	it("dead-letters retry failures and an exhausted slice budget", () => {
		const queue = new InMemoryStageJobQueue({ nextId: () => "lease-a" });
		queue.enqueue({ ...input("retry-job"), maxFailures: 1 });
		const failed = queue.fail(queue.claim("worker-a", 100)!, {
			code: "model_failure",
			message: "provider unavailable",
			retryable: true,
		});
		expect(failed).toMatchObject({ status: "dead_letter", failureCount: 1 });

		queue.enqueue({ ...input("slice-job"), commandId: "slice-command", maxSlices: 1 });
		const exhausted = queue.checkpoint(queue.claim("worker-a", 100)!, {
			sessionId: "session-a",
		});
		expect(exhausted).toMatchObject({
			status: "dead_letter",
			sliceCount: 1,
			lastFailure: { code: "slice_budget_exceeded", retryable: false },
		});
	});

	it("reports tenant-scoped metrics and requires an audited optimistic DLQ redrive", () => {
		let now = new Date("2026-09-03T00:00:00.000Z");
		const queue = new InMemoryStageJobQueue({ now: () => now, nextId: () => "lease-a" });
		queue.enqueue({ ...input("dead-job"), maxFailures: 1 });
		const dead = queue.fail(queue.claim("worker-a", 100)!, {
			code: "permission_denied",
			message: "manual review required",
			retryable: false,
		});
		queue.enqueue({
			...input("another-tenant-job"),
			tenantId: "tenant-b",
			workspaceId: "workspace-b",
			commandId: "command-b",
			sessionId: "session-b",
		});

		expect(queue.metrics({ tenantId: "tenant-a", workspaceId: "workspace-a" })).toMatchObject({
			total: 1,
			deadLetter: 1,
			queued: 0,
			failures: 1,
		});
		expect(queue.listDeadLetters({ tenantId: "tenant-a", workspaceId: "workspace-a" })).toHaveLength(1);
		expect(() => queue.redrive(dead.jobId, {
			expectedUpdatedAt: "2026-09-03T00:00:01.000Z",
			actorId: "operator-a",
			reason: "wrong version",
		})).toThrowError(expect.objectContaining({ code: "job_conflict" }));

		now = new Date("2026-09-03T00:00:01.000Z");
		const redriven = queue.redrive(dead.jobId, {
			expectedUpdatedAt: dead.updatedAt,
			actorId: "operator-a",
			reason: "provider access restored",
			additionalSlices: 2,
		});
		expect(redriven).toMatchObject({
			status: "queued",
			failureCount: 0,
			redriveCount: 1,
			lastRedrive: { actorId: "operator-a", reason: "provider access restored" },
		});
		expect(queue.metrics({ tenantId: "tenant-a", workspaceId: "workspace-a" })).toMatchObject({
			queued: 1,
			ready: 1,
			deadLetter: 0,
			failures: 1,
			redrives: 1,
		});
	});
});
