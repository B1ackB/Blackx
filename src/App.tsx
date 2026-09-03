import { FormEvent, useEffect, useRef, useState } from "react";
import type { RuntimeHealth } from "./runtime/contracts";
import { ConversationClient, ConversationClientError } from "./runtime/conversationClient";
import type {
	BackgroundTaskView,
	ConversationMessage,
	ConversationSummary,
	ConversationView,
	CronScheduleView,
	ProposalWorkspaceView,
} from "./runtime/conversationContracts";
import type {
	ProposalEvaluationReport,
	SolutionProposalV1,
} from "./print/solutionProposal";

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

function errorMessage(error: unknown): string {
	if (error instanceof ConversationClientError) {
		if (error.code === "real_provider_required") {
			return "当前服务不是实际模型模式。请使用 BLACKX_RUNTIME_MODE=anthropic 启动。";
		}
		return error.message;
	}
	return "请求失败，请检查服务端日志后重试。";
}

function proposalContent(value: unknown): SolutionProposalV1 | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const candidate = value as Partial<SolutionProposalV1>;
	return candidate.schemaVersion === "solution-proposal.v1" &&
		typeof candidate.title === "string" &&
		typeof candidate.summary === "string" &&
		Array.isArray(candidate.recommendations) &&
		Array.isArray(candidate.verificationRequired)
		? candidate as SolutionProposalV1
		: undefined;
}

function evaluationReport(value: unknown): ProposalEvaluationReport | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const candidate = value as Partial<ProposalEvaluationReport>;
	return candidate.schemaVersion === "proposal-evaluation.v1" &&
		typeof candidate.passed === "boolean" &&
		Array.isArray(candidate.issues)
		? candidate as ProposalEvaluationReport
		: undefined;
}

const stageLabels = {
	pending: "等待开始",
	running: "正在生成",
	evaluating: "正在评测",
	waiting_approval: "等待 Approval A",
	revision_required: "需要修订",
	passed: "已通过",
	retryable_failed: "评测未通过",
} as const;

