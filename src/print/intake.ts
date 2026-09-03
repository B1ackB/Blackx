import {
  factVersions,
  missingFacts,
  nextFactVersion,
  replay,
  shouldStaleProposal,
} from "../domain/engine";
import type {
  ChatMessage,
  DomainEvent,
  Fact,
  FactKey,
  Proposal,
  WorkspaceState,
} from "../domain/model";

export const factLabels: Record<FactKey, string> = {
  contents: "内容物",
  market: "目标市场",
  netWeight: "净含量",
  shelfLife: "目标保质期",
  quantity: "首单数量",
  dimensions: "成品尺寸",
  fillingMethod: "灌装方式",
};

export const exampleBrief =
  "为中国市场的 250g 咖啡豆做一款可重复封口袋，目标保质期 12 个月，首单 1 万个，品牌稿件稍后提供。";

type WithoutEnvelope<T> = T extends unknown ? Omit<T, "id" | "at"> : never;
type EventDraft = WithoutEnvelope<DomainEvent>;

function id(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function stamp(draft: EventDraft, now = new Date()): DomainEvent {
  return {
    ...draft,
    id: id("evt"),
    at: now.toISOString(),
  } as DomainEvent;
}

function message(role: ChatMessage["role"], content: string): ChatMessage {
  return {
    id: id("msg"),
    role,
    content,
    at: new Date().toISOString(),
  };
}

export function startConversation(): DomainEvent[] {
  return [
    stamp({ type: "run.created", runId: id("run") }),
    stamp({
      type: "message.added",
      message: message(
        "assistant",
        "你好，我是 Blackx。告诉我你想做什么包装，我会先整理事实、查询适用规则，并且只追问真正影响方案的问题。",
      ),
    }),
  ];
}

function makeFact(
  state: WorkspaceState,
  key: FactKey,
  value: string,
  source = "用户对话",
): Fact {
  return {
    key,
    label: factLabels[key],
    value,
    status: "unverified",
    source,
    version: nextFactVersion(state, key),
  };
}

export function extractFacts(state: WorkspaceState, text: string): Fact[] {
  const facts: Fact[] = [];
  const push = (key: FactKey, value: string) => {
    if (state.facts[key]?.value !== value) facts.push(makeFact(state, key, value));
  };

  const content = text.match(/咖啡豆|咖啡粉|茶叶|坚果|宠物食品/);
  if (content) push("contents", content[0]);

  if (/中国(?:大陆)?市场|国内市场/.test(text)) push("market", "中国大陆");

  const weight = text.match(/(\d+(?:\.\d+)?)\s*(kg|g|克|千克)/i);
  if (weight) push("netWeight", `${weight[1]} ${weight[2].toLowerCase()}`);

  const shelfLife = text.match(/(?:保质期[^\d]*)?(\d+)\s*(?:个)?月/);
  if (shelfLife) push("shelfLife", `${shelfLife[1]} 个月`);

  const quantity = text.match(/(?:首单|数量|生产|需要)?[^\d]{0,6}(\d+(?:\.\d+)?)\s*(万|千)?\s*(?:个(?!月)|只|件|pcs)/i);
  if (quantity) {
    const multiplier = quantity[2] === "万" ? 10000 : quantity[2] === "千" ? 1000 : 1;
    push("quantity", `${Number(quantity[1]) * multiplier} 个`);
  }

  const dimensions = text.match(
    /(\d{2,4})\s*[x×*]\s*(\d{2,4})(?:\s*[+＋]\s*(\d{1,4}))?\s*(?:mm|毫米)?/i,
  );
  if (dimensions) {
    push(
      "dimensions",
      `${dimensions[1]} × ${dimensions[2]}${dimensions[3] ? ` + ${dimensions[3]}` : ""} mm`,
    );
  }

  if (/自动灌装/.test(text)) {
    push("fillingMethod", /不充氮/.test(text) ? "自动灌装，不充氮" : /充氮/.test(text) ? "自动灌装，充氮" : "自动灌装");
  } else if (/手工灌装|人工灌装/.test(text)) {
    push("fillingMethod", /充氮/.test(text) ? "手工灌装，充氮" : "手工灌装");
  }

  return facts;
}

function missingQuestion(keys: FactKey[]): string {
  const questions: Partial<Record<FactKey, string>> = {
    contents: "包装里装的具体产品是什么？",
    market: "产品计划在哪个国家或地区销售？",
    shelfLife: "期望达到多长的保质期？",
    quantity: "首单预计生产多少个？",
    dimensions: "你是否已有目标尺寸？可以用“宽 × 高 + 底折，mm”告诉我。",
    fillingMethod: "采用自动还是手工灌装？是否充氮或进行其他气调处理？",
  };
  return keys
    .slice(0, 2)
    .map((key) => questions[key])
    .filter(Boolean)
    .join("\n");
}

function makeProposal(state: WorkspaceState): Proposal {
  return {
    id: state.proposal?.id ?? id("proposal"),
    version: (state.proposal?.version ?? 0) + 1,
    freshness: "fresh",
    approval: "pending",
    title: `${state.facts.contents?.value ?? "产品"}可重复封口袋方案`,
    bagType: "带拉链自立袋（候选）",
    closure: "顶部热封 + 可重复开合拉链（候选）",
    materialCandidate: "PET / AL / PE（演示候选，待材料与阻隔验证）",
    rationale: [
      "自立陈列与重复封口符合当前 Brief 的使用意图。",
      "候选结构以避光和阻隔目标为方向，尚未替代保质期验证。",
      "尺寸与数量已进入版本化输入，变化后方案会自动失效。",
    ],
    verificationRequired: [
      "材料供应商 TDS 与食品接触合规证据",
      "目标保质期对应的阻隔与实物验证",
      "工厂设备能力和热封工艺窗口",
      "试产后的密封与热合强度报告",
    ],
    inputFactVersions: factVersions(state.facts),
  };
}

export function processUserMessage(
  currentEvents: DomainEvent[],
  text: string,
): DomainEvent[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const drafts: EventDraft[] = [
    { type: "message.added", message: message("user", trimmed) },
  ];
  let state = replay([...currentEvents, ...drafts.map((draft) => stamp(draft))]);
  const extracted = extractFacts(state, trimmed);
  let didStaleProposal = false;

  for (const fact of extracted) {
    if (shouldStaleProposal(state.proposal, fact) && state.proposal) {
      didStaleProposal = true;
      drafts.push({
        type: "proposal.staled",
        proposalId: state.proposal.id,
        reason: `${fact.label}发生变化`,
      });
    }
    drafts.push({ type: "fact.recorded", fact });
    state = replay([...currentEvents, ...drafts.map((draft) => stamp(draft))]);
  }

  const missing = missingFacts(state);
  if (missing.length > 0) {
    const extractedSummary = extracted.length
      ? `我记录了：${extracted.map((fact) => `${fact.label}为 ${fact.value}`).join("；")}。\n\n`
      : "";
    drafts.push({
      type: "message.added",
      message: message(
        "assistant",
        `${extractedSummary}为了不猜测会改变方案的参数，还需要确认：\n${missingQuestion(missing)}`,
      ),
    });
    return drafts.map((draft) => stamp(draft));
  }

  if (didStaleProposal && state.proposal) {
    drafts.push({
      type: "message.added",
      message: message(
        "assistant",
        `我已经记录事实变化。Proposal v${state.proposal.version} 及其 Approval A 现在为 stale，不能继续作为当前方案使用。确认后我可以基于最新事实生成 v${state.proposal.version + 1}。`,
      ),
    });
    return drafts.map((draft) => stamp(draft));
  }

  const proposal = makeProposal(state);
  drafts.push({ type: "proposal.generated", proposal });
  drafts.push({
    type: "message.added",
    message: message(
      "assistant",
      `信息已经足够形成第一版候选方案。我创建了《${proposal.title}》v${proposal.version}。袋型、材料和工艺仍保持建议状态；右侧可以查看证据边界并审批这个具体版本。`,
    ),
  });
  return drafts.map((draft) => stamp(draft));
}

export function approveProposal(state: WorkspaceState): DomainEvent[] {
  if (!state.proposal || state.proposal.freshness === "stale") return [];
  return [
    stamp({
      type: "proposal.approved",
      proposalId: state.proposal.id,
      version: state.proposal.version,
    }),
    stamp({
      type: "message.added",
      message: message(
        "assistant",
        `Proposal v${state.proposal.version} 已获得 Approval A。审批绑定的是这个版本；任何依赖事实变化都会使它失效。`,
      ),
    }),
  ];
}

export function recoveryEvent(): DomainEvent {
  return stamp({ type: "run.recovered" });
}
