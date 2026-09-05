import { useEffect, useRef } from "react";

export function DeleteConversationDialog({ title, busy, error, onCancel, onConfirm }: {
	title: string;
	busy: boolean;
	error?: string;
	onCancel: () => void;
	onConfirm: () => void;
}) {
	const ref = useRef<HTMLDialogElement>(null);
	useEffect(() => {
		const dialog = ref.current!;
		dialog.showModal();
		return () => dialog.close();
	}, []);
	return <dialog ref={ref} className="delete-dialog" aria-labelledby="delete-title" aria-describedby="delete-description"
		onCancel={(event) => { event.preventDefault(); if (!busy) onCancel(); }}>
		<h2 id="delete-title">删除会话？</h2>
		<p className="delete-conversation-title">{title}</p>
		<p id="delete-description">会话及附件将从工作台移除，正在执行和排队的任务会停止，定时任务会暂停。未完成的需求单会取消。</p>
		<p className="delete-retention">删除后无法从界面恢复。历史消息、附件、交付版本及审计记录保留在本地，此操作不会物理擦除文件。</p>
		{error && <p className="delete-error" role="alert">{error}</p>}
		<div className="delete-dialog-actions">
			<button autoFocus disabled={busy} onClick={onCancel}>取消</button>
			<button className="danger-action" disabled={busy} onClick={onConfirm}>{busy ? "正在删除…" : error ? "重试删除" : "确认删除"}</button>
		</div>
	</dialog>;
}
