import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	DurableStageJobQueue,
	isStageJob,
	StageJobQueueError,
	type StageJob,
	type StageJobQueueOptions,
	type StageJobQueueStorage,
} from "../../src/enterprise/stageJobQueue";

interface QueueDocument {
	schemaVersion: 1;
	jobs: StageJob[];
}

function parseDocument(value: string): QueueDocument {
	try {
		const parsed = JSON.parse(value) as { schemaVersion?: unknown; jobs?: unknown };
		if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.jobs)) throw new Error("invalid_queue_document");
		const jobs = parsed.jobs.map((job) =>
			job && typeof job === "object" && !Array.isArray(job)
				? {
					...job,
					redriveCount: "redriveCount" in job ? job.redriveCount : 0,
					totalFailureCount: "totalFailureCount" in job
						? job.totalFailureCount
						: "failureCount" in job ? job.failureCount : 0,
				}
				: job,
		);
		if (!jobs.every(isStageJob) || new Set(jobs.map((job) => job.jobId)).size !== jobs.length) {
			throw new Error("invalid_stage_job");
		}
		return { schemaVersion: 1, jobs };
	} catch (error) {
		throw new StageJobQueueError("queue_corrupt", "SQLite Stage Job Queue cannot be decoded safely", { cause: error });
	}
}

class SqliteStageJobQueueStorage implements StageJobQueueStorage {
	// ponytail: one transactional document is enough for the single-node baseline;
	// move to row-level claims in PostgreSQL when measured queue contention requires it.
	private readonly database: DatabaseSync;

	constructor(path: string) {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		this.database = new DatabaseSync(path);
		this.database.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
		this.database.exec(`
			CREATE TABLE IF NOT EXISTS stage_job_queue (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				document TEXT NOT NULL
			);
		`);
		this.database.prepare(
			"INSERT OR IGNORE INTO stage_job_queue (id, document) VALUES (1, ?)",
		).run(JSON.stringify({ schemaVersion: 1, jobs: [] }));
		chmodSync(path, 0o600);
	}

	read(): StageJob[] {
		return structuredClone(this.load().jobs);
	}

	transaction<Value>(operation: (jobs: StageJob[]) => Value): Value {
		try {
			this.database.exec("BEGIN IMMEDIATE");
			const document = this.load();
			const jobs = structuredClone(document.jobs);
			const result = operation(jobs);
			if (JSON.stringify(jobs) !== JSON.stringify(document.jobs)) {
				this.database.prepare("UPDATE stage_job_queue SET document = ? WHERE id = 1")
					.run(JSON.stringify({ schemaVersion: 1, jobs }));
			}
			this.database.exec("COMMIT");
			return result;
		} catch (error) {
			try {
				this.database.exec("ROLLBACK");
			} catch {}
			if (error instanceof StageJobQueueError) throw error;
			throw new StageJobQueueError("queue_unavailable", "SQLite Stage Job Queue transaction failed", { cause: error });
		}
	}

	close(): void {
		this.database.close();
	}

	private load(): QueueDocument {
		const row = this.database.prepare("SELECT document FROM stage_job_queue WHERE id = 1").get() as
			| { document: string }
			| undefined;
		if (!row) throw new StageJobQueueError("queue_corrupt", "SQLite Stage Job Queue document is missing");
		return parseDocument(row.document);
	}
}

export class SqliteStageJobQueue extends DurableStageJobQueue {
	private readonly sqliteStorage: SqliteStageJobQueueStorage;

	constructor(path: string, options: StageJobQueueOptions = {}) {
		const storage = new SqliteStageJobQueueStorage(path);
		super(storage, options);
		this.sqliteStorage = storage;
	}

	close(): void {
		this.sqliteStorage.close();
	}
}
