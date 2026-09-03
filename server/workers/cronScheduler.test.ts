import { describe, expect, it } from "vitest";
import { InMemoryCronScheduleStore, type CronScheduleStore } from "../../src/enterprise/cronSchedule";
import { InMemoryStageJobQueue } from "../../src/enterprise/stageJobQueue";
import { CronDispatcher, validateCronFrequency } from "./cronScheduler";

describe("CronDispatcher", () => {
	it("uses timezone-aware Cron parsing and rejects sub-five-minute schedules", () => {
		expect(validateCronFrequency("*/5 * * * *", "Asia/Hong_Kong", new Date("2026-09-03T00:00:00Z")))
			.toEqual(new Date("2026-09-03T00:05:00Z"));
		expect(() => validateCronFrequency("* * * * *", "UTC", new Date("2026-09-03T00:00:00Z")))
			.toThrow("cron_frequency_below_five_minutes");
	});

	it("replays the same occurrence after a crash between enqueue and schedule ACK", () => {
		const now = new Date("2026-09-03T00:05:00.000Z");
		const store = new InMemoryCronScheduleStore(() => now);
		store.create({
			tenantId: "tenant-cron-dispatch",
			workspaceId: "workspace-cron-dispatch",
			runId: "conversation-cron-dispatch",
			scheduleId: "schedule-cron-dispatch",
			name: "five-minute-check",
			expression: "*/5 * * * *",
			timezone: "UTC",
			prompt: "check status",
			actorId: "agent:user-cron-dispatch",
			maxRuns: 1,
			nextRunAt: now.toISOString(),
		});
		const queue = new InMemoryStageJobQueue({ now: () => now });
		let crash = true;
		const crashOnce = new Proxy(store as CronScheduleStore, {
			get(target, property, receiver) {
				if (property !== "acknowledge") return Reflect.get(target, property, receiver);
				return (...parameters: Parameters<CronScheduleStore["acknowledge"]>) => {
					if (crash) {
						crash = false;
						throw new Error("injected_crash_after_enqueue");
					}
					return target.acknowledge(...parameters);
				};
			},
		});
		const dispatcher = new CronDispatcher(crashOnce, queue, () => now);

		expect(() => dispatcher.dispatchDue()).toThrow("injected_crash_after_enqueue");
		expect(queue.list()).toHaveLength(1);
		expect(dispatcher.dispatchDue()).toBe(1);
		expect(queue.list()).toHaveLength(1);
		expect(store.get("schedule-cron-dispatch")).toMatchObject({ status: "completed", runCount: 1 });
	});
});
