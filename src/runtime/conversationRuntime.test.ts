import { describe, expect, it } from "vitest";
import { replay } from "../domain/engine";
import type { DomainEvent } from "../domain/model";
import {
  applyRuntimeResult,
  createRuntimeTurnRequest,
} from "./conversationRuntime";

const at = "2026-08-26T00:00:00.000Z";
const baseEvents: DomainEvent[] = [
  { id: "1", at, type: "run.created", runId: "run-1" },
  {
    id: "2",
    at,
    type: "message.added",
    message: {
      id: "message-1",
      at,
      role: "assistant",
      content: "确定性候选回复",
    },
  },
];

describe("conversation runtime boundary", () => {
  it("passes only an unverified rewrite task to the runtime", () => {
    const request = createRuntimeTurnRequest(
      replay(baseEvents),
      "用户输入",
      [baseEvents[1]],
    );

    expect(JSON.parse(request?.fallbackOutput ?? "{}")).toEqual({
      assistantMessage: "确定性候选回复",
    });
    expect(request?.skills).toEqual(["blackx-print-conversation"]);
    expect(request?.outputSchema).toMatchObject({
      required: ["assistantMessage"],
    });
  });

  it("replaces copy before persistence and links the runtime execution", () => {
	    const events = applyRuntimeResult([baseEvents[1]], {
	      executionId: "execution-1",
	      adapter: "blackx-agent",
			status: "completed",
	      sessionId: "session-1",
      finalResponse: JSON.stringify({ assistantMessage: "自然语言回复" }),
      events: [],
    });

    expect(events[0]).toMatchObject({
      type: "message.added",
      message: { content: "自然语言回复" },
    });
    expect(events[1]).toMatchObject({
      type: "runtime.execution.linked",
      executionId: "execution-1",
      adapter: "blackx-agent",
      sessionId: "session-1",
    });
  });

  it("keeps deterministic copy when runtime JSON is invalid", () => {
    const events = applyRuntimeResult([baseEvents[1]], {
      executionId: "execution-1",
      adapter: "blackx-agent",
			status: "completed",
      finalResponse: "not-json",
      events: [],
    });

    expect(events[0]).toMatchObject({
      type: "message.added",
      message: { content: "确定性候选回复" },
    });
  });
});
