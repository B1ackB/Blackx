import { describe, expect, it } from "vitest";
import { readAnthropicStream } from "./stream";
import { AnthropicMessagesClient } from "./client";

const start = { type: "message_start", message: { id: "m1", type: "message", role: "assistant", model: "test", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 5 } } };
const frames = [start,
	{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
	{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "包装" } },
	{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " ready" } },
	{ type: "content_block_stop", index: 0 },
	{ type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "", signature: "" } },
	{ type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "private" } },
	{ type: "content_block_delta", index: 1, delta: { type: "signature_delta", signature: "signed" } },
	{ type: "content_block_stop", index: 1 },
	{ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "t1", name: "document_read", input: {} } },
	{ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"path":' } },
	{ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '"/test.pdf"}' } },
	{ type: "content_block_stop", index: 2 },
	{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 23 } },
	{ type: "message_stop" },
];
function body(events: unknown[], oneByte = false) {
	const bytes = new TextEncoder().encode(events.map((event) => `event: ignored\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join(""));
	return new ReadableStream<Uint8Array>({ start(controller) { if (oneByte) for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); else controller.enqueue(bytes); controller.close(); } });
}

describe("model streaming", () => {
	it("decodes split UTF-8, streams only visible text and assembles complete tool inputs/usage", async () => {
		const text: string[] = [];
		const result = await readAnthropicStream(body(frames, true), (delta) => { text.push(delta); });
		expect(text).toEqual(["包装", " ready"]);
		expect(result.usage).toEqual({ input_tokens: 10, output_tokens: 23, cache_read_input_tokens: 5 });
		expect(result.content).toEqual([{ type: "text", text: "包装 ready" }, { type: "thinking", thinking: "private", signature: "signed" }, { type: "tool_use", id: "t1", name: "document_read", input: { path: "/test.pdf" } }]);
	});
	it("does not accept a truncated stream as a completed model response", async () => {
		await expect(readAnthropicStream(body(frames.slice(0, -1)))).rejects.toThrow("incomplete");
		await expect(readAnthropicStream(body([start, frames[1], { ...frames[2], index: 9 }]))).rejects.toThrow("invalid");
		await expect(readAnthropicStream(body([start, { type: "error", error: { type: "overloaded_error" } }]))).rejects.toMatchObject({ code: "overloaded_error" });
	});
	it("aborts a blocked reader without waiting for another provider chunk", async () => {
		const controller = new AbortController(); let cancelled = false;
		const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
		const reading = readAnthropicStream(stream, undefined, controller.signal);
		controller.abort();
		await expect(reading).rejects.toThrow(); expect(cancelled).toBe(true);
	});
	it("requests real streaming and delivers a delta before HTTP completion", async () => {
		let close!: () => void; let observedRequest: unknown;
		const fetchImpl = (async (_url, init) => {
			observedRequest = JSON.parse(String(init?.body));
			return new Response(new ReadableStream({ start(controller) {
				controller.enqueue(new TextEncoder().encode(frames.slice(0, 3).map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")));
				close = () => { controller.enqueue(new TextEncoder().encode(frames.slice(3).map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""))); controller.close(); };
			} }), { headers: { "content-type": "text/event-stream" } });
		}) as typeof fetch;
		let first!: () => void; const received = new Promise<void>((resolve) => { first = resolve; });
		const client = new AnthropicMessagesClient({ baseUrl: "https://fixture.invalid", apiKey: "fixture", fetch: fetchImpl });
		let completed = false;
		const request = client.createMessage({ model: "test", max_tokens: 100, messages: [], stream: false }, undefined, () => { first(); }).then((value) => { completed = true; return value; });
		await received;
		expect(observedRequest).toMatchObject({ stream: true }); expect(completed).toBe(false);
		close(); await request; expect(completed).toBe(true);
	});
});
