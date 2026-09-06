import { useEffect, useState } from "react";
import { ConversationClient } from "../runtime/conversationClient";
import type { AssetInspectionRecord } from "../runtime/assetInspection";
import { compareRequirementVersions, factStatusLabels, inspectionStatusLabels, requirementFieldLabels, type RequirementDelivery } from "../manufacturing/requirementDelivery";

const client = new ConversationClient();
const valueOf = (fact?: { value: string | number | boolean; unit?: string; status: string }) => fact ? `${fact.value} ${fact.unit ?? ""} · ${factStatusLabels[fact.status] ?? fact.status}` : "—";

export function DeliveryPreview({ conversationId, versions, currentVersion, revision, onSources }: {
	conversationId: string; versions: number[]; currentVersion: number; revision: number; onSources: (sources: AssetInspectionRecord[]) => void;
}) {
	const [version, setVersion] = useState(currentVersion);
	const [delivery, setDelivery] = useState<RequirementDelivery>();
	const [previous, setPrevious] = useState<RequirementDelivery>();
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [sourceRef, setSourceRef] = useState<string>();
	useEffect(() => { setVersion(currentVersion); }, [conversationId, currentVersion]);
	useEffect(() => {
		let cancelled = false;
		setDelivery(undefined); setPrevious(undefined); setError("");
		const before = versions.filter((value) => value < version).sort((a, b) => b - a)[0];
		void Promise.all([client.delivery(conversationId, version), before ? client.delivery(conversationId, before).catch(() => undefined) : undefined])
			.then(([now, prior]) => { if (!cancelled) { setDelivery(now); setPrevious(prior); if (version === currentVersion) onSources(now.sources); } })
			.catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : "无法读取此版本"); });
		return () => { cancelled = true; };
	}, [conversationId, version, revision]);

	async function download(format: "md" | "html" | "json") {
		setBusy(true); setError("");
		try {
			const blob = await client.exportDelivery(conversationId, version, format);
			const url = URL.createObjectURL(blob);
			const link = document.createElement("a");
			link.href = url; link.download = `requirement-v${version}.${format}`; link.click();
			setTimeout(() => URL.revokeObjectURL(url), 1000);
		} catch (reason) { setError(reason instanceof Error ? reason.message : "导出失败"); }
		finally { setBusy(false); }
	}

	return <section className="proposal-section delivery-preview" aria-label="需求单预览与导出">
		<div className="section-title"><strong>需求单</strong><select aria-label="需求单版本" value={version} onChange={(event) => setVersion(Number(event.target.value))}>{versions.map((item) => <option key={item} value={item}>v{item}{item === currentVersion ? " · 当前" : " · 历史"}</option>)}</select></div>
		{error && <p role="alert">{error}</p>}
		{!delivery && !error && <p role="status">正在读取版本…</p>}
		{delivery && <>
			<span className={`delivery-status ${delivery.status}`}>{{ draft: "草稿 · 尚未批准", approved: "当前版本已批准", stale: "历史 / 已失效 · 不可用于交付确认" }[delivery.status]}</span>
			<h3>{delivery.content.title}</h3><p>{delivery.content.customerGoal}</p>
			<div className="table-scroll"><table><thead><tr><th>字段</th><th>内容与状态</th><th>来源</th></tr></thead><tbody>{delivery.content.facts.map((fact) => {
				const ref = delivery.citations[fact.key] ?? fact.sourceRef;
				const source = delivery.sources.find((item) => ref.startsWith(`${item.sourceRef}#page=`));
				return <tr key={fact.key}><td>{requirementFieldLabels[fact.key] ?? fact.key}</td><td>{valueOf(fact)}</td><td>{source ? <button className="text-action" onClick={() => { setSourceRef(source.sourceRef); document.getElementById(`sources-${version}`)?.scrollIntoView({ block: "nearest" }); }}>{source.name} · 第 {ref.split("#page=")[1]} 页</button> : <small>{fact.sourceType === "human_confirmation" ? "人工确认" : "会话 / 人工输入"}</small>}</td></tr>;
			})}</tbody></table></div>
			{delivery.content.missingRequiredFacts.length > 0 && <p className="missing-facts">待补充：{delivery.content.missingRequiredFacts.map((key) => requirementFieldLabels[key] ?? key).join("、")}</p>}
			{delivery.content.assumptions.length > 0 && <details><summary>假设与限制</summary><ul>{delivery.content.assumptions.map((item, i) => <li key={i}>{item}</li>)}</ul></details>}
			{previous && <details><summary>与 v{previous.version} 比较 · {compareRequirementVersions(previous.content, delivery.content).length} 个字段变化</summary>{compareRequirementVersions(previous.content, delivery.content).map((change) => <div className="version-change" key={change.key}><strong>{requirementFieldLabels[change.key] ?? change.key}</strong><del>{valueOf(change.before)}</del><span>{valueOf(change.after)}</span></div>)}</details>}
			<div id={`sources-${version}`} className="source-list">{delivery.sources.map((source) => <details key={source.attachmentId} open={sourceRef === source.sourceRef} onToggle={(event) => { if (!event.currentTarget.open && sourceRef === source.sourceRef) setSourceRef(undefined); }}><summary>{source.name} <small>{inspectionStatusLabels[source.inspection.status]}{source.inspection.truncated ? " · 内容截断" : ""}</small></summary>
				{source.inspection.status === "needs_ocr" && <p>这份 PDF 没有可提取文字。请补充文字版或人工录入关键字段。</p>}
				{source.inspection.width && <p>{source.inspection.width} × {source.inspection.height} 像素 · 不代表印刷尺寸或生产就绪</p>}
				{source.inspection.pages.map((page) => <div className="source-page" key={page.page}><strong>第 {page.page} 页</strong><pre>{page.text || "本页无可提取文字"}</pre></div>)}
				<small className="source-digest">SHA-256 {source.sha256} · 解析器 {source.parserVersion}</small>
			</details>)}</div>
			<div className="export-actions"><button disabled={busy} onClick={() => void download("md")}>导出 Markdown</button><button disabled={busy} onClick={() => void download("html")}>打印版 HTML</button><button disabled={busy} onClick={() => void download("json")}>JSON</button></div>
			<small>导出包含版本与确认状态。打印版可在浏览器中保存为 PDF。</small>
		</>}
	</section>;
}
