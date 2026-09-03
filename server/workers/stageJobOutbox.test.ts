import { describe, expect, it } from "vitest";
import { InMemoryEnterpriseEventStore } from "../../src/enterprise/inMemoryEventStore";
import { ProposalRunEngine } from "../../src/enterprise/proposalRunEngine";
import { InMemoryStageJobQueue } from "../../src/enterprise/stageJobQueue";
import { StageJobOutbox } from "./stageJobOutbox";

function prepare() {
	const store = new InMemoryEnterpriseEventStore({
		now: () => new Date("2026-09-03T00:00:00.000Z"),
	});
	const engine = new ProposalRunEngine(store);
	const scope = {
		tenantId: "tenant-outbox",
		workspaceId: "workspace-outbox",
		runId: "run-outbox",
	};
	engine.create({
		...scope,
		commandId: "create",
		correlationId: "trace-outbox",
		actorId: "user-outbox",
		expectedVersion: 0,
	});
	engine.startProposal({
		...scope,
		commandId: "start",
		correlationId: "trace-outbox",
		actorId: "user-outbox",
		expectedVersion: 1,
	});
	const command = {
		...scope,
		commandId: "execute",
		correlationId: "trace-outbox",
		expectedVersion: 2,
	};
	return { command, engine, store };
}

describe("StageJobOutbox", () => {
	it("persists dispatch before queue delivery and deduplicates a replay", () => {
		const { command, engine, store } = prepare();
		const queue = new InMemoryStageJobQueue();
		const outbox = new StageJobOutbox(engine, store, queue);
		const requested = outbox.requestProposal(command);
		const repeated = outbox.requestProposal(command);

		expect(repeated).toEqual(requested);
		expect(store.readPendingOutbox(10)).toEqual([requested]);
		expect(engine.load(command).aggregateVersion).toBe(3);
		expect(queue.list()).toEqual([]);

		const delivered = outbox.dispatchOne();
		expect(delivered).toMatchObject({
			status: "published",
			message: { status: "published", deliveryCount: 1 },
			job: { status: "queued", commandId: "execute", expectedVersion: 3 },
		});
		expect(store.readPendingOutbox(10)).toEqual([]);
	});

	it("safely repeats queue delivery after a crash before Outbox ACK", () => {
		const { command, engine, store } = prepare();
		const queue = new InMemoryStageJobQueue();
		const outbox = new StageJobOutbox(engine, store, queue);
		const message = outbox.requestProposal(command);
		const firstJob = queue.enqueue(message.payload);

		const recovered = new StageJobOutbox(engine, store, queue).dispatchOne();
		expect(recovered).toMatchObject({
			status: "published",
			job: { jobId: firstJob.jobId },
		});
		expect(queue.list()).toHaveLength(1);
	});
});
