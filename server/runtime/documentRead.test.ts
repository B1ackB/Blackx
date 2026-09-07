import { SkillRegistry } from "../../src/agent/skills";
import { mkdtempSync, readFileSync, rmSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryEnterpriseEventStore } from "../../src/enterprise/inMemoryEventStore";
import { ProposalRunEngine } from "../../src/enterprise/proposalRunEngine";
import { FileConversationAttachmentStore } from "./conversationAttachments";
import { AssetInspectionService } from "./assetInspection";
import { MacOsSeatbeltSandboxedToolExecutor } from "./macOsSeatbeltSandboxedToolExecutor";
import { BlackxAgentRuntime } from "./agentRuntime";
import { FileAgentStateStore } from "./fileAgentStateStore";
import { ConversationApiController } from "./conversationApi";
import { ConversationFileService } from "./conversationFiles";
import { documentFixture } from "../testing/documentFixture";
import type { ConversationView } from "../../src/runtime/conversationContracts";

const roots: string[] = [];
const identity = { tenantId: "t", workspaceId: "w", actorId: "a" };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "blackx-office-"))); roots.push(root);
	const attachments = new FileConversationAttachmentStore(join(root, "attachments"));
	const sessions = new FileAgentStateStore(join(root, "sessions"));
	const files = new ConversationFileService(join(root, "files"), (scope) => { if (!sessions.getSession({ ...scope, sessionId: scope.runId })) throw new Error("missing session"); });
	const service = new AssetInspectionService(new ProposalRunEngine(new InMemoryEnterpriseEventStore()), attachments, new MacOsSeatbeltSandboxedToolExecutor({ workspaceRoot: root }), root);
	const tool = service.documentTool((scope, path) => files.readDocument(scope, path));
	let observed = "";
	const usage = { inputTokens: 10, outputTokens: 2, cachedInputTokens: 0, reasoningOutputTokens: 0 };
	const runtime = new BlackxAgentRuntime({ skills: new SkillRegistry([]), sessions, snapshots: sessions, traces: sessions, sandboxedToolExecutor: service, tools: [tool], provider: { async generate(request) {
		const result = request.messages.findLast((message) => message.role === "tool");
		if (!result) {
			const source = request.messages.findLast((message) => message.sources?.length)?.sources?.[0];
			expect(source).toBeDefined();
			return { text: "", usage, toolCalls: [{ id: "read-1", name: "document_read", input: { attachmentId: source!.sourceRef.split("/").at(-1) } }] };
		}
		observed = result.content;
		return { text: "Read source document. Quantity is unverified pending your confirmation.", usage, toolCalls: [] };
	} } });
	const api = new ConversationApiController(runtime, sessions, undefined, undefined, ["document_read"], attachments);
	const conversation = (api.create(identity).body as { conversation: ConversationView }).conversation;
	return { root, attachments, sessions, files, service, api, conversation, observed: () => observed };
}

it("denies protected paths and symlinks before parsing local documents", async () => {
	const h = setup(); const scope = { ...identity, runId: h.conversation.conversationId };
	writeFileSync(join(h.root, "input.pdf"), documentFixture());
	symlinkSync(join(h.root, "input.pdf"), join(h.root, "link.pdf"));
	expect(() => h.files.readDocument(scope, join(h.root, "link.pdf"))).toThrow();
	expect(() => h.files.readDocument(scope, "/etc/passwd")).toThrow();
	expect(() => h.files.readDocument({ ...scope, tenantId: "other" }, join(h.root, "input.pdf"))).toThrow();
});

describe.skipIf(process.platform !== "darwin" || process.env.BLACKX_RUN_SEATBELT_TESTS !== "1")("real sandbox office reading", () => {
	for (const [name, kind, expected] of [["packaging.docx", "word", "5000 bags"], ["packaging.xlsx", "spreadsheet", "B1: 5000"]]) {
		it(`passes actual ${name} content through upload → model tool → next model context`, async () => {
			const h = setup();
			const file = h.attachments.put({ ...identity, conversationId: h.conversation.conversationId }, { requestId: "upload-1", name, mediaType: "application/octet-stream", content: readFileSync(`server/testing/documents/${name}`) }).attachment;
			const result = await h.api.send(identity, h.conversation.conversationId, { messageId: "m1", content: "Read this packaging document", attachmentIds: [file.attachmentId] });
			expect(result, JSON.stringify(result)).toMatchObject({ status: 200 });
			expect(h.observed()).toContain(expected);
			expect(JSON.parse(JSON.parse(h.observed()).stdout.text).inspection.kind).toBe(kind);
			if (kind === "spreadsheet") { expect(h.observed()).toContain("Sheet: 包装"); expect(h.observed()).toContain("Hong Kong"); expect(h.observed()).toContain("cached formula result"); }
			const reloaded = new FileAgentStateStore(join(h.root, "sessions")).getSession({ ...identity, runId: h.conversation.conversationId, sessionId: h.conversation.conversationId });
			expect(reloaded!.messages.find((message) => message.messageId === "m1")?.sources?.[0].sha256).toBe(file.sha256);
			expect((result.body as { conversation: ConversationView }).conversation.messages[0].attachments?.[0].name).toBe(name);
		}, 20_000);
	}
	it("previews local PDF content and does not execute external XML entities or oversized archives", async () => {
		const h = setup(); const scope = { ...identity, runId: h.conversation.conversationId };
		const inspect = (path: string) => h.service.preview(scope, path, (context, file) => h.files.readDocument(context, file), new AbortController().signal);
		const local = join(h.root, "input.pdf"); writeFileSync(local, documentFixture());
		expect((await inspect(local)).inspection.pages[0].text).toContain("Quantity: 5000");
		for (const name of ["unsafe.docx", "oversized.docx"]) {
			const path = join(h.root, name); writeFileSync(path, readFileSync(`server/testing/documents/${name}`));
			const result = await inspect(path);
			expect(result.inspection.status).toBe("unsupported"); expect(result.inspection.pages).toEqual([]);
		}
	}, 30_000);
});
