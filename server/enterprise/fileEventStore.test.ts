import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EnterpriseKernelError } from "../../src/enterprise/contracts";
import { ProposalRunEngine } from "../../src/enterprise/proposalRunEngine";
import { FileEnterpriseEventStore } from "./fileEventStore";

const temporaryDirectories: string[] = [];
const scope = {
	tenantId: "tenant-a",
	workspaceId: "workspace-a",
	runId: "run-persisted",
};

function temporaryStorePath(): string {
	const directory = mkdtempSync(join(tmpdir(), "blackx-event-store-"));
	temporaryDirectories.push(directory);
	return join(directory, "nested", "events.json");
}

function command(commandId: string, expectedVersion: number) {
	return {
		...scope,
		commandId,
		correlationId: "trace-persisted",
		actorId: "user-persisted",
		expectedVersion,
	};
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("FileEnterpriseEventStore", () => {
	it("restores the same Run state after constructing a new store instance", () => {
		const filePath = temporaryStorePath();
		let nextId = 0;
		const firstStore = new FileEnterpriseEventStore(filePath, {
			now: () => new Date("2026-09-01T00:00:00.000Z"),
			nextId: () => `id-${++nextId}`,
		});
		const firstEngine = new ProposalRunEngine(firstStore);
		firstEngine.create(command("create", 0));
		const expected = firstEngine.startProposal(command("start", 1));

		const recovered = new ProposalRunEngine(
			new FileEnterpriseEventStore(filePath),
		).load(scope);

		expect(recovered).toEqual(expected);
		expect(JSON.parse(readFileSync(filePath, "utf8"))).toMatchObject({
			schemaVersion: 3,
			outbox: [],
		});
		expect(statSync(filePath).mode & 0o777).toBe(0o600);
	});

	it("deduplicates a command after a process-style store reconstruction", () => {
		const filePath = temporaryStorePath();
		const firstEngine = new ProposalRunEngine(
			new FileEnterpriseEventStore(filePath),
		);
		firstEngine.create(command("create", 0));
		const expected = firstEngine.startProposal(command("start", 1));

		const recoveredStore = new FileEnterpriseEventStore(filePath);
		const repeated = new ProposalRunEngine(recoveredStore).startProposal(
			command("start", 1),
		);

		expect(repeated).toEqual(expected);
		expect(recoveredStore.read(scope)).toHaveLength(2);
	});

	it("persists the execution-request Event and Outbox message in one document", () => {
		const filePath = temporaryStorePath();
		const store = new FileEnterpriseEventStore(filePath, {
			now: () => new Date("2026-09-03T00:00:00.000Z"),
		});
		const engine = new ProposalRunEngine(store);
		engine.create(command("create", 0));
		engine.startProposal(command("start", 1));
		const result = engine.requestProposalJob(
			command("dispatch", 2),
			{
				messageId: "outbox-proposal-a",
				topic: "stage-job.requested",
				payload: {
					...scope,
					jobId: "proposal-a",
					stageId: "proposal",
					commandId: "dispatch",
					correlationId: "trace-persisted",
					expectedVersion: 3,
					sessionId: "proposal-a",
				},
			},
		);

		expect(result.message).toMatchObject({ status: "pending", deliveryCount: 0 });
		expect(engine.load(scope).aggregateVersion).toBe(3);
		expect(JSON.parse(readFileSync(filePath, "utf8"))).toMatchObject({
			schemaVersion: 3,
			events: [{}, {}, { data: { type: "stage.execution_requested" } }],
			outbox: [{ messageId: "outbox-proposal-a", status: "pending" }],
		});
		const recovered = new FileEnterpriseEventStore(filePath, {
			now: () => new Date("2026-09-03T00:00:01.000Z"),
		});
		expect(recovered.readPendingOutbox(1)).toHaveLength(1);
		expect(recovered.markOutboxPublished("outbox-proposal-a")).toMatchObject({
			status: "published",
			deliveryCount: 1,
		});
		expect(new FileEnterpriseEventStore(filePath).readPendingOutbox(1)).toEqual([]);
	});

	it("restores Fact values, authority status, and source after reconstruction", () => {
		const filePath = temporaryStorePath();
		const engine = new ProposalRunEngine(new FileEnterpriseEventStore(filePath));
		engine.create(command("create", 0));
		engine.startProposal(command("start", 1));
		engine.recordFactVersion({
			...command("quantity-v1", 2),
			factKey: "quantity",
			factVersion: 1,
			value: 10_000,
			unit: "bags",
			status: "unverified",
			sourceType: "user_input",
			sourceRef: "message-persisted-1",
		});

		const recovered = new ProposalRunEngine(
			new FileEnterpriseEventStore(filePath),
		).load(scope);

			expect(recovered.facts.quantity).toEqual({
			key: "quantity",
			version: 1,
			value: 10_000,
			unit: "bags",
			status: "unverified",
				sourceType: "user_input",
				sourceRef: "message-persisted-1",
				recordedAt: expect.any(String),
				recordedBy: "user-persisted",
			});
	});

	it("preserves the tenant and workspace boundary after restart", () => {
		const filePath = temporaryStorePath();
		const firstEngine = new ProposalRunEngine(
			new FileEnterpriseEventStore(filePath),
		);
		firstEngine.create(command("create", 0));

		expect(() => new FileEnterpriseEventStore(filePath).read({
			tenantId: "tenant-b",
			workspaceId: scope.workspaceId,
			runId: scope.runId,
		})).toThrowError(expect.objectContaining({
			code: "aggregate_access_denied",
		}) as Partial<EnterpriseKernelError>);
	});

	it("fails closed when the persisted event document is corrupt", () => {
		const filePath = temporaryStorePath();
		mkdirSync(join(filePath, ".."), { recursive: true });
		writeFileSync(filePath, "{not-json", "utf8");

		expect(() => new FileEnterpriseEventStore(filePath).read(scope)).toThrowError(
			expect.objectContaining({
				code: "event_store_corrupt",
			}) as Partial<EnterpriseKernelError>,
		);
	});

	it("rejects syntactically valid events with incomplete payloads", () => {
		const filePath = temporaryStorePath();
		const engine = new ProposalRunEngine(new FileEnterpriseEventStore(filePath));
		engine.create(command("create", 0));
		const document = JSON.parse(readFileSync(filePath, "utf8")) as {
			events: Array<{ data: unknown }>;
		};
		document.events[0].data = { type: "artifact.version_created" };
		writeFileSync(filePath, JSON.stringify(document), "utf8");

		expect(() => new FileEnterpriseEventStore(filePath).read(scope)).toThrowError(
			expect.objectContaining({ code: "event_store_corrupt" }) as Partial<EnterpriseKernelError>,
		);
	});

	it("rejects gaps in an aggregate event version sequence", () => {
		const filePath = temporaryStorePath();
		const engine = new ProposalRunEngine(new FileEnterpriseEventStore(filePath));
		engine.create(command("create", 0));
		engine.startProposal(command("start", 1));
		const document = JSON.parse(readFileSync(filePath, "utf8")) as {
			events: Array<{ aggregateVersion: number }>;
		};
		document.events[1].aggregateVersion = 3;
		writeFileSync(filePath, JSON.stringify(document), "utf8");

		expect(() => new FileEnterpriseEventStore(filePath).read(scope)).toThrowError(
			expect.objectContaining({ code: "event_store_corrupt" }) as Partial<EnterpriseKernelError>,
		);
	});

	it("rejects writes while another process owns the file lock", () => {
		const filePath = temporaryStorePath();
		mkdirSync(`${filePath}.lock`, { recursive: true });
		const engine = new ProposalRunEngine(new FileEnterpriseEventStore(filePath));

		expect(() => engine.create(command("create", 0))).toThrowError(
			expect.objectContaining({
				code: "concurrency_conflict",
			}) as Partial<EnterpriseKernelError>,
		);
	});
});
