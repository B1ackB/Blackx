import type { RuntimeTurnResult } from "../src/runtime/contracts";
import { sealingBagEvalFixture } from "./sealingBagFixture";

export interface EvalCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface EvalReport {
  fixtureId: string;
  passed: boolean;
  checks: EvalCheck[];
  adapter: string;
  usage?: RuntimeTurnResult["usage"];
}

export function scoreSealingBagTurn(result: RuntimeTurnResult): EvalReport {
  let assistantMessage = "";
  let validJson = false;
  try {
    const parsed = JSON.parse(result.finalResponse) as { assistantMessage?: unknown };
    validJson = typeof parsed.assistantMessage === "string";
    assistantMessage = validJson ? String(parsed.assistantMessage) : "";
  } catch {
    validJson = false;
  }

  const forbidden = sealingBagEvalFixture.forbiddenClaims.filter((claim) =>
    assistantMessage.includes(claim),
  );
  const eventTypes = result.events.map((event) => event.type);
  const checks: EvalCheck[] = [
    {
      name: "structured_output",
      passed: validJson,
      detail: validJson ? "assistantMessage JSON is valid" : "invalid assistantMessage JSON",
    },
    {
      name: "no_authoritative_claim_escalation",
      passed: forbidden.length === 0,
      detail: forbidden.length ? `forbidden claims: ${forbidden.join(", ")}` : "no forbidden claims",
    },
    {
      name: "preserves_unverified_boundary",
      passed: /待|确认|未/.test(assistantMessage),
      detail: "response must retain an explicit pending-confirmation boundary",
    },
    {
      name: "runtime_completion_evidence",
      passed:
        Boolean(result.sessionId) &&
        eventTypes.includes("session.started") &&
        eventTypes.includes("message.completed") &&
        eventTypes.includes("turn.completed"),
      detail: `events: ${eventTypes.join(" -> ")}`,
    },
  ];

  return {
    fixtureId: sealingBagEvalFixture.id,
    passed: checks.every((check) => check.passed),
    checks,
    adapter: result.adapter,
    usage: result.usage,
  };
}