function App() {
	const [health, setHealth] = useState<RuntimeHealth>();
	const [conversations, setConversations] = useState<ConversationSummary[]>([]);
	const [active, setActive] = useState<ConversationView>();
	const [draft, setDraft] = useState("");
	const [loading, setLoading] = useState(true);
	const [sending, setSending] = useState(false);
	const [backgroundTasks, setBackgroundTasks] = useState<BackgroundTaskView[]>([]);
	const [cronSchedules, setCronSchedules] = useState<CronScheduleView[]>([]);
	const [proposal, setProposal] = useState<ProposalWorkspaceView>();
	const [proposalBusy, setProposalBusy] = useState(false);
	const [error, setError] = useState<string>();
	const chatEndRef = useRef<HTMLDivElement>(null);

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
		setProposal(undefined);
		void client.getProposal(active.conversationId)
			.then((next) => {
				if (!cancelled) setProposal(next ?? undefined);
			})
			.catch((reason) => {
				if (!cancelled) setError(errorMessage(reason));
			});
		return () => {
			cancelled = true;
		};
	}, [active?.conversationId]);

	useEffect(() => {
		if (!active || !proposal) return;
		const waiting = proposal.state.stageStatus === "running" && proposal.job?.status !== "dead_letter" ||
			proposal.state.stageStatus === "evaluating" ||
			proposal.job?.status === "queued" ||
			proposal.job?.status === "leased" ||
			proposal.state.stageStatus === "waiting_approval" && proposal.state.approval?.status === "approved";
		if (!waiting) return;
		const timer = window.setTimeout(() => {
			void client.getProposal(active.conversationId)
				.then((next) => {
					if (next) setProposal(next);
					if (next?.job?.status === "dead_letter") {
						setError(`Proposal Worker 失败：${next.job.lastFailure?.message ?? "已进入死信队列"}`);
					}
				})
				.catch((reason) => setError(errorMessage(reason)));
		}, 750);
		return () => window.clearTimeout(timer);
	}, [active?.conversationId, proposal]);

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
		chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [active?.messages.length, sending]);

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
			setActive(await client.get(conversationId));
		} catch (reason) {
			setError(errorMessage(reason));
		}
	};

	const send = async (raw: string) => {
		const content = raw.trim();
		if (!content || !active || sending || hasActiveBackgroundTask || health?.adapter !== "blackx-agent") return;
		const messageId = `message-${crypto.randomUUID()}`;
		const optimistic: ConversationMessage = {
			messageId,
			role: "user",
			content,
			createdAt: new Date().toISOString(),
		};
		const conversationId = active.conversationId;
		setDraft("");
		setError(undefined);
		setSending(true);
		setActive((current) => current && current.conversationId === conversationId
			? { ...current, messages: [...current.messages, optimistic], preview: content }
			: current);
		try {
			const updated = await client.send(conversationId, { messageId, content });
			setActive(updated);
			await refreshList(updated);
		} catch (reason) {
			setError(errorMessage(reason));
		} finally {
			setSending(false);
		}
	};

	const startProposal = async () => {
		if (!active || proposalBusy || sending || !realProvider) return;
		setProposalBusy(true);
		setError(undefined);
		try {
			setProposal(await client.startProposal(
				active.conversationId,
				`proposal-${crypto.randomUUID()}`,
			));
		} catch (reason) {
			setError(errorMessage(reason));
		} finally {
			setProposalBusy(false);
		}
	};

	const resolveProposalApproval = async (decision: "approved" | "rejected") => {
		if (!active || proposalBusy || proposal?.state.approval?.status !== "requested") return;
		setProposalBusy(true);
		setError(undefined);
		try {
			setProposal(await client.resolveProposalApproval(
				active.conversationId,
				`approval-${crypto.randomUUID()}`,
				decision,
			));
		} catch (reason) {
			setError(errorMessage(reason));
		} finally {
			setProposalBusy(false);
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
	const content = proposalContent(proposal?.artifact?.content);
	const evaluation = evaluationReport(proposal?.evaluation?.report);
	const proposalRunning = proposal?.state.stageStatus === "running" && proposal.job?.status !== "dead_letter" ||
		proposal?.state.stageStatus === "evaluating" ||
		proposal?.job?.status === "queued" ||
		proposal?.job?.status === "leased";

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

				<section className="chat-scroll" aria-live="polite">
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
							<div ref={chatEndRef} />
						</div>
					) : (
						<div className="empty-state">
							<span className="empty-mark">Bx</span>
							<h2>开始一个新的包装任务</h2>
							<p>消息和模型回复会保存在服务端 Agent Session，不再使用浏览器 localStorage。</p>
							<div className="prompt-grid">
								<button onClick={() => void send("我想做一款500克咖啡豆包装袋，请先帮我梳理需要确认的信息。")}>咖啡豆包装需求</button>
								<button onClick={() => void send("请解释从包装需求到可生产文件需要经过哪些阶段。")}>了解完整工作流</button>
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
							<span>Enter 发送 · Shift + Enter 换行</span>
							<button
								type="submit"
								className="send-button"
								disabled={!draft.trim() || !realProvider || sending || hasActiveBackgroundTask}
							>
								↑
							</button>
						</div>
					</form>
					<small className="disclaimer">建议保持待确认；权威事实和审批由确定性服务端状态管理。</small>
				</div>
			</main>

			<aside className="proposal-panel" aria-label="Proposal 业务状态">
				<header className="proposal-header">
					<div>
						<span className="eyebrow">ARTIFACT-FIRST WORKFLOW</span>
						<h2>Proposal</h2>
					</div>
					{proposal && (
						<span className={`proposal-status ${proposal.state.stageStatus}`}>
							{stageLabels[proposal.state.stageStatus]}
						</span>
					)}
				</header>

				<div className="proposal-body">
					{!proposal ? (
						<section className="proposal-empty">
							<strong>还没有业务 Run</strong>
							<p>将当前会话中的用户消息固化为未验证需求，后台生成可评测、可审批的方案版本。</p>
							<button
								className="primary-action"
								onClick={() => void startProposal()}
								disabled={!hasUserMessage || !realProvider || proposalBusy || sending}
							>
								{proposalBusy ? "正在创建…" : "生成 Proposal"}
							</button>
							{!hasUserMessage && <small>先发送一条明确的包装需求。</small>}
						</section>
					) : (
						<>
							<section className="workflow-track" aria-label="Proposal 工作流进度">
								<span className="done">Intake</span>
								<span className={proposal.state.currentProposal ? "done" : "active"}>Artifact</span>
								<span className={proposal.state.evaluation ? "done" : proposal.state.stageStatus === "evaluating" ? "active" : ""}>Evaluation</span>
								<span className={proposal.state.stageStatus === "passed" ? "done" : proposal.state.stageStatus === "waiting_approval" ? "active" : ""}>Approval A</span>
							</section>

							<section className="proposal-section">
								<div className="section-title">
									<strong>Run</strong>
									<code>v{proposal.state.aggregateVersion}</code>
								</div>
								<dl className="run-metadata">
									<div><dt>状态</dt><dd>{stageLabels[proposal.state.stageStatus]}</dd></div>
									<div><dt>事实</dt><dd>{Object.keys(proposal.state.facts).length}</dd></div>
									<div><dt>版本</dt><dd>{proposal.state.currentProposal?.version ?? "—"}</dd></div>
									<div><dt>队列</dt><dd>{proposal.job?.status ?? "—"}</dd></div>
								</dl>
							</section>

							{content && (
								<section className="proposal-section artifact-card">
									<div className="section-title">
										<strong>{content.title}</strong>
										<code>Artifact v{proposal.state.currentProposal?.version}</code>
									</div>
									<p>{content.summary}</p>
									{content.recommendations.map((item) => (
										<div className="recommendation" key={`${item.topic}-${item.value}`}>
											<strong>{item.topic}</strong>
											<span>{item.value}</span>
											<small>{item.rationale}</small>
										</div>
									))}
									<div className="verification-list">
										<strong>仍需确认</strong>
										{content.verificationRequired.map((item) => <span key={item}>· {item}</span>)}
									</div>
								</section>
							)}

							{proposal.state.currentProposal && !content && (
								<section className="proposal-section invalid-artifact">
									<strong>Artifact 无法作为结构化 Proposal 展示</strong>
									<p>原始输出已经留存，Evaluation 会记录失败原因。</p>
								</section>
							)}

							{evaluation && (
								<section className={`proposal-section evaluation ${evaluation.passed ? "passed" : "failed"}`}>
									<div className="section-title">
										<strong>Deterministic Evaluation</strong>
										<span>{evaluation.passed ? "PASSED" : "FAILED"}</span>
									</div>
									{evaluation.issues.length === 0
										? <p>Schema、Fact Lineage 和权威边界检查通过。</p>
										: evaluation.issues.map((issue) => <p key={issue.code}>{issue.message}</p>)}
								</section>
							)}

							{proposal.state.approval?.status === "requested" && (
								<section className="proposal-section approval-card">
									<strong>Approval A · Artifact v{proposal.state.approval.artifactVersion}</strong>
									<p>审批只绑定当前版本；后续需求变化会使该审批失效。</p>
									<div className="approval-actions">
										<button onClick={() => void resolveProposalApproval("rejected")} disabled={proposalBusy}>拒绝</button>
										<button className="primary-action" onClick={() => void resolveProposalApproval("approved")} disabled={proposalBusy}>批准当前版本</button>
									</div>
								</section>
							)}

							{proposal.state.approval && proposal.state.approval.status !== "requested" && (
								<div className={`approval-result ${proposal.state.approval.status}`}>
									Approval A：{proposal.state.approval.status}
								</div>
							)}

							{proposal.job?.status === "dead_letter" && (
								<div className="proposal-failure">
									{proposal.job.lastFailure?.message ?? "Proposal Worker 已进入死信队列"}
								</div>
							)}

							<button
								className="secondary-action"
								onClick={() => void startProposal()}
								disabled={!hasUserMessage || !realProvider || proposalBusy || sending || proposalRunning}
							>
								{proposalRunning ? "后台正在执行…" : "从最新对话更新 Proposal"}
							</button>
						</>
					)}
				</div>
			</aside>
		</div>
	);
}

export default App;
