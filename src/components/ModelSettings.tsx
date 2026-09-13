import { useEffect, useState } from "react";
import { ConversationClient } from "../runtime/conversationClient";
import type { ModelSettingsView } from "../runtime/modelSettings";
import type { Language } from "../i18n";

const client = new ConversationClient();
export function ModelSettings({ language }: { language: Language }) {
	const en = language === "en";
	const [value, setValue] = useState<ModelSettingsView>();
	const [key, setKey] = useState("");
	const [clearKey, setClearKey] = useState(false);
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState("");
	useEffect(() => { void client.modelSettings().then(setValue).catch(() => setMessage("load_failed")); }, []);
	const messages: Record<string, string> = {
		saved: en ? "Saved. Stop and reopen Packx to apply. No model request was sent." : "已保存。停止并重新打开 Packx 后生效；本次未发送模型请求。",
		settings_revision_conflict: en ? "Settings changed in another window. Reopen this panel before saving." : "配置已在其他窗口更改，请重新打开面板后保存。",
		provider_key_required: en ? "Enter an API key to enable the model." : "请填写 API Key 后启用模型。",
		invalid_provider_url: en ? "Enter a service URL without credentials, query parameters or fragments." : "请填写不含凭据、查询参数和片段的服务地址。",
		model_id_required: en ? "Enter the model ID." : "请填写模型 ID。",
	};
	return <section className="model-settings">
		<h3>{en ? "Model connection" : "模型连接配置"}</h3>
		<p>{en ? "Use an Anthropic Messages compatible service. Credentials stay on this device and are excluded from business backups." : "连接兼容 Anthropic Messages 的服务。凭据仅保存在本机，不进入业务数据备份。"}</p>
		{value && <form onSubmit={(event) => {
			event.preventDefault(); setBusy(true); setMessage("");
			void client.saveModelSettings({ revision: value.revision, mode: value.mode, baseUrl: value.baseUrl, model: value.model, apiKey: key || undefined, clearKey })
				.then((next) => { setValue(next); setKey(""); setClearKey(false); setMessage("saved"); })
				.catch((error: { code?: string }) => { setKey(""); setMessage(error.code ?? "save_failed"); })
				.finally(() => setBusy(false));
		}}>
			<label>{en ? "Connection mode" : "连接模式"}<select value={value.mode} onChange={(e) => setValue({ ...value, mode: e.target.value as ModelSettingsView["mode"] })}><option value="fake">{en ? "Browse saved work (no model)" : "仅查看已保存内容（不连接模型）"}</option><option value="anthropic">{en ? "Connect model service" : "连接模型服务"}</option></select></label>
			<label>{en ? "Service URL" : "服务地址"}<input type="url" required value={value.baseUrl} onChange={(e) => setValue({ ...value, baseUrl: e.target.value })} placeholder="https://api.anthropic.com" /></label>
			<label>{en ? "Model ID" : "模型 ID"}<input maxLength={200} value={value.model} onChange={(e) => setValue({ ...value, model: e.target.value })} /></label>
			<label>API Key<input type="password" autoComplete="new-password" value={key} maxLength={8192} onChange={(e) => { setKey(e.target.value); setClearKey(false); }} placeholder={value.keyConfigured ? en ? "Configured · leave blank to retain" : "已配置 · 留空保留" : en ? "Enter a private key" : "填写私密凭据"} /></label>
			{value.keyConfigured && <label className="settings-checkbox"><input type="checkbox" checked={clearKey} onChange={(e) => { setClearKey(e.target.checked); setKey(""); }} />{en ? "Remove the stored key (also disables any key from .env)" : "清除已配置凭据（同时停用 .env 中的凭据）"}</label>}
			<button className="secondary-action" disabled={busy}>{busy ? en ? "Saving…" : "正在保存…" : en ? "Save connection" : "保存连接配置"}</button>
			{value.restartRequired && <p>{en ? "Restart required. Running tasks keep their current model." : "等待重启生效。正在执行的任务继续使用当前模型。"}</p>}
		</form>}
		{message && <p role="status">{messages[message] ?? (en ? "Unable to save or load settings. Check the fields and reopen the panel to retry." : "无法保存或读取配置，请检查填写内容并重新打开面板重试。")}</p>}
	</section>;
}
