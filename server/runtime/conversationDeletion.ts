import type { CronScheduleStore } from "../../src/enterprise/cronSchedule";
import type { ProposalRunEngine } from "../../src/enterprise/proposalRunEngine";
import { workspaceRunId } from "../enterprise/proposalWorkspaceApi";
import type { StageJobScheduler } from "../workers/stageJobScheduler";
import type { FileAgentStateStore, StoredAgentSession } from "./fileAgentStateStore";

// Enterprise cleanup stays outside Agent Core. A durable session tombstone is the
// deletion intent; repeating reconciliation also fences late outbox deliveries.
export class ConversationDeletion {
	constructor(
		private readonly sessions: FileAgentStateStore,
		private readonly scheduler: StageJobScheduler,
		private readonly schedules: CronScheduleStore,
		private readonly workflows: readonly { prefix: string; engine: ProposalRunEngine }[],
	) {}

	reconcile(scope: { tenantId: string; workspaceId: string }): void {
		for (const session of this.sessions.listSessions(scope, true)) {
			if (session.deletion && session.sessionId.startsWith("conversation-") && session.runId === session.sessionId) this.cleanup(session);
		}
	}

	cleanup(session: StoredAgentSession): void {
		if (!session.deletion) throw new Error("conversation_deletion_required");
		for (const schedule of this.schedules.list(session)) {
			if (schedule.runId === session.runId && schedule.status === "active") this.schedules.setStatus(schedule.scheduleId, session, "paused");
		}
		const runs = [session.runId, ...this.workflows.map(({ prefix }) => workspaceRunId(session, session.sessionId, prefix))];
		for (const runId of runs) {
			const scope = { tenantId: session.tenantId, workspaceId: session.workspaceId, runId };
			for (const job of this.scheduler.jobsForRun(scope)) {
				if (job.status === "queued" || job.status === "leased") this.scheduler.cancel(job.jobId, scope);
			}
		}
		for (const { prefix, engine } of this.workflows) {
			const scope = { tenantId: session.tenantId, workspaceId: session.workspaceId, runId: workspaceRunId(session, session.sessionId, prefix) };
			const state = engine.load(scope);
			if (state.aggregateVersion === 0 || state.stageStatus === "passed" || state.stageStatus === "cancelled") continue;
			engine.cancelStage({ ...scope, actorId: session.deletion.actorId, expectedVersion: state.aggregateVersion,
				commandId: "conversation-delete", correlationId: `delete-${scope.runId}` });
		}
	}
}
