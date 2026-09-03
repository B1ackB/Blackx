import { describe, expect, it } from "vitest";
import { validateAnthropicBaseUrl } from "./createRuntime";

describe("Anthropic Runtime configuration", () => {
  it("accepts a plain HTTP URL and removes a trailing slash", () => {
    expect(validateAnthropicBaseUrl("https://api.deepseek.com/anthropic/")).toBe(
      "https://api.deepseek.com/anthropic",
    );
  });

  it("rejects copied Markdown link syntax at startup", () => {
    expect(() =>
      validateAnthropicBaseUrl(
        "[https://api.deepseek.com/anthropic](https://api.deepseek.com/anthropic)",
      ),
    ).toThrow("plain http(s) URL");
  });
});
