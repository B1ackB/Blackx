import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { ModelSettings } from "./modelSettings";

const roots: string[] = [];
function setup() { const root = mkdtempSync(join(tmpdir(), "packx-settings-")); roots.push(root); return join(root, "private.json"); }
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));
const input = { revision: 0, mode: "anthropic" as const, baseUrl: "https://example.invalid", model: "fixture-model", apiKey: "fixture-secret" };
describe("private model configuration", () => {
	it("persists privately, masks credentials and applies only on the next startup", () => {
		const path = setup(), environment = { BLACKX_RUNTIME_MODE: "fake" };
		const settings = new ModelSettings(path, environment);
		const saved = settings.save(input, "local-user");
		expect(saved).toMatchObject({ keyConfigured: true, restartRequired: true, revision: 1 });
		expect(JSON.stringify(saved)).not.toContain("fixture-secret");
		expect(environment.BLACKX_RUNTIME_MODE).toBe("fake");
		expect(statSync(path).mode & 0o777).toBe(0o600);
		const next = new ModelSettings(path, environment), applied: NodeJS.ProcessEnv = { ...environment };
		next.apply(applied); expect(applied.ANTHROPIC_API_KEY).toBe("fixture-secret");
		expect(next.view().restartRequired).toBe(false);
		expect(() => next.save(input, "other-tab")).toThrow("settings_revision_conflict");
		next.save({ ...input, revision: 1, apiKey: undefined }, "local-user");
		expect(next.view().keyConfigured).toBe(true);
		next.save({ ...input, mode: "fake", revision: 2, apiKey: undefined, clearKey: true }, "local-user");
		const restart = new ModelSettings(path, { ANTHROPIC_API_KEY: "env-secret" });
		expect(restart.view().keyConfigured).toBe(false);
		expect(readFileSync(path, "utf8")).not.toContain("fixture-secret");
	});
	it("rejects unsafe endpoints, missing keys and links without replacing configuration", () => {
		const path = setup(), settings = new ModelSettings(path, {});
		for (const baseUrl of ["https://user:secret@example.invalid", "https://example.invalid?key=secret", "file:///etc/passwd"]) expect(() => settings.save({ ...input, baseUrl }, "user")).toThrow("invalid_provider_url");
		expect(() => settings.save({ ...input, apiKey: undefined }, "user")).toThrow("provider_key_required");
		expect(() => settings.save({ ...input, clearKey: true }, "user")).toThrow("invalid_model_settings");
		settings.save(input, "user");
		const link = `${path}.link`; symlinkSync(path, link);
		expect(() => new ModelSettings(link, {})).toThrow("settings_file_unsafe");
		expect(new ModelSettings(setup(), { ANTHROPIC_BASE_URL: "https://user:env-secret@example.invalid" }).view().baseUrl).toBe("");
	});
});
