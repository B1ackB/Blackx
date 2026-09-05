import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown, safeMarkdownLink } from "./Markdown";

describe("safe Markdown rendering", () => {
	it("renders structured content without executing model HTML or fetching images", () => {
		const output = renderToStaticMarkup(<Markdown text={'# 标题\n\n**强调**\n\n| 数量 | 单位 |\n| --- | --- |\n| 50 | 个 |\n\n```js\nconst n = 1;\n```\n\n<script>alert(1)</script>\n\n![remote](https://evil.test/track)\n\n[bad](javascript:alert%281%29)'} />);
		expect(output).toContain("<table>");
		expect(output).toContain("<strong>强调</strong>");
		expect(output).toContain("<pre><code>");
		expect(output).not.toContain("<script>");
		expect(output).not.toContain("<img");
		expect(output).not.toContain('href="javascript:');
	});
	it("allows only explicit HTTP links", () => {
		for (const url of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "/api/local-session"]) expect(safeMarkdownLink(url)).toBeUndefined();
		expect(safeMarkdownLink("https://example.com/a")).toBe("https://example.com/a");
	});
});
