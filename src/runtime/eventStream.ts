/** Bounded SSE framing shared by the provider adapter and browser transport. */
export async function* readEvents(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<{ event: string; data: string }> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let pending = "";
	let event = "message";
	let data: string[] = [];
	let size = 0;
	const abort = () => { void reader.cancel().catch(() => {}); };
	signal?.addEventListener("abort", abort, { once: true });
	try {
		while (true) {
			signal?.throwIfAborted();
			const chunk = await reader.read();
			signal?.throwIfAborted();
			pending += decoder.decode(chunk.value, { stream: !chunk.done });
			let newline: number;
			while ((newline = pending.indexOf("\n")) >= 0) {
				const line = pending.slice(0, newline).replace(/\r$/, "");
				pending = pending.slice(newline + 1);
				if (!line) {
					if (data.length) yield { event, data: data.join("\n") };
					event = "message"; data = []; size = 0;
				} else if (line.startsWith("event:")) event = line.slice(6).trim();
				else if (line.startsWith("data:")) { const value = line.slice(5).replace(/^ /, ""); data.push(value); size += value.length; }
				if (size > 2_000_000) throw new Error("stream_event_too_large");
			}
			if (pending.length + size > 2_000_000) throw new Error("stream_event_too_large");
			if (chunk.done) break;
		}
	} finally {
		signal?.removeEventListener("abort", abort);
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
