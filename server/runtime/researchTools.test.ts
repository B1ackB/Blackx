import { describe, expect, it } from "vitest";
import { researchSourceTool } from "./researchTools";

describe("researchSourceTool", () => {
	it("reads only a source from the fixed M1 corpus", async () => {
		expect(researchSourceTool.validate({ sourceId: "source-session" })).toBe(true);
		expect(researchSourceTool.validate({ sourceId: "missing" })).toBe(false);
		await expect(researchSourceTool.execute({ sourceId: "source-session" }, {} as never)).resolves.toMatchObject({
			sourceId: "source-session",
			content: expect.stringContaining("Runtime continuation"),
		});
	});
});
