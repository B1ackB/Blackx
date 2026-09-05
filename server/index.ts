import { deliveryHtml, deliveryMarkdown, type RequirementDelivery } from "../src/manufacturing/requirementDelivery";
import { AssetInspectionService } from "./runtime/assetInspection";
import { MacOsSeatbeltSandboxedToolExecutor } from "./runtime/macOsSeatbeltSandboxedToolExecutor";
import { LocalAccess } from "./localAccess";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { createServer as createViteServer } from "vite";
import { ProposalRunEngine } from "../src/enterprise/proposalRunEngine";
import type { RuntimeTurnRequest } from "../src/runtime/contracts";
import { RuntimeFailure } from "../src/runtime/contracts";
import { FileEnterpriseEventStore } from "./enterprise/fileEventStore";
import { FileCronScheduleStore } from "./enterprise/fileCronScheduleStore";
import { FileStageJobQueue } from "./enterprise/fileStageJobQueue";
import {
	ProposalApiController,
	type ProposalApiContext,
} from "./enterprise/proposalApi";
import { createRuntime } from "./runtime/createRuntime";
import {
	automationToolNames,
	automationWriteToolNames,
	createAutomationTools,
} from "./runtime/automationTools";
import { ConversationApiController } from "./runtime/conversationApi";
import { ConversationDeletion } from "./runtime/conversationDeletion";
import { ConversationFileService, conversationFileToolNames, TaskFileError } from "./runtime/conversationFiles";
import {
	ConversationAttachmentError,
	FileConversationAttachmentStore,
} from "./runtime/conversationAttachments";
import { FileArtifactContentStore } from "./artifacts/fileArtifactStore";
import { ProposalWorker } from "./workers/proposalWorker";
import { ProposalWorkerApiController } from "./workers/proposalWorkerApi";
import { StageJobOutbox } from "./workers/stageJobOutbox";
import { StageJobScheduler } from "./workers/stageJobScheduler";
import { BackgroundConversationWorker } from "./workers/backgroundConversationWorker";
import { BackgroundTaskApiController } from "./workers/backgroundTaskApi";
import { CronDispatcher } from "./workers/cronScheduler";
import { CronApiController } from "./workers/cronApi";
import { ProposalWorkspaceApiController } from "./enterprise/proposalWorkspaceApi";
import { researchSourceTool } from "./runtime/researchTools";
import { createProjectSourceReadTool } from "./runtime/requirementTools";
import { RequirementBriefWorker } from "./manufacturing/requirementBriefWorker";
import { RequirementBriefWorkspaceApiController } from "./manufacturing/requirementBriefApi";

const port = Number(process.env.BLACKX_PORT ?? 5173);
const localAccess = new LocalAccess(port);
const eventStore = new FileEnterpriseEventStore(
	resolve(
			process.env.BLACKX_EVENT_STORE_PATH ??
				".blackx-data/events.json",
	),
);
const proposalEngine = new ProposalRunEngine(eventStore);
const requirementBriefEngine = new ProposalRunEngine(eventStore, "requirement-brief");
const proposalApi = new ProposalApiController(
	proposalEngine,
	process.env.BLACKX_COMMAND_API_TOKEN,
	process.env.BLACKX_WORKER_API_TOKEN,
);
const stageJobQueueDriver = process.env.BLACKX_STAGE_JOB_QUEUE_DRIVER ?? "file";
if (stageJobQueueDriver !== "file" && stageJobQueueDriver !== "sqlite") {
	throw new Error("BLACKX_STAGE_JOB_QUEUE_DRIVER must be file or sqlite");
}
const sqliteStageJobQueue = stageJobQueueDriver === "sqlite"
	? new (await import("./enterprise/sqliteStageJobQueue")).SqliteStageJobQueue(
		resolve(process.env.BLACKX_STAGE_JOB_QUEUE_PATH ?? ".blackx-data/stage-jobs.sqlite"),
	)
	: undefined;
