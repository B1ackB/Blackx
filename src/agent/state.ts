import type {
	AgentMessage,
	AgentToolExecutionKey,
	AgentToolExecutionRecord,
	AgentToolExecutionStore,
} from "./contracts";
import type { RuntimeTraceRecord, RuntimeTraceStore } from "../runtime/contracts";

export interface AgentSessionScope {
	tenantId: string;
	workspaceId: string;
	runId: string;
	sessionId: string;
}

export interface AgentSessionState {
	revision: number;
	messages: AgentMessage[];
}

export interface ContextSnapshotRecord extends AgentSessionScope {
	schemaVersion: "context-snapshot.v2";
	snapshotId: string;
	iteration: number;
	skills: Array<{ name: string; version: string }>;
	messages: AgentMessage[];
	estimatedChars: number;
	estimatedTokens: number;
	removedMessages: number;
	createdAt: string;
}

export interface AgentSessionStore {
	load(scope: AgentSessionScope): AgentSessionState;
	save(
		scope: AgentSessionScope,
		expectedRevision: number,
		messages: readonly AgentMessage[],
		updatedAt: string,
	): AgentSessionState;
}

export interface ContextSnapshotStore {
	put(snapshot: ContextSnapshotRecord): ContextSnapshotRecord;
	read(scope: AgentSessionScope, snapshotId: string): ContextSnapshotRecord;
}

export class AgentStateStoreError extends Error {
	constructor(
		readonly code: "not_found" | "conflict" | "corrupt" | "unavailable",
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "AgentStateStoreError";
	}
}

function key(scope: AgentSessionScope): string {
	return JSON.stringify([scope.tenantId, scope.workspaceId, scope.runId, scope.sessionId]);
}

function cloneMessages(messages: readonly AgentMessage[]): AgentMessage[] {
	return messages.map((message) => ({
		...message,
		attachments: message.attachments?.map((attachment) => ({ ...attachment })),
		toolCalls: message.toolCalls?.map((call) => ({ ...call })),
		...(message.providerState === undefined
			? {}
			: { providerState: structuredClone(message.providerState) }),
	}));
}

function snapshotKey(scope: AgentSessionScope, snapshotId: string): string {
	return `${key(scope)}\n${snapshotId}`;
}

function equivalentSnapshot(left: ContextSnapshotRecord, right: ContextSnapshotRecord): boolean {
	const { createdAt: _leftCreatedAt, ...leftComparable } = left;
	const { createdAt: _rightCreatedAt, ...rightComparable } = right;
	return JSON.stringify(leftComparable) === JSON.stringify(rightComparable);
}

function toolExecutionKey(key: AgentToolExecutionKey): string {
	return JSON.stringify([key.tenantId, key.workspaceId, key.tool, key.idempotencyKey]);
}

export class InMemoryAgentStateStore implements AgentSessionStore, ContextSnapshotStore, AgentToolExecutionStore, RuntimeTraceStore {
	private readonly sessions = new Map<string, AgentSessionState>();
	private readonly snapshots = new Map<string, ContextSnapshotRecord>();
	private readonly toolExecutions = new Map<string, AgentToolExecutionRecord>();
	private readonly traces = new Map<string, RuntimeTraceRecord>();

	putTrace(trace: RuntimeTraceRecord): RuntimeTraceRecord {
		const key = JSON.stringify([trace.tenantId, trace.workspaceId, trace.runId, trace.executionId]);
		const existing = this.traces.get(key);
		if (existing && JSON.stringify(existing) !== JSON.stringify(trace)) {
			throw new AgentStateStoreError("conflict", "Runtime Trace identity conflict");
		}
		this.traces.set(key, structuredClone(trace));
		return structuredClone(trace);
	}

	listTraces(scope: { tenantId: string; workspaceId: string; runId: string }): RuntimeTraceRecord[] {
		return [...this.traces.values()]
			.filter((trace) => trace.tenantId === scope.tenantId && trace.workspaceId === scope.workspaceId && trace.runId === scope.runId)
			.sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt))
			.map((trace) => structuredClone(trace));
	}

	load(scope: AgentSessionScope): AgentSessionState {
		const state = this.sessions.get(key(scope));
		return state
			? { revision: state.revision, messages: cloneMessages(state.messages) }
			: { revision: 0, messages: [] };
	}

	save(
		scope: AgentSessionScope,
		expectedRevision: number,
		messages: readonly AgentMessage[],
		_updatedAt: string,
	): AgentSessionState {
		const current = this.load(scope);
		if (current.revision !== expectedRevision) {
			throw new AgentStateStoreError("conflict", "Agent Session revision changed");
		}
		const next = { revision: expectedRevision + 1, messages: cloneMessages(messages) };
		this.sessions.set(key(scope), next);
		return this.load(scope);
	}

	put(snapshot: ContextSnapshotRecord): ContextSnapshotRecord {
		const recordKey = snapshotKey(snapshot, snapshot.snapshotId);
		const existing = this.snapshots.get(recordKey);
		if (existing) {
			if (!equivalentSnapshot(existing, snapshot)) {
				throw new AgentStateStoreError("conflict", "Context Snapshot already exists with different content");
			}
			return structuredClone(existing);
		}
		this.snapshots.set(recordKey, structuredClone(snapshot));
		return structuredClone(snapshot);
	}

	read(scope: AgentSessionScope, snapshotId: string): ContextSnapshotRecord {
		const snapshot = this.snapshots.get(snapshotKey(scope, snapshotId));
		if (!snapshot) throw new AgentStateStoreError("not_found", "Context Snapshot does not exist");
		return structuredClone(snapshot);
	}

	async claim(record: AgentToolExecutionRecord): Promise<{ record: AgentToolExecutionRecord; duplicate: boolean }> {
		const key = toolExecutionKey(record);
		const existing = this.toolExecutions.get(key);
		if (existing) return { record: structuredClone(existing), duplicate: true };
		this.toolExecutions.set(key, structuredClone(record));
		return { record: structuredClone(record), duplicate: false };
	}

	async complete(
		key: AgentToolExecutionKey,
		completion: Pick<AgentToolExecutionRecord, "status" | "result" | "resultDigest" | "failureCode" | "completedAt">,
	): Promise<AgentToolExecutionRecord> {
		const recordKey = toolExecutionKey(key);
		const existing = this.toolExecutions.get(recordKey);
		if (!existing) throw new AgentStateStoreError("not_found", "Tool execution reservation does not exist");
		if (existing.status !== "started") return structuredClone(existing);
		const completed = { ...existing, ...completion };
		this.toolExecutions.set(recordKey, structuredClone(completed));
		return structuredClone(completed);
	}

	async find(key: AgentToolExecutionKey): Promise<AgentToolExecutionRecord | undefined> {
		const record = this.toolExecutions.get(toolExecutionKey(key));
		return record ? structuredClone(record) : undefined;
	}
}
