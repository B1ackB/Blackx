import { ChangeEvent, FormEvent, useEffect, useRef, useState } from "react";
import type { RuntimeHealth } from "./runtime/contracts";
import { ConversationClient, ConversationClientError } from "./runtime/conversationClient";
import type {
	BackgroundTaskView,
	ConversationAttachment,
	ConversationMessage,
	ConversationSummary,
	ConversationView,
	CronScheduleView,
	RequirementBriefMetricsSeriesView,
	RequirementBriefWorkspaceView,
} from "./runtime/conversationContracts";
import type {
	ManufacturingIndustry,
	RequirementBriefEvaluation,
	RequirementBriefV1,
} from "./manufacturing/requirementBrief";

const client = new ConversationClient();
let bootstrapPromise: Promise<{
	health: RuntimeHealth;
	conversations: ConversationSummary[];
	active: ConversationView;
}> | undefined;

function summary(conversation: ConversationView): ConversationSummary {
	return {
		conversationId: conversation.conversationId,
		title: conversation.title,
		preview: conversation.preview,
		updatedAt: conversation.updatedAt,
		messageCount: conversation.messages.length,
	};
}

async function bootstrap() {
	if (!bootstrapPromise) {
		bootstrapPromise = (async () => {
			const [health, existing] = await Promise.all([client.health(), client.list()]);
			const active = existing[0]
				? await client.get(existing[0].conversationId)
				: await client.create();
			return {
				health,
				conversations: existing.length ? existing : [summary(active)],
				active,
			};
		})();
	}
	return bootstrapPromise;
}

function displayTime(value: string): string {
	return new Intl.DateTimeFormat("zh-CN", {
		hour: "2-digit",
		minute: "2-digit",
	}).format(new Date(value));
}

function attachmentIdFromSourceRef(sourceRef: string): string | undefined {
	return /^attachment:\/\/[^/]+\/(attachment-[A-Za-z0-9]+)$/.exec(sourceRef)?.[1];
}

function errorMessage(error: unknown): string {
	if (error instanceof ConversationClientError) {
		if (error.code === "real_provider_required") {
			return "当前服务不是实际模型模式。请使用 BLACKX_RUNTIME_MODE=anthropic 启动。";
		}
		return error.message;
	}
	return "请求失败，请检查服务端日志后重试。";
}

function requirementContent(value: unknown): RequirementBriefV1 | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const candidate = value as Partial<RequirementBriefV1>;
	return candidate.schemaVersion === "requirement-brief.v1" &&
		typeof candidate.title === "string" &&
		typeof candidate.customerGoal === "string" &&
		Array.isArray(candidate.facts) &&
		Array.isArray(candidate.missingRequiredFacts)
		? candidate as RequirementBriefV1
		: undefined;
}

function evaluationReport(value: unknown): RequirementBriefEvaluation | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const candidate = value as Partial<RequirementBriefEvaluation>;
	return candidate.schemaVersion === "requirement-brief-evaluation.v1" &&
		typeof candidate.passed === "boolean" &&
		Array.isArray(candidate.issues)
		? candidate as RequirementBriefEvaluation
		: undefined;
}

const stageLabels = {
	pending: "等待开始",
	running: "正在生成",
	evaluating: "正在评测",
	needs_input: "需要补充/确认",
	waiting_approval: "等待 Approval A",
	revision_required: "需要修订",
	cancelled: "已取消",
	passed: "已通过",
	retryable_failed: "评测未通过",
} as const;

