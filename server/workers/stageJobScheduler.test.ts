import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileArtifactContentStore } from "../artifacts/fileArtifactStore";
import { InMemoryEnterpriseEventStore } from "../../src/enterprise/inMemoryEventStore";
import { ProposalRunEngine } from "../../src/enterprise/proposalRunEngine";
import { InMemoryStageJobQueue } from "../../src/enterprise/stageJobQueue";
import { createDeterministicProposal } from "../../src/print/solutionProposal";
import type {
	AgentRuntimePort,
	RuntimeHealth,
	RuntimeTurnRequest,
	RuntimeTurnResult,
} from "../../src/runtime/contracts";
import { RuntimeFailure } from "../../src/runtime/contracts";
import { ProposalWorker } from "./proposalWorker";
import { StageJobScheduler } from "./stageJobScheduler";

const temporaryDirectories: string[] = [];

class SlicedRuntime implements AgentRuntimePort {
	readonly requests: RuntimeTurnRequest[] = [];

	constructor(
		private pausesRemaining: number,
		private readonly finalResponse: string,
		private failuresRemaining = 0,
		private readonly delayMs = 0,
	) {}

	health(): Promise<RuntimeHealth> {
		return Promise.resolve({ adapter: "fake", online: true });
	}

	async executeTurn(request: RuntimeTurnRequest): Promise<RuntimeTurnResult> {
		this.requests.push(request);
		if (this.delayMs > 0) {
			await new Promise((resolve) => setTimeout(resolve, this.delayMs));
		}
		if (this.failuresRemaining-- > 0) {
			throw new RuntimeFailure("model_failure", "Provider unavailable", true);
		}
		const call = this.requests.length;
		const paused = this.pausesRemaining-- > 0;
		return {
			executionId: `execution-${call}`,
			adapter: "fake",
			status: paused ? "paused" : "completed",
			sessionId: request.sessionId,
			contextSnapshotId: `context-${call}`,
			finalResponse: paused ? "" : this.finalResponse,
			events: [],
		};
	}
}

