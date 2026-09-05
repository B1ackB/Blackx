import type { RuntimeActivity } from "../../src/runtime/conversationContracts";

type Scope = { tenantId: string; workspaceId: string; runId: string };
export class RuntimeActivityStore {
	private readonly active = new Map<string, RuntimeActivity>();
	private key(scope: Scope) { return `${scope.tenantId}\u0000${scope.workspaceId}\u0000${scope.runId}`; }
	get(scope: Scope): RuntimeActivity | null { return this.active.get(this.key(scope)) ?? null; }
	observe(scope: Scope, event: RuntimeActivity): void {
		const key = this.key(scope);
		this.active.delete(key);
		this.active.set(key, event);
		// Live progress is a bounded projection. Durable outcomes remain in RuntimeTrace/Session.
		if (this.active.size > 512) this.active.delete(this.active.keys().next().value!);
	}
}
