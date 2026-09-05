import type {
	SandboxedToolExecutorPort,
	ToolExecutionManifest,
	ToolExecutionResult,
} from "../../src/agent/sandbox";

export class FakeSandboxedToolExecutor implements SandboxedToolExecutorPort {
	readonly manifests: ToolExecutionManifest[] = [];

	constructor(
		private readonly handler: (
			manifest: ToolExecutionManifest,
			signal: AbortSignal,
		) => Promise<ToolExecutionResult>,
	) {}

	async execute(manifest: ToolExecutionManifest, signal: AbortSignal): Promise<ToolExecutionResult> {
		this.manifests.push(manifest);
		return this.handler(manifest, signal);
	}
}
