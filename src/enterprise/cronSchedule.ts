import type { AggregateScope } from "./contracts";

export type CronScheduleStatus = "active" | "paused" | "completed";

export interface CronScheduleInput extends AggregateScope {
	scheduleId: string;
	name: string;
	expression: string;
	timezone: string;
	prompt: string;
	actorId: string;
	maxRuns: number;
	nextRunAt: string;
}

export interface CronSchedule extends CronScheduleInput {
	schemaVersion: "cron-schedule.v1";
	status: CronScheduleStatus;
	runCount: number;
	createdAt: string;
	updatedAt: string;
	lastRunAt?: string;
}

export interface CronScheduleStore {
	create(input: CronScheduleInput): CronSchedule;
	get(scheduleId: string): CronSchedule | undefined;
	list(scope: { tenantId: string; workspaceId: string }): CronSchedule[];
	due(now: string, limit?: number): CronSchedule[];
	acknowledge(scheduleId: string, expectedRunAt: string, nextRunAt?: string): CronSchedule;
	setStatus(
		scheduleId: string,
		scope: { tenantId: string; workspaceId: string },
		status: "active" | "paused",
		nextRunAt?: string,
	): CronSchedule;
}

export interface CronScheduleStorage {
	read(): CronSchedule[];
	transaction<Value>(operation: (schedules: CronSchedule[]) => Value): Value;
}

export class CronScheduleError extends Error {
	constructor(
		readonly code: "invalid_schedule" | "schedule_conflict" | "schedule_not_found" | "schedule_store_corrupt" | "schedule_store_unavailable",
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "CronScheduleError";
	}
}

function clone<Value>(value: Value): Value {
	return structuredClone(value);
}

