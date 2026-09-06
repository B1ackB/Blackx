import { describe, expect, it } from "vitest";
import { LocalAccess } from "./localAccess";

describe("local Host access", () => {
	it("binds a per-process capability to loopback and rejects forged identity and cross-origin requests", () => {
		const access = new LocalAccess(5173);
		const headers = { host: "127.0.0.1:5173", "x-blackx-session-token": access.token };
		expect(access.authorize(headers)).toBe(true);
		expect(access.authorize({ host: headers.host })).toBe(false);
		expect(access.authorize({ ...headers, origin: "https://evil.example" })).toBe(false);
		expect(access.authorize({ ...headers, host: "evil.example:5173" })).toBe(false);
		expect(access.authorize({ ...headers, "x-blackx-workspace-id": "another-workspace" })).toBe(false);
		expect(new LocalAccess(5173).authorize(headers)).toBe(false);
		expect(access.authorize({ ...headers, "x-blackx-session-token": "界".repeat(64) })).toBe(false);
	});
	it("bootstrap requires a same-origin browser fetch, not a navigation or cross-site form", () => {
		const access = new LocalAccess(5173);
		const headers = { host: "127.0.0.1:5173", "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" };
		expect(access.canBootstrap(headers)).toBe(true);
		expect(access.canBootstrap({ ...headers, "sec-fetch-mode": "navigate" })).toBe(false);
		expect(access.canBootstrap({ ...headers, "sec-fetch-site": "cross-site" })).toBe(false);
	});
});
