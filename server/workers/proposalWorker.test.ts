import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileArtifactContentStore } from "../artifacts/fileArtifactStore";
import { ProposalRunEngine } from "../../src/enterprise/proposalRunEngine";
import type {
	AgentRuntimePort,
	RuntimeHealth,
	RuntimeTurnRequest,
	RuntimeTurnResult,
} from "../../src/runtime/contracts";
import { FakeAgentRuntime } from "../runtime/fakeAgentRuntime";
import { FileEnterpriseEventStore } from "../enterprise/fileEventStore";
import { ProposalWorker, type ProposalCrashPoint } from "./proposalWorker";

const temporaryDirectories: string[] = [];
const scope = {
	tenantId: "tenant-a",
	workspaceId: "workspace-a",
	runId: "run-worker-a",
};

class CapturingRuntime implements AgentRuntimePort {
	callCount = 0;
	lastRequest?: RuntimeTurnRequest;

	constructor(
		private readonly delegate: AgentRuntimePort = new FakeAgentRuntime(),
		private readonly finalResponse?: string,
	) {}

	health(): Promise<RuntimeHealth> {
		return this.delegate.health();
	}

	async executeTurn(
		request: RuntimeTurnRequest,
		signal?: AbortSignal,
	): Promise<RuntimeTurnResult> {
		this.callCount += 1;
		this.lastRequest = request;
		const result = await this.delegate.executeTurn(request, signal);
		return this.finalResponse === undefined
			? result
			: { ...result, finalResponse: this.finalResponse };
	}
}

function command(commandId: string, expectedVersion: number) {
	return {
		...scope,
		commandId,
		correlationId: "trace-worker-a",
		expectedVersion,
	};
}

function prepare(runtime = new CapturingRuntime()) {
	const directory = mkdtempSync(join(tmpdir(), "blackx-worker-artifacts-"));
	temporaryDirectories.push(directory);
	const eventPath = join(directory, "events.json");
	const artifactPath = join(directory, "artifacts");
	const eventStore = new FileEnterpriseEventStore(eventPath);
	const engine = new ProposalRunEngine(eventStore);
	engine.create({ ...command("create", 0), actorId: "user-a" });
	engine.startProposal({ ...command("start", 1), actorId: "user-a" });
	const withFact = engine.recordFactVersion({
		...command("fact-quantity-v1", 2),
		actorId: "user-a",
		factKey: "quantity",
		factVersion: 1,
		value: 10_000,
		unit: "bags",
		status: "unverified",
		sourceType: "user_input",
		sourceRef: "message-quantity-v1",
	});
	const artifacts = new FileArtifactContentStore(artifactPath);
	return {
		artifactPath,
		artifacts,
		engine,
		eventPath,
		eventStore,
		runtime,
		worker: new ProposalWorker(engine, runtime, artifacts),
		expectedVersion: withFact.aggregateVersion,
	};
}

