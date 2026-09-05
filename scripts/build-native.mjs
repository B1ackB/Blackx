import { mkdirSync, statSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

if (process.platform !== "darwin") {
	console.log("Native document inspection requires macOS; other platforms fail closed.");
	process.exit(0);
}
const source = resolve("native/AssetInspector.swift");
const output = resolve(".blackx-tools/asset-inspector");
mkdirSync(resolve(".blackx-tools"), { recursive: true, mode: 0o700 });
if (!existsSync(output) || statSync(source).mtimeMs > statSync(output).mtimeMs) {
	const result = spawnSync("/usr/bin/xcrun", ["swiftc", source, "-O", "-o", output, "-module-cache-path", resolve(".blackx-tools/module-cache")], { stdio: "inherit", shell: false });
	if (result.error || result.status !== 0) {
		console.error("Native parser build failed. Install Apple Command Line Tools and retry npm run build:native.");
		process.exit(1);
	}
}
console.log("Native asset inspector ready.");