const stageJobQueue = sqliteStageJobQueue ?? new FileStageJobQueue(
	resolve(process.env.BLACKX_STAGE_JOB_QUEUE_PATH ?? ".blackx-data/stage-jobs.json"),
);
const cronScheduleStore = new FileCronScheduleStore(
	resolve(process.env.BLACKX_CRON_SCHEDULE_PATH ?? ".blackx-data/cron-schedules.json"),
);
const conversationAttachments = new FileConversationAttachmentStore(
	resolve(process.env.BLACKX_ATTACHMENT_STORE_PATH ?? ".blackx-data/attachments"),
);
const workspaceRoot = resolve(process.env.BLACKX_WORKSPACE_ROOT ?? ".");
const conversationFiles = new ConversationFileService(resolve(process.env.BLACKX_FILE_STORE_PATH ?? ".blackx-data/files"), (scope) => {
	if (scope.tenantId !== localAccess.identity.tenantId || scope.workspaceId !== localAccess.identity.workspaceId || scope.actorId !== localAccess.identity.actorId) throw new TaskFileError("file_scope_denied", "本机文件仅供当前 Host 用户访问", 403);
	if (!agentState.getSession({ ...scope, sessionId: scope.runId })) throw new TaskFileError("conversation_not_found", "会话已删除或不存在", 404);
}, undefined, [resolve(".blackx-data"), ...[process.env.BLACKX_AGENT_STATE_PATH, process.env.BLACKX_EVENT_STORE_PATH, process.env.BLACKX_ARTIFACT_STORE_PATH, process.env.BLACKX_ATTACHMENT_STORE_PATH, process.env.BLACKX_STAGE_JOB_QUEUE_PATH, process.env.BLACKX_CRON_SCHEDULE_PATH, process.env.BLACKX_INSPECTION_CACHE_PATH].filter((path): path is string => !!path).map((path) => resolve(path))], workspaceRoot);
const assetInspection = new AssetInspectionService(requirementBriefEngine, conversationAttachments, new MacOsSeatbeltSandboxedToolExecutor({ workspaceRoot }), workspaceRoot, undefined, process.env.BLACKX_INSPECTION_CACHE_PATH);
const services = createRuntime(process.env, {
	sandboxedToolExecutor: assetInspection,
	tools: [
		...conversationFiles.tools(),
		...createAutomationTools(stageJobQueue, cronScheduleStore).map((tool) => tool.execution !== "host" ? tool : ({
			...tool,
			execute: (input: Parameters<typeof tool.execute>[0], context: Parameters<typeof tool.execute>[1]) => {
				if (!agentState.getSession({ ...context, sessionId: context.runId })) throw new RuntimeFailure("cancelled", "会话已删除或不存在", false);
				return tool.execute(input, context);
			},
		})),
		researchSourceTool,
		assetInspection.tool(),
		createProjectSourceReadTool(requirementBriefEngine, conversationAttachments),
	],
	autonomouslyApprovedTools: automationWriteToolNames,
	approval: conversationFiles,
	resolveImageAttachment: async (scope, attachment) => conversationAttachments.resolveImage(scope, attachment),
});
const { runtime, state: agentState } = services;
const conversationApi = new ConversationApiController(
	runtime,
	agentState,
	undefined,
	undefined,
	[...automationToolNames, ...conversationFileToolNames],
	conversationAttachments,
);
const stageJobOutbox = new StageJobOutbox(proposalEngine, eventStore, stageJobQueue);
const requirementBriefOutbox = new StageJobOutbox(requirementBriefEngine, eventStore, stageJobQueue);
const cronDispatcher = new CronDispatcher(cronScheduleStore, stageJobQueue);
const backgroundConversationWorker = new BackgroundConversationWorker(conversationApi);
const artifactStore = new FileArtifactContentStore(
	resolve(
		process.env.BLACKX_ARTIFACT_STORE_PATH ??
			".blackx-data/artifacts",
	),
);
const proposalWorker = new ProposalWorker(
	proposalEngine,
	runtime,
	artifactStore,
);
const requirementBriefWorker = new RequirementBriefWorker(
	requirementBriefEngine,
	runtime,
	artifactStore,
	conversationAttachments,
	assetInspection,
);
const stageJobScheduler = new StageJobScheduler(
	stageJobQueue,
	{
		workerId: process.env.BLACKX_WORKER_ID ?? `local-${process.pid}`,
		leaseMs: Number(process.env.BLACKX_WORKER_LEASE_MS ?? 135_000),
		pollIntervalMs: Number(process.env.BLACKX_WORKER_POLL_MS ?? 250),
		handlers: {
			proposal: (lease, signal, assertActive) => proposalWorker.executeLease(lease, signal, assertActive),
			"requirement-brief": (lease, signal, assertActive) => requirementBriefWorker.executeLease(lease, signal, assertActive),
			"conversation-background": (lease, signal, assertActive) => backgroundConversationWorker.execute(lease, signal, assertActive),
		},
		dispatchOutbox: () => {
			conversationDeletion.reconcile(localAccess.identity);
			stageJobOutbox.dispatchOne();
			requirementBriefOutbox.dispatchOne();
			cronDispatcher.dispatchDue();
			conversationDeletion.reconcile(localAccess.identity);
		},
		onError: (error) => {
			const code = error instanceof Error ? error.name : "unknown_error";
			console.error(`[stage-job-scheduler] ${code}`);
		},
	},
);
const conversationDeletion = new ConversationDeletion(agentState, stageJobScheduler, cronScheduleStore, [
	{ prefix: "proposal", engine: proposalEngine },
	{ prefix: "requirement", engine: requirementBriefEngine },
]);
const backgroundTaskApi = new BackgroundTaskApiController(stageJobQueue, conversationApi, runtime);
const cronApi = new CronApiController(cronScheduleStore);
const proposalWorkspaceApi = new ProposalWorkspaceApiController(
	conversationApi,
	proposalEngine,
	artifactStore,
	stageJobOutbox,
	stageJobScheduler,
);
const requirementBriefWorkspaceApi = new RequirementBriefWorkspaceApiController(
	conversationApi,
	requirementBriefEngine,
	artifactStore,
	requirementBriefOutbox,
	stageJobScheduler,
	conversationAttachments,
);
const proposalWorkerApi = new ProposalWorkerApiController(
	stageJobScheduler,
	stageJobOutbox,
	process.env.BLACKX_WORKER_API_TOKEN,
	process.env.BLACKX_OPERATOR_API_TOKEN,
);
let stopStageJobScheduler = () => {};
const server = createServer();
const vite = await createViteServer({
	server: { middlewareMode: true, hmr: { server } },
	appType: "spa",
});