function validId(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function validDate(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function isCronSchedule(value: unknown): value is CronSchedule {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const schedule = value as Partial<CronSchedule>;
	return schedule.schemaVersion === "cron-schedule.v1" &&
		[schedule.scheduleId, schedule.tenantId, schedule.workspaceId, schedule.runId,
			schedule.actorId].every(validId) &&
		typeof schedule.name === "string" && schedule.name.length > 0 && schedule.name.length <= 120 &&
		typeof schedule.expression === "string" && schedule.expression.length > 0 && schedule.expression.length <= 120 &&
		typeof schedule.timezone === "string" && schedule.timezone.length > 0 && schedule.timezone.length <= 80 &&
		typeof schedule.prompt === "string" && schedule.prompt.length > 0 && schedule.prompt.length <= 8_000 &&
		["active", "paused", "completed"].includes(String(schedule.status)) &&
		Number.isInteger(schedule.maxRuns) && Number(schedule.maxRuns) > 0 && Number(schedule.maxRuns) <= 100 &&
		Number.isInteger(schedule.runCount) && Number(schedule.runCount) >= 0 &&
		validDate(schedule.nextRunAt) && validDate(schedule.createdAt) && validDate(schedule.updatedAt) &&
		(schedule.lastRunAt === undefined || validDate(schedule.lastRunAt));
}

function assertInput(input: CronScheduleInput): void {
	const candidate: CronSchedule = {
		...input,
		schemaVersion: "cron-schedule.v1",
		status: "active",
		runCount: 0,
		createdAt: input.nextRunAt,
		updatedAt: input.nextRunAt,
	};
	if (!isCronSchedule(candidate)) throw new CronScheduleError("invalid_schedule", "Cron Schedule is invalid");
}

export class DurableCronScheduleStore implements CronScheduleStore {
	constructor(
		private readonly storage: CronScheduleStorage,
		private readonly now: () => Date = () => new Date(),
	) {}

	create(input: CronScheduleInput): CronSchedule {
		assertInput(input);
		return this.storage.transaction((schedules) => {
			const existing = schedules.find((schedule) => schedule.scheduleId === input.scheduleId);
			if (existing) {
				const comparable = (({ schemaVersion: _schemaVersion, status: _status, runCount: _runCount,
					createdAt: _createdAt, updatedAt: _updatedAt, lastRunAt: _lastRunAt, ...rest }) => rest)(existing);
				if (JSON.stringify(comparable) !== JSON.stringify(input)) {
					throw new CronScheduleError("schedule_conflict", "Cron Schedule ID is already bound to another request");
				}
				return clone(existing);
			}
			const now = this.now().toISOString();
			const schedule: CronSchedule = {
				...input,
				schemaVersion: "cron-schedule.v1",
				status: "active",
				runCount: 0,
				createdAt: now,
				updatedAt: now,
			};
			schedules.push(schedule);
			return clone(schedule);
		});
	}

	get(scheduleId: string): CronSchedule | undefined {
		if (!validId(scheduleId)) throw new CronScheduleError("invalid_schedule", "Cron Schedule ID is invalid");
		const schedule = this.storage.read().find((candidate) => candidate.scheduleId === scheduleId);
		return schedule ? clone(schedule) : undefined;
	}

	list(scope: { tenantId: string; workspaceId: string }): CronSchedule[] {
		if (![scope.tenantId, scope.workspaceId].every(validId)) {
			throw new CronScheduleError("invalid_schedule", "Cron Schedule scope is invalid");
		}
		return clone(this.storage.read()
			.filter((schedule) => schedule.tenantId === scope.tenantId && schedule.workspaceId === scope.workspaceId)
			.sort((left, right) => Date.parse(left.nextRunAt) - Date.parse(right.nextRunAt)));
	}

	due(now: string, limit = 10): CronSchedule[] {
		if (!validDate(now) || !Number.isInteger(limit) || limit < 1 || limit > 100) {
			throw new CronScheduleError("invalid_schedule", "Cron due scan is invalid");
		}
		return clone(this.storage.read()
			.filter((schedule) => schedule.status === "active" && Date.parse(schedule.nextRunAt) <= Date.parse(now))
			.sort((left, right) => Date.parse(left.nextRunAt) - Date.parse(right.nextRunAt))
			.slice(0, limit));
	}

	acknowledge(scheduleId: string, expectedRunAt: string, nextRunAt?: string): CronSchedule {
		if (!validId(scheduleId) || !validDate(expectedRunAt) || nextRunAt !== undefined && !validDate(nextRunAt)) {
			throw new CronScheduleError("invalid_schedule", "Cron acknowledgement is invalid");
		}
		return this.storage.transaction((schedules) => {
			const schedule = schedules.find((candidate) => candidate.scheduleId === scheduleId);
			if (!schedule) throw new CronScheduleError("schedule_not_found", "Cron Schedule does not exist");
			if (schedule.status !== "active" || schedule.nextRunAt !== expectedRunAt) {
				throw new CronScheduleError("schedule_conflict", "Cron Schedule occurrence was already acknowledged");
			}
			const runCount = schedule.runCount + 1;
			const now = this.now().toISOString();
			const updated: CronSchedule = {
				...schedule,
				status: runCount >= schedule.maxRuns || !nextRunAt ? "completed" : "active",
				runCount,
				nextRunAt: nextRunAt ?? expectedRunAt,
				lastRunAt: expectedRunAt,
				updatedAt: now,
			};
			schedules[schedules.indexOf(schedule)] = updated;
			return clone(updated);
		});
	}

	setStatus(
		scheduleId: string,
		scope: { tenantId: string; workspaceId: string },
		status: "active" | "paused",
		nextRunAt?: string,
	): CronSchedule {
		if (!validId(scheduleId) || ![scope.tenantId, scope.workspaceId].every(validId) ||
			status === "active" && !validDate(nextRunAt)) {
			throw new CronScheduleError("invalid_schedule", "Cron Schedule status update is invalid");
		}
		return this.storage.transaction((schedules) => {
			const schedule = schedules.find((candidate) => candidate.scheduleId === scheduleId &&
				candidate.tenantId === scope.tenantId && candidate.workspaceId === scope.workspaceId);
			if (!schedule) throw new CronScheduleError("schedule_not_found", "Cron Schedule does not exist");
			if (schedule.status === "completed") {
				throw new CronScheduleError("schedule_conflict", "Completed Cron Schedule cannot be resumed");
			}
			const updated = {
				...schedule,
				status,
				...(nextRunAt ? { nextRunAt } : {}),
				updatedAt: this.now().toISOString(),
			};
			schedules[schedules.indexOf(schedule)] = updated;
			return clone(updated);
		});
	}
}

class InMemoryCronScheduleStorage implements CronScheduleStorage {
	private schedules: CronSchedule[] = [];

	read(): CronSchedule[] {
		return clone(this.schedules);
	}

	transaction<Value>(operation: (schedules: CronSchedule[]) => Value): Value {
		const schedules = clone(this.schedules);
		const result = operation(schedules);
		this.schedules = schedules;
		return result;
	}
}

export class InMemoryCronScheduleStore extends DurableCronScheduleStore {
	constructor(now?: () => Date) {
		super(new InMemoryCronScheduleStorage(), now);
	}
}
