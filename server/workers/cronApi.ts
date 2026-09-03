import type { CronScheduleStore } from "../../src/enterprise/cronSchedule";
import type { ConversationApiContext, ConversationApiResponse } from "../runtime/conversationApi";
import { automationScheduleView } from "../runtime/automationTools";

function id(value: unknown, name: string): string {
	if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
		throw new Error(`${name} is invalid`);
	}
	return value;
}

export class CronApiController {
	constructor(private readonly schedules: CronScheduleStore) {}

	list(context: ConversationApiContext, conversationIdValue: unknown): ConversationApiResponse {
		try {
			const tenantId = id(context.tenantId, "tenantId");
			const workspaceId = id(context.workspaceId, "workspaceId");
			const conversationId = id(conversationIdValue, "conversationId");
			return {
				status: 200,
				body: {
					schedules: this.schedules.list({ tenantId, workspaceId })
						.filter((schedule) => schedule.runId === conversationId)
						.map(automationScheduleView),
				},
			};
		} catch (error) {
			return {
				status: 400,
				body: { code: "invalid_cron_schedule_request", message: error instanceof Error ? error.message : undefined },
			};
		}
	}
}
