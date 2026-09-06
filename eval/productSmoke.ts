import { summarizeModelCalls, type ModelTelemetryView } from "../src/runtime/modelTelemetry";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { documentFixture } from "../server/testing/documentFixture";
import { createRequirementBrief, requiredRequirementFacts } from "../src/manufacturing/requirementBrief";
import type { ConversationView, RequirementBriefWorkspaceView, RuntimeActivity } from "../src/runtime/conversationContracts";
import type { RequirementDelivery } from "../src/manufacturing/requirementDelivery";
import type { ConversationFilesView, LocalFileLocations } from "../src/runtime/conversationFiles";
import type { AnthropicMessageRequest } from "../server/anthropic/types";
import { FileAgentStateStore } from "../server/runtime/fileAgentStateStore";
import { FileCronScheduleStore } from "../server/enterprise/fileCronScheduleStore";
import { FileEnterpriseEventStore } from "../server/enterprise/fileEventStore";
import { ProposalRunEngine } from "../src/enterprise/proposalRunEngine";

// Deterministic local provider: exercises the real HTTP adapter, never contacts a model vendor.
const directory = mkdtempSync(join(tmpdir(), "blackx-product-smoke-"));
const documents = join(realpathSync(directory), "user-documents"); mkdirSync(documents);
const localDocument = join(documents, "客户包装需求.md");
const serve = process.argv.includes("--serve");
const provider = createServer(async (request, response) => {
	const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
	const body = JSON.parse(Buffer.concat(chunks).toString()) as AnthropicMessageRequest;
	response.setHeader("content-type", "application/json");
	if (request.url?.endsWith("count_tokens")) { response.end(JSON.stringify({ input_tokens: 100 })); return; }
	const blocks = body.messages.flatMap((message) => message.content);
	const last = body.messages.at(-1)?.content ?? [];
	const requirement = body.tools?.some((tool) => tool.name === "project_source_read");
	let content: unknown[];
	if (requirement && !last.some((block) => block.type === "tool_result")) {
		const system = JSON.stringify(body.system);
		const ids = [...new Set(system.match(/attachment-[a-f0-9]+/g) ?? [])];
		content = [{ type: "tool_use", id: `source-${Date.now()}`, name: "project_source_read", input: { sourceId: "customer-brief" } }, ...ids.map((attachmentId) => ({ type: "tool_use", id: `inspect-${attachmentId}-${Date.now()}`, name: "asset_metadata_inspect", input: { attachmentId } }))];
	} else if (requirement) {
		const raw = JSON.stringify(blocks);
		const sourceRef = raw.match(/attachment:\/\/[^\s"\\]+/g)?.[0]?.replace(/#page=\d+$/, "") ?? "runtime:fixture";
		const values: Record<string, string | number> = { product_type: "咖啡豆自立袋", quantity: 5000, dimensions: "160 × 230 + 80 mm", target_market: "香港", target_delivery: "2026-11-30", delivery_location: "香港九龙", artwork_status: "品牌稿待提供" };
		content = [{ type: "text", text: JSON.stringify(createRequirementBrief({ industry: "print", title: "咖啡包装需求单", customerGoal: "整理客户资料，确认数量、尺寸与交付要求。", facts: requiredRequirementFacts.print.map((key) => ({ key, version: 1, value: values[key]!, status: "unverified", sourceType: "model_output", sourceRef: `${sourceRef}#page=1` })) })) }];
	} else if (JSON.stringify(last).includes("本地文件测试") && !last.some((block) => block.type === "tool_result")) {
		const remove = JSON.stringify(last).includes("删除");
		const previous = existsSync(localDocument) ? readFileSync(localDocument, "utf8") : undefined;
		content = [...(previous !== undefined ? [{ type: "tool_use", id: "local-read", name: "file_read", input: { path: localDocument } }] : []), { type: "tool_use", id: "local-mutate", name: remove ? "file_delete" : "file_write", input: { path: localDocument, expectedSha256: previous === undefined ? null : createHash("sha256").update(previous).digest("hex"), ...(remove ? {} : { content: "# 已审批的包装需求\n客户尺寸仍待确认。" }) } }];
	} else if (JSON.stringify(last).includes("文件读取测试") && !last.some((block) => block.type === "tool_result")) {
		content = [{ type: "tool_use", id: "file-list", name: "file_list", input: {} }, { type: "tool_use", id: "file-read", name: "file_read", input: { path: "包装方案.md" } }];
	} else if (JSON.stringify(last).includes("文件操作测试") && !last.some((block) => block.type === "tool_result")) {
		const text = JSON.stringify(last);
		const remove = text.includes("删除");
		const overwrite = text.includes("覆盖");
		content = [{ type: "tool_use", id: `file-${Date.now()}`, name: remove ? "file_delete" : "file_write", input: { path: "包装方案.md", expectedVersion: remove ? 2 : overwrite ? 1 : null, ...(remove ? {} : { content: overwrite ? "# 包装方案 v2\n待用户核对尺寸。" : "# 包装方案 v1\n模型建议，待确认。" }) } }];
	} else if (JSON.stringify(last).includes("定时任务删除回归") && !last.some((block) => block.type === "tool_result")) {
		content = [{ type: "tool_use", id: "cron-delete-test", name: "cron_create", input: { name: "删除回归", expression: "*/5 * * * *", timezone: "Asia/Hong_Kong", prompt: "汇总需求", maxRuns: 2 } }];
	} else {
		const text = JSON.stringify(last);
		await new Promise((resolve) => setTimeout(resolve, text.includes("停止测试") ? 5000 : 350));
		content = [{ type: "text", text: "## 已收到你的需求\n\n先核对资料中的信息，再生成需求单。\n\n| 项目 | 当前状态 |\n| --- | --- |\n| 附件 | 已保存，生成需求单时解析 |\n| 关键字段 | 等待确认 |\n\n- 核对数量和交付地点\n- 补充设计稿状态\n\n```text\n资料 → 核对 → 生成版本 → 确认交付\n```\n\n这是本地固定测试响应。" }];
	}
	response.end(JSON.stringify({ id: "fixture-response", type: "message", role: "assistant", model: "local-fixture", content, stop_reason: requirement && !last.some((block) => block.type === "tool_result") ? "tool_use" : "end_turn", usage: { input_tokens: 100, output_tokens: 80, cache_read_input_tokens: 50, cache_creation_input_tokens: 50 } }));
});
provider.listen(0, "127.0.0.1"); await once(provider, "listening");
const providerPort = (provider.address() as { port: number }).port;
const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
const port = serve ? 5178 : (reservation.address() as { port: number }).port;
await new Promise<void>((resolve) => reservation.close(() => resolve()));
const baseUrl = `http://127.0.0.1:${port}`;
const host = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], { env: {
	...process.env, BLACKX_PORT: String(port), BLACKX_RUNTIME_MODE: "anthropic", ANTHROPIC_API_KEY: "offline-fixture-only", ANTHROPIC_BASE_URL: `http://127.0.0.1:${providerPort}`, ANTHROPIC_MODEL: "local-fixture",
	BLACKX_FILE_STORE_PATH: join(directory, "files"), BLACKX_AGENT_STATE_PATH: join(directory, "sessions"), BLACKX_EVENT_STORE_PATH: join(directory, "events.json"), BLACKX_STAGE_JOB_QUEUE_DRIVER: "file", BLACKX_STAGE_JOB_QUEUE_PATH: join(directory, "queue.json"), BLACKX_CRON_SCHEDULE_PATH: join(directory, "cron.json"), BLACKX_ATTACHMENT_STORE_PATH: join(directory, "attachments"), BLACKX_ARTIFACT_STORE_PATH: join(directory, "artifacts"), BLACKX_INSPECTION_CACHE_PATH: join(directory, "inspections"), BLACKX_WORKSPACE_ROOT: directory, BLACKX_ENABLE_RUNTIME_EVAL: "0", BLACKX_COMMAND_API_TOKEN: "", BLACKX_WORKER_API_TOKEN: "", BLACKX_OPERATOR_API_TOKEN: "",
}, stdio: ["ignore", "pipe", "pipe"] });
let output = ""; host.stdout.on("data", (chunk) => { output += String(chunk); }); host.stderr.on("data", (chunk) => { output += String(chunk); });
const close = async () => {
	host.kill("SIGTERM");
	if (host.exitCode === null && host.signalCode === null) await once(host, "exit");
	provider.closeAllConnections(); await new Promise<void>((resolve) => provider.close(() => resolve()));
	rmSync(directory, { recursive: true, force: true });
};
process.once("SIGINT", () => void close().then(() => process.exit(0)));
process.once("SIGTERM", () => void close().then(() => process.exit(0)));
try {
	let ready = false;
	for (let attempt = 0; attempt < 100; attempt++) {
		if (host.exitCode !== null) throw new Error(`Host exited: ${output}`);
		try { ready = (await fetch(baseUrl)).ok; } catch { /* Starting. */ }
		if (ready) break;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	assert(ready, `Host did not start: ${output}`);
	assert.equal((await fetch(baseUrl)).headers.get("x-frame-options"), "DENY");
	assert.equal((await fetch(`${baseUrl}/api/conversations`)).status, 403);
	const session = await fetch(`${baseUrl}/api/local-session`, { headers: { "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" } }).then((response) => response.json()) as { token: string };
	assert(session.token);
	const headers = { "x-blackx-session-token": session.token };
	for (const extra of [{ origin: "https://evil.test" }, { "x-blackx-tenant-id": "other" }]) assert.equal((await fetch(`${baseUrl}/api/conversations`, { headers: { ...headers, ...extra } })).status, 403);
	assert.equal((await fetch(`${baseUrl}/api/runtime/turn`, { method: "POST", headers })).status, 403);
	async function api<T = { conversation: ConversationView; requirementBrief: RequirementBriefWorkspaceView; delivery: RequirementDelivery; activity?: RuntimeActivity }>(path: string, body?: unknown) {
		const response = await fetch(`${baseUrl}${path}`, { headers: { ...headers, "content-type": "application/json" }, method: body === undefined ? "GET" : "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
		const value = await response.json(); assert(response.ok, `${path}: ${JSON.stringify(value)}`); return value as T;
	}
	const id = (await api("/api/conversations", {})).conversation.conversationId as string;
	const path = `/api/conversations/${id}`;
	async function pendingFor(conversationPath: string) {
		for (let i = 0; i < 100; i++) { const view = await fetch(`${baseUrl}${conversationPath}/files`, { headers }).then((response) => response.json()) as ConversationFilesView; if (view.approvals[0]) return view.approvals[0]; await new Promise((resolve) => setTimeout(resolve, 50)); }
		throw new Error("File approval not requested");
	}
	const createFile = api(`${path}/messages`, { messageId: "file-create", content: "文件操作测试：新建包装方案" });
	await api(`${path}/files/approvals/${(await pendingFor(path)).id}`, { decision: "approved" }); await createFile;
	async function files(): Promise<ConversationFilesView> { return await fetch(`${baseUrl}${path}/files`, { headers }).then((response) => response.json()) as ConversationFilesView; }
	assert.equal((await files()).files[0]?.version, 1);
	await api(`${path}/messages`, { messageId: "file-read", content: "文件读取测试：读取包装方案" });
	assert.equal((await fetch(`${baseUrl}${path}/files`)).status, 403);
	if (!serve) {
	const otherId = (await api("/api/conversations", {})).conversation.conversationId;
	const otherCreate = api(`/api/conversations/${otherId}/messages`, { messageId: "file-create", content: "文件操作测试：新建包装方案" });
	await api(`/api/conversations/${otherId}/files/approvals/${(await pendingFor(`/api/conversations/${otherId}`)).id}`, { decision: "approved" }); await otherCreate;
	const otherFiles = await fetch(`${baseUrl}/api/conversations/${otherId}/files`, { headers }).then((response) => response.json()) as ConversationFilesView;
	assert.equal(otherFiles.files[0]?.version, 1, "same message id in another conversation must create an independent file");
	await fetch(`${baseUrl}/api/conversations/${otherId}`, { method: "DELETE", headers });
	async function pendingFile() {
		for (let i = 0; i < 100; i++) { const pending = (await files()).approvals[0]; if (pending) return pending; await new Promise((resolve) => setTimeout(resolve, 50)); }
		throw new Error("File approval not requested");
	}
	const overwrite = api(`${path}/messages`, { messageId: "file-overwrite", content: "文件操作测试：覆盖包装方案" });
	const review = await pendingFile();
	assert.equal((await files()).files.length, 1);
	assert.equal(review.before, "# 包装方案 v1\n模型建议，待确认。");
	const reviewUrl = `${path}/files/approvals/${review.id}`;
	assert.equal((await fetch(`${baseUrl}${reviewUrl}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: "approved" }) })).status, 403);
	await api(reviewUrl, { decision: "approved" }); await overwrite;
	assert.equal((await files()).files.at(-1)?.version, 2);
	const rejectDelete = api(`${path}/messages`, { messageId: "file-reject", content: "文件操作测试：删除包装方案" });
	await api(`${path}/files/approvals/${(await pendingFile()).id}`, { decision: "rejected" }); await rejectDelete;
	assert.equal((await files()).files.at(-1)?.status, "draft");
	const stopDelete = api(`${path}/messages`, { messageId: "file-stop", content: "文件操作测试：删除包装方案" }).catch((error: unknown) => error);
	const stoppedApproval = await pendingFile();
	await api(`${path}/stop`, {}); assert(await stopDelete instanceof Error);
	assert.equal((await fetch(`${baseUrl}${path}/files/approvals/${stoppedApproval.id}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ decision: "approved" }) })).status, 409);
	const remove = api(`${path}/messages`, { messageId: "file-delete", content: "文件操作测试：删除包装方案" });
	await api(`${path}/files/approvals/${(await pendingFile()).id}`, { decision: "approved" }); await remove;
	assert.equal((await files()).files.at(-1)?.status, "deleted");
	const oldVersion = await fetch(`${baseUrl}${path}/files/content?path=${encodeURIComponent("包装方案.md")}&version=1`, { headers }).then((response) => response.json()) as { content: string };
	assert.equal(oldVersion.content, "# 包装方案 v1\n模型建议，待确认。");
	assert.equal((await fetch(`${baseUrl}${path}/files/directories`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: documents }) })).status, 403);
	assert.equal((await fetch(`${baseUrl}${path}/files/directories?path=${encodeURIComponent(documents)}`, { headers })).status, 200);
	assert.equal((await fetch(`${baseUrl}${path}/files/directories`, { method: "POST", headers, body: JSON.stringify({ path: documents }) })).status, 410);
	const localCreate = api(`${path}/messages`, { messageId: "local-create", content: "本地文件测试：新建" });
	const localReview = await pendingFor(path); assert.equal(localReview.path, localDocument); assert(!existsSync(localDocument));
	await api(`${path}/files/approvals/${localReview.id}`, { decision: "approved" }); await localCreate;
	assert(readFileSync(localDocument, "utf8").includes("已审批"));
	writeFileSync(localDocument, "客户手工调整的原文");
	const localWrite = api(`${path}/messages`, { messageId: "local-write", content: "本地文件测试：修改" });
	const localChange = await pendingFor(path); assert.equal(localChange.before, "客户手工调整的原文");
	await api(`${path}/files/approvals/${localChange.id}`, { decision: "approved" }); await localWrite;
	assert(readFileSync(localDocument, "utf8").includes("已审批"));
	const localDelete = api(`${path}/messages`, { messageId: "local-delete", content: "本地文件测试：删除" });
	await api(`${path}/files/approvals/${(await pendingFor(path)).id}`, { decision: "approved" }); await localDelete;
	assert(!existsSync(localDocument));
	const backup = await fetch(`${baseUrl}${path}/files/content?${new URLSearchParams({ path: localDocument, version: "2" })}`, { headers }).then((response) => response.json()) as { content: string };
	assert.equal(backup.content, "客户手工调整的原文");
	assert.equal((await fetch(`${baseUrl}${path}/files/directories/retired-grant`, { method: "DELETE", headers })).status, 410);
	assert.equal((await fetch(`${baseUrl}${path}/files/directories?path=${encodeURIComponent(documents)}`, { headers })).status, 200);
	}
	await api(`${path}/messages`, { messageId: "smoke-message", content: "需要 5000 个咖啡豆包装袋，资料见附件。" });
	const pdf = documentFixture(); writeFileSync(join(directory, "customer.pdf"), pdf);
	const upload = await fetch(`${baseUrl}${path}/attachments?requestId=smoke-upload&name=customer.pdf`, { method: "POST", headers: { ...headers, "content-type": "application/pdf" }, body: pdf });
	assert(upload.ok);
	const attachment = (await upload.json() as { attachment: { attachmentId: string } }).attachment;
	const start = await api(`${path}/requirement-brief`, { requestId: "smoke-start", industry: "print" }); assert(start.requirementBrief.runId);
	async function settled(): Promise<RequirementBriefWorkspaceView> {
		for (let attempt = 0; attempt < 150; attempt++) {
			const view = (await api(`${path}/requirement-brief`)).requirementBrief as RequirementBriefWorkspaceView;
			assert.notEqual(view.job?.status, "dead_letter", JSON.stringify(view.job?.lastFailure));
			if (!["queued", "leased"].includes(view.job?.status ?? "")) return view;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		throw new Error("Workflow did not finish");
	}
	const draft = await settled(); assert.equal(draft.state.stageStatus, "needs_input");
	const v1 = await api(`${path}/requirement-brief/versions/1`); assert.equal(v1.delivery.sources[0].inspection.status, "parsed"); assert.equal(v1.delivery.status, "draft");
	assert.equal((await api<LocalFileLocations>(`${path}/files/directories`)).locations.workingDirectory, realpathSync(directory));
	const metrics = await api<ModelTelemetryView>(`${path}/model-calls`);
	assert(metrics.calls.some((call) => call.kind === "count_tokens"));
	assert(metrics.calls.some((call) => call.kind === "generate" && call.status === "succeeded" && call.response?.model === "local-fixture"));
	assert.equal(summarizeModelCalls(metrics.calls).cacheHitRate, 0.25);
	const workflowMetrics = await api<ModelTelemetryView>(`${path}/model-calls?run=requirement`);
	assert(workflowMetrics.calls.length > 0);
	assert(workflowMetrics.calls.every((call) => !metrics.calls.some((other) => other.id === call.id)));
	assert.equal((await fetch(`${baseUrl}${path}/model-calls`)).status, 403);
	assert.equal((await fetch(`${baseUrl}${path}/model-calls`, { headers: { ...headers, "x-blackx-tenant-id": "other" } })).status, 403);
	assert(!JSON.stringify(metrics).includes("offline-fixture-only"));

	if (serve) {
		writeFileSync(localDocument, "# 客户包装需求\n客户原文，尚未被 Agent 修改。");
		console.log(JSON.stringify({ mode: "offline-browser-fixture", url: baseUrl, conversationId: id, fixtureDirectory: directory, localDirectory: documents, checks: "auth + real native PDF slice passed; draft ready" }));
		await new Promise(() => {});
	} else {
		for (const key of requiredRequirementFacts.print) await api(`${path}/requirement-brief/facts/${key}/decision`, { requestId: `verify-${key}`, decision: "verified" });
		await api(`${path}/requirement-brief`, { requestId: "smoke-revise", industry: "print" });
		assert.equal((await settled()).state.stageStatus, "waiting_approval");
		await api(`${path}/requirement-brief/approval`, { requestId: "smoke-approve", decision: "approved" });
		assert.equal((await settled()).state.stageStatus, "passed");
		assert.equal((await api(`${path}/requirement-brief/versions/1`)).delivery.status, "stale");
		assert.equal((await api(`${path}/requirement-brief/versions/2`)).delivery.status, "approved");
		for (const format of ["md", "html", "json"]) { const response = await fetch(`${baseUrl}${path}/requirement-brief/versions/2?format=${format}`, { headers }); assert(response.ok); assert((await response.text()).includes("5000")); }
		const pending = api(`${path}/messages`, { messageId: "cancel-message", content: "停止测试" }).catch((error: unknown) => error);
		for (let attempt = 0; attempt < 40; attempt++) { if ((await api(`${path}/activity`)).activity?.phase === "model") break; await new Promise((resolve) => setTimeout(resolve, 50)); }
		await api(`${path}/stop`, {}); assert(await pending instanceof Error);
		assert.equal((await api(path)).conversation.messages.at(-1)?.role, "user");
		assert((await api<ModelTelemetryView>(`${path}/model-calls`)).calls.some((call) => call.status === "cancelled"));
		await api(`${path}/messages`, { messageId: "cron-delete", content: "定时任务删除回归：香港时区，每5分钟汇总需求，执行2次。" });
		const schedules = new FileCronScheduleStore(join(directory, "cron.json"));
		assert.equal(schedules.list({ tenantId: "local-user", workspaceId: "default-workspace" }).filter((schedule) => schedule.runId === id && schedule.status === "active").length, 1);
		const deletingTurn = api(`${path}/messages`, { messageId: "delete-message", content: "停止测试，删除运行中的会话" }).catch((error: unknown) => error);
		for (let attempt = 0; attempt < 40; attempt++) { if ((await api(`${path}/activity`)).activity?.phase === "model") break; await new Promise((resolve) => setTimeout(resolve, 50)); }
		const background = await fetch(`${baseUrl}${path}/background-tasks`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ messageId: "delete-background", content: "删除后不应继续" }) });
		assert.equal(background.status, 202);
		const task = (await background.json() as { task: { taskId: string } }).task;
		assert.equal((await fetch(`${baseUrl}${path}`, { method: "DELETE" })).status, 403);
		const deletion = await fetch(`${baseUrl}${path}`, { method: "DELETE", headers });
		assert.equal(deletion.status, 200); const deletionBody = await deletion.json();
		assert.deepEqual(await fetch(`${baseUrl}${path}`, { method: "DELETE", headers }).then((response) => response.json()), deletionBody);
		assert(await deletingTurn instanceof Error);
		for (const suffix of ["", "/files", "/files/content?path=anything.md", "/attachments", `/attachments/${attachment.attachmentId}/content`, "/traces", "/activity", "/model-calls", "/model-calls?run=requirement", "/background-tasks", "/cron-schedules", "/requirement-brief", "/requirement-brief/versions/2", "/proposal"]) assert.equal((await fetch(`${baseUrl}${path}${suffix}`, { headers })).status, 404, suffix);
		assert.equal((await fetch(`${baseUrl}/api/background-tasks/${task.taskId}`, { headers })).status, 404);
		assert.equal((await fetch(`${baseUrl}${path}/messages`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ messageId: "after-delete", content: "hello" }) })).status, 404);
		const remaining = await fetch(`${baseUrl}/api/conversations`, { headers }).then((response) => response.json()) as { conversations: ConversationView[] };
		assert(!remaining.conversations.some((conversation) => conversation.conversationId === id));
		const persisted = new FileAgentStateStore(join(directory, "sessions"));
		assert.equal(persisted.getSession({ tenantId: "local-user", workspaceId: "default-workspace", runId: id, sessionId: id }), undefined);
		assert(schedules.list({ tenantId: "local-user", workspaceId: "default-workspace" }).every((schedule) => schedule.status === "paused"));
		const retained = new ProposalRunEngine(new FileEnterpriseEventStore(join(directory, "events.json")), "requirement-brief").load({ tenantId: "local-user", workspaceId: "default-workspace", runId: start.requirementBrief.runId });
		assert.equal(retained.stageStatus, "passed"); assert.equal(retained.approval?.status, "approved");
		console.log("PASS: durable scoped model calls, cache usage, cancellation telemetry, Agent-triggered per-operation approval without directory grants, approved creation/modification/deletion at absolute paths, original-content backups, retired grant APIs, all-write approval, scoped history, same-message isolation, native PDF slice, workflow approval/exports, cancellation, conversation deletion and audit retention; provider = local deterministic fixture.");
	}
} finally { await close(); }
