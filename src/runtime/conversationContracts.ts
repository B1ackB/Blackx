export interface ConversationMessage {
	messageId: string;
	role: "user" | "assistant";
	content: string;
	createdAt: string;
}

export interface ConversationView {
	conversationId: string;
	title: string;
	preview: string;
	updatedAt: string;
	revision: number;
	messages: ConversationMessage[];
}

export interface ConversationSummary extends Omit<ConversationView, "revision" | "messages"> {
	messageCount: number;
}

export type BackgroundTaskStatus = "queued" | "leased" | "completed" | "dead_letter" | "cancelled";

export interface BackgroundTaskView {
	taskId: string;
	conversationId: string;
	messageId: string;
	status: BackgroundTaskStatus;
	createdAt: string;
	updatedAt: string;
	deliveryCount: number;
	failureCount: number;
	lastFailure?: {
		code: string;
		message: string;
		retryable: boolean;
		at: string;
	};
}

export interface CronScheduleView {
	scheduleId: string;
	conversationId: string;
	name: string;
	expression: string;
	timezone: string;
	status: "active" | "paused" | "completed";
	runCount: number;
	maxRuns: number;
	nextRunAt: string;
	lastRunAt?: string;
}

export interface ProposalWorkspaceView {
	runId: string;
	state: ProposalRunState;
	artifact?: {
		content: unknown;
	};
	evaluation?: {
		report: unknown;
	};
	job?: {
		jobId: string;
		status: "queued" | "leased" | "completed" | "dead_letter" | "cancelled";
		failureCount: number;
		lastFailure?: {
			code: string;
			message: string;
		};
	};
}
import type { ProposalRunState } from "../enterprise/contracts";
