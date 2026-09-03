import { describe, expect, it } from "vitest";
import { InMemoryCronScheduleStore } from "./cronSchedule";

function input() {
	return {
		tenantId: "tenant-cron",
		workspaceId: "workspace-cron",
		runId: "conversation-cron",
		scheduleId: "schedule-cron",
		name: "daily-check",
		expression: "0 9 * * *",
		timezone: "Asia/Hong_Kong",
		prompt: "check status",
		actorId: "agent:user-cron",
		maxRuns: 2,
		nextRunAt: "2026-09-03T01:00:00.000Z",
	};
}

describe("CronScheduleStore", () => {
	it("creates idempotently, acknowledges occurrences, and completes at maxRuns", () => {
		let now = new Date("2026-09-03T00:00:00.000Z");
		const store = new InMemoryCronScheduleStore(() => now);
		const created = store.create(input());
		expect(store.create(input())).toEqual(created);
		expect(store.due("2026-09-03T00:59:59.000Z")).toEqual([]);
		expect(store.due("2026-09-03T01:00:00.000Z")).toHaveLength(1);

		now = new Date("2026-09-03T01:00:00.000Z");
		expect(store.acknowledge(created.scheduleId, created.nextRunAt, "2026-09-04T01:00:00.000Z"))
			.toMatchObject({ status: "active", runCount: 1, lastRunAt: created.nextRunAt });
		expect(store.acknowledge(created.scheduleId, "2026-09-04T01:00:00.000Z", "2026-09-05T01:00:00.000Z"))
			.toMatchObject({ status: "completed", runCount: 2 });
	});

	it("pauses and resumes only within the owning tenant", () => {
		const store = new InMemoryCronScheduleStore();
		store.create(input());
		expect(store.setStatus("schedule-cron", input(), "paused")).toMatchObject({ status: "paused" });
		expect(() => store.setStatus("schedule-cron", {
			tenantId: "tenant-other",
			workspaceId: "workspace-cron",
		}, "active", "2026-09-04T01:00:00.000Z")).toThrowError(expect.objectContaining({ code: "schedule_not_found" }));
		expect(store.setStatus("schedule-cron", input(), "active", "2026-09-04T01:00:00.000Z"))
			.toMatchObject({ status: "active", nextRunAt: "2026-09-04T01:00:00.000Z" });
	});
});
