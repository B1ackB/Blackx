import { describe, expect, it } from "vitest";
import { FakeAgentRuntime } from "../server/runtime/fakeAgentRuntime";
import { scoreSealingBagTurn } from "./score";
import { sealingBagEvalFixture } from "./sealingBagFixture";

describe("fixed sealing bag runtime eval", () => {
  it("passes deterministically with the offline Fake Runtime", async () => {
    const result = await new FakeAgentRuntime().executeTurn(sealingBagEvalFixture.request);
    const report = scoreSealingBagTurn(result);

    expect(report.passed).toBe(true);
    expect(report.checks.every((check) => check.passed)).toBe(true);
  });
});
