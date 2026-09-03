import { timingSafeEqual } from "node:crypto";
import type { AggregateScope } from "../../src/enterprise/contracts";
import { EnterpriseKernelError } from "../../src/enterprise/contracts";
import type {
	CommandEnvelope,
	CompleteProposalCommand,
	RecordFactVersionCommand,
	ResolveApprovalCommand,
} from "../../src/enterprise/proposalRunEngine";
import { ProposalRunEngine } from "../../src/enterprise/proposalRunEngine";

export interface ProposalApiContext {
	tenantId?: string;
	workspaceId?: string;
	actorId?: string;
	authorization?: string;
}

export interface ProposalApiResponse {
	status: number;
	body: unknown;
}

class ProposalApiValidationError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredId(
	value: unknown,
	name: string,
	maximumLength = 128,
): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > maximumLength ||
		!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
	) {
		throw new ProposalApiValidationError(`${name} is invalid`);
	}
	return value;
}

function requiredReference(value: unknown, name: string): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > 2_048 ||
		/[\r\n\u0000]/.test(value)
	) {
		throw new ProposalApiValidationError(`${name} is invalid`);
	}
	return value;
}

function expectedVersion(value: unknown): number {
	if (!Number.isInteger(value) || Number(value) < 0) {
		throw new ProposalApiValidationError("expectedVersion is invalid");
	}
	return Number(value);
}

function positiveVersion(value: unknown, name: string): number {
	if (!Number.isInteger(value) || Number(value) < 1) {
		throw new ProposalApiValidationError(`${name} is invalid`);
	}
	return Number(value);
}

function factValue(value: unknown): string | number | boolean {
	if (
		typeof value !== "string" &&
		typeof value !== "number" &&
		typeof value !== "boolean"
	) {
		throw new ProposalApiValidationError("value is invalid");
	}
	if (typeof value === "number" && !Number.isFinite(value)) {
		throw new ProposalApiValidationError("value is invalid");
	}
	if (typeof value === "string" && (value.length === 0 || value.length > 4_096)) {
		throw new ProposalApiValidationError("value is invalid");
	}
	return value;
}

function optionalUnit(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.length === 0 || value.length > 32) {
		throw new ProposalApiValidationError("unit is invalid");
	}
	return value;
}

function factVersions(value: unknown): Record<string, number> {
	if (!isRecord(value) || Object.keys(value).length > 200) {
		throw new ProposalApiValidationError("inputFactVersions is invalid");
	}
	return Object.fromEntries(
		Object.entries(value).map(([key, version]) => [
			requiredId(key, "factKey", 64),
			positiveVersion(version, `inputFactVersions.${key}`),
		]),
	);
}

function bearerToken(authorization?: string): string | undefined {
	const match = authorization?.match(/^Bearer ([^\s]+)$/);
	return match?.[1];
}

function tokensMatch(left: string, right: string): boolean {
	const leftBytes = Buffer.from(left);
	const rightBytes = Buffer.from(right);
	return (
		leftBytes.byteLength === rightBytes.byteLength &&
		timingSafeEqual(leftBytes, rightBytes)
	);
}

function kernelStatus(error: EnterpriseKernelError): number {
	switch (error.code) {
		case "aggregate_access_denied":
			return 404;
		case "concurrency_conflict":
			return 409;
		case "illegal_transition":
		case "artifact_version_mismatch":
			return 422;
		case "event_store_corrupt":
		case "event_store_unavailable":
			return 500;
	}
}

export class ProposalApiController {
	constructor(
		private readonly engine: ProposalRunEngine,
		private readonly commandToken?: string,
		private readonly workerToken?: string,
	) {
		for (const configuredToken of [commandToken, workerToken]) {
			if (configuredToken && Buffer.byteLength(configuredToken) < 32) {
				throw new Error("Proposal API tokens must contain at least 32 bytes");
			}
		}
		if (
			commandToken &&
			workerToken &&
			tokensMatch(commandToken, workerToken)
		) {
			throw new Error("Command and Worker API tokens must be different");
		}
	}

	query(context: ProposalApiContext, runIdValue: unknown): ProposalApiResponse {
		return this.respond(() => {
			requiredId(context.actorId, "actorId");
			const scope = this.scope(context, runIdValue);
			const state = this.engine.load(scope);
			if (state.aggregateVersion === 0) {
				return { status: 404, body: { code: "run_not_found" } };
			}
			return { status: 200, body: { state } };
		}, context, this.commandToken, "command_api_disabled");
	}

