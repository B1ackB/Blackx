import { useEffect, useRef } from "react";
import type { Language } from "../i18n";

export function DeleteConversationDialog({ title, busy, error, language, onCancel, onConfirm }: {
	title: string;
	busy: boolean;
	error?: string;
	language: Language;
	onCancel: () => void;
	onConfirm: () => void;
}) {
	const en = language === "en";
	const ref = useRef<HTMLDialogElement>(null);
	useEffect(() => {
		const dialog = ref.current!;
		dialog.showModal();
		return () => dialog.close();
	}, []);
	return <dialog ref={ref} className="delete-dialog" aria-labelledby="delete-title" aria-describedby="delete-description"
		onCancel={(event) => { event.preventDefault(); if (!busy) onCancel(); }}>
		<h2 id="delete-title">{en ? "Delete conversation?" : "删除会话？"}</h2>
		<p className="delete-conversation-title">{title}</p>
		<p id="delete-description">{en ? "The conversation and attachments will leave the workspace. Running and queued tasks will stop, scheduled tasks will pause, and any unfinished requirement brief will be cancelled." : "会话及附件将从工作台移除，正在执行和排队的任务会停止，定时任务会暂停。未完成的需求单会取消。"}</p>
		<p className="delete-retention">{en ? "You cannot restore it from the interface. Historical messages, attachments, delivery versions, and audit records remain local; this does not physically erase files." : "删除后无法从界面恢复。历史消息、附件、交付版本及审计记录保留在本地，此操作不会物理擦除文件。"}</p>
		{error && <p className="delete-error" role="alert">{error}</p>}
		<div className="delete-dialog-actions">
			<button autoFocus disabled={busy} onClick={onCancel}>{en ? "Cancel" : "取消"}</button>
			<button className="danger-action" disabled={busy} onClick={onConfirm}>{busy ? en ? "Deleting…" : "正在删除…" : error ? en ? "Retry delete" : "重试删除" : en ? "Delete conversation" : "确认删除"}</button>
		</div>
	</dialog>;
}
