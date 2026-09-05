import { ModelMonitor } from "./components/ModelMonitor";
import { FileExplorer } from "./components/FileExplorer";
import { ChangeEvent, FormEvent, useEffect, useRef, useState } from "react";
import { Markdown } from "./components/Markdown";
import { ConversationFiles } from "./components/ConversationFiles";
import { DeleteConversationDialog } from "./components/DeleteConversationDialog";
import { DeliveryPreview } from "./components/DeliveryPreview";
import { requirementFieldLabels, factStatusLabels, inspectionStatusLabels } from "./manufacturing/requirementDelivery";
import type { AssetInspectionRecord } from "./runtime/assetInspection";
import { requiredRequirementFacts } from "./manufacturing/requirementBrief";
import type { RuntimeActivity } from "./runtime/conversationContracts";
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
	RequirementBriefEvaluation,
	RequirementBriefV1,
} from "./manufacturing/requirementBrief";

const client = new ConversationClient();
let bootstrapPromise: Promise<{
	health: RuntimeHealth;
	conversations: ConversationSummary[];
	active: ConversationView | undefined;
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
				: undefined;
			return {
				health,
				conversations: existing,
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
	waiting_approval: "等待批准",
	revision_required: "需要修订",
	cancelled: "已取消",
	passed: "已通过",
	retryable_failed: "评测未通过",
} as const;

function App() {
	const [panelTab, setPanelTab] = useState<"requirement" | "models" | "files">("requirement");
	const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= 760);
	const [reviewOpen, setReviewOpen] = useState(() => window.innerWidth >= 1180);
	const [activity, setActivity] = useState<RuntimeActivity>();
	const [requirementActivity, setRequirementActivity] = useState<RuntimeActivity>();
	const [health, setHealth] = useState<RuntimeHealth>();
	const [conversations, setConversations] = useState<ConversationSummary[]>([]);
	const [active, setActive] = useState<ConversationView>();
	const activeIdRef = useRef<string | undefined>(undefined);
	const deletedIds = useRef(new Set<string>());
	const selectionVersion = useRef(0);
	const [pendingDelete, setPendingDelete] = useState<ConversationSummary>();
	const [deleting, setDeleting] = useState(false);
	const [deleteError, setDeleteError] = useState<string>();
	const activate = (conversation?: ConversationView) => {
		activeIdRef.current = conversation?.conversationId;
		setActive(conversation);
	};
	const updateActive = (conversation: ConversationView) => {
		if (activeIdRef.current === conversation.conversationId && !deletedIds.current.has(conversation.conversationId)) setActive(conversation);
	};
	const [draft, setDraft] = useState("");
	const [attachments, setAttachments] = useState<ConversationAttachment[]>([]);
	const [parsedSources, setParsedSources] = useState<AssetInspectionRecord[]>([]);
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
	const [factKey, setFactKey] = useState("");
	const [factValue, setFactValue] = useState("");
	const [factUnit, setFactUnit] = useState("");
	const [error, setError] = useState<string>();
	const chatScrollRef = useRef<HTMLElement>(null);
	const followChatRef = useRef(true);
	const newConversationRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		let cancelled = false;
		void bootstrap()
			.then((result) => {
				if (cancelled) return;
				setHealth(result.health);
				setConversations(result.conversations);
				activate(result.active);
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
		setAttachments([]);
		setParsedSources([]);
		setSelectedAttachmentIds([]);
		if (!active) return;
		let cancelled = false;
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
		setAttachmentPreviews({});
		if (!active) return;
		let cancelled = false;
		const objectUrls: string[] = [];
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
		setRequirement(undefined);
		if (!active) return;
		let cancelled = false;
		void client.getRequirementBrief(active.conversationId)
			.then((next) => {
				if (!cancelled) {
					setRequirement(next ?? undefined);
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
		if (!active || !requirement || requirement.readOnlyReason) return;
		const waiting = requirement.state.stageStatus === "running" && requirement.job?.status !== "dead_letter" ||
			requirement.state.stageStatus === "evaluating" ||
			requirement.job?.status === "queued" ||
			requirement.job?.status === "leased" ||
			requirement.state.stageStatus === "waiting_approval" && requirement.state.approval?.status === "approved";
		if (!waiting) return;
		let cancelled = false;
		const timer = window.setTimeout(() => {
			void client.getRequirementBrief(active.conversationId)
				.then((next) => {
					if (cancelled) return;
					if (next) setRequirement(next);
					if (next?.job?.status === "dead_letter") {
						setError(`Requirement Worker 失败：${next.job.lastFailure?.message ?? "已进入死信队列"}`);
					}
				})
				.catch((reason) => { if (!cancelled) setError(errorMessage(reason)); });
		}, 750);
		return () => { cancelled = true; window.clearTimeout(timer); };
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
		setCronSchedules([]);
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
		let cancelled = false;
		const timer = window.setTimeout(() => {
			void Promise.all(pending.map((task) => client.getBackgroundTask(task.taskId)))
				.then(async (updatedTasks) => {
					if (cancelled) return;
					setBackgroundTasks((current) => current.map((task) =>
						updatedTasks.find((updated) => updated.taskId === task.taskId) ?? task,
					));
					const completedActiveTask = updatedTasks.some((task) =>
						task.status === "completed" && task.conversationId === active?.conversationId,
					);
					if (completedActiveTask && active) {
						const updated = await client.get(active.conversationId);
						if (cancelled) return;
						updateActive(updated);
						await refreshList(updated);
					}
					const failed = updatedTasks.find((task) => task.status === "dead_letter");
					if (failed) setError(`后台任务失败：${failed.lastFailure?.message ?? "已进入死信队列"}`);
				})
				.catch((reason) => { if (!cancelled) setError(errorMessage(reason)); });
		}, 750);
		return () => { cancelled = true; window.clearTimeout(timer); };
	}, [backgroundTasks, active?.conversationId]);

	useEffect(() => {
		const view = chatScrollRef.current;
		if (!view || (!sending && !followChatRef.current)) return;
		view.scrollTo({ top: view.scrollHeight, behavior: "smooth" });
	}, [active?.conversationId, active?.messages.length, sending]);

	const refreshList = async (_current: ConversationView) => {
		const next = await client.list();
		setConversations(next.filter((item) => !deletedIds.current.has(item.conversationId)));
	};

	const createConversation = async () => {
		if (sending || deleting) return;
		const version = ++selectionVersion.current;
		setError(undefined);
		try {
			const created = await client.create();
			if (version !== selectionVersion.current) return;
			followChatRef.current = true;
			activate(created);
			setDraft("");
			if (window.innerWidth < 760) setSidebarOpen(false);
			setConversations((current) => [summary(created), ...current]);
		} catch (reason) {
			setError(errorMessage(reason));
		}
	};

	const selectConversation = async (conversationId: string) => {
		if (sending || deleting || deletedIds.current.has(conversationId)) return;
		if (window.innerWidth < 760) setSidebarOpen(false);
		if (active?.conversationId === conversationId) return;
		setError(undefined);
		const version = ++selectionVersion.current;
		try {
			followChatRef.current = true;
			const selected = await client.get(conversationId);
			if (version !== selectionVersion.current || deletedIds.current.has(conversationId)) return;
			activate(selected);
			setDraft("");
		} catch (reason) {
			setError(errorMessage(reason));
		}
	};

	const deleteConversation = async () => {
		if (!pendingDelete || deleting || uploading || requirementBusy) return;
		const conversationId = pendingDelete.conversationId;
		++selectionVersion.current;
		setDeleting(true);
		setDeleteError(undefined);
		try {
			let warning: string | undefined;
			try { await client.delete(conversationId); }
			catch (reason) {
				// Another tab may have deleted the same conversation already.
				if (!(reason instanceof ConversationClientError) || !["conversation_not_found", "conversation_cleanup_pending"].includes(reason.code)) throw reason;
				if (reason.code === "conversation_cleanup_pending") warning = reason.message;
			}
			setError(warning);
			deletedIds.current.add(conversationId);
			bootstrapPromise = undefined;
			const remaining = conversations.filter((item) => !deletedIds.current.has(item.conversationId));
			setConversations(remaining);
			setBackgroundTasks((current) => current.filter((task) => task.conversationId !== conversationId));
			if (activeIdRef.current === conversationId) {
				activate(undefined);
				setDraft(""); setSending(false); setRequirement(undefined);
				setActivity(undefined); setRequirementActivity(undefined);
				setAttachments([]); setSelectedAttachmentIds([]); setParsedSources([]); setAttachmentPreviews({});
				setCronSchedules([]); setFactKey(""); setFactValue(""); setFactUnit("");
				const index = conversations.findIndex((item) => item.conversationId === conversationId);
				const next = remaining[Math.min(index, remaining.length - 1)];
				if (next) {
					try { activate(await client.get(next.conversationId)); }
					catch (reason) { setError(errorMessage(reason)); }
				}
			}
			setPendingDelete(undefined);
			requestAnimationFrame(() => newConversationRef.current?.focus());
		} catch (reason) { setDeleteError(errorMessage(reason)); }
		finally { setDeleting(false); }
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
			if (activeIdRef.current !== conversationId || deletedIds.current.has(conversationId)) return;
			updateActive(updated);
			setSelectedAttachmentIds([]);
			await refreshList(updated);
		} catch (reason) {
			if (activeIdRef.current === conversationId && !deletedIds.current.has(conversationId)) setError(errorMessage(reason));
		} finally {
			if (activeIdRef.current === conversationId) setSending(false);
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
					value: factKey === "quantity" ? Number(factValue) : factValue.trim(),
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
	const requirementRunning = !requirement?.readOnlyReason && (requirement?.state.stageStatus === "running" && requirement.job?.status !== "dead_letter" ||
		requirement?.state.stageStatus === "evaluating" ||
		requirement?.job?.status === "queued" ||
		requirement?.job?.status === "leased");
	const requirementTerminal = requirement?.state.stageStatus === "passed" || requirement?.state.stageStatus === "cancelled";

	useEffect(() => {
		setActivity(undefined); setRequirementActivity(undefined);
		if (!active) return;
		let cancelled = false;
		const update = async () => {
			try {
				const [chat, task, freshHealth] = await Promise.all([client.activity(active.conversationId), requirementRunning ? client.activity(active.conversationId, true) : undefined, client.health()]);
				if (!cancelled) { setActivity(chat); setRequirementActivity(task); setHealth(freshHealth); }
				if (!sending && chat && ["completed", "failed", "paused"].includes(chat.phase)) {
					const restored = await client.get(active.conversationId);
					if (!cancelled) setActive((current) => current?.conversationId === restored.conversationId && current.revision < restored.revision ? restored : current);
				}
			} catch { /* The next interaction reports connection errors; stale progress is cleared. */
				if (!cancelled) { setActivity(undefined); setRequirementActivity(undefined); }
			}
		};
		void update();
		const timer = window.setInterval(() => void update(), 1000);
		return () => { cancelled = true; window.clearInterval(timer); };
	}, [active?.conversationId, sending, requirementRunning]);

	useEffect(() => {
		const resize = () => { if (window.innerWidth < 1180) setReviewOpen(false); if (window.innerWidth < 760) setSidebarOpen(false); };
		const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setReviewOpen(false); if (window.innerWidth < 760) setSidebarOpen(false); } };
		window.addEventListener("resize", resize); window.addEventListener("keydown", escape);
		return () => { window.removeEventListener("resize", resize); window.removeEventListener("keydown", escape); };
	}, []);

	const retryReply = async () => {
		if (!active || sending) return;
		setSending(true); setError(undefined);
		try { const updated = await client.retry(active.conversationId); updateActive(updated); await refreshList(updated); }
		catch (reason) { if (activeIdRef.current === active.conversationId && !deletedIds.current.has(active.conversationId)) setError(errorMessage(reason)); }
		finally { if (activeIdRef.current === active.conversationId) setSending(false); }
	};
	const stopReply = async () => {
		if (!active) return;
		try { await client.stop(active.conversationId); }
		catch (reason) { setError(errorMessage(reason)); }
	};
	const progressLabel = (value?: RuntimeActivity) => value?.phase === "tool" ? `正在${value.tool === "asset_metadata_inspect" ? "解析附件" : value.tool === "project_source_read" ? "读取需求来源" : "执行工具"}${value.tool ? ` · ${value.tool}` : ""}` : value?.phase === "model" ? `正在分析${value.iteration ? ` · 第 ${value.iteration} 轮` : ""}` : "正在准备任务";
	const replyRunning = sending || Boolean(activity && ["starting", "model", "tool"].includes(activity.phase));
	const fieldOptions = requiredRequirementFacts.print;

	return (
		<div className={`app-shell ${sidebarOpen ? "sidebar-open" : ""} ${reviewOpen ? "review-open" : ""}`}>
			<button className="drawer-backdrop" aria-label="关闭侧栏" onClick={() => { setReviewOpen(false); if (window.innerWidth < 760) setSidebarOpen(false); }} />
			<aside className="sidebar">
				<div className="brand-lockup">
					<span className="brand-mark" aria-hidden="true">Bx</span>
					<div>
						<strong>Blackx</strong>
						<span>Packaging Workspace</span>
					</div>
				</div>

				<button ref={newConversationRef} className="new-task" onClick={() => void createConversation()} disabled={sending || deleting || loading}>
					<span>＋</span> 新建会话
				</button>

				<div className="history-label">会话历史</div>
				<nav className="conversation-list" aria-label="会话历史">
					{!loading && conversations.length === 0 && <p className="history-empty">暂无会话，新建一个开始吧。</p>}
					{conversations.map((conversation) => (
						<div className="conversation-item" key={conversation.conversationId}>
						<button
							className={active?.conversationId === conversation.conversationId ? "active" : ""}
							onClick={() => void selectConversation(conversation.conversationId)}
							disabled={sending || deleting}
						>
							<strong>{conversation.title}</strong>
							<span>{conversation.preview}</span>
							<small>{displayTime(conversation.updatedAt)} · {conversation.messageCount} 条</small>
						</button>
						<button className="delete-conversation" aria-label={`删除会话：${conversation.title}`} title="删除会话"
							disabled={deleting || uploading || requirementBusy}
							onClick={() => { setDeleteError(undefined); setPendingDelete(conversation); }}>
							<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" /></svg>
						</button>
						</div>
					))}
				</nav>

				<div className="sidebar-footer">
					<div className="runtime-light">
						<i className={realProvider ? "online" : "offline"} />
						{!realProvider ? "模型尚未配置" : health?.providerStatus === "last_request_succeeded" ? "最近请求成功" : health?.providerStatus === "last_request_failed" ? "最近请求失败" : "模型已配置 · 待验证"}
					</div>
					<details className="permission-summary"><summary>本地访问与工具权限</summary><p>会话身份由本机服务绑定。可读取本机真实文件；Agent 会在新建、修改或删除前展示具体路径和内容，等你单次批准后执行，并保留备份。附件解析禁止联网，事实仍需人工确认。</p></details>
				</div>
			</aside>

			<main className="conversation">
				<header className="topbar">
					<button className="panel-toggle" aria-label="切换会话侧栏" aria-expanded={sidebarOpen} onClick={() => setSidebarOpen(!sidebarOpen)}>☰</button>
					<div>
						<span className="eyebrow">BLACKX WORKSPACE</span>
						<h1>{active?.title ?? "Blackx 会话"}</h1>
					</div>
					<button className="panel-toggle review-toggle" aria-expanded={reviewOpen} onClick={() => setReviewOpen(!reviewOpen)}>工作区 · {{ requirement: "需求单", models: "模型", files: "文件" }[panelTab]}</button>
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
										<Markdown text={message.content} />
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
							{(replyRunning || hasActiveBackgroundTask) && (
								<article className="message assistant thinking">
									<div className="avatar">Bx</div>
									<div>
										<span>{hasActiveBackgroundTask ? "后台任务正在执行，可以切换会话" : progressLabel(activity)}</span>
										<div className="thinking-dots"><i /><i /><i /></div>
									</div>
								</article>
							)}
						</div>
					) : (
						<div className="empty-state">
							<span className="empty-mark">Bx</span>
							<h2>开始一个新的包装需求任务</h2>
							<p>上传资料，描述你要交付什么。Blackx 会整理需求、标出缺失信息，生成可核对与导出的需求单。</p>
							{!active ? <button className="secondary-action" onClick={() => void createConversation()} disabled={deleting}>开始新会话</button> : <div className="prompt-grid">
								<button onClick={() => setDraft("我想做一款500克咖啡豆包装袋，请先帮我梳理需要确认的信息。")}>咖啡豆包装需求</button>
								<button onClick={() => setDraft("我想定制一批护肤品包装纸盒，请先帮我梳理盒型、尺寸、数量和交付信息。")}>护肤品纸盒需求</button>
							</div>}
						</div>
					)}
				</section>

				<div className="composer-wrap">
					{active && <ConversationFiles key={active.conversationId} conversationId={active.conversationId} />}
					{!realProvider && !loading && (
						<div className="provider-warning">
							模型服务尚未配置。配置本地模型连接后即可开始；已保存的会话和需求单仍可查看。
						</div>
					)}
					{error && <div className="error-banner" role="alert">{error}<button aria-label="关闭错误提示" onClick={() => setError(undefined)}>×</button></div>}
					{!replyRunning && !hasActiveBackgroundTask && active?.messages.at(-1)?.role === "user" && <button className="retry-action" disabled={!realProvider} onClick={() => void retryReply()}>继续上次未完成的回复</button>}
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
										: parsedSources.some((source) => source.sha256 === attachment.sha256) ? inspectionStatusLabels[parsedSources.find((source) => source.sha256 === attachment.sha256)!.inspection.status] : "已上传 · 生成需求单时解析"}</small>
								</button>
							))}
						</div>
					)}
					<form className="composer" onSubmit={onSubmit}>
						<textarea
							value={draft}
							onChange={(event) => setDraft(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
									event.preventDefault();
									void send(draft);
								}
							}}
							rows={2}
							placeholder={hasActiveBackgroundTask
								? "当前会话的后台任务完成后可继续发送"
								: realProvider ? "发送消息给 Blackx…" : "请先连接实际模型 API"}
							disabled={!active || !realProvider || replyRunning || hasActiveBackgroundTask}
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
							{replyRunning && <button type="button" className="stop-button" onClick={() => void stopReply()}>停止</button>}
							<button
								type="submit"
								className="send-button"
								disabled={(!draft.trim() && selectedAttachmentIds.length === 0) || !realProvider || sending || hasActiveBackgroundTask}
							>
								↑
							</button>
						</div>
					</form>
					<small className="disclaimer">AI 提取的信息需你确认。需求单保留资料来源与版本记录。</small>
				</div>
			</main>

			<aside className="proposal-panel" aria-label="多功能工作区">
				<header className="proposal-header">
					<button className="panel-toggle" aria-label="关闭工作区" onClick={() => setReviewOpen(false)}>×</button>
					<div>
						<span className="eyebrow">WORKSPACE</span>
						<h2>{{ requirement: "需求单工作区", models: "模型监控", files: "文件浏览" }[panelTab]}</h2>
					</div>
					{panelTab === "requirement" && requirement && (
						<span className={`proposal-status ${requirement.state.stageStatus}`}>
							{stageLabels[requirement.state.stageStatus]}
						</span>
					)}
				</header>

				<div className="workspace-tabs" role="tablist" aria-label="工作区功能">
					{(["requirement", "models", "files"] as const).map((tab, index, tabs) => <button key={tab} role="tab" id={`tab-${tab}`} aria-controls={`panel-${tab}`} aria-selected={panelTab === tab} tabIndex={panelTab === tab ? 0 : -1} onClick={() => setPanelTab(tab)} onKeyDown={(event) => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); const next = event.key === "Home" ? 0 : event.key === "End" ? 2 : (index + (event.key === "ArrowRight" ? 1 : 2)) % 3; setPanelTab(tabs[next]); (event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role=tab]")[next])?.focus(); } }}>{ { requirement: "需求单", models: "模型调用", files: "文件" }[tab]}</button>)}
				</div>
				<div className="proposal-body" role="tabpanel" id="panel-requirement" aria-labelledby="tab-requirement" hidden={panelTab !== "requirement"}>
					{requirementMetrics && requirementMetrics.totals.runs > 0 && (
						<details className="proposal-section diagnostics"><summary>运行统计</summary>
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
						</details>
					)}
					{requirement?.readOnlyReason ? (
						<section className="proposal-empty"><strong>历史需求（只读）</strong><p>{requirement.readOnlyReason}</p>
							<p>历史状态：{stageLabels[requirement.state.stageStatus]} · {requirement.state.proposalVersions.length} 个交付版本</p>
							{!requirementTerminal && <button className="secondary-action" disabled={requirementBusy} onClick={() => void cancelRequirement()}>取消历史任务</button>}
						</section>
					) : !requirement ? (
						<section className="proposal-empty">
							<strong>把资料整理成可交付的需求单</strong>
							<p>围绕包装类型、尺寸、数量、市场、交期和稿件，逐项核对资料，再确认当前版本。</p>
							<button
								className="primary-action"
								onClick={() => void startRequirement()}
								disabled={!hasUserMessage || !realProvider || requirementBusy || sending}
							>
								{requirementBusy ? "正在创建…" : "生成需求单"}
							</button>
							{!hasUserMessage && <small>先描述一条明确的包装需求。</small>}
						</section>
					) : (
						<>
							<section className="workflow-track" aria-label="Requirement Brief 工作流进度">
								<span className="done">收集需求</span>
								<span className={requirement.state.currentProposal ? "done" : "active"}>整理资料</span>
								<span className={requirement.state.evaluation ? "done" : requirement.state.stageStatus === "evaluating" ? "active" : ""}>校验</span>
								<span className={requirement.state.stageStatus === "passed" ? "done" : requirement.state.stageStatus === "waiting_approval" ? "active" : ""}>确认交付</span>
							</section>

							<section className="proposal-section">
								<div className="section-title"><strong>任务概览</strong><code>v{requirement.state.aggregateVersion}</code></div>
								<dl className="run-metadata">
									<div><dt>行业</dt><dd>包装</dd></div>
									<div><dt>状态</dt><dd>{stageLabels[requirement.state.stageStatus]}</dd></div>
									<div><dt>版本</dt><dd>{requirement.state.currentProposal?.version ?? "—"}</dd></div>
									<div><dt>队列</dt><dd>{requirement.job ? ({ queued: "排队中", leased: "执行中", completed: "已完成", cancelled: "已取消", dead_letter: "执行失败" }[requirement.job.status]) : "—"}</dd></div>
								</dl>
							</section>

							<details className="proposal-section diagnostics"><summary>本次运行详情</summary>
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
							</details>

							<section className="proposal-section facts-card">
								<div className="section-title"><strong>核对关键信息</strong><span>{facts.length}</span></div>
								{facts.map((fact) => (
									<div className="fact-row" key={`${fact.key}-${fact.version}`}>
										<div>
											<small>{requirementFieldLabels[fact.key] ?? fact.key} · v{fact.version}</small>
											<strong>{String(fact.value)}{fact.unit ? ` ${fact.unit}` : ""}</strong>
											<small>{factStatusLabels[fact.status]} · {fact.sourceType === "model_output" ? "AI 提取" : fact.sourceType === "human_confirmation" ? "人工确认" : "人工输入"}</small>
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
									<select value={factKey} onChange={(event) => { setFactKey(event.target.value); setFactValue(""); }} aria-label="需求字段" disabled={requirementTerminal}><option value="">选择要补充的字段</option>{fieldOptions.map((key) => <option key={key} value={key}>{requirementFieldLabels[key]}</option>)}</select>
									<input value={factValue} type={factKey === "quantity" ? "number" : factKey === "target_delivery" ? "date" : "text"} min={factKey === "quantity" ? 1 : undefined} step={1} required onChange={(event) => setFactValue(event.target.value)} placeholder={factKey === "dimensions" ? "例如：宽 160 × 高 230 + 底 80 mm" : "填写内容"} aria-label="字段内容" disabled={requirementTerminal} />
									<input value={factUnit} onChange={(event) => setFactUnit(event.target.value)} placeholder="单位（可选）" aria-label="字段单位" disabled={requirementTerminal} />
									<button type="submit" disabled={requirementBusy || requirementRunning || requirementTerminal || !factKey.trim() || !factValue.trim()}>添加待确认信息</button>
								</form>
								<small>新增信息需逐项确认。修改后旧需求单会失效，请重新生成。</small>
							</section>

							{content && active && requirement.state.currentProposal && <DeliveryPreview conversationId={active.conversationId} versions={requirement.state.proposalVersions.map((item) => item.version)} currentVersion={requirement.state.currentProposal.version} revision={requirement.state.aggregateVersion} onSources={setParsedSources} />}

							{requirement.state.currentProposal && !content && (
								<section className="proposal-section invalid-artifact">
									<strong>Artifact 无法作为结构化 Requirement Brief 展示</strong>
									<p>原始输出已经留存，Evaluation 会记录失败原因。</p>
								</section>
							)}

							{evaluation && (
								<section className={`proposal-section evaluation ${evaluation.passed ? "passed" : "failed"}`}>
									<div className="section-title"><strong>需求校验</strong><span>{evaluation.passed ? "通过" : "未通过"}</span></div>
									{evaluation.issues.length === 0
										? <p>结构和权威状态检查通过。{evaluation.approvalEligible ? "可以审批。" : "仍需补充或确认 信息。"}</p>
										: evaluation.issues.map((issue) => <p key={issue.code}>{issue.message}</p>)}
								</section>
							)}

							{requirement.state.approval?.status === "requested" && (
								<section className="proposal-section approval-card">
									<strong>确认需求单 · v{requirement.state.approval.artifactVersion}</strong>
									<p>审批只绑定当前版本；后续需求变化会使该审批失效。</p>
									<div className="approval-actions">
										<button onClick={() => void resolveRequirementApproval("rejected")} disabled={requirementBusy}>拒绝</button>
										<button className="primary-action" onClick={() => void resolveRequirementApproval("approved")} disabled={requirementBusy}>批准当前版本</button>
									</div>
								</section>
							)}

							{requirement.state.approval && requirement.state.approval.status !== "requested" && (
								<div className={`approval-result ${requirement.state.approval.status}`}>需求单确认：{requirement.state.approval.status}</div>
							)}
							{requirement.job?.status === "dead_letter" && (
								<div className="proposal-failure">{requirement.job.lastFailure?.message ?? "Requirement Worker 已进入死信队列"}</div>
							)}

							{requirement.state.stageStatus !== "passed" && requirement.state.stageStatus !== "cancelled" && (
								<button className="secondary-action" onClick={() => void cancelRequirement()} disabled={requirementBusy}>取消任务</button>
							)}
							{requirement.state.stageStatus === "passed" && <p className="cancelled-note">当前版本已批准。如有新需求，请新建任务，保留本次交付记录。</p>}
							{requirement.state.stageStatus === "cancelled" && (
								<div className="cancelled-note">已保留需求、Fact、Artifact 与审计事件；重新审查会从现有版本继续，不会删除历史。</div>
							)}
							<button
								className="secondary-action"
								onClick={() => void startRequirement()}
								disabled={!hasUserMessage || !realProvider || requirementBusy || sending || requirementRunning || requirement.state.stageStatus === "waiting_approval" || requirement.state.stageStatus === "passed"}
							>
								{requirementRunning
									? progressLabel(requirementActivity)
									: requirement.state.stageStatus === "cancelled"
										? "重新审查需求单"
										: "用最新信息生成新版本"}
							</button>
						</>
					)}
				</div>
				<div className="proposal-body" role="tabpanel" id="panel-models" aria-labelledby="tab-models" hidden={panelTab !== "models"}>{active && reviewOpen && panelTab === "models" ? <ModelMonitor key={active.conversationId} conversationId={active.conversationId} /> : !active && <p>新建或选择会话后查看模型调用。</p>}</div>
				<div className="proposal-body" role="tabpanel" id="panel-files" aria-labelledby="tab-files" hidden={panelTab !== "files"}>{active ? <FileExplorer key={active.conversationId} conversationId={active.conversationId} onUseFile={(path) => { setDraft(`请读取并协助处理这个文件：${path}\n处理要求：`); if (window.innerWidth < 1180) setReviewOpen(false); }} /> : <p>新建或选择会话后浏览本机文件。</p>}</div>
			</aside>
			{pendingDelete && <DeleteConversationDialog title={pendingDelete.title} busy={deleting} error={deleteError}
				onCancel={() => setPendingDelete(undefined)} onConfirm={() => void deleteConversation()} />}
		</div>
	);
}

export default App;
