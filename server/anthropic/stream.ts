import { readEvents } from "../../src/runtime/eventStream";
import type { AnthropicAssistantContentBlock, AnthropicMessageResponse } from "./types";

/** Only a closed message is eligible for validation, persistence and tool execution. */
export async function readAnthropicStream(body: ReadableStream<Uint8Array>, onText?: (text: string) => void | Promise<void>, signal?: AbortSignal): Promise<AnthropicMessageResponse> {
	let message: AnthropicMessageResponse | undefined;
	let open: number | undefined;
	let json = "";
	let size = 0;
	let finished = false;
	const invalid = (): never => { throw new Error("invalid_or_incomplete_model_stream"); };
	for await (const frame of readEvents(body, signal)) {
		const event = JSON.parse(frame.data);
		if (event.type === "ping") continue;
		if (event.type === "error") throw Object.assign(new Error("Model stream failed"), { code: typeof event.error?.type === "string" ? event.error.type : "upstream_error" });
		if (event.type === "message_start") {
			if (message || !event.message || !Array.isArray(event.message.content) || event.message.content.length) invalid();
			message = event.message; continue;
		}
		if (!message) invalid();
		const current = message!;
		if (event.type === "content_block_start") {
			if (open !== undefined || event.index !== current.content.length || !event.content_block || current.content.length >= 256) invalid();
			open = event.index; json = "";
			current.content.push(event.content_block as AnthropicAssistantContentBlock);
			if (event.content_block.type === "text" && typeof event.content_block.text === "string" && event.content_block.text) await onText?.(event.content_block.text);
		} else if (event.type === "content_block_delta") {
			if (open === undefined || event.index !== open) invalid();
			const block = current.content[open!];
			const delta = event.delta;
			const value = delta?.text ?? delta?.partial_json ?? delta?.thinking ?? delta?.signature;
			if (typeof value !== "string" || (size += value.length) > 2_000_000) invalid();
			if (delta.type === "text_delta" && block.type === "text") { block.text += delta.text; await onText?.(delta.text); }
			else if (delta.type === "input_json_delta" && block.type === "tool_use") json += delta.partial_json;
			else if (delta.type === "thinking_delta" && block.type === "thinking") block.thinking += delta.thinking;
			else if (delta.type === "signature_delta" && block.type === "thinking") block.signature += delta.signature;
			else invalid();
		} else if (event.type === "content_block_stop") {
			if (open === undefined || event.index !== open) invalid();
			const block = current.content[open!];
			if (block.type === "tool_use" && json) block.input = JSON.parse(json);
			open = undefined;
		} else if (event.type === "message_delta") {
			if (open !== undefined || !event.delta || !event.usage) invalid();
			current.stop_reason = event.delta.stop_reason;
			current.stop_sequence = event.delta.stop_sequence;
			current.usage = { ...current.usage, ...event.usage };
		} else if (event.type === "message_stop") {
			if (open !== undefined || !current.stop_reason) invalid();
			finished = true; break;
		}
	}
	if (!finished || !message) invalid();
	return message!;
}