function crashingWorker(
	harness: ReturnType<typeof prepare>,
	point: ProposalCrashPoint,
): ProposalWorker {
	return new ProposalWorker(
		harness.engine,
		harness.runtime,
		harness.artifacts,
		(reached) => {
			if (reached === point) throw new Error(`injected_crash:${point}`);
		},
	);
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("ProposalWorker", () => {
	it("runs the Fake Runtime, persists artifacts, evaluates, and requests Approval A", async () => {
		const harness = prepare();
		const completed = await harness.worker.execute(
			command("worker-proposal-v1", harness.expectedVersion),
		);

		expect(completed).toMatchObject({
			status: "waiting_approval",
			stageStatus: "waiting_approval",
			currentProposal: {
				artifactId: "solution-proposal",
				version: 1,
				schemaVersion: "solution-proposal.v1",
				inputFactVersions: { quantity: 1 },
				contextSnapshotId: `proposal-state-v${harness.expectedVersion}-i1`,
			},
			approval: { status: "requested", artifactVersion: 1 },
		});
		const proposal = harness.artifacts.readJson({
			...scope,
			artifactId: "solution-proposal",
			artifactVersion: 1,
		}) as { recommendations: Array<{ status: string }>; factLineage: Record<string, number> };
		expect(proposal.factLineage).toEqual({ quantity: 1 });
		expect(proposal.recommendations.every(({ status }) => status === "suggested")).toBe(true);
		expect(harness.artifacts.readJson({
			...scope,
			artifactId: "proposal-evaluation",
			artifactVersion: 1,
		})).toMatchObject({ passed: true, issues: [] });
		expect(harness.runtime.lastRequest).toMatchObject({
			stageId: "proposal",
			idempotencyKey: "worker-proposal-v1",
			policy: { sandboxMode: "read-only", approvalPolicy: "never" },
		});
		expect(harness.eventStore.read(scope).find(
			(event) => event.data.type === "runtime.execution.linked",
		)?.actorId).toBe("blackx-worker");
	});

	it("persists failed evidence without requesting approval when output is invalid", async () => {
		const runtime = new CapturingRuntime(new FakeAgentRuntime(), "not-json");
		const harness = prepare(runtime);
		const completed = await harness.worker.execute(
			command("worker-invalid-v1", harness.expectedVersion),
		);

		expect(completed.stageStatus).toBe("retryable_failed");
		expect(completed.approval).toBeUndefined();
		expect(completed.currentProposal?.schemaVersion).toBe("invalid-runtime-output.v1");
		expect(harness.artifacts.readJson({
			...scope,
			artifactId: "proposal-evaluation",
			artifactVersion: 1,
		})).toMatchObject({
			passed: false,
			issues: [{ code: "invalid_json" }],
		});
		expect(harness.eventStore.read(scope).map((event) => event.data.type)).not.toContain(
			"approval.requested",
		);
		expect(await harness.worker.execute(
			command("worker-invalid-v1", harness.expectedVersion),
		)).toEqual(completed);
		expect(harness.runtime.callCount).toBe(1);
	});

	it("does not invoke the Runtime again for a completed worker command", async () => {
		const harness = prepare();
		const workerCommand = command("worker-idempotent-v1", harness.expectedVersion);
		const first = await harness.worker.execute(workerCommand);
		const repeated = await harness.worker.execute(workerCommand);

		expect(repeated).toEqual(first);
		expect(harness.runtime.callCount).toBe(1);
	});

	it("recovers after StageStarted and before the Runtime call", async () => {
		const harness = prepare();
		const workerCommand = command("crash-stage-started", harness.expectedVersion);

		await expect(crashingWorker(
			harness,
			"after_stage_started",
		).execute(workerCommand)).rejects.toThrow("injected_crash:after_stage_started");
		expect(harness.runtime.callCount).toBe(0);
		expect(harness.engine.load(scope).aggregateVersion).toBe(harness.expectedVersion);

		const recovered = await new ProposalWorker(
			new ProposalRunEngine(new FileEnterpriseEventStore(harness.eventPath)),
			harness.runtime,
			new FileArtifactContentStore(harness.artifactPath),
		).execute(workerCommand);
		expect(recovered.stageStatus).toBe("waiting_approval");
		expect(harness.runtime.callCount).toBe(1);
	});

	it("resumes from the Runtime Checkpoint without repeating the expensive call", async () => {
		const harness = prepare();
		const workerCommand = command("crash-runtime-completed", harness.expectedVersion);

		await expect(crashingWorker(
			harness,
			"after_runtime_completed",
		).execute(workerCommand)).rejects.toThrow("injected_crash:after_runtime_completed");
		expect(harness.runtime.callCount).toBe(1);
		expect(harness.engine.load(scope).aggregateVersion).toBe(harness.expectedVersion);
		expect(harness.artifacts.readJson({
			...scope,
			artifactId: "proposal-runtime-checkpoint",
			artifactVersion: 1,
		})).toMatchObject({
			schemaVersion: "proposal-runtime-checkpoint.v2",
			factLineage: { quantity: 1 },
			contextSnapshotId: `proposal-state-v${harness.expectedVersion}-i1`,
		});

		const recovered = await new ProposalWorker(
			new ProposalRunEngine(new FileEnterpriseEventStore(harness.eventPath)),
			harness.runtime,
			new FileArtifactContentStore(harness.artifactPath),
		).execute(workerCommand);
		expect(recovered.stageStatus).toBe("waiting_approval");
		expect(harness.runtime.callCount).toBe(1);
	});

	it("continues Evaluation after the Artifact Version was persisted", async () => {
		const harness = prepare();
		const workerCommand = command("crash-artifact-created", harness.expectedVersion);

		await expect(crashingWorker(
			harness,
			"after_artifact_created",
		).execute(workerCommand)).rejects.toThrow("injected_crash:after_artifact_created");
		expect(harness.engine.load(scope)).toMatchObject({
			stageStatus: "evaluating",
			currentProposal: { version: 1 },
		});
		expect(() => harness.artifacts.readJson({
			...scope,
			artifactId: "proposal-evaluation",
			artifactVersion: 1,
		})).toThrowError(expect.objectContaining({ code: "artifact_not_found" }));

		const recovered = await harness.worker.execute(workerCommand);
		expect(recovered.stageStatus).toBe("waiting_approval");
		expect(harness.runtime.callCount).toBe(1);
	});

	it("deduplicates recovery after ApprovalRequested", async () => {
		const harness = prepare();
		const workerCommand = command("crash-approval-requested", harness.expectedVersion);

		await expect(crashingWorker(
			harness,
			"after_approval_requested",
		).execute(workerCommand)).rejects.toThrow("injected_crash:after_approval_requested");
		const waiting = harness.engine.load(scope);
		expect(waiting).toMatchObject({
			stageStatus: "waiting_approval",
			approval: { status: "requested" },
		});

		expect(await harness.worker.execute(workerCommand)).toEqual(waiting);
		expect(harness.runtime.callCount).toBe(1);
	});

	it("requires Worker Gate confirmation after Approval is persisted", async () => {
		const harness = prepare();
		const waiting = await harness.worker.execute(
			command("proposal-before-gate", harness.expectedVersion),
		);
		const approved = harness.engine.resolveApproval({
			...command("approve-before-gate", waiting.aggregateVersion),
			actorId: "approver-a",
			approvalId: waiting.approval?.approvalId ?? "missing",
			artifactId: "solution-proposal",
			artifactVersion: 1,
			decision: "approved",
		});
		expect(approved).toMatchObject({
			status: "waiting_approval",
			stageStatus: "waiting_approval",
			approval: { status: "approved" },
		});
		const gateCommand = command("confirm-after-approval", approved.aggregateVersion);

		await expect(crashingWorker(
			harness,
			"after_approval_resolved",
		).execute(gateCommand)).rejects.toThrow("injected_crash:after_approval_resolved");
		expect(harness.engine.load(scope)).toEqual(approved);

		const completed = await harness.worker.execute(gateCommand);
		expect(completed).toMatchObject({
			status: "completed",
			stageStatus: "passed",
			approval: { status: "approved" },
		});
		expect(harness.runtime.callCount).toBe(1);
	});
});
