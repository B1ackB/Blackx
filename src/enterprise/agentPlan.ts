import type { RuntimeUsage } from "../runtime/contracts";

export type AgentMode = "execute" | "plan";
export type PlanStatus = "planning" | "awaiting_confirmation" | "queued" | "running" | "paused" | "completed" | "failed" | "cancelled" | "superseded";
export interface PlanTask {
	title: string;
	objective: string;
	tools: string[];
}
export interface PlanSpec {
	summary: string;
	tasks: PlanTask[];
}
export interface SubagentResult {
	summary: string;
	evidence: string[];
	limitations: string[];
}
export interface PlanVersion {
	version: number;
	objective: string;
	context: string;
	conversationRevision: number;
	status: PlanStatus;
	createdAt: string;
	actorId: string;
	spec?: PlanSpec;
	approval?: { actorId: string; version: number; at: string };
	generation: number;
	calls: number;
	children: Array<{ taskIndex: number; sessionId: string; executionId: string; result: SubagentResult; usage?: RuntimeUsage }>;
	activeTask?: number;
	failure?: { code: string; retryable: boolean };
}
export interface PlanWorkspace {
	revision: number;
	mode: AgentMode;
	versions: PlanVersion[];
}
export interface PlanScope { tenantId: string; workspaceId: string; runId: string }
export const PLAN_LIMITS = { tasks: 4, calls: 16, iterations: 4, tools: 8, inputTokens: 12_000, timeoutMs: 60_000 } as const;
export class PlanError extends Error {
	constructor(readonly code: string, readonly status = 409) { super(code); this.name = "PlanError"; }
}
const bounded = (v: unknown, max: number): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export function parsePlan(value: unknown, allowedTools: readonly string[]): PlanSpec {
	if (!record(value) || Object.keys(value).some((key) => !["summary", "tasks"].includes(key)) || !bounded(value.summary, 2000) || !Array.isArray(value.tasks) || !value.tasks.length || value.tasks.length > PLAN_LIMITS.tasks) throw new PlanError("invalid_plan", 422);
	const tasks = value.tasks.map((task): PlanTask => {
		if (!record(task) || Object.keys(task).some((key) => !["title", "objective", "tools"].includes(key)) || !bounded(task.title, 120) || !bounded(task.objective, 4000) || !Array.isArray(task.tools) || task.tools.length > allowedTools.length || task.tools.some((tool) => typeof tool !== "string" || !allowedTools.includes(tool))) throw new PlanError("invalid_plan_task", 422);
		return { title: task.title, objective: task.objective, tools: [...new Set(task.tools as string[])] };
	});
	return { summary: value.summary, tasks };
}
export function parseSubagentResult(value: unknown): SubagentResult {
	if (!record(value) || Object.keys(value).some((key) => !["summary", "evidence", "limitations"].includes(key)) || !bounded(value.summary, 8000) || ![value.evidence, value.limitations].every((v) => Array.isArray(v) && v.length <= 20 && v.every((s) => bounded(s, 1000)))) throw new PlanError("invalid_subagent_result", 422);
	return { summary: value.summary, evidence: value.evidence as string[], limitations: value.limitations as string[] };
}
export const planSchema = {
	type: "object", additionalProperties: false, required: ["summary", "tasks"], properties: {
		summary: { type: "string", maxLength: 2000 },
		tasks: { type: "array", minItems: 1, maxItems: 4, items: { type: "object", additionalProperties: false, required: ["title", "objective", "tools"], properties: { title: { type: "string", maxLength: 120 }, objective: { type: "string", maxLength: 4000 }, tools: { type: "array", items: { type: "string" } } } } },
	},
};
export const subagentResultSchema = {
	type: "object", additionalProperties: false, required: ["summary", "evidence", "limitations"], properties: {
		summary: { type: "string", maxLength: 8000 },
		evidence: { type: "array", maxItems: 20, items: { type: "string", maxLength: 1000 } },
		limitations: { type: "array", maxItems: 20, items: { type: "string", maxLength: 1000 } },
	},
};

export function validPlanWorkspace(value: unknown): value is PlanWorkspace {
	if (!record(value) || !Number.isInteger(value.revision) || Number(value.revision) < 1 || !["plan", "execute"].includes(String(value.mode)) || !Array.isArray(value.versions)) return false;
	try {
		return value.versions.every((p, index) => {
			if (!record(p) || p.version !== index + 1 || !bounded(p.objective, 8000) || typeof p.context !== "string" || !Number.isInteger(p.conversationRevision) || Number(p.conversationRevision) < 0 || !["planning", "awaiting_confirmation", "queued", "running", "paused", "completed", "failed", "cancelled", "superseded"].includes(String(p.status)) || !Number.isInteger(p.calls) || Number(p.calls) < 0 || Number(p.calls) > PLAN_LIMITS.calls || !Number.isInteger(p.generation) || Number(p.generation) < 1 || !bounded(p.actorId, 128) || typeof p.createdAt !== "string" || !Number.isFinite(Date.parse(p.createdAt)) || !Array.isArray(p.children) || p.children.length > PLAN_LIMITS.tasks) return false;
			const declaredTools = record(p.spec) && Array.isArray(p.spec.tasks) ? p.spec.tasks.flatMap((t) => record(t) && Array.isArray(t.tools) ? t.tools.filter((tool): tool is string => bounded(tool, 128)) : []) : [];
			const spec = p.spec === undefined ? undefined : parsePlan(p.spec, declaredTools);
			if (["awaiting_confirmation", "queued", "running", "paused", "completed"].includes(String(p.status)) && !spec) return false;
			if (p.approval !== undefined && (!record(p.approval) || p.approval.version !== p.version || !bounded(p.approval.actorId, 128) || typeof p.approval.at !== "string" || !Number.isFinite(Date.parse(p.approval.at)))) return false;
			if (["queued", "running", "paused", "completed"].includes(String(p.status)) && !p.approval) return false;
			if (p.status === "completed" && p.children.length !== spec?.tasks.length) return false;
			return p.children.every((child, i) => record(child) && child.taskIndex === i && i < (spec?.tasks.length ?? 0) && bounded(child.sessionId, 128) && bounded(child.executionId, 128) && !!parseSubagentResult(child.result));
		});
	} catch { return false; }
}