function json(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

async function readBody(request: IncomingMessage, maxBytes = 256_000): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maxBytes) throw new Error("request_too_large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  return JSON.parse((await readBody(request)).toString("utf8"));
}

function isTurnRequest(value: unknown): value is RuntimeTurnRequest {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RuntimeTurnRequest>;
  return (
    typeof candidate.tenantId === "string" &&
    typeof candidate.workspaceId === "string" &&
    typeof candidate.runId === "string" &&
    typeof candidate.stageId === "string" &&
		typeof candidate.actorId === "string" &&
    typeof candidate.idempotencyKey === "string" &&
    typeof candidate.input === "string" &&
    typeof candidate.fallbackOutput === "string" &&
		(candidate.policy?.sandboxMode === "read-only" || candidate.policy?.sandboxMode === "workspace-write") &&
		(candidate.policy.approvalPolicy === "never" || candidate.policy.approvalPolicy === "required") &&
    typeof candidate.policy.timeoutMs === "number" &&
		(candidate.sessionId === undefined || typeof candidate.sessionId === "string") &&
		(candidate.resume === undefined || typeof candidate.resume === "boolean" || candidate.resume === "if-present") &&
		(!candidate.resume || typeof candidate.sessionId === "string") &&
		(candidate.contextSnapshotId === undefined || typeof candidate.contextSnapshotId === "string") &&
		(candidate.instructions === undefined || (
			Array.isArray(candidate.instructions) && candidate.instructions.every((value) => typeof value === "string")
		)) &&
		(candidate.skills === undefined || (
			Array.isArray(candidate.skills) && candidate.skills.every((value) => typeof value === "string")
		)) &&
		(candidate.allowedTools === undefined || (
			Array.isArray(candidate.allowedTools) && candidate.allowedTools.every((value) => typeof value === "string")
		)) &&
		(candidate.attachments === undefined || (
			Array.isArray(candidate.attachments) &&
			candidate.attachments.length <= 8 &&
			candidate.attachments.every((attachment) =>
				Boolean(attachment) &&
				typeof attachment === "object" &&
				!Array.isArray(attachment) &&
				(attachment as { type?: unknown }).type === "image" &&
				typeof (attachment as { name?: unknown }).name === "string" &&
				["image/gif", "image/jpeg", "image/png", "image/webp"].includes(
					String((attachment as { mediaType?: unknown }).mediaType),
				) &&
				typeof (attachment as { sourceRef?: unknown }).sourceRef === "string" &&
				/^[a-f0-9]{64}$/.test(String((attachment as { sha256?: unknown }).sha256)) &&
				(attachment as { data?: unknown }).data === undefined
			)
		))
  );
}

function safeRuntimeDiagnostic(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    messages.push(`${current.name}: ${current.message}`);
    current = current.cause;
  }
	const secrets = [
		process.env.OPENAI_API_KEY,
		process.env.ANTHROPIC_API_KEY,
		process.env.BLACKX_COMMAND_API_TOKEN,
		process.env.BLACKX_WORKER_API_TOKEN,
		process.env.BLACKX_OPERATOR_API_TOKEN,
	]
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => right.length - left.length);
  let diagnostic = messages.join(" <- ");
  for (const secret of secrets) diagnostic = diagnostic.replaceAll(secret, "[REDACTED]");
  return diagnostic
    .replace(/(?:sk-ant-|sk-)[A-Za-z0-9_-]{8,}/g, "[REDACTED]")
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .slice(0, 2_000);
}

function header(request: IncomingMessage, name: string): string | undefined {
	const value = request.headers[name];
	return Array.isArray(value) ? value[0] : value;
}

function proposalApiContext(request: IncomingMessage): ProposalApiContext {
	return {
		tenantId: header(request, "x-blackx-tenant-id"),
		workspaceId: header(request, "x-blackx-workspace-id"),
		actorId: header(request, "x-blackx-actor-id"),
		authorization: header(request, "authorization"),
	};
}

function conversationApiContext(request: IncomingMessage) {
	return {
		tenantId: header(request, "x-blackx-tenant-id"),
		workspaceId: header(request, "x-blackx-workspace-id"),
		actorId: header(request, "x-blackx-actor-id"),
	};
}

