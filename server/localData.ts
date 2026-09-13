import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export function configureLocalData(environment: NodeJS.ProcessEnv) {
	const root = resolve(environment.BLACKX_DATA_ROOT ?? ".blackx-data");
	const defaults: Record<string, string> = {
		BLACKX_AGENT_STATE_PATH: "agent", BLACKX_EVENT_STORE_PATH: "events.json", BLACKX_ARTIFACT_STORE_PATH: "artifacts",
		BLACKX_ATTACHMENT_STORE_PATH: "attachments", BLACKX_FILE_STORE_PATH: "files", BLACKX_CRON_SCHEDULE_PATH: "cron-schedules.json",
		BLACKX_STAGE_JOB_QUEUE_PATH: environment.BLACKX_STAGE_JOB_QUEUE_DRIVER === "sqlite" ? "stage-jobs.sqlite" : "stage-jobs.json",
		BLACKX_INSPECTION_CACHE_PATH: "inspection-cache",
	};
	for (const [key, path] of Object.entries(defaults)) {
		// Preserve the historical cache location when only WORKSPACE_ROOT was configured.
		environment[key] ??= key === "BLACKX_INSPECTION_CACHE_PATH" && !environment.BLACKX_DATA_ROOT
			? resolve(environment.BLACKX_WORKSPACE_ROOT ?? ".", ".blackx-data/inspection-cache") : resolve(root, path);
	}
	return { root, paths: Object.fromEntries(Object.keys(defaults).map((key) => [key, resolve(environment[key]!)])) };
}

export function within(root: string, path: string) {
	const part = relative(root, path);
	return part === "" || (!isAbsolute(part) && part !== ".." && !part.startsWith("../"));
}

export function processIsGone(pid: number): boolean {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	try { process.kill(pid, 0); return false; }
	catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

export function recoverLocalLock(root: string) {
	if (realpathSync(root) !== resolve(root)) throw new Error("data_root_must_be_canonical");
	const guard = resolve(root, ".packx-lock-recovery");
	mkdirSync(guard, { mode: 0o700 });
	try {
		const path = resolve(root, ".packx-operation.lock");
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024) throw new Error("unsafe_lock");
		const lock = JSON.parse(readFileSync(path, "utf8"));
		if (typeof lock.token !== "string" || !processIsGone(lock.pid)) throw new Error("lock_owner_alive_or_unknown");
		writeFileSync(resolve(root, `.packx-lock-recovered-${randomUUID()}.json`), JSON.stringify({ type: "local_lock_recovered", oldPid: lock.pid, oldToken: lock.token, at: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
		unlinkSync(path);
	} finally { rmdirSync(guard); }
}

/** The current release only adds a layout marker; future schemas fail closed before stores open. */
export function ensureLocalDataVersion(root: string) {
	const path = resolve(root, ".packx-data-version.json");
	if (existsSync(path)) {
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024) throw new Error("unsafe_data_version");
		const value = JSON.parse(readFileSync(path, "utf8"));
		if (value.schemaVersion !== 1) throw new Error("unsupported_data_version: use a compatible Packx release or restore a pre-upgrade backup");
	} else writeFileSync(path, JSON.stringify({ schemaVersion: 1, adoptedAt: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
}

// One Host or maintenance operation per local data root. Never guess that a lock is stale.
export function lockLocalData(root: string) {
	mkdirSync(root, { recursive: true, mode: 0o700 });
	if (lstatSync(root).isSymbolicLink() || realpathSync(root) !== resolve(root)) throw new Error("data_root_must_be_canonical");
	if (existsSync(resolve(root, ".packx-incomplete"))) throw new Error("data_restore_incomplete");
	const path = resolve(root, ".packx-operation.lock");
	let descriptor: number;
	try { descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); }
	catch { throw new Error("local_data_busy: stop Packx before maintenance; see docs/local-operations.md for crash recovery"); }
	const token = randomUUID();
	writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() }));
	closeSync(descriptor);
	return () => {
		if (existsSync(path) && JSON.parse(readFileSync(path, "utf8")).token === token) unlinkSync(path);
	};
}
