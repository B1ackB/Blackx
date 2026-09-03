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
			async generate(request) {
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