function prepare(
	runtime: AgentRuntimePort,
	now: () => Date = () => new Date("2026-09-03T00:00:00.000Z"),
	schedulerOptions: Partial<ConstructorParameters<typeof StageJobScheduler>[2]> = {},
) {
	const directory = mkdtempSync(join(tmpdir(), "blackx-stage-scheduler-"));
	temporaryDirectories.push(directory);
	const engine = new ProposalRunEngine(new InMemoryEnterpriseEventStore());
	const base = {
		tenantId: "tenant-scheduler",
		workspaceId: "workspace-scheduler",
		runId: "run-scheduler",
		correlationId: "trace-scheduler",
		actorId: "user-scheduler",
	};
	engine.create({ ...base, commandId: "create", expectedVersion: 0 });
	engine.startProposal({ ...base, commandId: "start", expectedVersion: 1 });
	const state = engine.recordFactVersion({
		...base,
		commandId: "fact",
		expectedVersion: 2,
		factKey: "quantity",
		factVersion: 1,
		value: 10_000,
		unit: "bags",
		status: "unverified",
		sourceType: "user_input",
		sourceRef: "message-a",
	});
	const queue = new InMemoryStageJobQueue({
		now,
		nextId: (() => {
			let value = 0;
			return () => `lease-${++value}`;
		})(),
	});
	const scheduler = new StageJobScheduler(
		queue,
		new ProposalWorker(engine, runtime, new FileArtifactContentStore(directory)),
		{ workerId: "worker-scheduler", leaseMs: 1_000, maxSlices: 4, ...schedulerOptions },
	);
	const command = {
		tenantId: base.tenantId,
		workspaceId: base.workspaceId,
		runId: base.runId,
		commandId: "execute-proposal",
		correlationId: base.correlationId,
		expectedVersion: state.aggregateVersion,
	};
	return { command, engine, queue, scheduler };
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("StageJobScheduler", () => {
	it("releases the worker after each slice and schedules the same Session again", async () => {
		const proposal = createDeterministicProposal({
			quantity: {
				key: "quantity",
				version: 1,
				value: 10_000,
				unit: "bags",
				status: "unverified",
				sourceType: "user_input",
				sourceRef: "message-a",
			},
		});
		const runtime = new SlicedRuntime(2, JSON.stringify(proposal));
		const { command, engine, queue, scheduler } = prepare(runtime);
		const enqueued = scheduler.enqueueProposal(command);

		expect(await scheduler.runNext()).toMatchObject({
			status: "paused",
			job: { status: "queued", sliceCount: 1 },
		});
		expect(await scheduler.runNext()).toMatchObject({
			status: "paused",
			job: { status: "queued", sliceCount: 2 },
		});
		expect(await scheduler.runNext()).toMatchObject({
			status: "completed",
			job: { status: "completed", sliceCount: 3, deliveryCount: 3 },
		});
		expect(await scheduler.runNext()).toEqual({ status: "idle" });
		expect(new Set(runtime.requests.map((request) => request.sessionId))).toEqual(
			new Set([enqueued.sessionId]),
		);
		expect(runtime.requests.every((request) => request.resume === "if-present")).toBe(true);
		expect(queue.get(enqueued.jobId)?.status).toBe("completed");
		expect(engine.load(command)).toMatchObject({
			status: "waiting_approval",
			stageStatus: "waiting_approval",
		});
	});

	it("classifies a retryable Runtime failure and backs off before the next claim", async () => {
		let current = new Date("2026-09-03T00:00:00.000Z");
		const proposal = createDeterministicProposal({});
		const runtime = new SlicedRuntime(0, JSON.stringify(proposal), 1);
		const { command, scheduler } = prepare(runtime, () => current);
		scheduler.enqueueProposal(command);

		expect(await scheduler.runNext()).toMatchObject({
			status: "retry_scheduled",
			job: { status: "queued", failureCount: 1, lastFailure: { code: "model_failure" } },
		});
		expect(await scheduler.runNext()).toEqual({ status: "idle" });
		current = new Date("2026-09-03T00:00:00.250Z");
		expect(await scheduler.runNext()).toMatchObject({ status: "completed" });
	});

	it("renews a lease while a slow slice is still running", async () => {
		const proposal = createDeterministicProposal({
			quantity: {
				key: "quantity",
				version: 1,
				value: 10_000,
				unit: "bags",
				status: "unverified",
				sourceType: "user_input",
				sourceRef: "message-a",
			},
		});
		const runtime = new SlicedRuntime(0, JSON.stringify(proposal), 0, 60);
		const { command, queue, scheduler } = prepare(
			runtime,
			() => new Date(),
			{ leaseMs: 30, heartbeatMs: 5 },
		);
		scheduler.enqueueProposal(command);
		const running = scheduler.runNext();
		await new Promise((resolve) => setTimeout(resolve, 40));

		expect(queue.claim("worker-competing", 30)).toBeUndefined();
		expect(await running).toMatchObject({ status: "completed" });
	});

	it("dispatches a registered non-proposal job through the same durable scheduler", async () => {
		let handledJobId = "";
		const runtime = new SlicedRuntime(0, "unused");
		const { queue, scheduler } = prepare(runtime, undefined, {
			handlers: {
				"conversation-background": async (lease) => {
					handledJobId = lease.jobId;
					return { status: "completed" };
				},
			},
		});
		queue.enqueue({
			tenantId: "tenant-scheduler",
			workspaceId: "workspace-scheduler",
			runId: "conversation-a",
			stageId: "conversation-background",
			jobId: "background-a",
			commandId: "message-a",
			correlationId: "background-a",
			expectedVersion: 0,
			sessionId: "conversation-a",
		});

		expect(await scheduler.runNext()).toMatchObject({ status: "completed", job: { jobId: "background-a" } });
		expect(handledJobId).toBe("background-a");
	});
});
