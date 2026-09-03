import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type {
	AgentMessage,
	AgentToolAuditEvent,
	AgentToolAuditPort,
	AgentToolExecutionKey,
	AgentToolExecutionRecord,
	AgentToolExecutionStore,
} from "../../src/agent/contracts";
import {
	AgentStateStoreError,
	type AgentSessionScope,
	type AgentSessionState,
	type AgentSessionStore,
	type ContextSnapshotRecord,
	type ContextSnapshotStore,
} from "../../src/agent/state";

interface SessionFile extends AgentSessionScope {
	schemaVersion: "agent-session.v1";
	revision: number;
	messages: AgentMessage[];
	updatedAt: string;
}

export interface StoredAgentSession extends AgentSessionScope, AgentSessionState {
	updatedAt: string;
}

function segment(value: string, name: string): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
		throw new AgentStateStoreError("unavailable", `${name} is invalid`);
	}
	return value;
}

function record(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function messages(value: unknown): value is AgentMessage[] {
	return Array.isArray(value) && value.every((message) => {
		if (!record(message) || !["system", "user", "assistant", "tool"].includes(String(message.role))) return false;
		if (typeof message.content !== "string") return false;
		if (message.messageId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(String(message.messageId))) return false;
		if (message.createdAt !== undefined && !Number.isFinite(Date.parse(String(message.createdAt)))) return false;
		if (message.pinned !== undefined && typeof message.pinned !== "boolean") return false;
		if (message.durable !== undefined && typeof message.durable !== "boolean") return false;
		if (message.toolCallId !== undefined && typeof message.toolCallId !== "string") return false;
		return message.toolCalls === undefined || (
			Array.isArray(message.toolCalls) && message.toolCalls.every((call) => (
				record(call) && typeof call.id === "string" && typeof call.name === "string" && "input" in call
			))
		);
	});
}

function toolExecutionRecord(value: unknown): value is AgentToolExecutionRecord {
	if (!record(value) || value.schemaVersion !== "tool-execution.v1") return false;
	const fieldsValid = [
		"tenantId", "workspaceId", "runId", "stageId", "actorId", "executionId",
		"tool", "toolCallId", "idempotencyKey", "approvalId", "inputDigest", "startedAt",
	].every((key) => typeof value[key] === "string" && value[key].length > 0) &&
		(value.risk === "write" || value.risk === "publish") &&
		["started", "succeeded", "unknown"].includes(String(value.status)) &&
		(value.result === undefined || typeof value.result === "string") &&
		(value.resultDigest === undefined || typeof value.resultDigest === "string") &&
		(value.failureCode === undefined || typeof value.failureCode === "string") &&
		(value.completedAt === undefined || typeof value.completedAt === "string");
	if (!fieldsValid) return false;
	return value.status === "started" || (
		typeof value.result === "string" &&
		typeof value.resultDigest === "string" &&
		typeof value.completedAt === "string"
	);
}

function sameScope(value: {
	tenantId?: unknown;
	workspaceId?: unknown;
	runId?: unknown;
	sessionId?: unknown;
}, scope: AgentSessionScope): boolean {
	return value.tenantId === scope.tenantId &&
		value.workspaceId === scope.workspaceId &&
		value.runId === scope.runId &&
		value.sessionId === scope.sessionId;
}

function canonical(value: unknown): string {
	if (value === null || typeof value !== "object") {
		const serialized = JSON.stringify(value);
		if (serialized === undefined) {
			throw new AgentStateStoreError("unavailable", "Agent State is not JSON serializable");
		}
		return serialized;
	}
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	const item = value as Record<string, unknown>;
	return `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${canonical(item[key])}`).join(",")}}`;
}

function equivalentSnapshot(left: ContextSnapshotRecord, right: ContextSnapshotRecord): boolean {
	const { createdAt: _leftCreatedAt, ...leftComparable } = left;
	const { createdAt: _rightCreatedAt, ...rightComparable } = right;
	return canonical(leftComparable) === canonical(rightComparable);
}

export class FileAgentStateStore implements AgentSessionStore, ContextSnapshotStore, AgentToolExecutionStore, AgentToolAuditPort {
	constructor(private readonly rootDirectory: string) {}

	load(scope: AgentSessionScope): AgentSessionState {
		const session = this.readSession(scope);
		return session
			? { revision: session.revision, messages: structuredClone(session.messages) }
			: { revision: 0, messages: [] };
	}

	createSession(scope: AgentSessionScope, updatedAt: string): StoredAgentSession {
		this.save(scope, 0, [], updatedAt);
		return this.readSession(scope)!;
	}

	getSession(scope: AgentSessionScope): StoredAgentSession | undefined {
		return this.readSession(scope);
	}

	listSessions(scope: { tenantId: string; workspaceId: string }): StoredAgentSession[] {
		const tenantId = segment(scope.tenantId, "tenantId");
		const workspaceId = segment(scope.workspaceId, "workspaceId");
		const workspaceDirectory = join(this.rootDirectory, tenantId, workspaceId);
		if (!existsSync(workspaceDirectory)) return [];
		const sessions: StoredAgentSession[] = [];
		for (const run of readdirSync(workspaceDirectory, { withFileTypes: true })) {
			if (!run.isDirectory()) continue;
			const directory = join(workspaceDirectory, run.name, "sessions");
			if (!existsSync(directory)) continue;
			for (const entry of readdirSync(directory, { withFileTypes: true })) {
				if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
				const value = this.parseSession(this.readFile(join(directory, entry.name)));
				if (value.tenantId !== tenantId || value.workspaceId !== workspaceId || value.runId !== run.name) {
					throw new AgentStateStoreError("corrupt", "Agent Session path does not match its scope");
				}
				sessions.push(value);
			}
		}
		return sessions.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
	}

	save(
		scope: AgentSessionScope,
		expectedRevision: number,
		value: readonly AgentMessage[],
		updatedAt: string,
	): AgentSessionState {
		if (!Number.isInteger(expectedRevision) || expectedRevision < 0 || !messages(value)) {
			throw new AgentStateStoreError("unavailable", "Agent Session update is invalid");
		}
		const path = this.sessionPath(scope);
		return this.locked(path, () => {
			const current = this.load(scope);
			if (current.revision !== expectedRevision) {
				throw new AgentStateStoreError("conflict", "Agent Session revision changed");
			}
			const next: SessionFile = {
				schemaVersion: "agent-session.v1",
				...scope,
				revision: expectedRevision + 1,
				messages: structuredClone(value),
				updatedAt,
			};
			this.write(path, next);
			return { revision: next.revision, messages: structuredClone(next.messages) };
		});
	}

	put(snapshot: ContextSnapshotRecord): ContextSnapshotRecord {
		const path = this.snapshotPath(snapshot, snapshot.snapshotId);
		return this.locked(path, () => {
			if (existsSync(path)) {
				const existing = this.parseSnapshot(this.readFile(path), snapshot, snapshot.snapshotId);
				if (!equivalentSnapshot(existing, snapshot)) {
					throw new AgentStateStoreError("conflict", "Context Snapshot already exists with different content");
				}
				return existing;
			}
			this.parseSnapshot(snapshot, snapshot, snapshot.snapshotId);
			this.write(path, snapshot);
			return structuredClone(snapshot);
		});
	}

	read(scope: AgentSessionScope, snapshotId: string): ContextSnapshotRecord {
		const path = this.snapshotPath(scope, snapshotId);
		if (!existsSync(path)) throw new AgentStateStoreError("not_found", "Context Snapshot does not exist");
		return this.parseSnapshot(this.readFile(path), scope, snapshotId);
	}

	async claim(record: AgentToolExecutionRecord): Promise<{ record: AgentToolExecutionRecord; duplicate: boolean }> {
		if (!toolExecutionRecord(record) || record.status !== "started") {
			throw new AgentStateStoreError("unavailable", "Tool execution reservation is invalid");
		}
		const path = this.toolExecutionPath(record);
		return this.locked(path, () => {
			if (existsSync(path)) {
				return { record: this.parseToolExecution(this.readFile(path), record), duplicate: true };
			}
			this.write(path, record);
			return { record: structuredClone(record), duplicate: false };
		});
	}

	async complete(
		key: AgentToolExecutionKey,
		completion: Pick<AgentToolExecutionRecord, "status" | "result" | "resultDigest" | "failureCode" | "completedAt">,
	): Promise<AgentToolExecutionRecord> {
		const path = this.toolExecutionPath(key);
		return this.locked(path, () => {
			if (!existsSync(path)) throw new AgentStateStoreError("not_found", "Tool execution reservation does not exist");
			const existing = this.parseToolExecution(this.readFile(path), key);
			if (existing.status !== "started") return existing;
			const completed = { ...existing, ...completion };
			if (!toolExecutionRecord(completed) || completed.status === "started") {
				throw new AgentStateStoreError("unavailable", "Tool execution completion is invalid");
			}
			this.write(path, completed);
			return structuredClone(completed);
		});
	}

	async find(key: AgentToolExecutionKey): Promise<AgentToolExecutionRecord | undefined> {
		const path = this.toolExecutionPath(key);
		return existsSync(path) ? this.parseToolExecution(this.readFile(path), key) : undefined;
	}

	append(event: AgentToolAuditEvent): void {
		const path = this.toolAuditPath(event);
		const persisted = JSON.parse(JSON.stringify(event)) as AgentToolAuditEvent;
		this.locked(path, () => {
			if (existsSync(path)) {
				if (canonical(this.readFile(path)) !== canonical(persisted)) {
					throw new AgentStateStoreError("conflict", "Tool audit event identity conflict");
				}
				return;
			}
			this.write(path, persisted);
		});
	}

	private parseSnapshot(
		value: unknown,
		scope: AgentSessionScope,
		snapshotId: string,
	): ContextSnapshotRecord {
		if (
			!record(value) ||
			value.schemaVersion !== "context-snapshot.v2" ||
			!sameScope(value, scope) ||
			value.snapshotId !== snapshotId ||
			!Number.isInteger(value.iteration) ||
			Number(value.iteration) < 1 ||
			!Array.isArray(value.skills) ||
			!value.skills.every((skill) => record(skill) && typeof skill.name === "string" && typeof skill.version === "string") ||
			!messages(value.messages) ||
			!Number.isInteger(value.estimatedChars) ||
			Number(value.estimatedChars) < 0 ||
			!Number.isInteger(value.estimatedTokens) ||
			Number(value.estimatedTokens) < 0 ||
			!Number.isInteger(value.removedMessages) ||
			Number(value.removedMessages) < 0 ||
			typeof value.createdAt !== "string"
		) {
			throw new AgentStateStoreError("corrupt", "Context Snapshot file is invalid");
		}
		return structuredClone(value) as unknown as ContextSnapshotRecord;
	}

	private sessionPath(scope: AgentSessionScope): string {
		return join(this.scopeDirectory(scope), "sessions", `${segment(scope.sessionId, "sessionId")}.json`);
	}

	private readSession(scope: AgentSessionScope): StoredAgentSession | undefined {
		const path = this.sessionPath(scope);
		if (!existsSync(path)) return undefined;
		const session = this.parseSession(this.readFile(path));
		if (!sameScope(session, scope)) {
			throw new AgentStateStoreError("corrupt", "Agent Session scope does not match its path");
		}
		return session;
	}

	private parseSession(value: unknown): StoredAgentSession {
		if (
			!record(value) ||
			value.schemaVersion !== "agent-session.v1" ||
			![value.tenantId, value.workspaceId, value.runId, value.sessionId].every((field) => (
				typeof field === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(field)
			)) ||
			!Number.isInteger(value.revision) ||
			Number(value.revision) < 1 ||
			!messages(value.messages) ||
			typeof value.updatedAt !== "string" ||
			!Number.isFinite(Date.parse(value.updatedAt))
		) {
			throw new AgentStateStoreError("corrupt", "Agent Session file is invalid");
		}
		return {
			tenantId: value.tenantId as string,
			workspaceId: value.workspaceId as string,
			runId: value.runId as string,
			sessionId: value.sessionId as string,
			revision: Number(value.revision),
			messages: structuredClone(value.messages),
			updatedAt: value.updatedAt,
		};
	}

	private snapshotPath(scope: AgentSessionScope, snapshotId: string): string {
		return join(this.scopeDirectory(scope), "contexts", `${segment(snapshotId, "snapshotId")}.json`);
	}

	private toolExecutionPath(key: AgentToolExecutionKey): string {
		const digest = createHash("sha256")
			.update(canonical([key.tool, key.idempotencyKey]))
			.digest("hex");
		return join(
			this.rootDirectory,
			segment(key.tenantId, "tenantId"),
			segment(key.workspaceId, "workspaceId"),
			"tool-executions",
			`${digest}.json`,
		);
	}

	private toolAuditPath(event: AgentToolAuditEvent): string {
		const digest = createHash("sha256")
			.update(canonical([event.executionId, event.toolCallId, event.type]))
			.digest("hex");
		return join(
			this.rootDirectory,
			segment(event.tenantId, "tenantId"),
			segment(event.workspaceId, "workspaceId"),
			"tool-audit",
			`${digest}.json`,
		);
	}

	private scopeDirectory(scope: AgentSessionScope): string {
		return join(
			this.rootDirectory,
			segment(scope.tenantId, "tenantId"),
			segment(scope.workspaceId, "workspaceId"),
			segment(scope.runId, "runId"),
		);
	}

	private readFile(path: string): unknown {
		try {
			return JSON.parse(readFileSync(path, "utf8"));
		} catch (error) {
			throw new AgentStateStoreError("corrupt", "Agent State file cannot be read", { cause: error });
		}
	}

	private parseToolExecution(value: unknown, key: AgentToolExecutionKey): AgentToolExecutionRecord {
		if (
			!toolExecutionRecord(value) ||
			value.tenantId !== key.tenantId ||
			value.workspaceId !== key.workspaceId ||
			value.tool !== key.tool ||
			value.idempotencyKey !== key.idempotencyKey
		) {
			throw new AgentStateStoreError("corrupt", "Tool execution record is invalid");
		}
		return structuredClone(value);
	}

	private write(path: string, value: unknown): void {
		const directory = dirname(path);
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		const temporary = `${path}.${crypto.randomUUID()}.tmp`;
		try {
			writeFileSync(temporary, canonical(value), { encoding: "utf8", mode: 0o600 });
			renameSync(temporary, path);
			chmodSync(path, 0o600);
		} catch (error) {
			throw new AgentStateStoreError("unavailable", "Agent State file cannot be written", { cause: error });
		} finally {
			if (existsSync(temporary)) unlinkSync(temporary);
		}
	}

	private locked<T>(path: string, operation: () => T): T {
		const lock = `${path}.lock`;
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		try {
			mkdirSync(lock);
		} catch (error) {
			throw new AgentStateStoreError("unavailable", "Agent State is locked by another writer", { cause: error });
		}
		try {
			return operation();
		} finally {
			rmdirSync(lock);
		}
	}
}
