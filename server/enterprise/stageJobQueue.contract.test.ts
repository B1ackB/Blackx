import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	InMemoryStageJobQueue,
	StageJobQueueError,
	type StageJobQueue,
} from "../../src/enterprise/stageJobQueue";
import { SqliteStageJobQueue } from "./sqliteStageJobQueue";

const temporaryDirectories: string[] = [];

function input(jobId = "contract-job") {
	return {
		tenantId: "tenant-contract",
		workspaceId: "workspace-contract",
		runId: "run-contract",
		stageId: "proposal",
		jobId,
		commandId: `command-${jobId}`,
		correlationId: "trace-contract",
		expectedVersion: 2,
		sessionId: `session-${jobId}`,
	};
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

for (const adapter of ["memory", "sqlite"] as const) {
	describe(`${adapter} StageJobQueue multi-worker contract`, () => {
		it("renews the active lease and fences the old worker after reassignment", () => {
			let current = new Date("2026-09-03T00:00:00.000Z");
			let sequence = 0;
			let close = () => {};
			let queue: StageJobQueue;
			const options = {
				now: () => current,
				nextId: () => `lease-${++sequence}`,
			};
			if (adapter === "memory") {
				queue = new InMemoryStageJobQueue(options);
			} else {
				const directory = mkdtempSync(join(tmpdir(), "blackx-queue-contract-"));
				temporaryDirectories.push(directory);
				const sqlite = new SqliteStageJobQueue(join(directory, "queue.sqlite"), options);
				queue = sqlite;
				close = () => sqlite.close();
			}

			try {
				queue.enqueue(input());
				const first = queue.claim("worker-a", 100)!;
				expect(queue.claim("worker-b", 100)).toBeUndefined();

				current = new Date("2026-09-03T00:00:00.080Z");
				const renewed = queue.renew(first, 100);
				expect(renewed.leaseExpiresAt).toBe("2026-09-03T00:00:00.180Z");
				current = new Date("2026-09-03T00:00:00.101Z");
				expect(queue.claim("worker-b", 100)).toBeUndefined();

				current = new Date("2026-09-03T00:00:00.181Z");
				const reassigned = queue.claim("worker-b", 100)!;
				expect(reassigned).toMatchObject({
					leaseOwner: "worker-b",
					failureCount: 1,
					recoveryCount: 1,
					totalRecoveryDetectionDelayMs: 1,
				});
				expect(() => queue.ack(renewed)).toThrowError(
					expect.objectContaining<Partial<StageJobQueueError>>({ code: "lease_lost" }),
				);
				expect(queue.ack(reassigned).status).toBe("completed");
			} finally {
				close();
			}
		});
	});
}

describe("SqliteStageJobQueue", () => {
	it("recovers queued work after a database connection restart", () => {
		const directory = mkdtempSync(join(tmpdir(), "blackx-sqlite-queue-"));
		temporaryDirectories.push(directory);
		const path = join(directory, "queue.sqlite");
		const first = new SqliteStageJobQueue(path);
		first.enqueue(input("sqlite-restart"));
		first.close();

		const recovered = new SqliteStageJobQueue(path);
		try {
			expect(recovered.claim("worker-recovered", 1_000)).toMatchObject({
				jobId: "sqlite-restart",
				status: "leased",
			});
		} finally {
			recovered.close();
		}
	});
});
