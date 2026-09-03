import { describe, expect, it, vi } from "vitest";
import { replay } from "../domain/engine";
import { emptyWorkspace } from "../domain/model";
import {
  approveProposal,
  exampleBrief,
  extractFacts,
  processUserMessage,
  recoveryEvent,
  startConversation,
} from "./intake";

vi.stubGlobal("crypto", { randomUUID: () => "fixed-id" });

describe("print intake conversation", () => {
  it("extracts authoritative project inputs without inventing missing facts", () => {
    const facts = extractFacts(emptyWorkspace, exampleBrief);
    const keys = facts.map((fact) => fact.key);

    expect(keys).toContain("contents");
    expect(keys).toContain("market");
    expect(keys).toContain("shelfLife");
    expect(keys).toContain("quantity");
    expect(facts.find((fact) => fact.key === "quantity")?.value).toBe("10000 个");
    expect(keys).not.toContain("dimensions");
    expect(keys).not.toContain("fillingMethod");
  });

  it("does not mistake the classifier in shelf life for a quantity unit", () => {
    const facts = extractFacts(
      emptyWorkspace,
      "内容物为烘焙咖啡豆，目标保质期 12 个月；成品尺寸、数量和设备参数仍待确认。",
    );

    expect(facts.find((fact) => fact.key === "shelfLife")?.value).toBe("12 个月");
    expect(facts.some((fact) => fact.key === "quantity")).toBe(false);
  });

  it("creates a proposal only after blocking inputs are supplied", () => {
    let events = startConversation();
    events = [...events, ...processUserMessage(events, exampleBrief)];
    expect(replay(events).proposal).toBeNull();

    events = [
      ...events,
      ...processUserMessage(events, "尺寸 160 × 230 + 80 mm；自动灌装并充氮。"),
    ];

    const state = replay(events);
    expect(state.proposal?.version).toBe(1);
    expect(state.proposal?.materialCandidate).toContain("待材料与阻隔验证");
  });

  it("invalidates an approved proposal after quantity changes", () => {
    let events = startConversation();
    events = [...events, ...processUserMessage(events, exampleBrief)];
    events = [
      ...events,
      ...processUserMessage(events, "尺寸 160 × 230 + 80 mm；自动灌装并充氮。"),
    ];
    events = [...events, ...approveProposal(replay(events))];
    expect(replay(events).proposal?.approval).toBe("approved");

    events = [...events, ...processUserMessage(events, "数量改为 20000 个。")];
    const state = replay(events);
    expect(state.proposal?.freshness).toBe("stale");
    expect(state.proposal?.approval).toBe("superseded");
  });

  it("regenerates a new proposal version from the latest fact versions", () => {
    let events = startConversation();
    events = [...events, ...processUserMessage(events, exampleBrief)];
    events = [
      ...events,
      ...processUserMessage(events, "尺寸 160 × 230 + 80 mm；自动灌装并充氮。"),
    ];
    events = [...events, ...approveProposal(replay(events))];
    events = [...events, ...processUserMessage(events, "数量改为 20000 个。")];

    expect(replay(events).proposal?.freshness).toBe("stale");

    events = [
      ...events,
      ...processUserMessage(events, "请根据更新后的事实重新生成方案。"),
    ];
    const state = replay(events);
    expect(state.proposal?.version).toBe(2);
    expect(state.proposal?.freshness).toBe("fresh");
    expect(state.proposal?.approval).toBe("pending");
    expect(state.proposal?.inputFactVersions.quantity).toBe(2);
  });

  it("replays a recovery event without losing business state", () => {
    let events = startConversation();
    events = [...events, ...processUserMessage(events, exampleBrief)];
    const beforeRecovery = replay(events);
    events = [...events, recoveryEvent()];
    const afterRecovery = replay(events);

    expect(afterRecovery.facts).toEqual(beforeRecovery.facts);
    expect(afterRecovery.messages).toEqual(beforeRecovery.messages);
    expect(afterRecovery.recoveryCount).toBe(1);
  });
});