	execute(context: ProposalApiContext, payload: unknown): ProposalApiResponse {
		const workerCommand =
			isRecord(payload) && payload.type === "complete_proposal";
		const commandContext = workerCommand
			? { ...context, actorId: "blackx-worker" }
			: context;
		return this.respond(() => {
			if (!isRecord(payload)) {
				throw new ProposalApiValidationError("Command payload must be an object");
			}
			const type = payload.type;
			const envelope = this.envelope(commandContext, payload);
			let state;
			switch (type) {
				case "create_run":
					state = this.engine.create(envelope);
					return { status: 201, body: { state } };
				case "start_proposal":
					state = this.engine.startProposal(envelope);
					break;
				case "restart_proposal":
					state = this.engine.restartProposal(envelope);
					break;
				case "record_fact_version":
					state = this.engine.recordFactVersion(
						this.recordFactCommand(envelope, payload),
					);
					break;
				case "complete_proposal":
					state = this.engine.completeProposal(
						this.completeProposalCommand(envelope, payload),
					);
					break;
				case "resolve_approval":
					state = this.engine.resolveApproval(
						this.resolveApprovalCommand(envelope, payload),
					);
					break;
				default:
					throw new ProposalApiValidationError("Command type is unsupported");
			}
			return { status: 200, body: { state } };
		}, context, workerCommand ? this.workerToken : this.commandToken,
			workerCommand ? "worker_api_disabled" : "command_api_disabled");
	}

	private respond(
		operation: () => ProposalApiResponse,
		context: ProposalApiContext,
		requiredToken: string | undefined,
		disabledCode: "command_api_disabled" | "worker_api_disabled",
	): ProposalApiResponse {
		if (!requiredToken) {
			return { status: 503, body: { code: disabledCode } };
		}
		const suppliedToken = bearerToken(context.authorization);
		if (!suppliedToken || !tokensMatch(suppliedToken, requiredToken)) {
			return { status: 401, body: { code: "unauthorized" } };
		}
		try {
			return operation();
		} catch (error) {
			if (error instanceof ProposalApiValidationError) {
				return {
					status: 400,
					body: { code: "invalid_command", message: error.message },
				};
			}
			if (error instanceof EnterpriseKernelError) {
				return {
					status: kernelStatus(error),
					body: { code: error.code, message: error.message },
				};
			}
			return { status: 500, body: { code: "internal_error" } };
		}
	}

	private scope(
		context: ProposalApiContext,
		runIdValue: unknown,
	): AggregateScope {
		return {
			tenantId: requiredId(context.tenantId, "tenantId"),
			workspaceId: requiredId(context.workspaceId, "workspaceId"),
			runId: requiredId(runIdValue, "runId"),
		};
	}

	private envelope(
		context: ProposalApiContext,
		payload: Record<string, unknown>,
	): CommandEnvelope {
		return {
			...this.scope(context, payload.runId),
			actorId: requiredId(context.actorId, "actorId"),
			commandId: requiredId(payload.commandId, "commandId"),
			correlationId: requiredId(payload.correlationId, "correlationId"),
			expectedVersion: expectedVersion(payload.expectedVersion),
		};
	}

	private recordFactCommand(
		envelope: CommandEnvelope,
		payload: Record<string, unknown>,
	): RecordFactVersionCommand {
		return {
			...envelope,
			factKey: requiredId(payload.factKey, "factKey", 64),
			factVersion: positiveVersion(payload.factVersion, "factVersion"),
			value: factValue(payload.value),
			unit: optionalUnit(payload.unit),
			status: "unverified",
			sourceType: "user_input",
			sourceRef: requiredReference(payload.sourceRef, "sourceRef"),
		};
	}

	private completeProposalCommand(
		envelope: CommandEnvelope,
		payload: Record<string, unknown>,
	): CompleteProposalCommand {
		if (
			!isRecord(payload.runtime) ||
			!isRecord(payload.artifact) ||
			!isRecord(payload.evaluation) ||
			typeof payload.evaluation.passed !== "boolean"
		) {
			throw new ProposalApiValidationError("Proposal completion evidence is invalid");
		}
		return {
			...envelope,
			runtime: {
				executionId: requiredId(payload.runtime.executionId, "runtime.executionId"),
				adapterId: requiredId(payload.runtime.adapterId, "runtime.adapterId"),
				resumeHandle:
					payload.runtime.resumeHandle === undefined
						? undefined
						: requiredReference(payload.runtime.resumeHandle, "runtime.resumeHandle"),
			},
			artifact: {
				artifactId: requiredId(payload.artifact.artifactId, "artifact.artifactId"),
				schemaVersion: requiredId(payload.artifact.schemaVersion, "artifact.schemaVersion"),
				contentRef: requiredReference(payload.artifact.contentRef, "artifact.contentRef"),
				inputFactVersions: factVersions(payload.artifact.inputFactVersions),
			},
			evaluation: {
				passed: payload.evaluation.passed,
				reportRef: requiredReference(payload.evaluation.reportRef, "evaluation.reportRef"),
			},
			approvalId: requiredId(payload.approvalId, "approvalId"),
		};
	}

	private resolveApprovalCommand(
		envelope: CommandEnvelope,
		payload: Record<string, unknown>,
	): ResolveApprovalCommand {
		if (payload.decision !== "approved" && payload.decision !== "rejected") {
			throw new ProposalApiValidationError("decision is invalid");
		}
		return {
			...envelope,
			approvalId: requiredId(payload.approvalId, "approvalId"),
			artifactId: requiredId(payload.artifactId, "artifactId"),
			artifactVersion: positiveVersion(payload.artifactVersion, "artifactVersion"),
			decision: payload.decision,
		};
	}
}
