export type FactStatus = "suggested" | "unverified" | "verified";

export type FactKey =
  | "contents"
  | "market"
  | "netWeight"
  | "shelfLife"
  | "quantity"
  | "dimensions"
  | "fillingMethod";

export interface Fact {
  key: FactKey;
  label: string;
  value: string;
  status: FactStatus;
  source: string;
  version: number;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  at: string;
}

export interface Proposal {
  id: string;
  version: number;
  freshness: "fresh" | "stale";
  approval: "pending" | "approved" | "superseded";
  title: string;
  bagType: string;
  closure: string;
  materialCandidate: string;
  rationale: string[];
  verificationRequired: string[];
  inputFactVersions: Partial<Record<FactKey, number>>;
}

export type RunStatus =
  | "collecting"
  | "proposal_ready"
  | "waiting_approval"
  | "approved";

interface EventBase {
  id: string;
  at: string;
}

export type DomainEvent =
  | (EventBase & { type: "run.created"; runId: string })
  | (EventBase & { type: "message.added"; message: ChatMessage })
  | (EventBase & { type: "fact.recorded"; fact: Fact })
  | (EventBase & { type: "proposal.generated"; proposal: Proposal })
  | (EventBase & { type: "proposal.approved"; proposalId: string; version: number })
  | (EventBase & { type: "proposal.staled"; proposalId: string; reason: string })
  | (EventBase & {
      type: "runtime.execution.linked";
      executionId: string;
		adapter: "fake" | "blackx-agent" | "client-fallback";
		sessionId?: string;
    })
  | (EventBase & {
      type: "runtime.execution.failed";
      code: string;
    })
  | (EventBase & { type: "run.recovered" });

export interface WorkspaceState {
  runId: string | null;
  status: RunStatus;
  messages: ChatMessage[];
  facts: Partial<Record<FactKey, Fact>>;
  proposal: Proposal | null;
  runtime: {
		adapter: "fake" | "blackx-agent" | "client-fallback";
		sessionId?: string;
    lastExecutionId?: string;
    lastFailureCode?: string;
  };
  recoveryCount: number;
  eventCount: number;
}

export const emptyWorkspace: WorkspaceState = {
  runId: null,
  status: "collecting",
  messages: [],
  facts: {},
  proposal: null,
  runtime: { adapter: "client-fallback" },
  recoveryCount: 0,
  eventCount: 0,
};
