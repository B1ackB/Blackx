import type {
	AnthropicMessageRequest,
	AnthropicMessageResponse,
	AnthropicTokenCountResponse,
} from "./types";

export class AnthropicCompatibilityError extends Error {
	readonly code: string;
	readonly providerStatus?: number;
	readonly adapterStatus?: number;

	constructor(
		code: string,
		message: string,
		status: { providerStatus?: number; adapterStatus?: number } = {},
	) {
		super(message);
		this.name = "AnthropicCompatibilityError";
		this.code = code;
		this.providerStatus = status.providerStatus;
		this.adapterStatus = status.adapterStatus;
	}
}

export interface AnthropicClientOptions {
  baseUrl: string;
  apiKey: string;
  anthropicVersion?: string;
  fetch?: typeof fetch;
}

export class AnthropicMessagesClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly anthropicVersion: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AnthropicClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.anthropicVersion = options.anthropicVersion ?? "2023-06-01";
    this.fetchImpl = options.fetch ?? fetch;
  }

  async createMessage(
    request: AnthropicMessageRequest,
    signal?: AbortSignal,
  ): Promise<AnthropicMessageResponse> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": this.anthropicVersion,
      },
      body: JSON.stringify(request),
      signal,
    });

    const body = (await response.json().catch(() => undefined)) as
      | AnthropicMessageResponse
      | { error?: { message?: string; type?: string } }
      | undefined;
    if (!response.ok) {
      const message = body && "error" in body ? body.error?.message : undefined;
      throw new AnthropicCompatibilityError(
        body && "error" in body ? body.error?.type ?? "upstream_error" : "upstream_error",
        message ?? `Anthropic-compatible endpoint returned HTTP ${response.status}`,
		{ providerStatus: response.status },
      );
    }
    return body as AnthropicMessageResponse;
  }

	async countMessageTokens(
		request: AnthropicMessageRequest,
		signal?: AbortSignal,
	): Promise<AnthropicTokenCountResponse> {
		const { max_tokens: _maxTokens, stream: _stream, ...body } = request;
		const response = await this.fetchImpl(`${this.baseUrl}/v1/messages/count_tokens`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-api-key": this.apiKey,
				"anthropic-version": this.anthropicVersion,
			},
			body: JSON.stringify(body),
			signal,
		});
		const result = (await response.json().catch(() => undefined)) as
			| AnthropicTokenCountResponse
			| { error?: { message?: string; type?: string } }
			| undefined;
		if (!response.ok) {
			const message = result && "error" in result ? result.error?.message : undefined;
			throw new AnthropicCompatibilityError(
				result && "error" in result ? result.error?.type ?? "upstream_error" : "upstream_error",
				message ?? `Anthropic-compatible endpoint returned HTTP ${response.status}`,
				{ providerStatus: response.status },
			);
		}
		if (!result || !("input_tokens" in result) || !Number.isInteger(result.input_tokens)) {
			throw new AnthropicCompatibilityError(
				"invalid_response",
				"Token Count response is invalid",
				{ adapterStatus: 502 },
			);
		}
		return result;
	}
}
