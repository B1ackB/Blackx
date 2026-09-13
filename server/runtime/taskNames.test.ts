import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { TaskNames } from "./taskNames";
import { ConversationApiController } from "./conversationApi";
import { FileAgentStateStore } from "./fileAgentStateStore";
import { FakeAgentRuntime } from "./fakeAgentRuntime";
import type { ConversationView } from "../../src/runtime/conversationContracts";

it("names Plan-only tasks without changing execution revisions and rejects stale/cross-tenant writes", () => {
	const root = mkdtempSync(join(tmpdir(), "packx-names-")), path = join(root, "names.sqlite");
	let names = new TaskNames(path);
	try {
		const sessions = new FileAgentStateStore(join(root, "sessions"));
		const context = { tenantId: "tenant", workspaceId: "workspace", actorId: "actor" };
		const target = { ...context, runId: "conversation-task", sessionId: "conversation-task" };
		sessions.createSession(target, new Date().toISOString());
		const controller = new ConversationApiController(new FakeAgentRuntime(), sessions, undefined, undefined, [], undefined, undefined, names, () => "咖啡袋材料核对计划");
		expect((controller.get(context, target.runId).body as { conversation: ConversationView }).conversation.title).toBe("咖啡袋材料核对计划");
		const revision = sessions.getSession(target)!.revision;
		expect(controller.rename(context, target.runId, { name: "客户 A 包装跟进", nameRevision: 0 }).status).toBe(200);
		expect(controller.rename(context, target.runId, { name: "客户 A 包装跟进", nameRevision: 0 }).status).toBe(200);
		expect(controller.rename(context, target.runId, { name: "stale", nameRevision: 0 }).status).toBe(409);
		expect(controller.rename({ ...context, tenantId: "other" }, target.runId, { name: "bad", nameRevision: 0 }).status).toBe(404);
		expect(controller.rename(context, target.runId, { name: "\n", nameRevision: 1 }).status).toBe(400);
		expect(sessions.getSession(target)!.revision).toBe(revision);
		const listed = JSON.stringify(controller.list(context).body);
		expect(listed).toContain("客户 A 包装跟进"); expect(listed).toContain("咖啡袋材料核对计划");
		names.close(); names = new TaskNames(path);
		expect(names.get(target)).toEqual({ name: "客户 A 包装跟进", nameRevision: 1 });
		sessions.deleteSession(target, "actor", new Date().toISOString());
		expect(controller.rename(context, target.runId, { name: "revive", nameRevision: 1 }).status).toBe(404);
	} finally { names.close(); rmSync(root, { recursive: true, force: true }); }
});
