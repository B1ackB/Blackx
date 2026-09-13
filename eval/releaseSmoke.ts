import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const archive = resolve(process.argv[2] ?? `releases/Packx-0.1.0-macos-${process.arch}.tar.gz`);
const root = realpathSync(mkdtempSync(join(tmpdir(), "packx-release-smoke-")));
let launcher: ChildProcess | undefined;
const stop = async () => {
	if (!launcher || launcher.exitCode !== null || launcher.signalCode !== null) return;
	const exited = once(launcher, "exit"); launcher.kill("SIGTERM"); await exited;
};
try {
	assert.equal(spawnSync("/usr/bin/tar", ["-xzf", archive, "-C", root]).status, 0);
	const release = JSON.parse(readFileSync(join(root, "packx-release.json"), "utf8"));
	for (const file of release.files) assert.equal(createHash("sha256").update(readFileSync(join(root, file.path))).digest("hex"), file.sha256);
	assert.equal(release.arch, process.arch);
	// Reuse this checkout's installed dependencies. This proves relocation, not a clean-device npm install.
	symlinkSync(resolve("node_modules"), join(root, "node_modules"), "dir");
	const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
	const port = (reservation.address() as { port: number }).port;
	await new Promise<void>((done) => reservation.close(() => done()));
	const base = `http://127.0.0.1:${port}`;
	const start = async () => {
		launcher = spawn(process.execPath, ["scripts/launch.mjs"], { cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: tmpdir(), PACKX_NO_OPEN: "1", BLACKX_PORT: String(port), BLACKX_RUNTIME_MODE: "fake", ANTHROPIC_API_KEY: "", BLACKX_DATA_ROOT: join(root, ".blackx-data"), PACKX_SETTINGS_PATH: join(root, ".packx-settings.json") }, stdio: ["ignore", "pipe", "pipe"] });
		let logs = ""; launcher.stdout!.on("data", (c) => { logs += c; }); launcher.stderr!.on("data", (c) => { logs += c; });
		for (let i = 0; i < 150; i++) {
			assert.equal(launcher.exitCode, null, logs);
			if (logs.includes("Packx listening")) return;
			await delay(50);
		}
		throw new Error("release_start_timeout");
	};
	const token = async () => (await fetch(`${base}/api/local-session`, { headers: { "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" } }).then((r) => r.json()) as { token: string }).token;
	await start();
	let auth = await token();
	const request = async (path: string, method = "GET", body?: unknown) => {
		const response = await fetch(`${base}${path}`, { method, headers: { "x-blackx-session-token": auth, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
		assert(response.ok, `${path}: ${response.status}`);
		return await response.json() as Record<string, any>;
	};
	const html = await fetch(base).then((r) => r.text());
	assert(html.includes("/assets/")); assert(!html.includes("/src/main.tsx"));
	for (const path of ["/src/App.tsx", "/.env", "/.packx-settings.json", "/assets/%2e%2e/server/index.ts"]) assert.equal((await fetch(base + path)).status, 404);
	const created = (await request("/api/conversations", "POST", {})).conversation;
	await request(`/api/conversations/${created.conversationId}`, "PATCH", { name: "发行重启验收", nameRevision: 0 });
	const saved = await request("/api/model-settings", "PUT", { revision: 0, mode: "anthropic", baseUrl: "http://127.0.0.1:1", model: "release-offline-fixture", apiKey: "synthetic-private-key" });
	assert.equal(saved.restartRequired, true); assert.equal(saved.apiKey, undefined);
	assert.equal((await request("/api/runtime/health")).adapter, "fake");
	await stop(); await start(); auth = await token();
	assert.equal((await request("/api/model-settings")).restartRequired, false);
	assert.equal((await request("/api/runtime/health")).adapter, "blackx-agent");
	assert.equal((await request(`/api/conversations/${created.conversationId}`)).conversation.title, "发行重启验收");
	console.log("PASS: release digests, relocated launcher, static frontend isolation, private settings and task names across restart; reused local dependencies, no model calls.");
} finally { await stop(); rmSync(root, { recursive: true, force: true }); }
