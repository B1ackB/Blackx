import { readFileSync, readdirSync } from "node:fs";
import ts from "typescript";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { errorText, statusFor } from "./i18n";
import { Markdown } from "./components/Markdown";
import { createRequirementBrief } from "./manufacturing/requirementBrief";
import { deliveryHtml, deliveryMarkdown, type RequirementDelivery } from "./manufacturing/requirementDelivery";

it("renders bilingual export labels and leaves source facts intact", () => {
	const delivery: RequirementDelivery = { schemaVersion: "requirement-delivery.v1", runId: "r", version: 2, status: "draft", createdAt: "2026-09-07", sources: [], citations: {}, content: createRequirementBrief({ industry: "print", title: "Packaging", customerGoal: "Review customer request", facts: [{ key: "quantity", version: 1, value: 5000, status: "unverified", sourceType: "model_output", sourceRef: "attachment:a" }] }) };
	// Assumptions are source content, not UI labels.
	delivery.content.assumptions = [];
	for (const render of [deliveryHtml, deliveryMarkdown]) {
		const english = render(delivery, "en");
		expect(english).toContain("Quantity"); expect(english).toContain("Unverified"); expect(english).not.toMatch(/\p{Script=Han}/u);
		expect(render(delivery, "zh")).toContain("数量");
	}
	delivery.content.facts[0].value = "客户原文";
	expect(deliveryHtml(delivery, "en")).toContain("客户原文");
});
it("localizes errors and markdown controls in both directions", () => {
	const error = { code: "file_version_conflict" };
	const english = errorText(error, "en"); expect(english).toContain("changed"); expect(errorText(english, "zh")).toContain("文件已变化");
	expect(statusFor("en", "needs_ocr", "需要 OCR")).toBe("OCR required");
	const text = "```\nexample\n```\n![reference](https://example.test/image.png)";
	const englishMarkup = renderToStaticMarkup(<Markdown text={text} language="en" />);
	expect(englishMarkup).toContain("Copy"); expect(englishMarkup).toContain("Image: "); expect(englishMarkup).not.toMatch(/\p{Script=Han}/u);
	expect(renderToStaticMarkup(<Markdown text={text} language="zh" />)).toContain("复制");
});
it("keeps unconditional Chinese JSX labels out of bilingual UI components", () => {
	const paths = ["src/App.tsx", ...readdirSync("src/components").filter((name) => name.endsWith(".tsx") && !name.includes(".test.")).map((name) => `src/components/${name}`)];
	const untranslated: string[] = [];
	for (const path of paths) {
		const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
		function walk(node: ts.Node) {
			if (ts.isJsxText(node) && /\p{Script=Han}/u.test(node.text)) untranslated.push(`${path}: ${node.text.trim()}`);
			if (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer) && /\p{Script=Han}/u.test(node.initializer.text)) untranslated.push(`${path}: ${node.initializer.text}`);
			ts.forEachChild(node, walk);
		}
		walk(source);
	}
	expect(untranslated).toEqual([]);
});
