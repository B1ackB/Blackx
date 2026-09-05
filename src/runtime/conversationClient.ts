import type { RuntimeHealth } from "./contracts";
import type { RuntimeTraceRecord } from "./contracts";
import type {
	BackgroundTaskView,
	ConversationAttachment,
	ConversationSummary,
	ConversationView,
	CronScheduleView,
	ProposalWorkspaceView,
	RequirementBriefMetricsSeriesView,
	RequirementBriefWorkspaceView,
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
				...(typeof init?.body === "string" ? { "content-type": "application/json" } : {}),
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

async function attachmentRequest(path: string, init?: RequestInit): Promise<Response> {
	let response: Response;
	try {
		response = await fetch(path, {
			...init,
			headers: { ...identityHeaders, ...init?.headers },
		});
	} catch {
		throw new ConversationClientError("runtime_unavailable", "无法连接 Blackx 服务端");
	}
	if (!response.ok) {
		const payload = await response.json().catch(() => ({})) as ErrorPayload;
		throw new ConversationClientError(
			payload.code ?? "attachment_failed",
			payload.message ?? `附件请求失败（HTTP ${response.status}）`,
		);
	}
	return response;
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

	async listAttachments(conversationId: string): Promise<ConversationAttachment[]> {
		return (await request<{ attachments: ConversationAttachment[] }>(
			`/api/conversations/${encodeURIComponent(conversationId)}/attachments`,
		)).attachments;
	}

	async uploadAttachment(
		conversationId: string,
		requestId: string,
		file: File,
	): Promise<ConversationAttachment> {
		const query = new URLSearchParams({ requestId, name: file.name });
		const response = await attachmentRequest(
			`/api/conversations/${encodeURIComponent(conversationId)}/attachments?${query}`,
			{
				method: "POST",
				body: file,
				headers: { "content-type": file.type || "application/octet-stream" },
			},
		);
		return ((await response.json()) as { attachment: ConversationAttachment }).attachment;
	}

	async readAttachment(conversationId: string, attachmentId: string): Promise<Blob> {
		const response = await attachmentRequest(
			`/api/conversations/${encodeURIComponent(conversationId)}/attachments/${encodeURIComponent(attachmentId)}/content`,
		);
		return response.blob();
	}

	async listTraces(conversationId: string): Promise<RuntimeTraceRecord[]> {
		return (await request<{ traces: RuntimeTraceRecord[] }>(
			`/api/conversations/${encodeURIComponent(conversationId)}/traces`,
		)).traces;
	}

	async send(
		conversationId: string,
		message: { messageId: string; content: string; attachmentIds?: string[] },
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

	async getRequirementBrief(conversationId: string): Promise<RequirementBriefWorkspaceView | null> {
		return (await request<{ requirementBrief: RequirementBriefWorkspaceView | null }>(
			`/api/conversations/${encodeURIComponent(conversationId)}/requirement-brief`,
		)).requirementBrief;
	}

	async getRequirementBriefMetrics(): Promise<RequirementBriefMetricsSeriesView> {
		return (await request<{ requirementBriefMetrics: RequirementBriefMetricsSeriesView }>(
			"/api/requirement-brief/metrics",
		)).requirementBriefMetrics;
	}

	async startRequirementBrief(
		conversationId: string,
		requestId: string,
		industry: "print" | "furniture",
	): Promise<RequirementBriefWorkspaceView> {
		return (await request<{ requirementBrief: RequirementBriefWorkspaceView }>(
			`/api/conversations/${encodeURIComponent(conversationId)}/requirement-brief`,
			{ method: "POST", body: JSON.stringify({ requestId, industry }) },
		)).requirementBrief;
	}

	async recordRequirementFact(
		conversationId: string,
		requestId: string,
		fact: { key: string; value: string | number | boolean; unit?: string },
	): Promise<RequirementBriefWorkspaceView> {
		return (await request<{ requirementBrief: RequirementBriefWorkspaceView }>(
			`/api/conversations/${encodeURIComponent(conversationId)}/requirement-brief/facts`,
			{ method: "POST", body: JSON.stringify({ requestId, ...fact }) },
		)).requirementBrief;
	}

	async resolveRequirementFact(
		conversationId: string,
		factKey: string,
		requestId: string,
		decision: "verified" | "rejected",
	): Promise<RequirementBriefWorkspaceView> {
		return (await request<{ requirementBrief: RequirementBriefWorkspaceView }>(
			`/api/conversations/${encodeURIComponent(conversationId)}/requirement-brief/facts/${encodeURIComponent(factKey)}/decision`,
			{ method: "POST", body: JSON.stringify({ requestId, decision }) },
		)).requirementBrief;
	}

	async resolveRequirementApproval(
		conversationId: string,
		requestId: string,
		decision: "approved" | "rejected",
	): Promise<RequirementBriefWorkspaceView> {
		return (await request<{ requirementBrief: RequirementBriefWorkspaceView }>(
			`/api/conversations/${encodeURIComponent(conversationId)}/requirement-brief/approval`,
			{ method: "POST", body: JSON.stringify({ requestId, decision }) },
		)).requirementBrief;
	}

	async cancelRequirementBrief(
		conversationId: string,
		requestId: string,
	): Promise<RequirementBriefWorkspaceView> {
		return (await request<{ requirementBrief: RequirementBriefWorkspaceView }>(
			`/api/conversations/${encodeURIComponent(conversationId)}/requirement-brief/cancel`,
			{ method: "POST", body: JSON.stringify({ requestId }) },
		)).requirementBrief;
	}
}
