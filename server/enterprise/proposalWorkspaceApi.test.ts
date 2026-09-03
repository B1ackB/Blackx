import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryEnterpriseEventStore } from "../../src/enterprise/inMemoryEventStore";
import { ProposalRunEngine } from "../../src/enterprise/proposalRunEngine";
import { InMemoryStageJobQueue } from "../../src/enterprise/stageJobQueue";
import type { ConversationView, ProposalWorkspaceView } from "../../src/runtime/conversationContracts";
import { FileArtifactContentStore } from "../artifacts/fileArtifactStore";
import { ConversationApiController } from "../runtime/conversationApi";
import { FakeAgentRuntime } from "../runtime/fakeAgentRuntime";
import { FileAgentStateStore } from "../runtime/fileAgentStateStore";
import { ProposalWorker } from "../workers/proposalWorker";
import { StageJobOutbox } from "../workers/stageJobOutbox";
import { StageJobScheduler } from "../workers/stageJobScheduler";
import { ProposalWorkspaceApiController } from "./proposalWorkspaceApi";

const directories: string[] = [];
const context = {
	tenantId: "tenant-workspace",
	workspaceId: "workspace-workspace",
	actorId: "user-workspace",
};

function proposal(response: { body: unknown }): ProposalWorkspaceView {
	return (response.body as { proposal: ProposalWorkspaceView }).proposal;
}

function harness() {
	const directory = mkdtempSync(join(tmpdir(), "blackx-proposal-workspace-"));
	directories.push(directory);
	const sessions = new FileAgentStateStore(join(directory, "agent"));
	const conversations = new ConversationApiController(
		new FakeAgentRuntime({ sessions, snapshots: sessions }),
		sessions,
		() => "2026-09-03T00:00:00.000Z",
		() => "workspace-conversation",
	);
	const created = (conversations.create(context).body as { conversation: ConversationView }).conversation;
	const stored = sessions.getSession({
		...context,
		runId: created.conversationId,
		sessionId: created.conversationId,
	})!;
	sessions.save(
		{ ...context, runId: created.conversationId, sessionId: created.conversationId },
		stored.revision,
		[{
			role: "user",
			content: "我要做 5000 个香港市场咖啡豆自立拉链袋。",
			messageId: "message-brief",
			createdAt: "2026-09-03T00:01:00.000Z",
			pinned: true,
		}],
		"2026-09-03T00:01:00.000Z",
	);
	const eventStore = new InMemoryEnterpriseEventStore();
	const engine = new ProposalRunEngine(eventStore);
	const artifacts = new FileArtifactContentStore(join(directory, "artifacts"));
	const queue = new InMemoryStageJobQueue();
	const outbox = new StageJobOutbox(engine, eventStore, queue);
	const scheduler = new StageJobScheduler(
		queue,
		new ProposalWorker(engine, new FakeAgentRuntime(), artifacts),
		{ workerId: "proposal-workspace-test" },
	);
	return {
		conversationId: created.conversationId,
		controller: new ProposalWorkspaceApiController(
			conversations,
			engine,
			artifacts,
			outbox,
			scheduler,
		),
		queue,
		scheduler,
	};
}

afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("ProposalWorkspaceApiController", () => {
	it("connects a Conversation snapshot to Artifact, Evaluation, Approval A, and the Stage gate", async () => {
		const { controller, conversationId, queue, scheduler } = harness();

		expect(controller.get(context, conversationId)).toEqual({
			status: 200,
			body: { proposal: null },
		});
		const started = controller.start(context, conversationId, { requestId: "proposal-request-1" });
		expect(started.status).toBe(202);
		expect(proposal(started)).toMatchObject({
			state: {
				stageStatus: "running",
				facts: {
					customer_brief: {
						status: "unverified",
						sourceType: "user_input",
					},
				},
			},
			job: { status: "queued" },
		});
		const repeated = controller.start(context, conversationId, { requestId: "proposal-request-1" });
		expect(proposal(repeated).state.aggregateVersion).toBe(proposal(started).state.aggregateVersion);
		expect(queue.list()).toHaveLength(1);

		expect(await scheduler.runNext()).toMatchObject({ status: "completed" });
		const waiting = controller.get(context, conversationId);
		expect(proposal(waiting)).toMatchObject({
			state: {
				stageStatus: "waiting_approval",
				currentProposal: { artifactId: "solution-proposal", version: 1 },
				evaluation: { passed: true, artifactVersion: 1 },
				approval: { status: "requested", artifactVersion: 1 },
			},
			artifact: { content: { schemaVersion: "solution-proposal.v1" } },
			evaluation: { report: { passed: true, issues: [] } },
		});

		const approved = controller.resolveApproval(context, conversationId, {
			requestId: "approval-request-1",
			decision: "approved",
		});
		expect(proposal(approved).state.approval?.status).toBe("approved");
		expect(await scheduler.runNext()).toMatchObject({ status: "completed" });
		expect(proposal(controller.get(context, conversationId)).state).toMatchObject({
			status: "completed",
			stageStatus: "passed",
			approval: { status: "approved", artifactVersion: 1 },
		});
	});

	it("does not expose another tenant's Conversation or Proposal Run", () => {
		const { controller, conversationId } = harness();
		controller.start(context, conversationId, { requestId: "proposal-request-tenant" });

		expect(controller.get({ ...context, tenantId: "tenant-other" }, conversationId)).toEqual({
			status: 404,
			body: { code: "conversation_not_found" },
		});
	});
});
