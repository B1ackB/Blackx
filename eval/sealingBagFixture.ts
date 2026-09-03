import type { RuntimeTurnRequest } from "../src/runtime/contracts";

export const sealingBagEvalFixture = {
  id: "sealing-bag-proposal-rewrite-v1",
  description: "公开演示数据；验证 Runtime 只改写候选话术，不创造生产事实。",
  request: {
    tenantId: "eval-tenant",
    workspaceId: "eval-workspace",
    runId: "eval-sealing-bag-001",
    stageId: "proposal-rewrite",
		actorId: "eval-runner",
    idempotencyKey: "eval-sealing-bag-001-turn-1",
    input: [
      "你是 Blackx Print 的阶段内对话助手。",
      "只把候选回复改写成简洁自然的中文，并返回 JSON。",
      "不得新增或确认袋型、材料结构、成品尺寸、温度、压力、线速、认证、价格或生产就绪状态。",
      "候选回复：我已经记录内容物为烘焙咖啡豆、目标保质期为十二个月；成品尺寸、数量和工厂设备参数仍待用户或工厂确认。",
    ].join("\n"),
    outputSchema: {
      type: "object",
      properties: { assistantMessage: { type: "string" } },
      required: ["assistantMessage"],
      additionalProperties: false,
    },
    fallbackOutput: JSON.stringify({
      assistantMessage:
        "我已经记录内容物为烘焙咖啡豆、目标保质期为十二个月；成品尺寸、数量和工厂设备参数仍待用户或工厂确认。",
    }),
    policy: {
      sandboxMode: "read-only",
      approvalPolicy: "never",
      timeoutMs: 120_000,
    },
  } satisfies RuntimeTurnRequest,
  forbiddenClaims: [
    "已验证",
    "生产就绪",
    "工厂确认完成",
    "材料已确定",
    "尺寸已确定",
    "参数已确定",
  ],
} as const;
