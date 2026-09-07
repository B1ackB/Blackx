import { useEffect, useState } from "react";
import { ConversationClient } from "../runtime/conversationClient";
import { summarizeModelCalls, type ModelTelemetryView } from "../runtime/modelTelemetry";
import type { Language } from "../i18n";

const client = new ConversationClient();
const statusLabels = { running: "等待响应", succeeded: "成功", failed: "失败", cancelled: "已取消", interrupted: "执行中断" };
const statusLabelsEn = { running: "Awaiting response", succeeded: "Succeeded", failed: "Failed", cancelled: "Cancelled", interrupted: "Interrupted" };
export function ModelMonitor({ conversationId, language }: { conversationId: string; language: Language }) {
	const en = language === "en";
	const status = (value: keyof typeof statusLabels) => en ? statusLabelsEn[value] : statusLabels[value];
	const [requirement, setRequirement] = useState(false);
	const [view, setView] = useState<ModelTelemetryView>();
	const [error, setError] = useState("");
	useEffect(() => {
		let stopped = false; let timer: ReturnType<typeof setTimeout>;
		setView(undefined); setError("");
		async function refresh() {
			try { const next = await client.modelCalls(conversationId, requirement); if (!stopped) { setView(next); setError(""); } }
			catch (cause) { if (!stopped) setError(cause instanceof Error ? cause.message : "无法读取调用记录"); }
			if (!stopped) timer = setTimeout(() => void refresh(), 1000);
		}
		void refresh(); return () => { stopped = true; clearTimeout(timer); };
	}, [conversationId, requirement]);
	const summary = view && summarizeModelCalls(view.calls);
	const latest = view?.calls.filter((call) => call.kind === "generate").at(-1);
	return <section className="model-monitor" aria-label={en ? "Model call monitor" : "模型调用监控"}>
		<label className="panel-field">{en ? "Scope" : "统计范围"}<select value={requirement ? "requirement" : "chat"} onChange={(event) => setRequirement(event.target.value === "requirement")}><option value="chat">{en ? "Current conversation (including background tasks)" : "当前会话（含后台任务）"}</option><option value="requirement">{en ? "Current requirement brief workflow" : "当前需求单工作流"}</option></select></label>
		{error && <p role="alert" className="file-error">{error} · {en ? "the data below may be stale" : "下方数据可能已过期"}</p>}
		{!view ? <p>{en ? "Loading call records…" : "正在加载调用记录…"}</p> : <>
			<div className="model-identity"><small>{en ? "Configured model" : "当前配置模型"}</small><strong>{view.configuredModel}</strong><span>{latest ? `${en ? "Latest request" : "最近请求"}：${status(latest.status)}` : en ? "No model requests yet" : "尚无模型请求"}</span>{latest?.response && <small>{en ? "Response model" : "响应模型"}：{latest.response.model}</small>}</div>
			<div className="monitor-grid">
				<div><small>{en ? "Generation calls" : "生成调用次数"}</small><strong>{summary!.generated}</strong></div>
				<div><small>{en ? "Cache hit rate · Tokens" : "缓存命中率 · Token"}</small><strong>{summary!.cacheHitRate === null ? en ? "Not provided" : "未提供" : `${(summary!.cacheHitRate * 100).toFixed(1)}%`}</strong></div>
				<div><small>{en ? "Succeeded / failed" : "成功 / 失败"}</small><strong>{summary!.succeeded} / {summary!.failed}</strong></div>
				<div><small>{en ? "Average response time" : "平均响应耗时"}</small><strong>{summary!.averageLatencyMs === null ? "—" : `${(summary!.averageLatencyMs / 1000).toFixed(2)} s`}</strong></div>
			</div>
			<dl className="run-metadata"><div><dt>等待 / 取消或中断</dt><dd>{summary!.running} / {summary!.cancelled}</dd></div><div><dt>Token 计数请求</dt><dd>{summary!.counted}</dd></div><div><dt>非缓存输入 / 输出 Token</dt><dd>{summary!.inputTokens} / {summary!.outputTokens}</dd></div><div><dt>缓存读取 / 写入 Token</dt><dd>{summary!.cacheCoverage ? `${summary!.cacheReadTokens} / ${summary!.cacheWriteTokens}` : "未提供"}</dd></div></dl>
			<p className="panel-note">缓存统计覆盖 {summary!.cacheCoverage} / {summary!.responses} 次有效响应；上游缺少缓存字段时不计入命中率。按缓存读取 ÷（非缓存输入 + 缓存读取 + 缓存写入）计算。</p>
			<p className="panel-note">每个运行最多保留最近 {view.retentionLimit} 次请求，刷新与重启后保留。{view.truncated ? "更早记录已移出，以上为保留窗口统计。" : "仅统计此功能启用后的请求。"}</p>
			<div className="model-call-list"><h3>{en ? "Request records" : "请求记录"}</h3>{!view.calls.length && <p>{en ? "Live calls appear here after you send a message." : "发送消息后将在这里显示真实调用情况。"}</p>}{[...view.calls].reverse().map((call) => <details key={call.id} className={`model-call ${call.status}`}><summary><span>{call.kind === "generate" ? en ? "Generate" : "生成" : en ? "Token count" : "Token 计数"} · {status(call.status)}</span><small>{new Date(call.startedAt).toLocaleTimeString(en ? "en-US" : "zh-CN")} · {call.latencyMs === undefined ? en ? "In progress" : "进行中" : `${call.latencyMs} ms`}</small></summary><dl className="run-metadata"><div><dt>{en ? "Requested model" : "请求模型"}</dt><dd>{call.model}</dd></div><div><dt>{en ? "Response status" : "返回状态"}</dt><dd>{call.httpStatus ? `HTTP ${call.httpStatus}` : call.response?.stopReason ?? call.failure ?? status(call.status)}</dd></div>{call.response && <div><dt>{en ? "Input / output" : "输入 / 输出"}</dt><dd>{call.response.inputTokens} / {call.response.outputTokens}</dd></div>}</dl><small className="local-path">{en ? "Call ID" : "调用 ID"}：{call.id}</small></details>)}</div>
		</>}
	</section>;
}
