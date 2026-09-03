import { createHash } from "node:crypto";
import { Cron } from "croner";
import type { CronSchedule, CronScheduleStore } from "../../src/enterprise/cronSchedule";
import type { StageJobQueue } from "../../src/enterprise/stageJobQueue";
import { enqueueBackgroundConversationTask } from "./backgroundTaskApi";

export function nextCronRun(expression: string, timezone: string, after: Date): Date {
	if (!expression.trim() || expression.length > 120 || !timezone.trim() || timezone.length > 80) {
		throw new Error("invalid_cron_schedule");
	}
	new Intl.DateTimeFormat("en", { timeZone: timezone }).format(after);
	const next = new Cron(expression, { timezone, paused: true }).nextRun(after);
	if (!next) throw new Error("cron_has_no_next_run");
	return next;
}

export function validateCronFrequency(expression: string, timezone: string, after: Date): Date {
	const first = nextCronRun(expression, timezone, after);
	const second = nextCronRun(expression, timezone, first);
	if (second.getTime() - first.getTime() < 300_000) throw new Error("cron_frequency_below_five_minutes");
	return first;
}

function occurrenceId(schedule: CronSchedule): string {
	return createHash("sha256")
		.update(`${schedule.scheduleId}\u0000${schedule.nextRunAt}`)
		.digest("hex");
}

export class CronDispatcher {
	constructor(
		private readonly schedules: CronScheduleStore,
		private readonly queue: StageJobQueue,
		private readonly now: () => Date = () => new Date(),
	) {}

	dispatchDue(limit = 10): number {
		const due = this.schedules.due(this.now().toISOString(), limit);
		for (const schedule of due) {
			const occurrence = occurrenceId(schedule);
			enqueueBackgroundConversationTask(this.queue, {
				tenantId: schedule.tenantId,
				workspaceId: schedule.workspaceId,
				conversationId: schedule.runId,
				messageId: `cron-${occurrence}`,
				content: `[定时任务：${schedule.name}]\n${schedule.prompt}`,
				actorId: `cron:${schedule.scheduleId}`,
				requestedBy: "cron",
			});
			const next = schedule.runCount + 1 >= schedule.maxRuns
				? undefined
				: nextCronRun(schedule.expression, schedule.timezone, new Date(schedule.nextRunAt)).toISOString();
			this.schedules.acknowledge(schedule.scheduleId, schedule.nextRunAt, next);
		}
		return due.length;
	}
}
