import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ProposalRunEngine } from "../../src/enterprise/proposalRunEngine";
import { FileEnterpriseEventStore } from "../enterprise/fileEventStore";
import { FileCronScheduleStore } from "../enterprise/fileCronScheduleStore";
import { FileStageJobQueue } from "../enterprise/fileStageJobQueue";
import { workspaceRunId } from "../enterprise/proposalWorkspaceApi";
import { StageJobScheduler } from "../workers/stageJobScheduler";
import { StageJobOutbox } from "../workers/stageJobOutbox";
import { BackgroundTaskApiController, enqueueBackgroundConversationTask } from "../workers/backgroundTaskApi";
import { CronDispatcher } from "../workers/cronScheduler";
import { ConversationApiController } from "./conversationApi";
import { ConversationDeletion } from "./conversationDeletion";
import { FakeAgentRuntime } from "./fakeAgentRuntime";
import { FileAgentStateStore } from "./fileAgentStateStore";

const directories: string[] = [];
const context = { tenantId: "tenant-delete", workspaceId: "workspace-delete", actorId: "user-delete" };
const now = "2026-09-05T00:00:00.000Z";
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

function setup(directory: string) {
	const sessions = new FileAgentStateStore(join(directory, "sessions"));
	const queue = new FileStageJobQueue(join(directory, "queue.json"));
	const schedules = new FileCronScheduleStore(join(directory, "cron.json"));
	const events = new FileEnterpriseEventStore(join(directory, "events.json"));
	const engine = new ProposalRunEngine(events);
	const scheduler = new StageJobScheduler(queue, { workerId: "delete-worker" });
	const deletion = new ConversationDeletion(sessions, scheduler, schedules, [{ prefix: "proposal", engine }]);
	const api = new ConversationApiController(new FakeAgentRuntime(), sessions);
	return { sessions, queue, schedules, engine, scheduler, deletion, api, outbox: new StageJobOutbox(engine, events, queue) };
}

it("recovers an interrupted deletion, cancels leases and late outbox jobs, pauses cron, and isolates other workspaces", () => {
	const directory = mkdtempSync(join(tmpdir(), "blackx-delete-")); directories.push(directory);
	const first = setup(directory);
	const conversationId = "conversation-delete";
	const scope = { ...context, runId: conversationId, sessionId: conversationId };
	first.sessions.createSession(scope, now);
	first.sessions.createSession({ ...scope, workspaceId: "other" }, now);
	const job = enqueueBackgroundConversationTask(first.queue, { ...context, conversationId, messageId: "pending", content: "work", requestedBy: "user" });
	const lease = first.queue.claim("crashed-worker", 60_000)!;
	expect(lease.jobId).toBe(job.jobId);
	const other = enqueueBackgroundConversationTask(first.queue, { ...context, workspaceId: "other", conversationId, messageId: "other-pending", content: "work", requestedBy: "user" });
	for (const workspaceId of [context.workspaceId, "other"]) first.schedules.create({ ...context, workspaceId, runId: conversationId, scheduleId: `schedule-${workspaceId}`, name: "recurring", expression: "*/5 * * * *", timezone: "UTC", prompt: "work", maxRuns: 3, nextRunAt: now });
	const runScope = { ...context, runId: workspaceRunId(context, conversationId, "proposal") };
	first.engine.create({ ...runScope, commandId: "create", correlationId: "create", expectedVersion: 0 });
	first.engine.startProposal({ ...runScope, commandId: "start", correlationId: "start", expectedVersion: 1 });
	first.outbox.requestProposal({ ...runScope, commandId: "outbox", correlationId: "outbox", expectedVersion: 2 });
	first.sessions.deleteSession(scope, context.actorId, now); // crash before cleanup
	const restarted = setup(directory);
	restarted.deletion.reconcile(context);
	expect(restarted.queue.get(job.jobId)?.status).toBe("cancelled");
	expect(() => restarted.queue.ack(lease)).toThrow();
	expect(restarted.queue.get(other.jobId)?.status).toBe("queued");
	expect(restarted.sessions.getSession({ ...scope, workspaceId: "other" })).toBeDefined();
	expect(restarted.schedules.get(`schedule-${context.workspaceId}`)?.status).toBe("paused");
	expect(restarted.schedules.get("schedule-other")?.status).toBe("active");
	expect(restarted.engine.load(runScope).stageStatus).toBe("cancelled");
	const version = restarted.engine.load(runScope).aggregateVersion;
	const late = restarted.outbox.dispatchOne();
	expect(late.status).toBe("published");
	restarted.deletion.reconcile(context);
	if (late.status === "published") expect(restarted.queue.get(late.job.jobId)?.status).toBe("cancelled");
	expect(restarted.engine.load(runScope).aggregateVersion).toBe(version);
	new CronDispatcher(restarted.schedules, restarted.queue, () => new Date(now)).dispatchDue();
	expect(restarted.queue.list().filter((candidate) => candidate.workspaceId === context.workspaceId && candidate.status === "queued")).toEqual([]);
	const background = new BackgroundTaskApiController(restarted.queue, restarted.api, new FakeAgentRuntime());
	expect(background.list(context, conversationId).status).toBe(404);
	expect(background.get(context, job.jobId).status).toBe(404);
});
