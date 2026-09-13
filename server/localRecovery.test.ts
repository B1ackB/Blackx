import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { ensureLocalDataVersion, lockLocalData, recoverLocalLock } from "./localData";
import { reapAbandonedInputs } from "./runtime/assetInspection";

it("recovers only a dead owner's lock and staged inputs, then rejects a future data version", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "packx-recovery-")));
	try {
		const release = lockLocalData(root);
		expect(() => recoverLocalLock(root)).toThrow("lock_owner_alive_or_unknown"); release();
		const dead = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" }).pid;
		writeFileSync(join(root, ".packx-operation.lock"), JSON.stringify({ pid: dead, token: "fixture-token" }));
		recoverLocalLock(root); expect(existsSync(join(root, ".packx-operation.lock"))).toBe(false);
		const staging = join(root, "staging"); mkdirSync(staging);
		for (const [name, pid] of [["dead", dead], ["alive", process.pid]] as const) {
			mkdirSync(join(staging, name)); writeFileSync(join(staging, name, ".owner.json"), JSON.stringify({ pid }));
		}
		reapAbandonedInputs(staging);
		expect(existsSync(join(staging, "dead"))).toBe(false); expect(existsSync(join(staging, "alive"))).toBe(true);
		ensureLocalDataVersion(root); expect(JSON.parse(readFileSync(join(root, ".packx-data-version.json"), "utf8")).schemaVersion).toBe(1);
		writeFileSync(join(root, ".packx-data-version.json"), '{"schemaVersion":99}');
		expect(() => ensureLocalDataVersion(root)).toThrow("unsupported_data_version");
	} finally { rmSync(root, { recursive: true, force: true }); }
});
