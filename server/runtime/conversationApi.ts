import type { AgentMessage } from "../../src/agent/contracts";
import type { AgentRuntimePort, RuntimeFailureCode } from "../../src/runtime/contracts";
import { RuntimeFailure } from "../../src/runtime/contracts";
import type {
	ConversationMessage,
	ConversationSummary,
	ConversationView,
} from "../../src/runtime/conversationContracts";
import { AgentStateStoreError, type AgentSessionScope } from "../../src/agent/state";
import { FileAgentStateStore, type StoredAgentSession } from "./fileAgentStateStore";
import { FileConversationAttachmentStore } from "./conversationAttachments";

export interface ConversationApiContext {
	tenantId?: string;
	workspaceId?: string;
	actorId?: string;
}

export interface ConversationApiResponse {
	status: number;
	body: unknown;
}

class ConversationValidationError extends Error {}

function id(value: unknown, name: string): string {
	if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
		throw new ConversationValidationError(`${name} is invalid`);
	}
	return value;
}

function text(value: unknown): string {
	if (typeof value !== "string" || value.length > 32_000) {
		throw new ConversationValidationError("message content is invalid");
	}
	return value.trim();
}

function record(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function visibleMessages(session: StoredAgentSession): ConversationMessage[] {
	return session.messages.flatMap((message, index) => {
		if (message.role !== "user" && message.role !== "assistant") return [];
		if (message.durable || message.toolCalls?.length || (!message.content.trim() && !message.attachments?.length)) return [];
		return [{
			messageId: message.messageId ?? `${session.sessionId}-message-${index + 1}`,
			role: message.role,
			content: message.content,
			createdAt: message.createdAt ?? session.updatedAt,
			attachments: message.attachments?.map((attachment) => ({
				name: attachment.name,
				mediaType: attachment.mediaType,
				sourceRef: attachment.sourceRef,
			})),
		}];
	});
}

function title(messages: readonly ConversationMessage[]): string {
	const first = messages.find((message) => message.role === "user");
	const value = first?.content.replace(/\s+/g, " ") || first?.attachments?.[0]?.name;
	return value ? `${value.slice(0, 30)}${value.length > 30 ? "…" : ""}` : "新会话";
}

function view(session: StoredAgentSession): ConversationView {
	const messages = visibleMessages(session);
	const latest = messages.at(-1);
	const last = latest?.content.replace(/\s+/g, " ") || latest?.attachments?.map((attachment) => attachment.name).join("、") || "尚未发送消息";
	return {
		conversationId: session.sessionId,
		title: title(messages),
		preview: `${last.slice(0, 48)}${last.length > 48 ? "…" : ""}`,
		updatedAt: session.updatedAt,
		revision: session.revision,
		messages,
	};
}

function scope(context: ConversationApiContext, conversationId: unknown): AgentSessionScope {
	const tenantId = id(context.tenantId, "tenantId");
	const workspaceId = id(context.workspaceId, "workspaceId");
	const sessionId = id(conversationId, "conversationId");
	return { tenantId, workspaceId, runId: sessionId, sessionId };
}

function failureStatus(code: RuntimeFailureCode): number {
	if (code === "authentication") return 401;
	if (code === "rate_limit") return 429;
	if (code === "invalid_output" || code === "permission_denied") return 400;
	return 502;
}

export class ConversationApiController {
	private readonly activeTurns = new Set<string>();

	constructor(
		private readonly runtime: AgentRuntimePort,
		private readonly sessions: FileAgentStateStore,
		private readonly now: () => string = () => new Date().toISOString(),
		private readonly nextId: () => string = () => crypto.randomUUID(),
		private readonly allowedTools: readonly string[] = [],
		private readonly attachments?: FileConversationAttachmentStore,
	) {}

	list(context: ConversationApiContext): ConversationApiResponse {
		try {
			const tenantId = id(context.tenantId, "tenantId");
			const workspaceId = id(context.workspaceId, "workspaceId");
			const conversations: ConversationSummary[] = this.sessions
				.listSessions({ tenantId, workspaceId })
				.filter((session) => session.sessionId.startsWith("conversation-") && session.runId === session.sessionId)
				.map((session) => {
					const conversation = view(session);
					return {
						conversationId: conversation.conversationId,
						title: conversation.title,
						preview: conversation.preview,
						updatedAt: conversation.updatedAt,
						messageCount: conversation.messages.length,
					};
				});
			return { status: 200, body: { conversations } };
		} catch (error) {
			return this.failure(error, "conversation_list_failed");
		}
	}

	create(context: ConversationApiContext): ConversationApiResponse {
		try {
			const conversationId = `conversation-${this.nextId()}`;
			const created = this.sessions.createSession(scope(context, conversationId), this.now());
			return { status: 201, body: { conversation: view(created) } };
		} catch (error) {
			return this.failure(error, "conversation_create_failed");
		}
	}

	get(context: ConversationApiContext, conversationId: unknown): ConversationApiResponse {
		try {
			const session = this.sessions.getSession(scope(context, conversationId));
			return session
				? { status: 200, body: { conversation: view(session) } }
				: { status: 404, body: { code: "conversation_not_found" } };
		} catch (error) {
			return this.failure(error, "conversation_read_failed");
		}
	}

	traces(context: ConversationApiContext, conversationId: unknown): ConversationApiResponse {
		try {
			const target = scope(context, conversationId);
			if (!this.sessions.getSession(target)) {
				return { status: 404, body: { code: "conversation_not_found" } };
			}
			return { status: 200, body: { traces: this.sessions.listTraces(target) } };
		} catch (error) {
			return this.failure(error, "runtime_trace_list_failed");
		}
	}

	async send(
		context: ConversationApiContext,
		conversationId: unknown,
		payload: unknown,
		options: { retryIncomplete?: boolean } = {},
	): Promise<ConversationApiResponse> {
		let activeKey: string | undefined;
		try {
			if (!record(payload)) throw new ConversationValidationError("message payload must be an object");
			const target = scope(context, conversationId);
			const actorId = id(context.actorId, "actorId");
			const messageId = id(payload.messageId, "messageId");
			const content = text(payload.content);
			if (
				payload.attachmentIds !== undefined &&
				(!Array.isArray(payload.attachmentIds) ||
					payload.attachmentIds.length > 8 ||
					payload.attachmentIds.some((attachmentId) => typeof attachmentId !== "string"))
			) {
				throw new ConversationValidationError("attachmentIds are invalid");
			}
			const attachmentIds = [...new Set((payload.attachmentIds ?? []) as string[])];
			if (!content && attachmentIds.length === 0) {
				throw new ConversationValidationError("message content or an image attachment is required");
			}
			if (attachmentIds.length && !this.attachments) {
				throw new ConversationValidationError("conversation attachments are unavailable");
			}
			const imageAttachments = this.attachments?.imageReferences({
				tenantId: target.tenantId,
				workspaceId: target.workspaceId,
				conversationId: target.sessionId,
			}, attachmentIds) ?? [];
			if (imageAttachments.length !== attachmentIds.length) {
				throw new ConversationValidationError("only model-ready image attachments can be sent to the model");
			}
			const health = await this.runtime.health();
			if (health.adapter !== "blackx-agent") {
				return { status: 503, body: { code: "real_provider_required" } };
			}
			const existing = this.sessions.getSession(target);
			if (!existing) return { status: 404, body: { code: "conversation_not_found" } };
			const userIndex = existing.messages.findIndex((message) => message.messageId === messageId);
			if (userIndex >= 0) {
				if (
					existing.messages[userIndex]?.content !== content ||
					JSON.stringify(existing.messages[userIndex]?.attachments ?? []) !== JSON.stringify(imageAttachments)
				) {
					return { status: 409, body: { code: "message_conflict" } };
				}
				const completed = existing.messages.slice(userIndex + 1).some((message) => message.role === "assistant");
				if (completed) return { status: 200, body: { conversation: view(existing), duplicate: true } };
				if (!options.retryIncomplete) return { status: 409, body: { code: "turn_incomplete" } };
			}
			activeKey = `${target.tenantId}\u0000${target.workspaceId}\u0000${target.sessionId}`;
			if (this.activeTurns.has(activeKey)) {
				return { status: 409, body: { code: "turn_in_progress" } };
			}
			this.activeTurns.add(activeKey);
			if (userIndex < 0) {
				const createdAt = this.now();
				const userMessage: AgentMessage = {
					role: "user",
					content,
					messageId,
					createdAt,
					pinned: true,
					attachments: imageAttachments,
				};
				this.sessions.save(target, existing.revision, [...existing.messages, userMessage], createdAt);
			}
			const result = await this.runtime.executeTurn({
				tenantId: target.tenantId,
				workspaceId: target.workspaceId,
				runId: target.runId,
				stageId: "conversation",
				actorId,
				idempotencyKey: messageId,
				sessionId: target.sessionId,
				resume: true,
				instructions: [
					"直接回答用户当前消息；信息不足时只问最必要的问题。",
					"不得把模型建议、未知参数或用户未确认的内容声明为权威事实。",
					"如果任务适合异步完成，可自主调用 background_task_create；如果用户明确要求重复执行，可调用 cron_create。创建前必须确认目标、时区、频率和有限 maxRuns，不得创建任意脚本任务。",
				],
				skills: ["blackx-print-conversation"],
				allowedTools: [...this.allowedTools],
				input: "",
				fallbackOutput: "暂时无法生成回复，请稍后重试。",
				policy: {
					sandboxMode: this.allowedTools.length ? "workspace-write" : "read-only",
					approvalPolicy: this.allowedTools.length ? "required" : "never",
					timeoutMs: 120_000,
				},
			});
			const updated = this.sessions.getSession(target);
			if (!updated) throw new AgentStateStoreError("not_found", "Agent Session disappeared after the turn");
			return {
				status: 200,
				body: {
					conversation: view(updated),
					execution: {
						executionId: result.executionId,
						contextSnapshotId: result.contextSnapshotId,
						status: result.status,
					},
				},
			};
		} catch (error) {
			return this.failure(error, "conversation_turn_failed");
		} finally {
			if (activeKey) this.activeTurns.delete(activeKey);
		}
	}

	private failure(error: unknown, fallbackCode: string): ConversationApiResponse {
		if (error instanceof ConversationValidationError) {
			return { status: 400, body: { code: "invalid_conversation_request", message: error.message } };
		}
		if (error instanceof RuntimeFailure) {
			return {
				status: failureStatus(error.code),
				body: { code: error.code, message: error.message, retryable: error.retryable },
			};
		}
		if (error instanceof AgentStateStoreError) {
			return {
				status: error.code === "conflict" ? 409 : error.code === "not_found" ? 404 : 503,
				body: { code: error.code, message: error.message },
			};
		}
		return { status: 500, body: { code: fallbackCode } };
	}
}
