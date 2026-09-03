import type { DomainEvent, WorkspaceState } from "../domain/model";
import type { RuntimeTurnRequest, RuntimeTurnResult } from "./contracts";

export const assistantResponseSchema = {
  type: "object",
  properties: {
    assistantMessage: { type: "string" },
  },
  required: ["assistantMessage"],
  additionalProperties: false,
} as const;

function lastAssistantMessage(events: DomainEvent[]): DomainEvent | undefined {
  return [...events]
    .reverse()
    .find(
      (event) =>
        event.type === "message.added" && event.message.role === "assistant",
    );
}

export function createRuntimeTurnRequest(
  state: WorkspaceState,
  userText: string,
  deterministicEvents: DomainEvent[],
): RuntimeTurnRequest | null {
  const assistantEvent = lastAssistantMessage(deterministicEvents);
  if (!assistantEvent || assistantEvent.type !== "message.added" || !state.runId) {
    return null;
  }

  const fallbackResponse = assistantEvent.message.content;
  const facts = Object.values(state.facts).map((fact) =>
    fact
      ? {
          key: fact.key,
          value: fact.value,
          status: fact.status,
          version: fact.version,
        }
      : null,
  );

  return {
    tenantId: "demo-tenant",
    workspaceId: "demo-workspace",
    runId: state.runId,
    stageId: "proposal",
		actorId: "demo-user",
    idempotencyKey: `turn-${crypto.randomUUID()}`,
		sessionId: state.runtime.sessionId,
		skills: ["blackx-print-conversation"],
		instructions: [
			"程序已经完成事实提取、缺失判断、Artifact 和审批状态转换。",
			"模型输出只能改写候选回复，不能改变权威业务状态。",
		],
    fallbackOutput: JSON.stringify({ assistantMessage: fallbackResponse }),
    outputSchema: assistantResponseSchema,
    policy: {
      sandboxMode: "read-only",
      approvalPolicy: "never",
      timeoutMs: 120_000,
    },
		input: [
			`用户文本：${JSON.stringify(userText)}`,
      `当前项目事实：${JSON.stringify(facts)}`,
      `候选回复：${JSON.stringify(fallbackResponse)}`,
      "只返回符合给定 JSON Schema 的结果。",
    ].join("\n"),
  };
}

function parseAssistantMessage(
  result: RuntimeTurnResult,
  fallback: string,
): string {
  try {
    const parsed = JSON.parse(result.finalResponse) as {
      assistantMessage?: unknown;
    };
    return typeof parsed.assistantMessage === "string" && parsed.assistantMessage.trim()
      ? parsed.assistantMessage.trim()
      : fallback;
  } catch {
    return fallback;
  }
}

export function applyRuntimeResult(
  deterministicEvents: DomainEvent[],
  result: RuntimeTurnResult,
): DomainEvent[] {
  const assistantEvent = lastAssistantMessage(deterministicEvents);
  if (!assistantEvent || assistantEvent.type !== "message.added") {
    return deterministicEvents;
  }

  const content = parseAssistantMessage(
    result,
    assistantEvent.message.content,
  );
  const replaced = deterministicEvents.map((event) =>
    event.id === assistantEvent.id && event.type === "message.added"
      ? { ...event, message: { ...event.message, content } }
      : event,
  );

  return [
    ...replaced,
    {
      id: `evt-${crypto.randomUUID()}`,
      at: new Date().toISOString(),
      type: "runtime.execution.linked",
      executionId: result.executionId,
      adapter: result.adapter,
		sessionId: result.sessionId,
    },
  ];
}

export function runtimeFailureEvent(code: string): DomainEvent {
  return {
    id: `evt-${crypto.randomUUID()}`,
    at: new Date().toISOString(),
    type: "runtime.execution.failed",
    code,
  };
}
