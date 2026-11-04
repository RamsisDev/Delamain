import type { Pricing } from "../schema/models.ts";
import type { ProviderType } from "../schema/providers.ts";

export interface ModelInfo {
  id: string;
  label?: string;
  contextWindow?: number;
  toolCalling?: boolean;
  pricing?: Pricing;
  /** Raw `supported_parameters` from catalogs such as OpenRouter's. */
  supportedParameters?: string[];
}

export type Health =
  | { status: "online"; latencyMs?: number; models?: number }
  | { status: "offline"; message: string }
  | { status: "rate_limited"; untilMs: number }
  | { status: "auth_error"; message: string };

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema of the arguments. */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

export type ChatMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string; isError?: boolean };

export interface ChatRequest {
  model: string;
  system: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  maxOutputTokens?: number;
  temperature?: number;
  /** Ask the provider to cache the stable prefix (system prompt and early turns). */
  cache?: boolean;
  /** Working directory, used by cli providers that edit the worktree themselves. */
  cwd?: string;
}

/** `not_found` is about one model (a 404); `unavailable` is about the whole provider. */
export type ErrorKind = "rate_limit" | "auth" | "context_length" | "unavailable" | "not_found" | "bad_request";

export interface RateLimitSnapshot {
  requestsRemaining?: number;
  tokensRemaining?: number;
  resetAt?: number;
}

export type ChatEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; id: string; name: string; args: unknown }
  | { type: "usage"; input: number; output: number; cached?: number }
  | { type: "rate_limits"; snapshot: RateLimitSnapshot }
  | { type: "error"; kind: ErrorKind; message: string; retryAfterMs?: number }
  | { type: "done"; stopReason?: string };

export interface ProviderAdapter {
  readonly id: string;
  readonly type: ProviderType;
  listModels(): Promise<ModelInfo[]>;
  healthCheck(): Promise<Health>;
  stream(request: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent>;
  /** Exact token count with the model's tokenizer, when the provider exposes one. */
  countTokens?(request: ChatRequest): Promise<number | undefined>;
}

/** Character-based approximation used when a model exposes no tokenizer. */
export function approximateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

export class ProviderError extends Error {
  constructor(
    readonly kind: ErrorKind,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
