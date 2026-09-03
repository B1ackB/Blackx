import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileCronScheduleStore } from "./fileCronScheduleStore";

describe("FileCronScheduleStore", () => {
	it("survives a process-style reopen", () => {
		const directory = mkdtempSync(join(tmpdir(), "blackx-cron-store-"));
		const path = join(directory, "schedules.json");
		try {
			new FileCronScheduleStore(path).create({
				tenantId: "tenant-file-cron",
				workspaceId: "workspace-file-cron",
				runId: "conversation-file-cron",
				scheduleId: "schedule-file-cron",
				name: "status-check",
				expression: "*/5 * * * *",
				timezone: "UTC",
				prompt: "check status",
				actorId: "agent:user-file-cron",
				maxRuns: 3,
				nextRunAt: "2026-09-03T00:05:00.000Z",
			});

			expect(new FileCronScheduleStore(path).get("schedule-file-cron"))
				.toMatchObject({ expression: "*/5 * * * *", maxRuns: 3, status: "active" });
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
