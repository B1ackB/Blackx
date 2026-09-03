export type JsonObject = Record<string, unknown>;

export type AnthropicAssistantContentBlock =
	| { type: "text"; text: string }
	| { type: "thinking"; thinking: string; signature: string }
	| { type: "redacted_thinking"; data: string }
	| { type: "tool_use"; id: string; name: string; input: unknown };

export type AnthropicContentBlock =
	| AnthropicAssistantContentBlock
	| { type: "tool_result"; tool_use_id: string; content: string };

export interface AnthropicMessageRequest {
  model: string;
  max_tokens: number;
  system?: Array<{ type: "text"; text: string }>;
  messages: Array<{
    role: "user" | "assistant";
    content: AnthropicContentBlock[];
  }>;
  tools?: Array<{
    name: string;
    description?: string;
    input_schema: JsonObject;
    strict?: boolean;
  }>;
  tool_choice?: unknown;
	thinking?: { type: "disabled" };
  output_config?: {
    format: { type: "json_schema"; schema: JsonObject };
  };
  stream: false;
}

export interface AnthropicMessageResponse {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
	content: AnthropicAssistantContentBlock[];
  stop_reason:
    | "end_turn"
    | "max_tokens"
    | "stop_sequence"
    | "tool_use"
    | "pause_turn"
    | "refusal"
    | "model_context_window_exceeded"
    | null;
  stop_sequence?: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens_details?: { thinking_tokens?: number };
  };
}

export interface AnthropicTokenCountResponse {
	input_tokens: number;
}
