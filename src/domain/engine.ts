import type {
  DomainEvent,
  Fact,
  FactKey,
  Proposal,
  WorkspaceState,
} from "./model";
import { emptyWorkspace } from "./model";

export const requiredProposalFacts: FactKey[] = [
  "contents",
  "market",
  "shelfLife",
  "quantity",
  "dimensions",
  "fillingMethod",
];

export function replay(events: DomainEvent[]): WorkspaceState {
  return events.reduce(reduceEvent, emptyWorkspace);
}

function reduceEvent(state: WorkspaceState, event: DomainEvent): WorkspaceState {
  const next = { ...state, eventCount: state.eventCount + 1 };

  switch (event.type) {
    case "run.created":
      return { ...next, runId: event.runId, status: "collecting" };
    case "message.added":
      return { ...next, messages: [...state.messages, event.message] };
    case "fact.recorded":
      return {
        ...next,
        facts: { ...state.facts, [event.fact.key]: event.fact },
      };
    case "proposal.generated":
      return {
        ...next,
        proposal: event.proposal,
        status: "waiting_approval",
      };
    case "proposal.approved":
      if (
        !state.proposal ||
        state.proposal.id !== event.proposalId ||
        state.proposal.version !== event.version ||
        state.proposal.freshness === "stale"
      ) {
        return next;
      }
      return {
        ...next,
        status: "approved",
        proposal: { ...state.proposal, approval: "approved" },
      };
    case "proposal.staled":
      if (!state.proposal || state.proposal.id !== event.proposalId) return next;
      return {
        ...next,
        status: "collecting",
        proposal: {
          ...state.proposal,
          freshness: "stale",
          approval:
            state.proposal.approval === "approved"
              ? "superseded"
              : state.proposal.approval,
        },
      };
    case "runtime.execution.linked":
      return {
        ...next,
        runtime: {
          adapter: event.adapter,
			sessionId: event.sessionId ?? state.runtime.sessionId,
          lastExecutionId: event.executionId,
        },
      };
    case "runtime.execution.failed":
      return {
        ...next,
        runtime: {
          ...state.runtime,
          adapter: "client-fallback",
          lastFailureCode: event.code,
        },
      };
    case "run.recovered":
      return { ...next, recoveryCount: state.recoveryCount + 1 };
  }
}

export function missingFacts(state: WorkspaceState): FactKey[] {
  return requiredProposalFacts.filter((key) => !state.facts[key]?.value);
}

export function factVersions(
  facts: WorkspaceState["facts"],
): Partial<Record<FactKey, number>> {
  return Object.fromEntries(
    Object.entries(facts).map(([key, fact]) => [key, fact?.version]),
  );
}

export function shouldStaleProposal(
  proposal: Proposal | null,
  nextFact: Fact,
): boolean {
  if (!proposal || proposal.freshness === "stale") return false;
  const usedVersion = proposal.inputFactVersions[nextFact.key];
  return usedVersion !== undefined && usedVersion !== nextFact.version;
}

export function nextFactVersion(
  state: WorkspaceState,
  key: FactKey,
): number {
  return (state.facts[key]?.version ?? 0) + 1;
}
