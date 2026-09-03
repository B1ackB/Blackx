import type { RuntimeHealth } from "./contracts";
import type { RuntimeTraceRecord } from "./contracts";
import type {
	BackgroundTaskView,
	ConversationSummary,
	ConversationView,
	CronScheduleView,
	ProposalWorkspaceView,
} from "./conversationContracts";

interface ErrorPayload {
	code?: string;
	message?: string;
}

export class ConversationClientError extends Error {
	constructor(readonly code: string, message: string) {
		super(message);
		this.name = "ConversationClientError";
	}
}

const identityHeaders = {
	"x-blackx-tenant-id": "local-user",
	"x-blackx-workspace-id": "default-workspace",
	"x-blackx-actor-id": "local-user",
};

async function request<Value>(path: string, init?: RequestInit): Promise<Value> {
	let response: Response;
	try {
		response = await fetch(path, {
			...init,
			headers: {
				...identityHeaders,
				...(init?.body ? { "content-type": "application/json" } : {}),
				...init?.headers,
			},
		});
	} catch (error) {
		throw new ConversationClientError("runtime_unavailable", "无法连接 Blackx 服务端");
	}
	if (!response.ok) {
		const payload = await response.json().catch(() => ({})) as ErrorPayload;
		throw new ConversationClientError(
			payload.code ?? "request_failed",
			payload.message ?? `请求失败（HTTP ${response.status}）`,
		);
	}
	return response.json() as Promise<Value>;
}

export class ConversationClient {
	health(): Promise<RuntimeHealth> {
		return request<RuntimeHealth>("/api/runtime/health");
	}

	async list(): Promise<ConversationSummary[]> {
		return (await request<{ conversations: ConversationSummary[] }>("/api/conversations")).conversations;
	}

	async create(): Promise<ConversationView> {
		return (await request<{ conversation: ConversationView }>("/api/conversations", {
			method: "POST",
		})).conversation;
	}

	async get(conversationId: string): Promise<ConversationView> {
		return (await request<{ conversation: ConversationView }>(
			`/api/conversations/${encodeURIComponent(conversationId)}`,
		)).conversation;
	}

	async listTraces(conversationId: string): Promise<RuntimeTraceRecord[]> {
		return (await request<{ traces: RuntimeTraceRecord[] }>(
			`/api/conversations/${encodeURIComponent(conversationId)}/traces`,
		)).traces;
	}

	async send(
		conversationId: string,
		message: { messageId: string; content: string },
	): Promise<ConversationView> {
		return (await request<{ conversation: ConversationView }>(
			`/api/conversations/${encodeURIComponent(conversationId)}/messages`,
			{ method: "POST", body: JSON.stringify(message) },
		)).conversation;
	}

	async createBackgroundTask(
		conversationId: string,
		message: { messageId: string; content: string },
	): Promise<BackgroundTaskView> {
		return (await request<{ task: BackgroundTaskView }>(
			`/api/conversations/${encodeURIComponent(conversationId)}/background-tasks`,
			{ method: "POST", body: JSON.stringify(message) },
		)).task;
	}

	async listBackgroundTasks(conversationId: string): Promise<BackgroundTaskView[]> {
		return (await request<{ tasks: BackgroundTaskView[] }>(
			`/api/conversations/${encodeURIComponent(conversationId)}/background-tasks`,
		)).tasks;
	}

	async getBackgroundTask(taskId: string): Promise<BackgroundTaskView> {
		return (await request<{ task: BackgroundTaskView }>(
			`/api/background-tasks/${encodeURIComponent(taskId)}`,
		)).task;
	}

	async listCronSchedules(conversationId: string): Promise<CronScheduleView[]> {
		return (await request<{ schedules: CronScheduleView[] }>(
			`/api/conversations/${encodeURIComponent(conversationId)}/cron-schedules`,
		)).schedules;
	}

	async getProposal(conversationId: string): Promise<ProposalWorkspaceView | null> {
		return (await request<{ proposal: ProposalWorkspaceView | null }>(
			`/api/conversations/${encodeURIComponent(conversationId)}/proposal`,
		)).proposal;
	}

	async startProposal(conversationId: string, requestId: string): Promise<ProposalWorkspaceView> {
		return (await request<{ proposal: ProposalWorkspaceView }>(
			`/api/conversations/${encodeURIComponent(conversationId)}/proposal`,
			{ method: "POST", body: JSON.stringify({ requestId }) },
		)).proposal;
	}

	async recordProposalFact(
		conversationId: string,
		requestId: string,
		fact: { key: string; value: string | number | boolean; unit?: string },
	): Promise<ProposalWorkspaceView> {
		return (await request<{ proposal: ProposalWorkspaceView }>(
			`/api/conversations/${encodeURIComponent(conversationId)}/proposal/facts`,
			{ method: "POST", body: JSON.stringify({ requestId, ...fact }) },
		)).proposal;
	}

	async resolveProposalFact(
		conversationId: string,
		factKey: string,
		requestId: string,
		decision: "verified" | "rejected",
	): Promise<ProposalWorkspaceView> {
		return (await request<{ proposal: ProposalWorkspaceView }>(
			`/api/conversations/${encodeURIComponent(conversationId)}/proposal/facts/${encodeURIComponent(factKey)}/decision`,
			{ method: "POST", body: JSON.stringify({ requestId, decision }) },
		)).proposal;
	}

	async resolveProposalApproval(
		conversationId: string,
		requestId: string,
		decision: "approved" | "rejected",
	): Promise<ProposalWorkspaceView> {
		return (await request<{ proposal: ProposalWorkspaceView }>(
			`/api/conversations/${encodeURIComponent(conversationId)}/proposal/approval`,
			{ method: "POST", body: JSON.stringify({ requestId, decision }) },
		)).proposal;
	}
}
