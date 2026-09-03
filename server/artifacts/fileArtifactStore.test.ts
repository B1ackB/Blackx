import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStoreError } from "../../src/enterprise/artifactStore";
import { FileArtifactContentStore } from "./fileArtifactStore";

const temporaryDirectories: string[] = [];
const key = {
	tenantId: "tenant-a",
	workspaceId: "workspace-a",
	runId: "run-a",
	artifactId: "solution-proposal",
	artifactVersion: 1,
};

function harness() {
	const directory = mkdtempSync(join(tmpdir(), "blackx-artifacts-"));
	temporaryDirectories.push(directory);
	return { directory, store: new FileArtifactContentStore(directory) };
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("FileArtifactContentStore", () => {
	it("persists canonical JSON with a private file mode", () => {
		const { directory, store } = harness();
		const contentRef = store.putJson(key, { z: 1, a: ["candidate"] });

		expect(contentRef).toBe("artifact://solution-proposal/v1");
		expect(store.readJson(key)).toEqual({ a: ["candidate"], z: 1 });
		expect(statSync(join(
			directory,
			"tenant-a/workspace-a/run-a/solution-proposal/v1.json",
		)).mode & 0o777).toBe(0o600);
	});

	it("deduplicates identical writes and rejects content replacement", () => {
		const { store } = harness();
		store.putJson(key, { value: "first", order: 1 });
		expect(store.putJson(key, { order: 1, value: "first" })).toBe(
			"artifact://solution-proposal/v1",
		);

		expect(() => store.putJson(key, { value: "replacement" })).toThrowError(
			expect.objectContaining({ code: "artifact_conflict" }) as Partial<ArtifactStoreError>,
		);
	});

	it("rejects path traversal identifiers", () => {
		const { store } = harness();

		expect(() => store.putJson({ ...key, tenantId: "../other" }, {})).toThrowError(
			expect.objectContaining({ code: "artifact_store_unavailable" }) as Partial<ArtifactStoreError>,
		);
	});
});
