import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compileToolExecutionManifest } from "../../src/agent/sandbox";
import type { ToolExecutionManifest } from "../../src/agent/sandbox";
import {
	compileMacOsSeatbeltProfile,
	diagnoseMacOsSeatbelt,
	MacOsSeatbeltSandboxedToolExecutor,
} from "./macOsSeatbeltSandboxedToolExecutor";

const runSeatbeltTests = process.platform === "darwin" && process.env.BLACKX_RUN_SEATBELT_TESTS === "1";

function manifest(
	workspaceRoot: string,
	overrides: {
		executable?: string;
		argv?: readonly string[];
		readOnly?: readonly string[];
		writable?: readonly string[];
		network?: ToolExecutionManifest["network"];
		limits?: Partial<ToolExecutionManifest["limits"]>;
	} = {},
): ToolExecutionManifest {
	return compileToolExecutionManifest({
		attemptId: randomUUID(),
		tenantId: "tenant-1",
		workspaceId: "workspace-1",
		runId: "run-1",
		stageId: "stage-1",
		executionId: "execution-1",
		toolCallId: "tool-call-1",
		tool: { name: "seatbelt_fixture", version: "1.0.0" },
		command: {
			executable: overrides.executable ?? "/usr/bin/true",
			argv: overrides.argv ?? [],
			workingDirectory: workspaceRoot,
		},
		paths: {
			readOnly: overrides.readOnly ?? [],
			writable: overrides.writable ?? [],
			temporaryDirectory: join(workspaceRoot, ".blackx-tmp", randomUUID()),
		},
		environment: { LANG: "C" },
		network: overrides.network ?? { mode: "deny-all", allowedDomains: [] },
		limits: {
			timeoutMs: 1_000,
			maxStdoutBytes: 8_192,
			maxStderrBytes: 8_192,
			maxOutputFiles: 4,
			maxOutputBytes: 8_192,
			...overrides.limits,
		},
		idempotencyKey: "seatbelt-fixture-1",
	});
}

describe("macOS Seatbelt profile compiler", () => {
	it("denies network and file access before reopening only declared paths", () => {
		const profile = compileMacOsSeatbeltProfile({
			executable: "/usr/bin/sips",
			workingDirectory: "/workspace",
			readOnlyPaths: ["/workspace/input.png"],
			writablePaths: ["/workspace/output"],
			temporaryDirectory: "/workspace/.blackx-tmp/attempt",
		});

		expect(profile).toContain("(deny network*)");
		expect(profile.indexOf("(deny file-read*)")).toBeLessThan(profile.indexOf("/workspace/input.png"));
		expect(profile.indexOf("(deny file-write*)")).toBeLessThan(profile.lastIndexOf("/workspace/output"));
		expect(profile).not.toContain("/Users/");
	});

	it("reports unsupported platforms or missing Seatbelt executables", async () => {
		const diagnostic = await diagnoseMacOsSeatbelt("/missing/sandbox-exec");

		expect(diagnostic).toEqual({
			available: false,
			reason: process.platform === "darwin"
				? "sandbox-exec is unavailable or not executable"
				: "macOS is required",
		});
	});

	it("fails closed instead of spawning without Seatbelt", async () => {
		const executor = new MacOsSeatbeltSandboxedToolExecutor({
			workspaceRoot: "/missing/workspace",
			sandboxExecutable: "/missing/sandbox-exec",
		});

		const failed = await executor.execute(manifest("/missing/workspace"), new AbortController().signal);

		expect(failed).toMatchObject({
			status: "sandbox_unavailable",
			sandbox: { platform: "macos-seatbelt" },
		});
	});
});

