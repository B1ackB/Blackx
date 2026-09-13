import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PlanError, validPlanWorkspace, type PlanScope, type PlanWorkspace } from "../../src/enterprise/agentPlan";

// Append-only state events retain every proposed plan and its approval lineage.
// SQLite owns atomic compare-and-swap; there is no second mutable state file.
export class AgentPlanStore {
	private readonly db: DatabaseSync;
	constructor(path: string, private readonly now: () => string = () => new Date().toISOString()) {
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		this.db = new DatabaseSync(path);
		this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
			CREATE TABLE IF NOT EXISTS plan_events (
				tenant TEXT NOT NULL, workspace TEXT NOT NULL, run TEXT NOT NULL,
				revision INTEGER NOT NULL, command TEXT NOT NULL, digest TEXT NOT NULL,
				actor TEXT NOT NULL, type TEXT NOT NULL, at TEXT NOT NULL, state TEXT NOT NULL,
				PRIMARY KEY (tenant, workspace, run, revision), UNIQUE (tenant, workspace, run, command)
			);`);
		if (path !== ":memory:") chmodSync(path, 0o600);
	}
	close() { this.db.close(); }
	read(scope: PlanScope): PlanWorkspace {
		const row = this.db.prepare("SELECT state FROM plan_events WHERE tenant=? AND workspace=? AND run=? ORDER BY revision DESC LIMIT 1").get(scope.tenantId, scope.workspaceId, scope.runId);
		if (!row) return { revision: 0, mode: "execute", versions: [] };
		try {
			const state = JSON.parse(String(row.state)) as PlanWorkspace;
			if (!validPlanWorkspace(state)) throw new Error();
			return state;
		} catch { throw new PlanError("plan_store_corrupt", 503); }
	}
	scopes(): PlanScope[] {
		return this.db.prepare("SELECT DISTINCT tenant, workspace, run FROM plan_events").all().map((r) => ({ tenantId: String(r.tenant), workspaceId: String(r.workspace), runId: String(r.run) }));
	}
	change(scope: PlanScope, command: string, digest: string, actor: string, type: string, expected: number, update: (state: PlanWorkspace) => void): PlanWorkspace {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const duplicate = this.db.prepare("SELECT digest FROM plan_events WHERE tenant=? AND workspace=? AND run=? AND command=?").get(scope.tenantId, scope.workspaceId, scope.runId, command);
			const state = this.read(scope);
			if (duplicate) {
				if (duplicate.digest !== digest) throw new PlanError("plan_command_conflict");
			} else {
				if (state.revision !== expected) throw new PlanError("plan_revision_conflict");
				update(state);
				state.revision++;
				if (!validPlanWorkspace(state)) throw new PlanError("invalid_plan_state", 503);
				this.db.prepare("INSERT INTO plan_events VALUES (?,?,?,?,?,?,?,?,?,?)").run(scope.tenantId, scope.workspaceId, scope.runId, state.revision, command, digest, actor, type, this.now(), JSON.stringify(state));
			}
			this.db.exec("COMMIT");
			return state;
		} catch (error) { this.db.exec("ROLLBACK"); throw error; }
	}
}
