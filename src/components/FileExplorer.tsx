import { useEffect, useRef, useState } from "react";
import { ConversationClient } from "../runtime/conversationClient";
import type { LocalDirectoryListing, LocalFileLocations } from "../runtime/conversationFiles";
const client = new ConversationClient();
const message = (cause: unknown) => cause instanceof Error ? cause.message : "文件读取失败";
function Directory({ conversationId, path, name, openFile, initiallyOpen = false }: { conversationId: string; path: string; name: string; openFile: (path: string) => void; initiallyOpen?: boolean }) {
	const [open, setOpen] = useState(initiallyOpen), [listing, setListing] = useState<LocalDirectoryListing>(), [error, setError] = useState("");
	useEffect(() => {
		if (!open || listing) return;
		let stopped = false;
		client.browseDirectory(conversationId, path).then((next) => { if (!stopped) { setListing(next); setError(""); } }).catch((cause) => { if (!stopped) setError(message(cause)); });
		return () => { stopped = true; };
	}, [conversationId, path, open, listing]);
	return <details className="file-tree-directory" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}><summary title={path}>▣ {name}</summary>{error && <p role="alert" className="file-error">{error}</p>}{open && !listing && !error && <p>正在读取目录…</p>}{listing && <div className="file-tree-children">{listing.entries.map((entry) => entry.kind === "directory" ? <Directory key={entry.absolutePath} conversationId={conversationId} path={entry.absolutePath} name={entry.name} openFile={openFile} /> : <button key={entry.absolutePath} className="file-tree-file" title={entry.absolutePath} onClick={() => openFile(entry.absolutePath)}>▤ {entry.name}</button>)}{!listing.entries.length && <small>目录为空或没有可查看的文件</small>}{listing.truncated && <small>只显示前 200 项，请打开具体子目录。</small>}</div>}</details>;
}
export function FileExplorer({ conversationId, onUseFile }: { conversationId: string; onUseFile: (path: string) => void }) {
	const [locations, setLocations] = useState<LocalFileLocations>();
	const [input, setInput] = useState(""); const [root, setRoot] = useState(""); const [revision, setRevision] = useState(0);
	const [preview, setPreview] = useState<{ path: string; content: string; version?: number }>();
	const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
	const requestId = useRef(0);
	useEffect(() => {
		let stopped = false;
		client.fileLocations(conversationId).then((next) => { if (!stopped) { setLocations(next); setRoot((value) => value || next.locations.workingDirectory); setInput((value) => value || next.locations.workingDirectory); } }).catch((cause) => { if (!stopped) setError(message(cause)); });
		return () => { stopped = true; };
	}, [conversationId, revision]);
	useEffect(() => () => { requestId.current++; }, [conversationId]);
	async function openFile(path: string, version?: number) {
		const id = ++requestId.current; setBusy(true); setError(""); setPreview(undefined);
		try {
			const result = version === undefined ? await client.readLocalFile(conversationId, path) : await client.readFile(conversationId, path, version);
			if (id === requestId.current) setPreview({ path, content: result.content, version });
		} catch (cause) { if (id === requestId.current) setError(message(cause)); }
		finally { if (id === requestId.current) setBusy(false); }
	}
	function browse(path: string) { requestId.current++; setBusy(false); setPreview(undefined); setError(""); setInput(path); setRoot(path); setRevision((value) => value + 1); }
	const recent = locations ? [...new Map(locations.files.map((file) => [file.path, file])).values()].filter((file) => file.status !== "deleted").slice(-12).reverse() : [];
	return <section className="file-explorer" aria-label="本地文件浏览器">
		<form onSubmit={(event) => { event.preventDefault(); browse(input.trim()); }}><label className="panel-field">文件或目录绝对路径<input aria-label="浏览路径" value={input} onChange={(event) => setInput(event.target.value)} placeholder="/Users/…/Documents" required /></label><div className="file-actions"><button disabled={!input.trim()}>打开目录</button><button type="button" disabled={!input.trim()} onClick={() => void openFile(input.trim())}>打开文件</button><button type="button" onClick={() => { setRevision((value) => value + 1); if (preview) void openFile(preview.path, preview.version); }}>刷新</button></div></form>
		<div className="file-location-shortcuts">{locations && Object.entries(locations.locations).map(([key, path]) => <button key={key} title={path} onClick={() => browse(path)}>{({ homeDirectory: "主目录", workingDirectory: "工作目录", documentsDirectory: "文档", desktopDirectory: "桌面" } as Record<string, string>)[key] ?? key}</button>)}</div>
		<p className="panel-note">直接查看本机文件，读取无需审批。要修改文件，可交给 Agent；写入与删除仍需你单次批准。文本预览最多 128 KiB。</p>
		{error && <p role="alert" className="file-error">{error}</p>}{busy && <p role="status">正在打开文件…</p>}
		{preview && <div className="explorer-preview"><div className="section-title"><strong>文件内容{preview.version ? ` · 快照 v${preview.version}` : ""}</strong><button onClick={() => setPreview(undefined)}>关闭预览</button></div><p className="local-path">{preview.path}</p><div className="file-actions"><button onClick={() => onUseFile(preview.path)}>交给 Agent</button></div><pre>{preview.content || "（空文件）"}</pre></div>}
		{recent.length > 0 && <details className="recent-files"><summary>最近操作的文件</summary>{recent.map((file) => <button className="file-tree-file" key={file.path} title={file.path} onClick={() => void openFile(file.path, file.absolutePath ? undefined : file.version)}>{file.path.split("/").at(-1)}</button>)}</details>}
		{root && <div className="file-tree" aria-label="文件树"><p className="local-path">{root}</p><Directory key={`${root}:${revision}`} conversationId={conversationId} path={root} name={root.split("/").at(-1) || root} openFile={(path) => void openFile(path)} initiallyOpen /></div>}
	</section>;
}