describe.skipIf(!runSeatbeltTests)("macOS Seatbelt executor attack regression", () => {
	let workspaceRoot: string;
	let outsideRoot: string;

	beforeEach(() => {
		workspaceRoot = mkdtempSync(join(tmpdir(), "blackx-seatbelt-workspace-"));
		outsideRoot = mkdtempSync(join(tmpdir(), "blackx-seatbelt-outside-"));
		mkdirSync(join(workspaceRoot, ".blackx-tmp"));
	});

	afterEach(() => {
		rmSync(workspaceRoot, { recursive: true, force: true });
		rmSync(outsideRoot, { recursive: true, force: true });
	});

	it("reads only declared Workspace inputs and receives only allowlisted environment values", async () => {
		const input = join(workspaceRoot, "input.txt");
		writeFileSync(input, "allowed-input");
		const executor = new MacOsSeatbeltSandboxedToolExecutor({ workspaceRoot });

		const read = await executor.execute(manifest(workspaceRoot, {
			executable: "/bin/cat",
			argv: [input],
			readOnly: [input],
		}), new AbortController().signal);
		const environment = await executor.execute(manifest(workspaceRoot, {
			executable: "/usr/bin/env",
		}), new AbortController().signal);

		expect(read.stderr.text).toBe("");
		expect(read).toMatchObject({ status: "succeeded", exitCode: 0 });
		expect(read.stdout.text).toBe("allowed-input");
		expect(environment.stdout.text.trim()).toBe("LANG=C");
		expect(environment.stdout.text).not.toContain("ANTHROPIC_API_KEY");
	});

	it("denies undeclared reads and writes even when argv requests them", async () => {
		const outsideInput = join(outsideRoot, "secret.txt");
		const undeclaredInput = join(workspaceRoot, "undeclared-secret.txt");
		const undeclaredOutput = join(workspaceRoot, "undeclared.txt");
		writeFileSync(outsideInput, "secret");
		writeFileSync(undeclaredInput, "workspace-secret");
		const executor = new MacOsSeatbeltSandboxedToolExecutor({ workspaceRoot });

		const outsideRead = await executor.execute(manifest(workspaceRoot, {
			executable: "/bin/cat",
			argv: [outsideInput],
		}), new AbortController().signal);
		const workspaceRead = await executor.execute(manifest(workspaceRoot, {
			executable: "/bin/cat",
			argv: [undeclaredInput],
		}), new AbortController().signal);
		const write = await executor.execute(manifest(workspaceRoot, {
			executable: "/usr/bin/touch",
			argv: [undeclaredOutput],
		}), new AbortController().signal);

		expect(outsideRead.status).toBe("failed");
		expect(outsideRead.stdout.text).not.toContain("secret");
		expect(workspaceRead.status).toBe("failed");
		expect(workspaceRead.stdout.text).not.toContain("workspace-secret");
		expect(write.status).toBe("failed");
		expect(existsSync(undeclaredOutput)).toBe(false);
	});

	it("keeps Git and Blackx control state denied even under a broad Workspace grant", async () => {
		const gitDirectory = join(workspaceRoot, ".git");
		const stateDirectory = join(workspaceRoot, ".blackx-data");
		const gitConfig = join(gitDirectory, "config");
		const stateFile = join(stateDirectory, "events.json");
		mkdirSync(gitDirectory);
		mkdirSync(stateDirectory);
		writeFileSync(gitConfig, "git-secret");
		writeFileSync(stateFile, "state-before");
		const executor = new MacOsSeatbeltSandboxedToolExecutor({ workspaceRoot });

		const read = await executor.execute(manifest(workspaceRoot, {
			executable: "/bin/cat",
			argv: [gitConfig],
			readOnly: [workspaceRoot],
		}), new AbortController().signal);
		const write = await executor.execute(manifest(workspaceRoot, {
			executable: "/usr/bin/touch",
			argv: [stateFile],
			writable: [workspaceRoot],
		}), new AbortController().signal);

		expect(read.status).toBe("failed");
		expect(read.stdout.text).not.toContain("git-secret");
		expect(write.status).toBe("failed");
		expect(readFileSync(stateFile, "utf8")).toBe("state-before");
	});

	it("allows declared writes and hashes staged regular-file outputs before cleanup", async () => {
		const input = join(workspaceRoot, "input.txt");
		const writable = join(workspaceRoot, "output");
		mkdirSync(writable);
		writeFileSync(input, "artifact-output");
		const executor = new MacOsSeatbeltSandboxedToolExecutor({ workspaceRoot });
		const writeManifest = manifest(workspaceRoot, {
			executable: "/usr/bin/touch",
			argv: [join(writable, "allowed.txt")],
			writable: [writable],
		});
		const stagedManifest = manifest(workspaceRoot, {
			executable: "/bin/cp",
			readOnly: [input],
		});
		const stagedPath = join(stagedManifest.paths.temporaryDirectory, "artifact.txt");
		const stagedWithArgv = compileToolExecutionManifest({
			...stagedManifest,
			command: { ...stagedManifest.command, argv: [input, stagedPath] },
		});

		const write = await executor.execute(writeManifest, new AbortController().signal);
		const staged = await executor.execute(stagedWithArgv, new AbortController().signal);

		expect(write.stderr.text).toBe("");
		expect(write.status).toBe("succeeded");
		expect(readFileSync(join(writable, "allowed.txt"))).toHaveLength(0);
		expect(staged).toMatchObject({
			status: "succeeded",
			outputs: [{
				path: "artifact.txt",
				size: Buffer.byteLength("artifact-output"),
				mimeType: "text/plain",
				sha256: createHash("sha256").update("artifact-output").digest("hex"),
			}],
		});
		expect(existsSync(stagedManifest.paths.temporaryDirectory)).toBe(false);
	});

	it("rejects manifest paths outside the configured Workspace before spawn", async () => {
		const outsideInput = join(outsideRoot, "input.txt");
		writeFileSync(outsideInput, "outside");
		const executor = new MacOsSeatbeltSandboxedToolExecutor({ workspaceRoot });

		const denied = await executor.execute(manifest(workspaceRoot, {
			readOnly: [outsideInput],
		}), new AbortController().signal);

		expect(denied).toMatchObject({
			status: "policy_denied",
			sandbox: { terminationReason: "manifest_path_policy_denied" },
		});
	});

	it("rejects symbolic links in permission paths and staged outputs", async () => {
		const outsideInput = join(outsideRoot, "input.txt");
		const linkedInput = join(workspaceRoot, "linked-input.txt");
		writeFileSync(outsideInput, "outside");
		symlinkSync(outsideInput, linkedInput);
		const executor = new MacOsSeatbeltSandboxedToolExecutor({ workspaceRoot });

		const permissionLink = await executor.execute(manifest(workspaceRoot, {
			readOnly: [linkedInput],
		}), new AbortController().signal);
		const outputManifest = manifest(workspaceRoot, { executable: "/bin/ln" });
		const outputLink = join(outputManifest.paths.temporaryDirectory, "linked-output.txt");
		const stagedLink = compileToolExecutionManifest({
			...outputManifest,
			command: { ...outputManifest.command, argv: ["-s", outsideInput, outputLink] },
		});
		const output = await executor.execute(stagedLink, new AbortController().signal);

		expect(permissionLink.status).toBe("policy_denied");
		expect(output).toMatchObject({
			status: "policy_denied",
			sandbox: { terminationReason: "output_validation_failed" },
		});
	});

	it("rejects staged hard links before returning their output manifest", async () => {
		const writable = join(workspaceRoot, "work");
		const source = join(writable, "source.txt");
		mkdirSync(writable);
		writeFileSync(source, "linked-content");
		const executor = new MacOsSeatbeltSandboxedToolExecutor({ workspaceRoot });
		const base = manifest(workspaceRoot, {
			executable: "/bin/ln",
			writable: [writable],
		});
		const linked = compileToolExecutionManifest({
			...base,
			command: {
				...base.command,
				argv: [source, join(base.paths.temporaryDirectory, "hard-link.txt")],
			},
		});

		const output = await executor.execute(linked, new AbortController().signal);

		expect(output).toMatchObject({
			status: "policy_denied",
			outputs: [],
			sandbox: { terminationReason: "output_validation_failed" },
		});
	});

	it("enforces stdout and wall-clock limits and kills the process group", async () => {
		const executor = new MacOsSeatbeltSandboxedToolExecutor({ workspaceRoot });
		const noisy = await executor.execute(manifest(workspaceRoot, {
			executable: "/usr/bin/yes",
			limits: { maxStdoutBytes: 64 },
		}), new AbortController().signal);
		const slow = await executor.execute(manifest(workspaceRoot, {
			executable: "/bin/sh",
			argv: ["-c", "/bin/sleep 10 & echo $!; wait"],
			limits: { timeoutMs: 50 },
		}), new AbortController().signal);

		expect(noisy.status).toBe("resource_exhausted");
		expect(Buffer.byteLength(noisy.stdout.text)).toBeLessThanOrEqual(64);
		expect(noisy.stdout.truncated).toBe(true);
		expect(slow.status).toBe("timed_out");
		expect(slow.durationMs).toBeLessThan(2_000);
		const childPid = Number(slow.stdout.text.trim());
		expect(Number.isSafeInteger(childPid)).toBe(true);
		expect(() => process.kill(childPid, 0)).toThrow();
	});

	it("propagates user cancellation and terminates the sandbox process group", async () => {
		const executor = new MacOsSeatbeltSandboxedToolExecutor({ workspaceRoot });
		const controller = new AbortController();
		const pending = executor.execute(manifest(workspaceRoot, {
			executable: "/bin/sleep",
			argv: ["10"],
		}), controller.signal);
		setTimeout(() => controller.abort(new Error("user_cancelled")), 20);

		const cancelled = await pending;

		expect(cancelled.status).toBe("cancelled");
		expect(cancelled.durationMs).toBeLessThan(2_000);
	});

	it("denies localhost network access before the request reaches the Host", async () => {
		let requests = 0;
		const server = createServer((_request, response) => {
			requests += 1;
			response.end("unexpected");
		});
		await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Local test server did not expose a TCP port");
		const executor = new MacOsSeatbeltSandboxedToolExecutor({ workspaceRoot });

		try {
			const denied = await executor.execute(manifest(workspaceRoot, {
				executable: "/usr/bin/curl",
				argv: ["--silent", "--show-error", "--max-time", "1", `http://127.0.0.1:${address.port}`],
			}), new AbortController().signal);

			expect(denied.status).toBe("failed");
			expect(requests).toBe(0);
		} finally {
			await new Promise<void>((resolveClose, rejectClose) => server.close((error) =>
				error ? rejectClose(error) : resolveClose()
			));
		}
	});

	it("fails closed when domain allowlisting has no trusted Host proxy", async () => {
		const executor = new MacOsSeatbeltSandboxedToolExecutor({ workspaceRoot });

		const denied = await executor.execute(manifest(workspaceRoot, {
			network: { mode: "allowlist", allowedDomains: ["example.com"] },
		}), new AbortController().signal);

		expect(denied).toMatchObject({
			status: "sandbox_unavailable",
			sandbox: { terminationReason: "network_allowlist_proxy_unavailable" },
		});
	});
});
