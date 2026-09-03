import { describe, expect, it } from "vitest";
import { replay, shouldStaleProposal } from "./engine";
import type { DomainEvent, Fact, Proposal } from "./model";

const at = "2026-08-26T00:00:00.000Z";

describe("domain event replay", () => {
  it("binds approval to a concrete proposal version", () => {
    const proposal: Proposal = {
      id: "proposal-1",
      version: 1,
      freshness: "fresh",
      approval: "pending",
      title: "test",
      bagType: "suggested",
      closure: "suggested",
      materialCandidate: "suggested",
      rationale: [],
      verificationRequired: [],
      inputFactVersions: { quantity: 1 },
    };
    const events: DomainEvent[] = [
      { id: "1", at, type: "run.created", runId: "run-1" },
      { id: "2", at, type: "proposal.generated", proposal },
      { id: "3", at, type: "proposal.approved", proposalId: "proposal-1", version: 1 },
    ];

    expect(replay(events).proposal?.approval).toBe("approved");
    expect(replay(events).status).toBe("approved");
  });

  it("supersedes approval after an input fact changes", () => {
    const proposal: Proposal = {
      id: "proposal-1",
      version: 1,
      freshness: "fresh",
      approval: "approved",
      title: "test",
      bagType: "suggested",
      closure: "suggested",
      materialCandidate: "suggested",
      rationale: [],
      verificationRequired: [],
      inputFactVersions: { quantity: 1 },
    };
    const events: DomainEvent[] = [
      { id: "1", at, type: "run.created", runId: "run-1" },
      { id: "2", at, type: "proposal.generated", proposal },
      { id: "3", at, type: "proposal.staled", proposalId: "proposal-1", reason: "quantity changed" },
    ];

    const state = replay(events);
    expect(state.proposal?.freshness).toBe("stale");
    expect(state.proposal?.approval).toBe("superseded");
  });

  it("detects changes to facts consumed by a proposal", () => {
    const proposal = {
      id: "proposal-1",
      version: 1,
      freshness: "fresh",
      approval: "approved",
      title: "test",
      bagType: "test",
      closure: "test",
      materialCandidate: "test",
      rationale: [],
      verificationRequired: [],
      inputFactVersions: { quantity: 1 },
    } satisfies Proposal;
    const changedFact: Fact = {
      key: "quantity",
      label: "quantity",
      value: "20000",
      status: "unverified",
      source: "user",
      version: 2,
    };

    expect(shouldStaleProposal(proposal, changedFact)).toBe(true);
  });
});
