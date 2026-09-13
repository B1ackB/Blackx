import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentSessionScope } from "../../src/agent/state";
import { PlanError } from "../../src/enterprise/agentPlan";

/** Presentation metadata is independent of model messages and Plan approval revisions. */
export class TaskNames {
	private readonly db: DatabaseSync;
	constructor(path: string) {
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		this.db = new DatabaseSync(path);
		this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
			CREATE TABLE IF NOT EXISTS task_names (tenant TEXT, workspace TEXT, run TEXT, revision INTEGER,
			name TEXT NOT NULL, actor TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY(tenant,workspace,run,revision));`);
		if (path !== ":memory:") chmodSync(path, 0o600);
	}
	close() { this.db.close(); }
	get(scope: AgentSessionScope): { name?: string; nameRevision: number } {
		const row = this.db.prepare("SELECT name,revision FROM task_names WHERE tenant=? AND workspace=? AND run=? ORDER BY revision DESC LIMIT 1").get(scope.tenantId, scope.workspaceId, scope.runId);
		return row ? { name: String(row.name), nameRevision: Number(row.revision) } : { nameRevision: 0 };
	}
	set(scope: AgentSessionScope, payload: unknown, actor: string) {
		const p = payload as { name?: unknown; nameRevision?: unknown } | null;
		if (!p || typeof p.name !== "string" || !p.name.trim() || p.name.trim().length > 100 || /[\x00-\x1f\x7f]/.test(p.name) || !Number.isSafeInteger(p.nameRevision)) throw new PlanError("invalid_task_name", 400);
		const name = p.name.trim();
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const current = this.get(scope);
			if (current.name !== name) {
				if (current.nameRevision !== p.nameRevision) throw new PlanError("task_name_conflict");
				this.db.prepare("INSERT INTO task_names VALUES (?,?,?,?,?,?,?)").run(scope.tenantId, scope.workspaceId, scope.runId, current.nameRevision + 1, name, actor, new Date().toISOString());
			}
			this.db.exec("COMMIT");
		} catch (error) { this.db.exec("ROLLBACK"); throw error; }
	}
}
