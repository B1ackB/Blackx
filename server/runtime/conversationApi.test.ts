import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentModelProvider } from "../../src/agent/contracts";
import { SkillRegistry } from "../../src/agent/skills";
import { printSkills } from "../../src/print/skills";
import type { ConversationView } from "../../src/runtime/conversationContracts";
import { BlackxAgentRuntime } from "./agentRuntime";
import { ConversationApiController } from "./conversationApi";
import { FileConversationAttachmentStore } from "./conversationAttachments";
import { FakeAgentRuntime } from "./fakeAgentRuntime";
import { FileAgentStateStore } from "./fileAgentStateStore";

const directories: string[] = [];
const context = {
	tenantId: "tenant-conversation",
	workspaceId: "workspace-conversation",
	actorId: "user-conversation",
};

function state(): FileAgentStateStore {
	const directory = mkdtempSync(join(tmpdir(), "blackx-conversations-"));
	directories.push(directory);
	return new FileAgentStateStore(directory);
}

function conversation(response: { body: unknown }): ConversationView {
	return (response.body as { conversation: ConversationView }).conversation;
}

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("ConversationApiController", () => {
	it("deletes an active turn without letting a late provider response restore it", async () => {
		const sessions = state();
		let started!: () => void; let release!: () => void;
		const entered = new Promise<void>((resolve) => { started = resolve; });
		const late = new Promise<void>((resolve) => { release = resolve; });
		const runtime = new BlackxAgentRuntime({ sessions, snapshots: sessions, skills: new SkillRegistry(), provider: { async generate() {
			started(); await late;
			return { text: "late reply", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, reasoningOutputTokens: 0 } };
		} } });
		const api = new ConversationApiController(runtime, sessions);
		const id = conversation(api.create(context)).conversationId;
		const pending = api.send(context, id, { messageId: "delete-race", content: "slow" });
		await entered;
		let cleanups = 0;
		const cleanup = () => { cleanups++; };
		expect(api.delete({ ...context, workspaceId: "other" }, id, cleanup).status).toBe(404);
		expect(cleanups).toBe(0);
		const deleted = api.delete(context, id, cleanup);
		expect(deleted.status).toBe(200);
		expect(await pending).toMatchObject({ body: { code: "cancelled" } });
		expect((await runtime.health()).providerStatus).toBe("configured");
		release();
		expect(api.delete(context, id, cleanup)).toEqual(deleted);
		expect(api.get(context, id).status).toBe(404);
		expect(api.traces(context, id).status).toBe(404);
		expect(api.list(context).body).toEqual({ conversations: [] });
		expect(await api.send(context, id, { messageId: "after-delete", content: "restart" })).toMatchObject({ status: 404 });
		expect(sessions.listSessions(context, true)[0].messages.some((message) => message.content === "late reply")).toBe(false);
	});

	it("keeps deletion intent when cleanup fails and retries cleanup with the original audit attribution", () => {
		const sessions = state();
		const api = new ConversationApiController(new FakeAgentRuntime(), sessions);
		const id = conversation(api.create(context)).conversationId;
		expect(api.delete(context, id, () => { throw new Error("queue unavailable"); })).toMatchObject({ status: 503, body: { code: "conversation_cleanup_pending" } });
		expect(api.get(context, id).status).toBe(404);
		let actor: string | undefined;
		expect(api.delete({ ...context, actorId: "retry-user" }, id, (session) => { actor = session.deletion?.actorId; }).status).toBe(200);
		expect(actor).toBe(context.actorId);
	});

	it("resumes a saved tool checkpoint instead of treating tool calls as a final reply", async () => {
		const sessions = state(); let calls = 0;
		const runtime = new BlackxAgentRuntime({ provider: { async generate() { calls++; return { text: "工具阶段之后的最终回复", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, reasoningOutputTokens: 0 } }; } }, skills: new SkillRegistry(), sessions, snapshots: sessions });
		const controller = new ConversationApiController(runtime, sessions);
		const id = conversation(controller.create(context)).conversationId;
		const target = { ...context, runId: id, sessionId: id };
		sessions.save(target, sessions.getSession(target)!.revision, [
			{ role: "user", content: "继续任务", messageId: "paused-user", pinned: true },
			{ role: "assistant", content: "读取资料", toolCalls: [{ id: "paused-tool", name: "source_read", input: {} }] },
			{ role: "tool", content: "已读取的资料", toolCallId: "paused-tool" },
		], new Date().toISOString());
		expect(await controller.retry(context, id)).toMatchObject({ status: 200 });
		expect(calls).toBe(1);
		expect(conversation(controller.get(context, id)).messages.at(-1)?.content).toBe("工具阶段之后的最终回复");
	});

	it("keeps the active turn owned during conflicting requests, cancels it, and retries one saved message", async () => {
		const sessions = state();
		let started!: () => void; let release!: () => void; let count = 0;
		const entered = new Promise<void>((resolve) => { started = resolve; });
		const late = new Promise<void>((resolve) => { release = resolve; });
		const provider: AgentModelProvider = { async generate() {
			count += 1;
			if (count === 1) { started(); await late; }
			return { text: "已完成", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, reasoningOutputTokens: 0 } };
		} };
		const runtime = new BlackxAgentRuntime({ provider, skills: new SkillRegistry(), sessions, snapshots: sessions, traces: sessions });
		const controller = new ConversationApiController(runtime, sessions);
		const id = conversation(controller.create(context)).conversationId;
		const pending = controller.send(context, id, { messageId: "first", content: "继续任务" });
		await entered;
		for (const messageId of ["conflict-1", "conflict-2"]) expect(await controller.send(context, id, { messageId, content: "重复请求" })).toMatchObject({ status: 409, body: { code: "turn_in_progress" } });
		expect(controller.cancel({ ...context, tenantId: "other" }, id).status).toBe(404);
		expect(controller.cancel(context, id)).toMatchObject({ status: 200, body: { stopped: true } });
		expect(await pending).toMatchObject({ body: { code: "cancelled" } });
		release();
		expect(conversation(controller.get(context, id)).messages).toHaveLength(1);
		expect(await controller.retry(context, id)).toMatchObject({ status: 200 });
		expect(conversation(controller.get(context, id)).messages.map((message) => message.content)).toEqual(["继续任务", "已完成"]);
		expect(await controller.retry(context, id)).toMatchObject({ status: 200, body: { duplicate: true } });
		expect(count).toBe(2);
	});

	it("creates, lists, and selects server-persisted conversations within a tenant", () => {
		const sessions = state();
		const controller = new ConversationApiController(
			new FakeAgentRuntime({ sessions, snapshots: sessions }),
			sessions,
			() => "2026-09-03T00:00:00.000Z",
			() => "conversation-a",
		);
		const created = controller.create(context);

		expect(created).toMatchObject({
			status: 201,
			body: { conversation: { title: "新会话", messages: [] } },
		});
		const conversationId = conversation(created).conversationId;
		expect(controller.list(context)).toMatchObject({
			status: 200,
			body: { conversations: [{ conversationId, messageCount: 0 }] },
		});
		expect(controller.get(context, conversationId)).toMatchObject({ status: 200 });
		expect(controller.get({ ...context, tenantId: "tenant-other" }, conversationId)).toEqual({
			status: 404,
			body: { code: "conversation_not_found" },
		});
	});

	it("uses the requested language for an empty conversation title", () => {
		const sessions = state();
		const controller = new ConversationApiController(new FakeAgentRuntime(), sessions);

		expect(controller.create(context, "en")).toMatchObject({
			status: 201,
			body: { conversation: { title: "New conversation", preview: "No messages yet" } },
		});
		expect(controller.create(context, "zh")).toMatchObject({
			status: 201,
			body: { conversation: { title: "新会话" } },
		});
	});

	it("requires an English reply for an English user message", async () => {
		const sessions = state();
		let systemPrompt = "";
		let fallbackOutput = "";
		const runtime = new BlackxAgentRuntime({
			provider: {
				async generate(request) {
					systemPrompt = request.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n");
					fallbackOutput = request.fallbackOutput;
					return { text: "I can help you confirm the packaging requirements.", toolCalls: [], usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0 } };
				},
			},
			skills: new SkillRegistry(),
			sessions,
			snapshots: sessions,
		});
		const controller = new ConversationApiController(runtime, sessions);
		const conversationId = conversation(controller.create(context)).conversationId;

		const response = await controller.send(context, conversationId, {
			messageId: "english-message",
			content: "I need packaging for coffee beans. What details do you need?",
		});

		expect(response).toMatchObject({ status: 200 });
		expect(systemPrompt).toContain("The user's latest message is in English.");
		expect(systemPrompt).toContain("Do not switch to Chinese");
		expect(fallbackOutput).toContain("I’m unable to generate a reply");
	});

	it("keeps internal Agent Sessions out of the user conversation list", () => {
		const sessions = state();
		const controller = new ConversationApiController(
			new FakeAgentRuntime({ sessions, snapshots: sessions }),
			sessions,
			() => "2026-09-03T00:00:00.000Z",
			() => "conversation-visible",
		);
		controller.create(context);
		sessions.createSession({
			tenantId: context.tenantId,
			workspaceId: context.workspaceId,
			runId: "proposal-run",
			sessionId: "proposal-session",
		}, "2026-09-03T00:01:00.000Z");

		expect(controller.list(context)).toMatchObject({
			status: 200,
			body: {
				conversations: [{ conversationId: "conversation-conversation-visible" }],
			},
		});
	});

	it("keeps internal Tool calls and durable receipts out of the chat projection", () => {
		const sessions = state();
		const controller = new ConversationApiController(
			new FakeAgentRuntime({ sessions, snapshots: sessions }),
			sessions,
			undefined,
			() => "conversation-internal-messages",
		);
		const conversationId = conversation(controller.create(context)).conversationId;
		const target = { ...context, runId: conversationId, sessionId: conversationId };
		sessions.save(target, 1, [
			{ role: "user", content: "创建定时任务", messageId: "message-visible" },
			{ role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "cron_create", input: {} }] },
			{ role: "tool", content: "{\"ok\":true}", toolCallId: "call-1" },
			{ role: "user", content: "internal receipt", durable: true },
			{ role: "assistant", content: "定时任务已经创建" },
		], "2026-09-03T00:00:00.000Z");

		expect(conversation(controller.get(context, conversationId)).messages.map((message) => message.content))
			.toEqual(["创建定时任务", "定时任务已经创建"]);
	});

	it("persists the user message before waiting and resumes the same model Session", async () => {
		const sessions = state();
		let generateCount = 0;
		let release!: () => void;
		const started = new Promise<void>((resolve) => {
			release = resolve;
		});
		let unblock!: () => void;
		const blocked = new Promise<void>((resolve) => {
			unblock = resolve;
		});
		const provider: AgentModelProvider = {
			async generate() {
				generateCount += 1;
				release();
				await blocked;
				return {
					text: generateCount === 1 ? "第一轮真实回复" : "第二轮真实回复",
					toolCalls: [],
					usage: { inputTokens: 2, cachedInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0 },
				};
			},
		};
		const runtime = new BlackxAgentRuntime({
			provider,
			skills: new SkillRegistry(printSkills),
			sessions,
			snapshots: sessions,
			traces: sessions,
		});
		const controller = new ConversationApiController(
			runtime,
			sessions,
			() => "2026-09-03T00:00:00.000Z",
			() => "conversation-b",
		);
		const conversationId = conversation(controller.create(context)).conversationId;
		const pending = controller.send(context, conversationId, {
			messageId: "message-1",
			content: "第一轮问题",
		});
		await started;

		expect(sessions.getSession({
			...context,
			runId: conversationId,
			sessionId: conversationId,
		})?.messages).toMatchObject([{ role: "user", content: "第一轮问题", messageId: "message-1" }]);
		unblock();
		const completed = await pending;
		expect(completed).toMatchObject({ status: 200 });
		expect(conversation(completed).messages.map((message) => message.content)).toEqual([
			"第一轮问题",
			"第一轮真实回复",
		]);
		expect(controller.list(context)).toMatchObject({
			body: { conversations: [{ title: "第一轮问题", messageCount: 2 }] },
		});
		expect(controller.traces(context, conversationId)).toMatchObject({
			status: 200,
			body: {
				traces: [{
					status: "completed",
					usage: { inputTokens: 2, outputTokens: 2 },
					events: expect.arrayContaining([
						expect.objectContaining({ type: "model.completed" }),
						expect.objectContaining({ type: "message.completed", text: "[stored in session]" }),
					]),
				}],
			},
		});

		const duplicate = await controller.send(context, conversationId, {
			messageId: "message-1",
			content: "第一轮问题",
		});
		expect(duplicate).toMatchObject({ status: 200, body: { duplicate: true } });
		expect(generateCount).toBe(1);

		const second = await controller.send(context, conversationId, {
			messageId: "message-2",
			content: "第二轮问题",
		});
		expect(conversation(second).messages.map((message) => message.content)).toEqual([
			"第一轮问题",
			"第一轮真实回复",
			"第二轮问题",
			"第二轮真实回复",
		]);
		expect(generateCount).toBe(2);
	});

	it("sends selected images as native model input without persisting Base64", async () => {
		const sessions = state();
		const attachmentDirectory = mkdtempSync(join(tmpdir(), "blackx-conversation-images-"));
		directories.push(attachmentDirectory);
		const attachments = new FileConversationAttachmentStore(attachmentDirectory);
		let receivedData: string | undefined;
		const provider: AgentModelProvider = {
			async generate(modelRequest) {
				receivedData = modelRequest.messages
					.flatMap((message) => message.attachments ?? [])
					.at(-1)?.data;
				return {
					text: "我看到了参考图。",
					toolCalls: [],
					usage: { inputTokens: 2, cachedInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0 },
				};
			},
		};
		const runtime = new BlackxAgentRuntime({
			provider,
			skills: new SkillRegistry(printSkills),
			sessions,
			snapshots: sessions,
			traces: sessions,
			resolveImageAttachment: async (scope, attachment) => attachments.resolveImage(scope, attachment),
		});
		const controller = new ConversationApiController(
			runtime,
			sessions,
			undefined,
			() => "conversation-image",
			[],
			attachments,
		);
		const conversationId = conversation(controller.create(context)).conversationId;
		const uploaded = attachments.put({
			tenantId: context.tenantId,
			workspaceId: context.workspaceId,
			conversationId,
		}, {
			requestId: "upload-image",
			name: "reference.png",
			mediaType: "image/png",
			content: Buffer.from("image-bytes"),
		}).attachment;

		const response = await controller.send(context, conversationId, {
			messageId: "message-image",
			content: "",
			attachmentIds: [uploaded.attachmentId],
		});

		expect(response.status).toBe(200);
		expect(receivedData).toBe(Buffer.from("image-bytes").toString("base64"));
		expect(conversation(response).messages[0]).toMatchObject({
			role: "user",
			content: "",
			attachments: [{ name: "reference.png", mediaType: "image/png" }],
		});
		const stored = sessions.getSession({
			...context,
			runId: conversationId,
			sessionId: conversationId,
		});
		expect(stored?.messages.flatMap((message) => message.attachments ?? []).every((attachment) => attachment.data === undefined)).toBe(true);
		const trace = (controller.traces(context, conversationId).body as {
			traces: Array<{ events: Array<{ type: string; count?: number; snapshotId?: string }> }>;
		}).traces[0];
		expect(trace.events).toContainEqual({ type: "input.attachments.resolved", count: 1 });
		const snapshotId = trace.events.find((event) => event.type === "context.snapshot.saved")?.snapshotId;
		expect(snapshotId).toBeDefined();
		const snapshot = sessions.read({
			...context,
			runId: conversationId,
			sessionId: conversationId,
		}, snapshotId!);
		expect(snapshot.messages.flatMap((message) => message.attachments ?? []).every((attachment) => attachment.data === undefined)).toBe(true);
		expect(JSON.stringify(snapshot)).not.toContain(Buffer.from("image-bytes").toString("base64"));
	});

	it("refuses conversation turns when the server is running the Fake adapter", async () => {
		const sessions = state();
		const controller = new ConversationApiController(
			new FakeAgentRuntime({ sessions, snapshots: sessions }),
			sessions,
			undefined,
			() => "conversation-c",
		);
		const conversationId = conversation(controller.create(context)).conversationId;

		expect(await controller.send(context, conversationId, {
			messageId: "message-fake",
			content: "不要使用 Fake",
		})).toEqual({ status: 503, body: { code: "real_provider_required" } });
	});

	it("replays an incomplete persisted turn after a worker crash without duplicating the user message", async () => {
		const sessions = state();
		let attempts = 0;
		const provider: AgentModelProvider = {
			async generate() {
				attempts += 1;
				if (attempts === 1) throw new Error("simulated worker crash");
				return {
					text: "恢复后的回复",
					toolCalls: [],
					usage: { inputTokens: 2, cachedInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0 },
				};
			},
		};
		const runtime = new BlackxAgentRuntime({
			provider,
			skills: new SkillRegistry(printSkills),
			sessions,
			snapshots: sessions,
		});
		const controller = new ConversationApiController(runtime, sessions, undefined, () => "conversation-replay");
		const conversationId = conversation(controller.create(context)).conversationId;

		expect((await controller.send(context, conversationId, {
			messageId: "message-replay",
			content: "需要恢复的问题",
		})).status).toBe(502);
		const replayed = await controller.send(context, conversationId, {
			messageId: "message-replay",
			content: "需要恢复的问题",
		}, { retryIncomplete: true });

		expect(replayed.status).toBe(200);
		expect(conversation(replayed).messages.map((message) => message.content)).toEqual([
			"需要恢复的问题",
			"恢复后的回复",
		]);
		expect(attempts).toBe(2);
	});
});
