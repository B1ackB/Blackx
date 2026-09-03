import type {
	AgentRuntimePort,
  RuntimeFailureCode,
  RuntimeHealth,
  RuntimeTurnRequest,
  RuntimeTurnResult,
} from "./contracts";
import { RuntimeFailure } from "./contracts";

interface ErrorPayload {
  code?: RuntimeFailureCode;
  message?: string;
  retryable?: boolean;
}

export class HttpRuntimeClient implements AgentRuntimePort {
  async health(): Promise<RuntimeHealth> {
    const response = await fetch("/api/runtime/health");
    if (!response.ok) {
      return { adapter: "client-fallback", online: false };
    }
    return response.json() as Promise<RuntimeHealth>;
  }

  async executeTurn(
    request: RuntimeTurnRequest,
    signal?: AbortSignal,
  ): Promise<RuntimeTurnResult> {
    let response: Response;
    try {
      response = await fetch("/api/runtime/turn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
        signal,
      });
    } catch (error) {
      throw new RuntimeFailure(
        "runtime_unavailable",
        "Blackx Runtime server is unavailable",
        true,
        { cause: error },
      );
    }

    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as ErrorPayload;
      throw new RuntimeFailure(
        payload.code ?? "execution_failed",
        payload.message ?? "Blackx Runtime execution failed",
        payload.retryable ?? false,
      );
    }

    return response.json() as Promise<RuntimeTurnResult>;
  }
}