function App() {
	const [health, setHealth] = useState<RuntimeHealth>();
	const [conversations, setConversations] = useState<ConversationSummary[]>([]);
	const [active, setActive] = useState<ConversationView>();
	const [draft, setDraft] = useState("");
	const [attachments, setAttachments] = useState<ConversationAttachment[]>([]);
	const [attachmentPreviews, setAttachmentPreviews] = useState<Record<string, string>>({});
	const [selectedAttachmentIds, setSelectedAttachmentIds] = useState<string[]>([]);
	const [uploading, setUploading] = useState(false);
	const [loading, setLoading] = useState(true);
	const [sending, setSending] = useState(false);
	const [backgroundTasks, setBackgroundTasks] = useState<BackgroundTaskView[]>([]);
	const [cronSchedules, setCronSchedules] = useState<CronScheduleView[]>([]);
	const [requirement, setRequirement] = useState<RequirementBriefWorkspaceView>();
	const [requirementMetrics, setRequirementMetrics] = useState<RequirementBriefMetricsSeriesView>();
	const [requirementBusy, setRequirementBusy] = useState(false);
	const [industry, setIndustry] = useState<ManufacturingIndustry>("print");
	const [factKey, setFactKey] = useState("");
	const [factValue, setFactValue] = useState("");
	const [factUnit, setFactUnit] = useState("");
	const [error, setError] = useState<string>();
	const chatScrollRef = useRef<HTMLElement>(null);
	const followChatRef = useRef(true);

	useEffect(() => {
		let cancelled = false;
		void bootstrap()
			.then((result) => {
				if (cancelled) return;
				setHealth(result.health);
				setConversations(result.conversations);
				setActive(result.active);
			})
			.catch((reason) => {
				if (!cancelled) setError(errorMessage(reason));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		if (!active) return;
		let cancelled = false;
		void client.listBackgroundTasks(active.conversationId)
			.then((tasks) => {
				if (cancelled) return;
				setBackgroundTasks((current) => [
					...current.filter((task) => task.conversationId !== active.conversationId),
					...tasks,
				]);
			})
			.catch((reason) => {
				if (!cancelled) setError(errorMessage(reason));
			});
		return () => {
			cancelled = true;
		};
	}, [active?.conversationId, active?.revision]);

	useEffect(() => {
		if (!active) return;
		let cancelled = false;
		setAttachments([]);
		setSelectedAttachmentIds([]);
		void client.listAttachments(active.conversationId)
			.then((items) => {
				if (!cancelled) setAttachments(items);
			})
			.catch((reason) => {
				if (!cancelled) setError(errorMessage(reason));
			});
		return () => {
			cancelled = true;
		};
	}, [active?.conversationId]);

	useEffect(() => {
		if (!active) return;
		let cancelled = false;
		const objectUrls: string[] = [];
		setAttachmentPreviews({});
		void Promise.all(attachments
			.filter((attachment) => attachment.kind === "image")
			.map(async (attachment) => {
				const url = URL.createObjectURL(await client.readAttachment(
					active.conversationId,
					attachment.attachmentId,
				));
				objectUrls.push(url);
				return [attachment.attachmentId, url] as const;
			}))
			.then((entries) => {
				if (cancelled) {
					objectUrls.forEach((url) => URL.revokeObjectURL(url));
					return;
				}
				setAttachmentPreviews(Object.fromEntries(entries));
			})
			.catch((reason) => {
				if (!cancelled) setError(errorMessage(reason));
			});
		return () => {
			cancelled = true;
			objectUrls.forEach((url) => URL.revokeObjectURL(url));
		};
	}, [active?.conversationId, attachments]);

	useEffect(() => {
		if (!active) return;
		let cancelled = false;
		setRequirement(undefined);
		void client.getRequirementBrief(active.conversationId)
			.then((next) => {
				if (!cancelled) {
					setRequirement(next ?? undefined);
					const selected = next?.state.facts.industry?.value;
					if (selected === "print" || selected === "furniture") setIndustry(selected);
				}
			})
			.catch((reason) => {
				if (!cancelled) setError(errorMessage(reason));
			});
		return () => {
			cancelled = true;
		};
	}, [active?.conversationId]);

	useEffect(() => {
		if (!active || !requirement) return;
		const waiting = requirement.state.stageStatus === "running" && requirement.job?.status !== "dead_letter" ||
			requirement.state.stageStatus === "evaluating" ||
			requirement.job?.status === "queued" ||
			requirement.job?.status === "leased" ||
			requirement.state.stageStatus === "waiting_approval" && requirement.state.approval?.status === "approved";
		if (!waiting) return;
		const timer = window.setTimeout(() => {
			void client.getRequirementBrief(active.conversationId)
				.then((next) => {
					if (next) setRequirement(next);
					if (next?.job?.status === "dead_letter") {
						setError(`Requirement Worker 失败：${next.job.lastFailure?.message ?? "已进入死信队列"}`);
					}
				})
				.catch((reason) => setError(errorMessage(reason)));
		}, 750);
		return () => window.clearTimeout(timer);
	}, [active?.conversationId, requirement]);

	useEffect(() => {
		let cancelled = false;
		void client.getRequirementBriefMetrics()
			.then((metrics) => {
				if (!cancelled) setRequirementMetrics(metrics);
			})
			.catch((reason) => {
				if (!cancelled) setError(errorMessage(reason));
			});
		return () => {
			cancelled = true;
		};
	}, [conversations.length, requirement?.state.aggregateVersion]);

	useEffect(() => {
		if (!active) return;
		let cancelled = false;
		void client.listCronSchedules(active.conversationId)
			.then((schedules) => {
				if (!cancelled) setCronSchedules(schedules);
			})
			.catch((reason) => {
				if (!cancelled) setError(errorMessage(reason));
			});
		return () => {
			cancelled = true;
		};
	}, [active?.conversationId, active?.revision]);

	useEffect(() => {
		const pending = backgroundTasks.filter((task) => task.status === "queued" || task.status === "leased");
		if (!pending.length) return;
		const timer = window.setTimeout(() => {
			void Promise.all(pending.map((task) => client.getBackgroundTask(task.taskId)))
				.then(async (updatedTasks) => {
					setBackgroundTasks((current) => current.map((task) =>
						updatedTasks.find((updated) => updated.taskId === task.taskId) ?? task,
					));
					const completedActiveTask = updatedTasks.some((task) =>
						task.status === "completed" && task.conversationId === active?.conversationId,
					);
					if (completedActiveTask && active) {
						const updated = await client.get(active.conversationId);
						setActive(updated);
						await refreshList(updated);
					}
					const failed = updatedTasks.find((task) => task.status === "dead_letter");
					if (failed) setError(`后台任务失败：${failed.lastFailure?.message ?? "已进入死信队列"}`);
				})
				.catch((reason) => setError(errorMessage(reason)));
		}, 750);
		return () => window.clearTimeout(timer);
	}, [backgroundTasks, active?.conversationId]);

	useEffect(() => {
		const view = chatScrollRef.current;
		if (!view || (!sending && !followChatRef.current)) return;
		view.scrollTo({ top: view.scrollHeight, behavior: "smooth" });
	}, [active?.conversationId, active?.messages.length, sending]);

	const refreshList = async (current: ConversationView) => {
		const next = await client.list();
		setConversations(next.some((item) => item.conversationId === current.conversationId)
			? next
			: [summary(current), ...next]);
	};

	const createConversation = async () => {
		if (sending) return;
		setError(undefined);
		try {
			const created = await client.create();
			followChatRef.current = true;
			setActive(created);
			setConversations((current) => [summary(created), ...current]);
		} catch (reason) {
			setError(errorMessage(reason));
		}
	};

	const selectConversation = async (conversationId: string) => {
		if (sending || active?.conversationId === conversationId) return;
		setError(undefined);
		try {
			followChatRef.current = true;
			setActive(await client.get(conversationId));
		} catch (reason) {
			setError(errorMessage(reason));
		}
	};

	const send = async (raw: string) => {
		const content = raw.trim();
		const selectedAttachments = attachments.filter((attachment) => selectedAttachmentIds.includes(attachment.attachmentId));
		if ((!content && selectedAttachments.length === 0) || !active || sending || hasActiveBackgroundTask || health?.adapter !== "blackx-agent") return;
		const messageId = `message-${crypto.randomUUID()}`;
		const optimistic: ConversationMessage = {
			messageId,
			role: "user",
			content,
			createdAt: new Date().toISOString(),
			attachments: selectedAttachments.map((attachment) => ({
				name: attachment.name,
				mediaType: attachment.mediaType,
				sourceRef: `attachment://${active.conversationId}/${attachment.attachmentId}`,
			})),
		};
		const conversationId = active.conversationId;
		setDraft("");
		setError(undefined);
		followChatRef.current = true;
		setSending(true);
		setActive((current) => current && current.conversationId === conversationId
			? { ...current, messages: [...current.messages, optimistic], preview: content }
			: current);
		try {
			const updated = await client.send(conversationId, {
				messageId,
				content,
				attachmentIds: selectedAttachments.map((attachment) => attachment.attachmentId),
			});
			setActive(updated);
			setSelectedAttachmentIds([]);
			await refreshList(updated);
		} catch (reason) {
			setError(errorMessage(reason));
		} finally {
			setSending(false);
		}
	};

	const startRequirement = async () => {
		if (!active || requirementBusy || sending || !realProvider) return;
		setRequirementBusy(true);
		setError(undefined);
		try {
			setRequirement(await client.startRequirementBrief(
				active.conversationId,
				`requirement-${crypto.randomUUID()}`,
				industry,
			));
		} catch (reason) {
			setError(errorMessage(reason));
		} finally {
			setRequirementBusy(false);
		}
	};

	const uploadAttachments = async (event: ChangeEvent<HTMLInputElement>) => {
		const input = event.currentTarget;
		const files = [...(input.files ?? [])];
		if (!active || files.length === 0 || uploading) return;
		setUploading(true);
		setError(undefined);
		try {
			const uploaded: ConversationAttachment[] = [];
			for (const file of files) {
				uploaded.push(await client.uploadAttachment(
					active.conversationId,
					`upload-${crypto.randomUUID()}`,
					file,
				));
			}
			setAttachments(await client.listAttachments(active.conversationId));
			setSelectedAttachmentIds((current) => [...new Set([
				...current,
				...uploaded.filter((attachment) => attachment.modelInput === "image").map((attachment) => attachment.attachmentId),
			])]);
		} catch (reason) {
			setError(errorMessage(reason));
		} finally {
			input.value = "";
			setUploading(false);
		}
	};

	const downloadAttachment = async (attachment: ConversationAttachment) => {
		if (!active) return;
		try {
			const url = URL.createObjectURL(await client.readAttachment(
				active.conversationId,
				attachment.attachmentId,
			));
			const link = document.createElement("a");
			link.href = url;
			link.download = attachment.name;
			link.click();
			window.setTimeout(() => URL.revokeObjectURL(url), 0);
		} catch (reason) {
			setError(errorMessage(reason));
		}
	};

	const useAttachment = (attachment: ConversationAttachment) => {
		if (attachment.modelInput !== "image") {
			void downloadAttachment(attachment);
			return;
		}
		setSelectedAttachmentIds((current) => current.includes(attachment.attachmentId)
			? current.filter((attachmentId) => attachmentId !== attachment.attachmentId)
			: [...current, attachment.attachmentId].slice(-8));
	};

	const resolveRequirementApproval = async (decision: "approved" | "rejected") => {
		if (!active || requirementBusy || requirement?.state.approval?.status !== "requested") return;
		setRequirementBusy(true);
		setError(undefined);
		try {
			setRequirement(await client.resolveRequirementApproval(
				active.conversationId,
				`approval-${crypto.randomUUID()}`,
				decision,
			));
		} catch (reason) {
			setError(errorMessage(reason));
		} finally {
			setRequirementBusy(false);
		}
	};

	const cancelRequirement = async () => {
		if (!active || !requirement || requirementBusy || requirement.state.stageStatus === "passed") return;
		setRequirementBusy(true);
		setError(undefined);
		try {
			setRequirement(await client.cancelRequirementBrief(
				active.conversationId,
				`cancel-${crypto.randomUUID()}`,
			));
		} catch (reason) {
			setError(errorMessage(reason));
		} finally {
			setRequirementBusy(false);
		}
	};

	const recordFact = async (event: FormEvent) => {
		event.preventDefault();
		if (!active || !requirement || requirementBusy || !factKey.trim() || !factValue.trim()) return;
		setRequirementBusy(true);
		setError(undefined);
		try {
			setRequirement(await client.recordRequirementFact(
				active.conversationId,
				`fact-${crypto.randomUUID()}`,
				{
					key: factKey.trim(),
					value: factValue.trim(),
					unit: factUnit.trim() || undefined,
				},
			));
			setFactKey("");
			setFactValue("");
			setFactUnit("");
		} catch (reason) {
			setError(errorMessage(reason));
		} finally {
			setRequirementBusy(false);
		}
	};

	const resolveFact = async (key: string, decision: "verified" | "rejected") => {
		if (!active || requirementBusy) return;
		setRequirementBusy(true);
		setError(undefined);
		try {
			setRequirement(await client.resolveRequirementFact(
				active.conversationId,
				key,
				`fact-decision-${crypto.randomUUID()}`,
				decision,
			));
		} catch (reason) {
			setError(errorMessage(reason));
		} finally {
			setRequirementBusy(false);
		}
	};

	const onSubmit = (event: FormEvent) => {
		event.preventDefault();
		void send(draft);
	};

	const realProvider = health?.adapter === "blackx-agent";
	const activeBackgroundTasks = backgroundTasks.filter((task) =>
		task.conversationId === active?.conversationId && (task.status === "queued" || task.status === "leased"),
	);
	const hasActiveBackgroundTask = activeBackgroundTasks.length > 0;
	const activeCronSchedules = cronSchedules.filter((schedule) => schedule.status === "active");
	const hasUserMessage = Boolean(active?.messages.some((message) => message.role === "user"));
	const content = requirementContent(requirement?.artifact?.content);
	const evaluation = evaluationReport(requirement?.evaluation?.report);
	const facts = Object.values(requirement?.state.facts ?? {})
		.filter((fact) => fact.key !== "customer_brief" && fact.key !== "industry" && fact.key !== "customer_attachments")
		.sort((left, right) => left.key.localeCompare(right.key));
	const requirementRunning = requirement?.state.stageStatus === "running" && requirement.job?.status !== "dead_letter" ||
		requirement?.state.stageStatus === "evaluating" ||
		requirement?.job?.status === "queued" ||
		requirement?.job?.status === "leased";
	const requirementTerminal = requirement?.state.stageStatus === "passed" || requirement?.state.stageStatus === "cancelled";

	return (
		<div className="app-shell">
			<aside className="sidebar">
				<div className="brand-lockup">
					<span className="brand-mark" aria-hidden="true">Bx</span>
					<div>
						<strong>Blackx</strong>
						<span>Agent Workspace</span>
					</div>
				</div>

				<button className="new-task" onClick={() => void createConversation()} disabled={sending}>
					<span>＋</span> 新建会话
				</button>

				<div className="history-label">会话历史</div>
				<nav className="conversation-list" aria-label="会话历史">
					{conversations.map((conversation) => (
						<button
							key={conversation.conversationId}
							className={active?.conversationId === conversation.conversationId ? "active" : ""}
							onClick={() => void selectConversation(conversation.conversationId)}
							disabled={sending}
						>
							<strong>{conversation.title}</strong>
							<span>{conversation.preview}</span>
							<small>{displayTime(conversation.updatedAt)} · {conversation.messageCount} 条</small>
						</button>
					))}
				</nav>

				<div className="sidebar-footer">
					<div className="runtime-light">
						<i className={realProvider ? "online" : "offline"} />
						{realProvider ? "实际模型 API 已连接" : "实际模型 API 未连接"}
					</div>
					<small>{health?.adapter ?? "正在检查 Runtime"}</small>
				</div>
			</aside>

			<main className="conversation">
				<header className="topbar">
					<div>
						<span className="eyebrow">SERVER-PERSISTED AGENT SESSION</span>
						<h1>{active?.title ?? "Blackx 会话"}</h1>
					</div>
					<span className={`runtime-chip ${realProvider ? "online" : "offline"}`}>
						{realProvider ? "LIVE API" : "API REQUIRED"}
					</span>
				</header>

				<section
					ref={chatScrollRef}
					className="chat-scroll"
					aria-live="polite"
					onScroll={(event) => {
						const view = event.currentTarget;
						followChatRef.current = view.scrollHeight - view.scrollTop - view.clientHeight < 80;
					}}
				>
					{loading ? (
						<div className="empty-state"><p>正在加载服务端会话…</p></div>
					) : active?.messages.length ? (
						<div className="message-list">
							{active.messages.map((message) => (
								<article key={message.messageId} className={`message ${message.role}`}>
									<div className="avatar">{message.role === "assistant" ? "Bx" : "你"}</div>
									<div className="message-content">
										<div className="message-meta">
											<strong>{message.role === "assistant" ? "Blackx" : "你"}</strong>
											<time>{displayTime(message.createdAt)}</time>
										</div>
										{message.content.split("\n").map((line, index) => (
											<p key={`${message.messageId}-${index}`}>{line || <br />}</p>
										))}
										{message.attachments?.length ? (
											<div className="message-attachments">
												{message.attachments.map((attachment) => {
													const attachmentId = attachmentIdFromSourceRef(attachment.sourceRef);
													const preview = attachmentId ? attachmentPreviews[attachmentId] : undefined;
													return <span key={attachment.sourceRef}>
														{preview && <img src={preview} alt="" />}
														{attachment.name}
													</span>;
												})}
											</div>
										) : null}
									</div>
								</article>
							))}
							{(sending || hasActiveBackgroundTask) && (
								<article className="message assistant thinking">
									<div className="avatar">Bx</div>
									<div>
										<span>{hasActiveBackgroundTask ? "后台任务正在执行，可以切换会话" : "正在等待模型回复"}</span>
										<div className="thinking-dots"><i /><i /><i /></div>
									</div>
								</article>
							)}
						</div>
					) : (
						<div className="empty-state">
							<span className="empty-mark">Bx</span>
							<h2>开始一个新的制造需求任务</h2>
							<p>消息和模型回复会保存在服务端 Agent Session，不再使用浏览器 localStorage。</p>
							<div className="prompt-grid">
								<button onClick={() => void send("我想做一款500克咖啡豆包装袋，请先帮我梳理需要确认的信息。")}>咖啡豆包装需求</button>
								<button onClick={() => void send("我要定制一组办公室储物柜，请先帮我梳理尺寸、数量、安装和交付信息。")}>办公家具需求</button>
							</div>
						</div>
					)}
				</section>

				<div className="composer-wrap">
					{!realProvider && !loading && (
						<div className="provider-warning">
							请停止当前服务，并使用 <code>BLACKX_RUNTIME_MODE=anthropic npm run dev</code> 启动实际模型。
						</div>
					)}
					{error && <div className="error-banner" role="alert">{error}</div>}
					{hasActiveBackgroundTask && (
						<div className="task-banner" role="status">
							后台任务：{activeBackgroundTasks.some((task) => task.status === "leased") ? "模型处理中" : "排队或等待重试"}
						</div>
					)}
					{activeCronSchedules.length > 0 && (
						<div className="cron-banner" role="status">
							Agent 管理的定时任务：{activeCronSchedules.length} 个 · 下次运行 {displayTime(activeCronSchedules[0].nextRunAt)}
						</div>
					)}
					{attachments.length > 0 && (
						<div className="attachment-list" aria-label="会话附件">
							{attachments.map((attachment) => (
								<button
									key={attachment.attachmentId}
									type="button"
									className={selectedAttachmentIds.includes(attachment.attachmentId) ? "selected" : ""}
									onClick={() => useAttachment(attachment)}
									title={`${attachment.name} · ${(attachment.size / 1024).toFixed(1)} KB`}
								>
									{attachmentPreviews[attachment.attachmentId]
										? <img src={attachmentPreviews[attachment.attachmentId]} alt="" />
										: <span>{attachment.kind === "text" ? "TXT" : "FILE"}</span>}
									<strong>{attachment.name}</strong>
									<small>{attachment.modelInput === "image"
										? selectedAttachmentIds.includes(attachment.attachmentId) ? "将随下一条消息发送" : "点击附到下一条消息"
										: attachment.modelInput === "text_extracted" ? "文本将进入需求来源" : "已保存，当前仅传递元数据"}</small>
								</button>
							))}
						</div>
					)}
					<form className="composer" onSubmit={onSubmit}>
						<textarea
							value={draft}
							onChange={(event) => setDraft(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter" && !event.shiftKey) {
									event.preventDefault();
									void send(draft);
								}
							}}
							rows={2}
							placeholder={hasActiveBackgroundTask
								? "当前会话的后台任务完成后可继续发送"
								: realProvider ? "发送消息给 Blackx…" : "请先连接实际模型 API"}
							disabled={!active || !realProvider || sending || hasActiveBackgroundTask}
							aria-label="对话输入"
						/>
						<div className="composer-tools">
							<label className={uploading ? "attachment-upload disabled" : "attachment-upload"}>
								<input
									type="file"
									multiple
									accept="image/*,.pdf,.txt,.md,.csv,.json"
									onChange={(event) => void uploadAttachments(event)}
									disabled={!active || uploading}
								/>
								{uploading ? "上传中…" : "＋ 图片 / 文件"}
							</label>
							<span>Enter 发送 · Shift + Enter 换行</span>
							<button
								type="submit"
								className="send-button"
								disabled={(!draft.trim() && selectedAttachmentIds.length === 0) || !realProvider || sending || hasActiveBackgroundTask}
							>
								↑
							</button>
						</div>
					</form>
					<small className="disclaimer">建议保持待确认；权威事实和审批由确定性服务端状态管理。</small>
				</div>
			</main>

			<aside className="proposal-panel" aria-label="Requirement Brief 业务状态">
				<header className="proposal-header">
					<div>
						<span className="eyebrow">ARTIFACT-FIRST WORKFLOW</span>
						<h2>Requirement Brief</h2>
					</div>
					{requirement && (
						<span className={`proposal-status ${requirement.state.stageStatus}`}>
							{stageLabels[requirement.state.stageStatus]}
						</span>
					)}
				</header>

				<div className="proposal-body">
					{requirementMetrics && requirementMetrics.totals.runs > 0 && (
						<section className="proposal-section">
							<div className="section-title"><strong>Cross-run Metrics</strong><code>{requirementMetrics.totals.runs} Runs</code></div>
							<dl className="run-metadata">
								<div><dt>工作流完成</dt><dd>{requirementMetrics.rates.workflowCompletion === null ? "—" : `${Math.round(requirementMetrics.rates.workflowCompletion * 100)}%`}</dd></div>
								<div><dt>Stage 通过</dt><dd>{requirementMetrics.rates.stagePass === null ? "—" : `${Math.round(requirementMetrics.rates.stagePass * 100)}%`}</dd></div>
								<div><dt>评测通过</dt><dd>{requirementMetrics.rates.evaluationPass === null ? "—" : `${Math.round(requirementMetrics.rates.evaluationPass * 100)}%`}</dd></div>
								<div><dt>需要补充</dt><dd>{requirementMetrics.totals.needsInput}</dd></div>
								<div><dt>平均 Fact 确认</dt><dd>{requirementMetrics.averages.confirmationRate === null ? "—" : `${Math.round(requirementMetrics.averages.confirmationRate * 100)}%`}</dd></div>
								<div><dt>候选确认准确率</dt><dd>{requirementMetrics.averages.confirmedCandidateAccuracy === null ? "—" : `${Math.round(requirementMetrics.averages.confirmedCandidateAccuracy * 100)}%`}</dd></div>
								<div><dt>来源覆盖</dt><dd>{requirementMetrics.averages.sourceCoverageRate === null ? "—" : `${Math.round(requirementMetrics.averages.sourceCoverageRate * 100)}%`}</dd></div>
								<div><dt>Artifact / 澄清问题</dt><dd>{requirementMetrics.totals.artifactVersions} / {requirementMetrics.totals.clarificationQuestions}</dd></div>
								<div><dt>Queue 恢复 / 失败率</dt><dd>{requirementMetrics.queue.recoveryRate === null ? "—" : `${Math.round(requirementMetrics.queue.recoveryRate * 100)}%`} / {requirementMetrics.queue.failureRate === null ? "—" : `${Math.round(requirementMetrics.queue.failureRate * 100)}%`}</dd></div>
								<div><dt>Tool 失败率</dt><dd>{requirementMetrics.runtime.toolFailureRate === null ? "—" : `${Math.round(requirementMetrics.runtime.toolFailureRate * 100)}%`}</dd></div>
								<div><dt>总 Token (in / out)</dt><dd>{requirementMetrics.runtime.usage ? `${requirementMetrics.runtime.usage.inputTokens} / ${requirementMetrics.runtime.usage.outputTokens}` : "—"}</dd></div>
								<div><dt>平均 Runtime 延迟</dt><dd>{requirementMetrics.averages.runtimeLatencyMs === null ? "—" : `${Math.round(requirementMetrics.averages.runtimeLatencyMs)} ms`}</dd></div>
							</dl>
							<div className="verification-list">
								<strong>最近运行时间序列</strong>
								{requirementMetrics.points.slice(-6).reverse().map((point) => (
									<span key={point.runId}>{displayTime(point.startedAt)} · {point.industry ?? "unknown"} · {stageLabels[point.stageStatus]} · Artifact v{point.metrics.artifactVersions}</span>
								))}
							</div>
						</section>
					)}
					{!requirement ? (
						<section className="proposal-empty">
							<strong>还没有 Requirement Run</strong>
							<p>将当前会话固化为有来源、可确认、可评测和可审批的需求单版本。</p>
							<div className="industry-picker" role="group" aria-label="制造行业">
								<button className={industry === "print" ? "selected" : ""} onClick={() => setIndustry("print")}>印刷 / 包装</button>
								<button className={industry === "furniture" ? "selected" : ""} onClick={() => setIndustry("furniture")}>定制家具</button>
							</div>
							<button
								className="primary-action"
								onClick={() => void startRequirement()}
								disabled={!hasUserMessage || !realProvider || requirementBusy || sending}
							>
								{requirementBusy ? "正在创建…" : "生成需求单"}
							</button>
							{!hasUserMessage && <small>先发送一条明确的印刷或家具需求。</small>}
						</section>
					) : (
						<>
							<section className="workflow-track" aria-label="Requirement Brief 工作流进度">
								<span className="done">Intake</span>
								<span className={requirement.state.currentProposal ? "done" : "active"}>Artifact</span>
								<span className={requirement.state.evaluation ? "done" : requirement.state.stageStatus === "evaluating" ? "active" : ""}>Evaluation</span>
								<span className={requirement.state.stageStatus === "passed" ? "done" : requirement.state.stageStatus === "waiting_approval" ? "active" : ""}>Approval</span>
							</section>

							<section className="proposal-section">
								<div className="section-title"><strong>Run</strong><code>v{requirement.state.aggregateVersion}</code></div>
								<dl className="run-metadata">
									<div><dt>行业</dt><dd>{requirement.state.facts.industry?.value === "furniture" ? "家具" : "印刷"}</dd></div>
									<div><dt>状态</dt><dd>{stageLabels[requirement.state.stageStatus]}</dd></div>
									<div><dt>版本</dt><dd>{requirement.state.currentProposal?.version ?? "—"}</dd></div>
									<div><dt>队列</dt><dd>{requirement.job?.status ?? "—"}</dd></div>
								</dl>
							</section>

							<section className="proposal-section">
								<div className="section-title"><strong>Product Metrics</strong><code>{requirement.metrics.schemaVersion}</code></div>
								<dl className="run-metadata">
									<div><dt>Canonical 命中</dt><dd>{requirement.metrics.canonicalFactHitRate === null ? "—" : `${Math.round(requirement.metrics.canonicalFactHitRate * 100)}%`}</dd></div>
									<div><dt>Fact 确认</dt><dd>{Math.round(requirement.metrics.confirmationRate * 100)}% ({requirement.metrics.confirmedRequiredFacts}/{requirement.metrics.requiredFacts})</dd></div>
									<div><dt>候选确认准确率</dt><dd>{requirement.metrics.confirmedCandidateAccuracy === null ? "—" : `${Math.round(requirement.metrics.confirmedCandidateAccuracy * 100)}%`}</dd></div>
									<div><dt>来源覆盖</dt><dd>{requirement.metrics.sourceCoverageRate === null ? "—" : `${Math.round(requirement.metrics.sourceCoverageRate * 100)}%`}</dd></div>
									<div><dt>缺失 Fact</dt><dd>{requirement.metrics.missingRequiredFacts.length}</dd></div>
									<div><dt>澄清轮次</dt><dd>{requirement.metrics.clarificationRounds}</dd></div>
									<div><dt>Token (in / out)</dt><dd>{requirement.metrics.runtime.usage ? `${requirement.metrics.runtime.usage.inputTokens} / ${requirement.metrics.runtime.usage.outputTokens}` : "—"}</dd></div>
									<div><dt>Runtime 延迟</dt><dd>{requirement.metrics.runtime.latencyMs === null ? "—" : `${requirement.metrics.runtime.latencyMs} ms`}</dd></div>
									<div><dt>成本</dt><dd>{requirement.metrics.runtime.costStatus === "unconfigured" ? "未配置价格" : `$${requirement.metrics.runtime.costUsd}`}</dd></div>
									<div><dt>澄清问题</dt><dd>{requirement.metrics.clarificationQuestions}</dd></div>
									<div><dt>恢复 / 失败</dt><dd>{requirement.metrics.queue.recoveryCount} / {requirement.metrics.queue.totalFailureCount}</dd></div>
									<div><dt>Tool 失败率</dt><dd>{requirement.metrics.runtime.toolFailureRate === null ? "—" : `${Math.round(requirement.metrics.runtime.toolFailureRate * 100)}%`}</dd></div>
								</dl>
							</section>

							<section className="proposal-section facts-card">
								<div className="section-title"><strong>Field Facts</strong><span>{facts.length}</span></div>
								{facts.map((fact) => (
									<div className="fact-row" key={`${fact.key}-${fact.version}`}>
										<div>
											<code>{fact.key}@v{fact.version}</code>
											<strong>{String(fact.value)}{fact.unit ? ` ${fact.unit}` : ""}</strong>
											<small>{fact.sourceType} · {fact.status}</small>
										</div>
										{(fact.status === "suggested" || fact.status === "unverified") && (
											<div className="fact-actions">
												<button onClick={() => void resolveFact(fact.key, "rejected")} disabled={requirementBusy || requirementRunning || requirementTerminal}>拒绝</button>
												<button onClick={() => void resolveFact(fact.key, "verified")} disabled={requirementBusy || requirementRunning || requirementTerminal}>确认</button>
											</div>
										)}
									</div>
								))}
								<form className="fact-form" onSubmit={(event) => void recordFact(event)}>
									<input value={factKey} onChange={(event) => setFactKey(event.target.value)} placeholder="字段，例如 quantity" aria-label="Fact 字段" disabled={requirementTerminal} />
									<input value={factValue} onChange={(event) => setFactValue(event.target.value)} placeholder="值" aria-label="Fact 值" disabled={requirementTerminal} />
									<input value={factUnit} onChange={(event) => setFactUnit(event.target.value)} placeholder="单位（可选）" aria-label="Fact 单位" disabled={requirementTerminal} />
									<button type="submit" disabled={requirementBusy || requirementRunning || requirementTerminal || !factKey.trim() || !factValue.trim()}>记录候选</button>
								</form>
								<small>模型或用户输入只能形成候选；确认后才成为 verified。</small>
							</section>

							{content && (
								<section className="proposal-section artifact-card">
									<div className="section-title"><strong>{content.title}</strong><code>Artifact v{requirement.state.currentProposal?.version}</code></div>
									<p>{content.customerGoal}</p>
									<div className="verification-list">
										<strong>缺失的必填字段</strong>
										{content.missingRequiredFacts.length
											? content.missingRequiredFacts.map((item) => <span key={item}>· {item}</span>)
											: <span>无</span>}
									</div>
									<small>下一步：{content.nextAction}</small>
								</section>
							)}

							{requirement.state.currentProposal && !content && (
								<section className="proposal-section invalid-artifact">
									<strong>Artifact 无法作为结构化 Requirement Brief 展示</strong>
									<p>原始输出已经留存，Evaluation 会记录失败原因。</p>
								</section>
							)}

							{evaluation && (
								<section className={`proposal-section evaluation ${evaluation.passed ? "passed" : "failed"}`}>
									<div className="section-title"><strong>Deterministic Evaluation</strong><span>{evaluation.passed ? "PASSED" : "FAILED"}</span></div>
									{evaluation.issues.length === 0
										? <p>结构和权威状态检查通过。{evaluation.approvalEligible ? "可以审批。" : "仍需补充或确认 Fact。"}</p>
										: evaluation.issues.map((issue) => <p key={issue.code}>{issue.message}</p>)}
								</section>
							)}

							{requirement.state.approval?.status === "requested" && (
								<section className="proposal-section approval-card">
									<strong>Requirement Approval · Artifact v{requirement.state.approval.artifactVersion}</strong>
									<p>审批只绑定当前版本；后续需求变化会使该审批失效。</p>
									<div className="approval-actions">
										<button onClick={() => void resolveRequirementApproval("rejected")} disabled={requirementBusy}>拒绝</button>
										<button className="primary-action" onClick={() => void resolveRequirementApproval("approved")} disabled={requirementBusy}>批准当前版本</button>
									</div>
								</section>
							)}

							{requirement.state.approval && requirement.state.approval.status !== "requested" && (
								<div className={`approval-result ${requirement.state.approval.status}`}>Requirement Approval：{requirement.state.approval.status}</div>
							)}
							{requirement.job?.status === "dead_letter" && (
								<div className="proposal-failure">{requirement.job.lastFailure?.message ?? "Requirement Worker 已进入死信队列"}</div>
							)}

							{requirement.state.stageStatus !== "passed" && requirement.state.stageStatus !== "cancelled" && (
								<button className="secondary-action" onClick={() => void cancelRequirement()} disabled={requirementBusy}>取消任务</button>
							)}
							{requirement.state.stageStatus === "cancelled" && (
								<div className="cancelled-note">已保留需求、Fact、Artifact 与审计事件；重新审查会从现有版本继续，不会删除历史。</div>
							)}
							<button
								className="secondary-action"
								onClick={() => void startRequirement()}
								disabled={!hasUserMessage || !realProvider || requirementBusy || sending || requirementRunning || requirement.state.stageStatus === "waiting_approval" || requirement.state.stageStatus === "passed"}
							>
								{requirementRunning
									? "后台正在执行…"
									: requirement.state.stageStatus === "cancelled"
										? "重新审查需求单"
										: "用最新 Fact 生成新版本"}
							</button>
						</>
					)}
				</div>
			</aside>
		</div>
	);
}

export default App;
