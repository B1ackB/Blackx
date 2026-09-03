import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentModelProvider } from "../../src/agent/contracts";
import { SkillRegistry } from "../../src/agent/skills";
import { InMemoryStageJobQueue } from "../../src/enterprise/stageJobQueue";
import { printSkills } from "../../src/print/skills";
import type { BackgroundTaskView, ConversationView } from "../../src/runtime/conversationContracts";
import { BlackxAgentRuntime } from "../runtime/agentRuntime";
import { ConversationApiController } from "../runtime/conversationApi";
import { FakeAgentRuntime } from "../runtime/fakeAgentRuntime";
import { FileAgentStateStore } from "../runtime/fileAgentStateStore";
import { BackgroundConversationWorker } from "./backgroundConversationWorker";
import { BackgroundTaskApiController } from "./backgroundTaskApi";

const directories: string[] = [];
const context = {
	tenantId: "tenant-background",
	workspaceId: "workspace-background",
	actorId: "user-background",
};

function state(): FileAgentStateStore {
	const directory = mkdtempSync(join(tmpdir(), "blackx-background-task-"));
	directories.push(directory);
	return new FileAgentStateStore(directory);
}

function body<Value>(response: { body: unknown }, key: string): Value {
	return (response.body as Record<string, Value>)[key];
}

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("BackgroundTaskApiController", () => {
	it("accepts a tenant-scoped task, hides its content, and executes it idempotently", async () => {
		const sessions = state();
		let modelCalls = 0;
		const provider: AgentModelProvider = {
			async generate() {
				modelCalls += 1;
				return {
					text: "后台模型回复",
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
		const conversations = new ConversationApiController(
			runtime,
			sessions,
			() => "2026-09-03T00:00:00.000Z",
			() => "background-conversation",
		);
		const conversationId = body<ConversationView>(conversations.create(context), "conversation").conversationId;
		const queue = new InMemoryStageJobQueue({ nextId: () => "lease-background" });
		const api = new BackgroundTaskApiController(queue, conversations, runtime);

		const accepted = await api.create(context, conversationId, {
			messageId: "message-background",
			content: "后台处理这个问题",
		});
		const task = body<BackgroundTaskView>(accepted, "task");
		expect(accepted.status).toBe(202);
		expect(task).toMatchObject({ conversationId, messageId: "message-background", status: "queued" });
		expect(JSON.stringify(accepted.body)).not.toContain("后台处理这个问题");
		expect(api.list(context, conversationId)).toMatchObject({
			status: 200,
			body: { tasks: [{ taskId: task.taskId }] },
		});
		expect(api.get({ ...context, tenantId: "tenant-other" }, task.taskId)).toMatchObject({ status: 404 });

		const lease = queue.claim("worker-background", 1_000)!;
		const worker = new BackgroundConversationWorker(conversations);
		expect(await worker.execute(lease)).toEqual({ status: "completed" });
		expect(await worker.execute(lease)).toEqual({ status: "completed" });
		expect(modelCalls).toBe(1);
		queue.ack(lease);
		const completedConversation = body<ConversationView>(conversations.get(context, conversationId), "conversation");
		expect(completedConversation.messages.map((message) => message.content)).toEqual([
			"后台处理这个问题",
			"后台模型回复",
		]);
	});

	it("rejects background execution when only the Fake adapter is configured", async () => {
		const sessions = state();
		const runtime = new FakeAgentRuntime({ sessions, snapshots: sessions });
		const conversations = new ConversationApiController(runtime, sessions, undefined, () => "fake-conversation");
		const conversationId = body<ConversationView>(conversations.create(context), "conversation").conversationId;
		const api = new BackgroundTaskApiController(new InMemoryStageJobQueue(), conversations, runtime);

		expect(await api.create(context, conversationId, {
			messageId: "message-fake",
			content: "不能进入后台",
		})).toEqual({ status: 503, body: { code: "real_provider_required" } });
	});
});