server.on("request", async (request, response) => {
	response.setHeader("x-frame-options", "DENY");
	response.setHeader("content-security-policy", "frame-ancestors 'none'");
	response.setHeader("referrer-policy", "no-referrer");
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (process.env.BLACKX_RUNTIME_DEBUG === "1" && url.pathname.startsWith("/v1/")) {
    console.error(`[runtime-debug] inbound method=${request.method ?? "unknown"} path=${url.pathname}`);
  }

	if (url.pathname === "/api/local-session" && request.method === "GET") {
		if (!localAccess.canBootstrap(request.headers)) { json(response, 403, { code: "local_access_denied" }); return; }
		response.setHeader("cache-control", "no-store");
		json(response, 200, { token: localAccess.token, identity: localAccess.identity });
		return;
	}
	if (url.pathname.startsWith("/api/")) {
		response.setHeader("cache-control", "no-store");
		response.setHeader("x-content-type-options", "nosniff");
		if (!localAccess.authorize(request.headers)) { json(response, 403, { code: "local_access_denied", message: "本地会话已失效，请刷新页面。" }); return; }
		request.headers["x-blackx-tenant-id"] = localAccess.identity.tenantId;
		request.headers["x-blackx-workspace-id"] = localAccess.identity.workspaceId;
		request.headers["x-blackx-actor-id"] = localAccess.identity.actorId;
	}

  if (request.method === "GET" && url.pathname === "/api/runtime/health") {
    json(response, 200, await runtime.health());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/runtime/turn") {
		if (process.env.BLACKX_ENABLE_RUNTIME_EVAL !== "1") { json(response, 403, { code: "runtime_eval_disabled" }); return; }
    try {
      const payload = await readJson(request);
      if (!isTurnRequest(payload)) {
        json(response, 400, {
          code: "invalid_output",
          message: "Invalid Runtime turn request",
          retryable: false,
        });
        return;
      }

      const controller = new AbortController();
      const timeoutMs = Math.min(Math.max(payload.policy.timeoutMs, 1_000), 120_000);
      const timeout = setTimeout(() => controller.abort("runtime_timeout"), timeoutMs);
      try {
        const result = await runtime.executeTurn({ ...payload, ...localAccess.identity, allowedTools: [], policy: { ...payload.policy, timeoutMs, sandboxMode: "read-only", approvalPolicy: "required" } }, controller.signal);
        json(response, 200, result);
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      if (process.env.BLACKX_RUNTIME_DEBUG === "1") {
        console.error(`[runtime-debug] ${safeRuntimeDiagnostic(error)}`);
      }
      const failure =
        error instanceof RuntimeFailure
          ? error
          : new RuntimeFailure(
              "execution_failed",
              error instanceof Error && error.message === "request_too_large"
                ? "Runtime request is too large"
                : "Runtime request failed",
              false,
            );
      json(response, failure.code === "authentication" ? 401 : 500, {
        code: failure.code,
        message: failure.message,
        retryable: failure.retryable,
      });
    }
    return;
  }

	if (url.pathname === "/api/conversations") {
		const result = request.method === "GET"
			? conversationApi.list(conversationApiContext(request))
			: request.method === "POST"
				? conversationApi.create(conversationApiContext(request))
				: undefined;
		if (result) {
			json(response, result.status, result.body);
			return;
		}
	}

	if (request.method === "GET" && url.pathname === "/api/requirement-brief/metrics") {
		const result = requirementBriefWorkspaceApi.metricsSeries(conversationApiContext(request));
		json(response, result.status, result.body);
		return;
	}

	const filesMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)\/files(?:\/(content|local-content|directories|directories\/([^/]+)|approvals\/([^/]+)))?$/);
	if (filesMatch) {
		try {
			const runId = decodeURIComponent(filesMatch[1]);
			const context = conversationApiContext(request);
			const accessible = conversationApi.get(context, runId);
			if (accessible.status !== 200) { json(response, accessible.status, accessible.body); return; }
			const scope = { tenantId: context.tenantId!, workspaceId: context.workspaceId!, actorId: context.actorId!, runId };
			if (request.method === "GET" && !filesMatch[2]) json(response, 200, conversationFiles.list(scope));
			else if (request.method === "GET" && filesMatch[2] === "content") {
				json(response, 200, conversationFiles.read(scope, url.searchParams.get("path") ?? "", url.searchParams.has("version") ? Number(url.searchParams.get("version")) : undefined));
			} else if (request.method === "GET" && filesMatch[2] === "local-content") {
				json(response, 200, conversationFiles.readLocal(scope, url.searchParams.get("path") ?? ""));
			} else if (request.method === "GET" && filesMatch[2] === "directories") {
				json(response, 200, conversationFiles.browse(scope, url.searchParams.get("path") ?? undefined));
			} else if ((request.method === "POST" && filesMatch[2] === "directories") || (request.method === "DELETE" && filesMatch[3])) {
				json(response, 410, { code: "directory_grants_retired", message: "无需提前授权目录，请直接让 Agent 操作文件，每次写入或删除会发起审批。" });
			} else if (request.method === "POST" && filesMatch[4]) {
				const payload = await readJson(request) as { decision?: unknown };
				if (!payload || !["approved", "rejected"].includes(String(payload.decision))) throw new TaskFileError("file_input_invalid", "审批决定无效", 400);
				conversationFiles.decide(scope, decodeURIComponent(filesMatch[4]), payload.decision as "approved" | "rejected");
				json(response, 200, conversationFiles.list(scope));
			} else json(response, 405, { code: "method_not_allowed", message: "不支持此文件操作" });
		} catch (error) {
			json(response, error instanceof TaskFileError ? error.status : 500, { code: error instanceof TaskFileError ? error.code : "file_store_unavailable", message: error instanceof TaskFileError ? error.message : "无法访问会话文件区" });
		}
		return;
	}

	const attachmentContentMatch = url.pathname.match(
		/^\/api\/conversations\/([^/]+)\/attachments\/([^/]+)\/content$/,
	);
	if (request.method === "GET" && attachmentContentMatch) {
		const context = conversationApiContext(request);
		let conversationId: string;
		let attachmentId: string;
		try {
			conversationId = decodeURIComponent(attachmentContentMatch[1]);
			attachmentId = decodeURIComponent(attachmentContentMatch[2]);
		} catch {
			json(response, 400, { code: "invalid_attachment" });
			return;
		}
		const access = conversationApi.get(context, conversationId);
		if (access.status !== 200) {
			json(response, access.status, access.body);
			return;
		}
		try {
			const stored = conversationAttachments.read({
				tenantId: context.tenantId!,
				workspaceId: context.workspaceId!,
				conversationId,
			}, attachmentId);
			response.writeHead(200, {
				"content-type": stored.attachment.mediaType,
				"content-length": stored.content.byteLength,
				"content-disposition": `${stored.attachment.kind === "image" ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(stored.attachment.name)}`,
				"cache-control": "private, no-store",
				"x-content-type-options": "nosniff",
			});
			response.end(stored.content);
		} catch (error) {
			const known = error instanceof ConversationAttachmentError ? error : undefined;
			json(response, known?.code === "attachment_not_found" ? 404 : 503, {
				code: known?.code ?? "attachment_store_unavailable",
				message: known?.message,
			});
		}
		return;
	}

	const conversationAttachmentsMatch = url.pathname.match(
		/^\/api\/conversations\/([^/]+)\/attachments$/,
	);
	if (conversationAttachmentsMatch && (request.method === "GET" || request.method === "POST")) {
		const context = conversationApiContext(request);
		let conversationId: string;
		try {
			conversationId = decodeURIComponent(conversationAttachmentsMatch[1]);
		} catch {
			json(response, 400, { code: "invalid_attachment" });
			return;
		}
		const access = conversationApi.get(context, conversationId);
		if (access.status !== 200) {
			json(response, access.status, access.body);
			return;
		}
		const attachmentScope = {
			tenantId: context.tenantId!,
			workspaceId: context.workspaceId!,
			conversationId,
		};
		try {
			if (request.method === "GET") {
				json(response, 200, { attachments: conversationAttachments.list(attachmentScope) });
				return;
			}
			const content = await readBody(request, 10 * 1024 * 1024);
			const currentAccess = conversationApi.get(context, conversationId);
			if (currentAccess.status !== 200) { json(response, currentAccess.status, currentAccess.body); return; }
			const result = conversationAttachments.put(attachmentScope, {
				requestId: url.searchParams.get("requestId") ?? "",
				name: url.searchParams.get("name") ?? "",
				mediaType: header(request, "content-type") ?? "application/octet-stream",
				content,
			});
			json(response, result.duplicate ? 200 : 201, result);
		} catch (error) {
			if (error instanceof Error && error.message === "request_too_large") {
				json(response, 413, { code: "request_too_large", message: "附件不能超过 10 MB" });
				return;
			}
			const known = error instanceof ConversationAttachmentError ? error : undefined;
			json(response, known?.code === "attachment_conflict" ? 409 : known?.code === "invalid_attachment" ? 400 : 503, {
				code: known?.code ?? "attachment_store_unavailable",
				message: known?.message,
			});
		}
		return;
	}

	const conversationBackgroundTaskMatch = url.pathname.match(
		/^\/api\/conversations\/([^/]+)\/background-tasks$/,
	);
	if (conversationBackgroundTaskMatch && (request.method === "GET" || request.method === "POST")) {
		let conversationId: string;
		try {
			conversationId = decodeURIComponent(conversationBackgroundTaskMatch[1]);
		} catch {
			json(response, 400, { code: "invalid_conversation_id" });
			return;
		}
		if (request.method === "GET") {
			const result = backgroundTaskApi.list(conversationApiContext(request), conversationId);
			json(response, result.status, result.body);
			return;
		}
		try {
			const result = await backgroundTaskApi.create(
				conversationApiContext(request),
				conversationId,
				await readJson(request),
			);
			json(response, result.status, result.body);
		} catch (error) {
			json(response, 400, {
				code: error instanceof Error && error.message === "request_too_large"
					? "request_too_large"
					: "invalid_json",
			});
		}
		return;
	}

	const conversationCronMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)\/cron-schedules$/);
	if (request.method === "GET" && conversationCronMatch) {
		let conversationId: string;
		try {
			conversationId = decodeURIComponent(conversationCronMatch[1]);
		} catch {
			json(response, 400, { code: "invalid_conversation_id" });
			return;
		}
		const access = conversationApi.get(conversationApiContext(request), conversationId);
		const result = access.status === 200 ? cronApi.list(conversationApiContext(request), conversationId) : access;
		json(response, result.status, result.body);
		return;
	}

	const backgroundTaskMatch = url.pathname.match(/^\/api\/background-tasks\/([^/]+)$/);
	if (request.method === "GET" && backgroundTaskMatch) {
		let taskId: string;
		try {
			taskId = decodeURIComponent(backgroundTaskMatch[1]);
		} catch {
			json(response, 400, { code: "invalid_background_task_id" });
			return;
		}
		const result = backgroundTaskApi.get(conversationApiContext(request), taskId);
		json(response, result.status, result.body);
		return;
	}

	const modelCallsMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)\/model-calls$/);
	if (modelCallsMatch && request.method === "GET") {
		const conversationId = decodeURIComponent(modelCallsMatch[1]);
		const access = conversationApi.get(conversationApiContext(request), conversationId);
		if (access.status !== 200) { json(response, access.status, access.body); return; }
		try {
			const brief = url.searchParams.get("run") === "requirement" ? requirementBriefWorkspaceApi.get(localAccess.identity, conversationId) : undefined;
			const runId = brief ? (brief.body as { requirementBrief?: { runId: string } }).requirementBrief?.runId : conversationId;
			json(response, 200, runId ? services.telemetry.view({ ...localAccess.identity, runId }) : { configuredModel: services.telemetry.configuredModel, calls: [], retentionLimit: services.telemetry.retentionLimit, truncated: false });
		} catch { json(response, 503, { code: "model_metrics_unavailable", message: "模型统计暂时不可用" }); }
		return;
	}

	const conversationControl = url.pathname.match(/^\/api\/conversations\/([^/]+)\/(stop|retry|activity)$/);
	if (conversationControl) {
		const context = conversationApiContext(request);
		const conversationId = conversationControl[1];
		const access = conversationApi.get(context, conversationId);
		if (access.status !== 200) { json(response, access.status, access.body); return; }
		if (request.method === "GET" && conversationControl[2] === "activity") {
			const brief = url.searchParams.get("run") === "requirement" ? requirementBriefWorkspaceApi.get(localAccess.identity, conversationId) : undefined;
			const runId = brief ? (brief.body as { requirementBrief?: { runId: string } }).requirementBrief?.runId : conversationId;
			json(response, 200, { activity: runId ? services.activity.get({ ...localAccess.identity, runId }) : undefined });
		} else if (request.method === "POST" && conversationControl[2] !== "activity") {
			const result = conversationControl[2] === "stop"
				? conversationApi.cancel(context, conversationId)
				: await conversationApi.retry(context, conversationId);
			json(response, result.status, result.body);
		} else json(response, 405, { code: "method_not_allowed" });
		return;
	}

	const conversationMessageMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/);
	if (request.method === "POST" && conversationMessageMatch) {
		try {
			const result = await conversationApi.send(
				conversationApiContext(request),
				decodeURIComponent(conversationMessageMatch[1]),
				await readJson(request),
			);
			json(response, result.status, result.body);
		} catch (error) {
			json(response, 400, {
				code: error instanceof Error && error.message === "request_too_large"
					? "request_too_large"
					: "invalid_json",
			});
		}
		return;
	}

	const conversationTraceMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)\/traces$/);
	if (request.method === "GET" && conversationTraceMatch) {
		let conversationId: string;
		try {
			conversationId = decodeURIComponent(conversationTraceMatch[1]);
		} catch {
			json(response, 400, { code: "invalid_conversation_id" });
			return;
		}
		const result = conversationApi.traces(conversationApiContext(request), conversationId);
		json(response, result.status, result.body);
		return;
	}

	const deliveryMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)\/requirement-brief\/versions\/(\d+)$/);
	if (deliveryMatch && request.method === "GET") {
		const result = requirementBriefWorkspaceApi.delivery(conversationApiContext(request), deliveryMatch[1], Number(deliveryMatch[2]));
		if (result.status !== 200) { json(response, result.status, result.body); return; }
		const { delivery } = result.body as { delivery: RequirementDelivery };
		const format = url.searchParams.get("format");
		if (format === "md" || format === "html") {
			response.writeHead(200, { "content-type": format === "html" ? "text/html; charset=utf-8" : "text/markdown; charset=utf-8", "content-disposition": `attachment; filename="requirement-v${delivery.version}.${format}"`, "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" });
			response.end(format === "html" ? deliveryHtml(delivery) : deliveryMarkdown(delivery));
		} else json(response, 200, { delivery });
		return;
	}

	const requirementApprovalMatch = url.pathname.match(
		/^\/api\/conversations\/([^/]+)\/requirement-brief\/approval$/,
	);
	const requirementCancelMatch = url.pathname.match(
		/^\/api\/conversations\/([^/]+)\/requirement-brief\/cancel$/,
	);
	if (request.method === "POST" && requirementCancelMatch) {
		try {
			const result = requirementBriefWorkspaceApi.cancel(
				conversationApiContext(request),
				decodeURIComponent(requirementCancelMatch[1]),
				await readJson(request),
			);
			json(response, result.status, result.body);
		} catch (error) {
			json(response, 400, {
				code: error instanceof Error && error.message === "request_too_large"
					? "request_too_large"
					: "invalid_json",
			});
		}
		return;
	}
	const requirementFactDecisionMatch = url.pathname.match(
		/^\/api\/conversations\/([^/]+)\/requirement-brief\/facts\/([^/]+)\/decision$/,
	);
	if (request.method === "POST" && requirementFactDecisionMatch) {
		try {
			const result = requirementBriefWorkspaceApi.resolveFact(
				conversationApiContext(request),
				decodeURIComponent(requirementFactDecisionMatch[1]),
				decodeURIComponent(requirementFactDecisionMatch[2]),
				await readJson(request),
			);
			json(response, result.status, result.body);
		} catch (error) {
			json(response, 400, {
				code: error instanceof Error && error.message === "request_too_large"
					? "request_too_large"
					: "invalid_json",
			});
		}
		return;
	}

	const requirementFactsMatch = url.pathname.match(
		/^\/api\/conversations\/([^/]+)\/requirement-brief\/facts$/,
	);
	if (request.method === "POST" && requirementFactsMatch) {
		try {
			const result = requirementBriefWorkspaceApi.recordFact(
				conversationApiContext(request),
				decodeURIComponent(requirementFactsMatch[1]),
				await readJson(request),
			);
			json(response, result.status, result.body);
		} catch (error) {
			json(response, 400, {
				code: error instanceof Error && error.message === "request_too_large"
					? "request_too_large"
					: "invalid_json",
			});
		}
		return;
	}

	if (request.method === "POST" && requirementApprovalMatch) {
		try {
			const result = requirementBriefWorkspaceApi.resolveApproval(
				conversationApiContext(request),
				decodeURIComponent(requirementApprovalMatch[1]),
				await readJson(request),
			);
			json(response, result.status, result.body);
		} catch (error) {
			json(response, 400, {
				code: error instanceof Error && error.message === "request_too_large"
					? "request_too_large"
					: "invalid_json",
			});
		}
		return;
	}

	const conversationRequirementMatch = url.pathname.match(
		/^\/api\/conversations\/([^/]+)\/requirement-brief$/,
	);
	if (conversationRequirementMatch && (request.method === "GET" || request.method === "POST")) {
		try {
			const conversationId = decodeURIComponent(conversationRequirementMatch[1]);
			const result = request.method === "GET"
				? requirementBriefWorkspaceApi.get(conversationApiContext(request), conversationId)
				: requirementBriefWorkspaceApi.start(
					conversationApiContext(request),
					conversationId,
					await readJson(request),
				);
			json(response, result.status, result.body);
		} catch (error) {
			json(response, 400, {
				code: error instanceof Error && error.message === "request_too_large"
					? "request_too_large"
					: "invalid_json",
			});
		}
		return;
	}

	const conversationProposalApprovalMatch = url.pathname.match(
		/^\/api\/conversations\/([^/]+)\/proposal\/approval$/,
	);
	const conversationFactDecisionMatch = url.pathname.match(
		/^\/api\/conversations\/([^/]+)\/proposal\/facts\/([^/]+)\/decision$/,
	);
	if (request.method === "POST" && conversationFactDecisionMatch) {
		try {
			const result = proposalWorkspaceApi.resolveFact(
				conversationApiContext(request),
				decodeURIComponent(conversationFactDecisionMatch[1]),
				decodeURIComponent(conversationFactDecisionMatch[2]),
				await readJson(request),
			);
			json(response, result.status, result.body);
		} catch (error) {
			json(response, 400, {
				code: error instanceof Error && error.message === "request_too_large"
					? "request_too_large"
					: "invalid_json",
			});
		}
		return;
	}

	const conversationFactsMatch = url.pathname.match(
		/^\/api\/conversations\/([^/]+)\/proposal\/facts$/,
	);
	if (request.method === "POST" && conversationFactsMatch) {
		try {
			const result = proposalWorkspaceApi.recordFact(
				conversationApiContext(request),
				decodeURIComponent(conversationFactsMatch[1]),
				await readJson(request),
			);
			json(response, result.status, result.body);
		} catch (error) {
			json(response, 400, {
				code: error instanceof Error && error.message === "request_too_large"
					? "request_too_large"
					: "invalid_json",
			});
		}
		return;
	}

	if (request.method === "POST" && conversationProposalApprovalMatch) {
		try {
			const result = proposalWorkspaceApi.resolveApproval(
				conversationApiContext(request),
				decodeURIComponent(conversationProposalApprovalMatch[1]),
				await readJson(request),
			);
			json(response, result.status, result.body);
		} catch (error) {
			json(response, 400, {
				code: error instanceof Error && error.message === "request_too_large"
					? "request_too_large"
					: "invalid_json",
			});
		}
		return;
	}

	const conversationProposalMatch = url.pathname.match(
		/^\/api\/conversations\/([^/]+)\/proposal$/,
	);
	if (conversationProposalMatch && (request.method === "GET" || request.method === "POST")) {
		try {
			const conversationId = decodeURIComponent(conversationProposalMatch[1]);
			const result = request.method === "GET"
				? proposalWorkspaceApi.get(conversationApiContext(request), conversationId)
				: proposalWorkspaceApi.start(
					conversationApiContext(request),
					conversationId,
					await readJson(request),
				);
			json(response, result.status, result.body);
		} catch (error) {
			json(response, 400, {
				code: error instanceof Error && error.message === "request_too_large"
					? "request_too_large"
					: "invalid_json",
			});
		}
		return;
	}

	const conversationMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)$/);
	if ((request.method === "GET" || request.method === "DELETE") && conversationMatch) {
		let conversationId: string;
		try {
			conversationId = decodeURIComponent(conversationMatch[1]);
		} catch {
			json(response, 400, { code: "invalid_conversation_id" });
			return;
		}
		const result = request.method === "DELETE"
			? conversationApi.delete(conversationApiContext(request), conversationId, (session) => conversationDeletion.cleanup(session))
			: conversationApi.get(conversationApiContext(request), conversationId);
		json(response, result.status, result.body);
		return;
	}

	if (
		request.method === "POST" &&
		url.pathname === "/api/proposal-runs/commands"
	) {
		try {
			const result = proposalApi.execute(
				proposalApiContext(request),
				await readJson(request),
			);
			json(response, result.status, result.body);
		} catch (error) {
			json(response, 400, {
				code:
					error instanceof Error && error.message === "request_too_large"
						? "request_too_large"
						: "invalid_json",
			});
		}
		return;
	}

	const proposalWorkerMatch = url.pathname.match(
		/^\/api\/proposal-runs\/([^/]+)\/execute-proposal$/,
	);
	if (request.method === "POST" && proposalWorkerMatch) {
		try {
			const runId = decodeURIComponent(proposalWorkerMatch[1]);
			const result = await proposalWorkerApi.execute(
				proposalApiContext(request),
				runId,
				await readJson(request),
			);
			json(response, result.status, result.body);
		} catch (error) {
			json(response, 400, {
				code:
					error instanceof Error && error.message === "request_too_large"
						? "request_too_large"
						: "invalid_json",
			});
		}
		return;
	}

	const proposalRunMatch = url.pathname.match(/^\/api\/proposal-runs\/([^/]+)$/);
	if (request.method === "GET" && proposalRunMatch) {
		let runId: string;
		try {
			runId = decodeURIComponent(proposalRunMatch[1]);
		} catch {
			json(response, 400, { code: "invalid_run_id" });
			return;
		}
		const result = proposalApi.query(proposalApiContext(request), runId);
		json(response, result.status, result.body);
		return;
	}

	if (request.method === "GET" && url.pathname === "/api/stage-jobs/metrics") {
		const result = proposalWorkerApi.metrics(proposalApiContext(request));
		json(response, result.status, result.body);
		return;
	}

	if (request.method === "GET" && url.pathname === "/api/stage-jobs/dead-letter") {
		const result = proposalWorkerApi.deadLetters(proposalApiContext(request));
		json(response, result.status, result.body);
		return;
	}

	const stageJobRedriveMatch = url.pathname.match(/^\/api\/stage-jobs\/([^/]+)\/redrive$/);
	if (request.method === "POST" && stageJobRedriveMatch) {
		try {
			const result = proposalWorkerApi.redrive(
				proposalApiContext(request),
				decodeURIComponent(stageJobRedriveMatch[1]),
				await readJson(request),
			);
			json(response, result.status, result.body);
		} catch (error) {
			json(response, 400, {
				code: error instanceof Error && error.message === "request_too_large"
					? "request_too_large"
					: "invalid_json",
			});
		}
		return;
	}

	const stageJobMatch = url.pathname.match(/^\/api\/stage-jobs\/([^/]+)$/);
	if (request.method === "GET" && stageJobMatch) {
		let jobId: string;
		try {
			jobId = decodeURIComponent(stageJobMatch[1]);
		} catch {
			json(response, 400, { code: "invalid_job_id" });
			return;
		}
		const result = proposalWorkerApi.status(proposalApiContext(request), jobId);
		json(response, result.status, result.body);
		return;
	}

  vite.middlewares(request, response, () => {
    json(response, 404, { message: "Not found" });
  });
});

server.listen(port, "127.0.0.1", () => {
	stopStageJobScheduler = stageJobScheduler.start();
  void runtime.health().then((health) => {
    console.log(
      `Blackx listening on http://127.0.0.1:${port} (${health.adapter})`,
    );
  });
});
server.on("close", () => {
	stopStageJobScheduler();
	sqliteStageJobQueue?.close();
});
