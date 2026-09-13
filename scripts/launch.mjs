import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));
const [major, minor] = process.versions.node.split(".").map(Number);
if (process.platform !== "darwin" || major !== 24 || minor < 14) {
	console.error("Packx requires macOS and Node.js 24.14+ (24.x). See START-HERE.md."); process.exit(1);
}
if (!existsSync("node_modules/tsx")) {
	console.log("Installing the dependencies pinned in package-lock.json. This first step needs internet access.");
	const installed = spawnSync("npm", ["ci", "--include=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { stdio: "inherit", shell: false });
	if (installed.error || installed.status !== 0) process.exit(1);
}
for (const path of ["dist/index.html", ".blackx-tools/asset-inspector", ".blackx-tools/tool-supervisor"]) {
	if (!existsSync(path)) { console.error("Release is incomplete. Download or build a complete Packx release."); process.exit(1); }
}
const environment = { ...process.env, BLACKX_PRODUCTION: "1" };
const host = spawn(process.execPath, ["--env-file-if-exists=.env", "--import", "tsx", "server/index.ts"], { env: environment, stdio: ["inherit", "pipe", "inherit"] });
let opened = false, output = "";
host.stdout.on("data", (chunk) => {
	process.stdout.write(chunk); output = (output + chunk).slice(-1000);
	const address = /Packx listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1];
	if (address && !opened && process.env.PACKX_NO_OPEN !== "1") { opened = true; spawn("/usr/bin/open", [address], { stdio: "ignore" }).unref(); }
});
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => host.kill(signal));
host.once("error", () => { console.error("Packx could not start."); process.exitCode = 1; });
host.once("exit", (code) => {
	if (code) console.error(`Packx stopped. For crash recovery run: npm run state -- recover-lock\nData directory: ${resolve(process.env.BLACKX_DATA_ROOT ?? ".blackx-data")}`);
	process.exitCode = code ?? 1;
});
