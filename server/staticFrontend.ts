import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type { ServerResponse } from "node:http";
import { within } from "./localData";

export async function serveFrontend(pathname: string, response: ServerResponse, root = resolve("dist")) {
	let path: string;
	try {
		const decoded = decodeURIComponent(pathname);
		if (decoded !== "/" && !decoded.startsWith("/assets/")) throw new Error();
		path = resolve(root, decoded === "/" ? "index.html" : `.${decoded}`);
		if (!within(root, path) || !within(await realpath(root), await realpath(path)) || !(await lstat(path)).isFile()) throw new Error();
	} catch { response.writeHead(404); response.end("Not found"); return; }
	const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };
	response.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream", "x-content-type-options": "nosniff", "cache-control": pathname === "/" ? "no-cache" : "public, max-age=31536000, immutable" });
	createReadStream(path).on("error", () => response.destroy()).pipe(response);
}
