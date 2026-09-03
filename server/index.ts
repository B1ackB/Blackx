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

const workingDirectory = resolve(process.cwd());
const port = Number(process.env.BLACKX_PORT ?? 5173);
const eventStore = new FileEnterpriseEventStore(
	resolve(
			process.env.BLACKX_EVENT_STORE_PATH ??
				".blackx-data/events.json",
	),
);
const proposalEngine = new ProposalRunEngine(eventStore);
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
const services = createRuntime(process.env, {
	tools: [...createAutomationTools(stageJobQueue, cronScheduleStore), researchSourceTool],
	autonomouslyApprovedTools: automationWriteToolNames,
});
const { runtime, state: agentState } = services;
const conversationApi = new ConversationApiController(runtime, agentState, undefined, undefined, automationToolNames);
const stageJobOutbox = new StageJobOutbox(proposalEngine, eventStore, stageJobQueue);
const cronDispatcher = new CronDispatcher(cronScheduleStore, stageJobQueue);
const backgroundConversationWorker = new BackgroundConversationWorker(conversationApi);
const artifactStore = new FileArtifactContentStore(
	resolve(
		process.env.BLACKX_ARTIFACT_STORE_PATH ??
			".blackx-data/artifacts",
	),
);
const stageJobScheduler = new StageJobScheduler(
	stageJobQueue,
	new ProposalWorker(
		proposalEngine,
		runtime,
		artifactStore,
	),
	{
		workerId: process.env.BLACKX_WORKER_ID ?? `local-${process.pid}`,
		leaseMs: Number(process.env.BLACKX_WORKER_LEASE_MS ?? 135_000),
		pollIntervalMs: Number(process.env.BLACKX_WORKER_POLL_MS ?? 250),
		handlers: {
			"conversation-background": (lease) => backgroundConversationWorker.execute(lease),
		},
		dispatchOutbox: () => {
			stageJobOutbox.dispatchOne();
			cronDispatcher.dispatchDue();
		},
		onError: (error) => {
			const code = error instanceof Error ? error.name : "unknown_error";
			console.error(`[stage-job-scheduler] ${code}`);
		},
	},
);
const backgroundTaskApi = new BackgroundTaskApiController(stageJobQueue, conversationApi, runtime);
const cronApi = new CronApiController(cronScheduleStore);
const proposalWorkspaceApi = new ProposalWorkspaceApiController(
	conversationApi,
	proposalEngine,
	artifactStore,
	stageJobOutbox,
	stageJobScheduler,
);
const proposalWorkerApi = new ProposalWorkerApiController(
	stageJobScheduler,
	stageJobOutbox,
	process.env.BLACKX_WORKER_API_TOKEN,
	process.env.BLACKX_OPERATOR_API_TOKEN,
);
let stopStageJobScheduler = () => {};
const vite = await createViteServer({
	server: { middlewareMode: true, hmr: { port: port + 20_000 } },
	appType: "spa",
});

function json(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > 256_000) throw new Error("request_too_large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
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

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (process.env.BLACKX_RUNTIME_DEBUG === "1" && url.pathname.startsWith("/v1/")) {
    console.error(`[runtime-debug] inbound method=${request.method ?? "unknown"} path=${url.pathname}`);
  }

  if (request.method === "GET" && url.pathname === "/api/runtime/health") {
    json(response, 200, await runtime.health());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/runtime/turn") {
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
        const result = await runtime.executeTurn(payload, controller.signal);
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
		const result = cronApi.list(conversationApiContext(request), conversationId);
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
	if (request.method === "GET" && conversationMatch) {
		let conversationId: string;
		try {
			conversationId = decodeURIComponent(conversationMatch[1]);
		} catch {
			json(response, 400, { code: "invalid_conversation_id" });
			return;
		}
		const result = conversationApi.get(conversationApiContext(request), conversationId);
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
