import { FakeAgentRuntime } from "../server/runtime/fakeAgentRuntime";
import type { RuntimeTurnResult } from "../src/runtime/contracts";
import { sealingBagEvalFixture } from "./sealingBagFixture";
import { scoreSealingBagTurn } from "./score";

async function runRemote(baseUrl: string): Promise<RuntimeTurnResult> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/runtime/turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(sealingBagEvalFixture.request),
  });
  if (!response.ok) {
    const failure = (await response.json().catch(() => undefined)) as
      | { code?: string; message?: string; retryable?: boolean }
      | undefined;
    const summary = failure
      ? ` (${failure.code ?? "unknown"}: ${failure.message ?? "no message"}; retryable=${String(failure.retryable)})`
      : "";
    throw new Error(`Online Eval endpoint returned HTTP ${response.status}${summary}`);
  }
  return (await response.json()) as RuntimeTurnResult;
}

const remoteUrl = process.env.BLACKX_EVAL_BASE_URL;
const onlineRequired = process.argv.includes("--online");
if (onlineRequired && !remoteUrl) {
  throw new Error("Online Eval requires BLACKX_EVAL_BASE_URL; refusing to run the Fake Runtime");
}
const result = remoteUrl
  ? await runRemote(remoteUrl)
  : await new FakeAgentRuntime().executeTurn(sealingBagEvalFixture.request);
if (process.env.BLACKX_EVAL_DEBUG === "1") {
  console.error(
    JSON.stringify({
      finalResponseLength: result.finalResponse.length,
      finalResponsePreview: result.finalResponse.slice(0, 800),
    }),
  );
}
const report = scoreSealingBagTurn(result);
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
