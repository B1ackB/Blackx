import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

/** One capability per Host process. Never included in model context, logs, or disk. */
export class LocalAccess {
	readonly token = randomBytes(32).toString("hex");
	readonly identity = Object.freeze({ tenantId: "local-user", workspaceId: "default-workspace", actorId: "local-user" });
	constructor(private readonly port: number) {}

	private trustedOrigin(headers: IncomingHttpHeaders): boolean {
		const expected = `http://127.0.0.1:${this.port}`;
		return headers.host === `127.0.0.1:${this.port}` &&
			(headers.origin === undefined || headers.origin === expected) &&
			(headers["sec-fetch-site"] === undefined || headers["sec-fetch-site"] === "same-origin");
	}

	canBootstrap(headers: IncomingHttpHeaders): boolean {
		return this.trustedOrigin(headers) && headers["sec-fetch-site"] === "same-origin" &&
			["cors", "same-origin"].includes(String(headers["sec-fetch-mode"]));
	}

	authorize(headers: IncomingHttpHeaders): boolean {
		if (!this.trustedOrigin(headers)) return false;
		const supplied = headers["x-blackx-session-token"];
		if (typeof supplied !== "string" || !/^[a-f0-9]{64}$/.test(supplied) ||
			!timingSafeEqual(Buffer.from(supplied), Buffer.from(this.token))) return false;
		return Object.entries(this.identity).every(([key, value]) => {
			const header = `x-blackx-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
			return headers[header] === undefined || headers[header] === value;
		});
	}
}
