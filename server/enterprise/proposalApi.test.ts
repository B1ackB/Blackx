import { describe, expect, it } from "vitest";
import type { ProposalRunState } from "../../src/enterprise/contracts";
import { InMemoryEnterpriseEventStore } from "../../src/enterprise/inMemoryEventStore";
import { ProposalRunEngine } from "../../src/enterprise/proposalRunEngine";
import {
	ProposalApiController,
	type ProposalApiContext,
	type ProposalApiResponse,
} from "./proposalApi";

const token = "test-command-token-with-sufficient-entropy";
const workerToken = "test-worker-token-with-sufficient-entropy";
const context: ProposalApiContext = {
	tenantId: "tenant-a",
	workspaceId: "workspace-a",
	actorId: "user-a",
	authorization: `Bearer ${token}`,
};
const workerContext: ProposalApiContext = {
	...context,
	actorId: "worker-a",
	authorization: `Bearer ${workerToken}`,
};

function harness(
	requiredToken: string | null = token,
	requiredWorkerToken: string | null = workerToken,
) {
	const store = new InMemoryEnterpriseEventStore();
	const controller = new ProposalApiController(
		new ProposalRunEngine(store),
		requiredToken ?? undefined,
		requiredWorkerToken ?? undefined,
	);
	return { controller, store };
}

function state(response: ProposalApiResponse): ProposalRunState {
	return (response.body as { state: ProposalRunState }).state;
}

function command(
	type: string,
	commandId: string,
	expectedVersion: number,
	extra: Record<string, unknown> = {},
) {
	return {
		type,
		runId: "run-api-1",
		commandId,
		correlationId: "trace-api-1",
		expectedVersion,
		...extra,
	};
}

describe("ProposalApiController", () => {
	it("stays disabled until a server-side command token is configured", () => {
		const { controller } = harness(null, null);

		expect(controller.execute(context, command("create_run", "create", 0))).toEqual({
			status: 503,
			body: { code: "command_api_disabled" },
		});
	});

	it("rejects missing or incorrect bearer credentials", () => {
		const { controller } = harness();

		expect(controller.execute(
			{ ...context, authorization: "Bearer wrong" },
			command("create_run", "create", 0),
		)).toMatchObject({ status: 401, body: { code: "unauthorized" } });
	});

	it("keeps Runtime and evaluation completion disabled without a Worker token", () => {
		const store = new InMemoryEnterpriseEventStore();
		const controller = new ProposalApiController(
			new ProposalRunEngine(store),
			token,
			undefined,
		);

		expect(controller.execute(
			context,
			command("complete_proposal", "complete", 0),
		)).toEqual({
			status: 503,
			body: { code: "worker_api_disabled" },
		});
	});

	it("rejects configurations that reuse the Command token for Worker authority", () => {
		const store = new InMemoryEnterpriseEventStore();

		expect(() => new ProposalApiController(
			new ProposalRunEngine(store),
			token,
			token,
		)).toThrow("must be different");
	});

	it("rejects short API tokens at startup", () => {
		const store = new InMemoryEnterpriseEventStore();

		expect(() => new ProposalApiController(
			new ProposalRunEngine(store),
			"too-short",
		)).toThrow("at least 32 bytes");
	});

	it("runs the persisted Proposal command path and records the authenticated actor", () => {
		const { controller, store } = harness();
		const created = controller.execute(
			context,
			command("create_run", "create", 0),
		);
		const started = controller.execute(
			context,
			command("start_proposal", "start", state(created).aggregateVersion),
		);
		const factRecorded = controller.execute(
			context,
			command("record_fact_version", "quantity-v1", state(started).aggregateVersion, {
				factKey: "quantity",
				factVersion: 1,
				value: 10_000,
				unit: "bags",
				sourceRef: "message-api-quantity-v1",
			}),
		);
		expect(state(factRecorded).facts.quantity).toMatchObject({
			value: 10_000,
			unit: "bags",
			status: "unverified",
			sourceType: "user_input",
			sourceRef: "message-api-quantity-v1",
		});
		const completed = controller.execute(
			workerContext,
			command("complete_proposal", "complete", state(factRecorded).aggregateVersion, {
				runtime: {
					executionId: "runtime-1",
					adapterId: "fake-runtime",
					resumeHandle: "opaque-thread-1",
				},
				artifact: {
					artifactId: "solution-proposal",
					schemaVersion: "solution-proposal.v1",
					contentRef: "artifact://solution-proposal/v1",
					inputFactVersions: { quantity: 1 },
				},
				evaluation: {
					passed: true,
					reportRef: "artifact://proposal-evaluation/v1",
				},
				approvalId: "approval-a-v1",
			}),
		);
		const approved = controller.execute(
			context,
			command("resolve_approval", "approve", state(completed).aggregateVersion, {
				approvalId: "approval-a-v1",
				artifactId: "solution-proposal",
				artifactVersion: 1,
				decision: "approved",
			}),
		);

		expect(created.status).toBe(201);
		expect(approved.status).toBe(200);
		expect(state(approved)).toMatchObject({
			status: "waiting_approval",
			stageStatus: "waiting_approval",
			approval: { status: "approved", artifactVersion: 1 },
		});
		const persistedEvents = store.read({
			tenantId: "tenant-a",
			workspaceId: "workspace-a",
			runId: "run-api-1",
		});
		expect(persistedEvents.find(
			(event) => event.data.type === "runtime.execution.linked",
		)?.actorId).toBe("blackx-worker");
		expect(persistedEvents.find(
			(event) => event.data.type === "approval.resolved",
		)?.actorId).toBe("user-a");
	});

	it("returns the same state for a retried idempotent command", () => {
		const { controller } = harness();
		const created = controller.execute(
			context,
			command("create_run", "create", 0),
		);
		const first = controller.execute(
			context,
			command("start_proposal", "start", state(created).aggregateVersion),
		);
		const repeated = controller.execute(
			context,
			command("start_proposal", "start", state(created).aggregateVersion),
		);

		expect(repeated).toEqual(first);
	});

	it("does not reveal a run through another tenant scope", () => {
		const { controller } = harness();
		controller.execute(context, command("create_run", "create", 0));

		expect(controller.query(
			{ ...context, tenantId: "tenant-b" },
			"run-api-1",
		)).toMatchObject({
			status: 404,
			body: { code: "aggregate_access_denied" },
		});
	});

	it("requires an Actor identity on protected state queries", () => {
		const { controller } = harness();

		expect(controller.query(
			{ ...context, actorId: undefined },
			"run-api-1",
		)).toMatchObject({
			status: 400,
			body: { code: "invalid_command" },
		});
	});

	it("rejects malformed lineage before it reaches the RunEngine", () => {
		const { controller } = harness();

		expect(controller.execute(
			workerContext,
			command("complete_proposal", "bad-complete", 0, {
				runtime: { executionId: "runtime-1", adapterId: "fake-runtime" },
				artifact: {
					artifactId: "solution-proposal",
					schemaVersion: "solution-proposal.v1",
					contentRef: "artifact://proposal/v1",
					inputFactVersions: { quantity: 0 },
				},
				evaluation: { passed: true, reportRef: "artifact://evaluation/v1" },
				approvalId: "approval-a-v1",
			}),
		)).toMatchObject({
			status: 400,
			body: { code: "invalid_command" },
		});
	});
});
