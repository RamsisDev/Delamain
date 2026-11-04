import type { ChatEvent, ChatMessage, ChatRequest, ErrorKind, Health, ModelInfo, ProviderAdapter } from "@delamain/core";
import { checkHealth, errorEvent, getJson, joinUrl, rateLimitSnapshot, readSse, safeJson, type HttpOptions } from "./http.ts";

const API_VERSION = "2023-06-01";

type ContentBlock =
  | { type: "text"; text: string; cache_control?: { type: "ephemeral" } }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export function toAnthropicMessages(messages: ChatMessage[], cache: boolean): { role: "user" | "assistant"; content: ContentBlock[] }[] {
  const out: { role: "user" | "assistant"; content: ContentBlock[] }[] = [];
  const push = (role: "user" | "assistant", block: ContentBlock) => {
    const last = out.at(-1);
    if (last && last.role === role) last.content.push(block);
    else out.push({ role, content: [block] });
  };
  for (const message of messages) {
    if (message.role === "user") push("user", { type: "text", text: message.content || " " });
    else if (message.role === "assistant") {
      if (message.content) push("assistant", { type: "text", text: message.content });
      for (const call of message.toolCalls ?? []) push("assistant", { type: "tool_use", id: call.id, name: call.name, input: call.args ?? {} });
      if (!message.content && !message.toolCalls?.length) push("assistant", { type: "text", text: " " });
    } else {
      push("user", { type: "tool_result", tool_use_id: message.toolCallId, content: message.content, ...(message.isError ? { is_error: true } : {}) });
    }
  }
  if (cache && out.length > 0) {
    const first = out[0]!.content.find((b) => b.type === "text") as { cache_control?: unknown } | undefined;
    if (first) first.cache_control = { type: "ephemeral" };
  }
  return out;
}

function streamErrorKind(type: string, message: string): ErrorKind {
  if (type === "rate_limit_error") return "rate_limit";
  if (type === "authentication_error" || type === "permission_error") return "auth";
  if (type === "not_found_error") return "not_found";
  if (/too long|context/i.test(message)) return "context_length";
  return "unavailable";
}

/** Native Messages API: prompt caching and exact token counting. */
export class AnthropicAdapter implements ProviderAdapter {
  readonly type = "anthropic" as const;
  private readonly http: HttpOptions;

  constructor(
    readonly id: string,
    http: HttpOptions,
  ) {
    this.http = { ...http, baseUrl: http.baseUrl.replace(/\/v1\/?$/, "") };
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      "anthropic-version": API_VERSION,
      ...(this.http.apiKey ? { "x-api-key": this.http.apiKey } : {}),
      ...this.http.headers,
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    const data = await getJson<{ data: { id: string; display_name?: string }[] }>(this.http, "/v1/models?limit=1000", this.headers());
    return data.data.map((m) => ({ id: m.id, ...(m.display_name ? { label: m.display_name } : {}), toolCalling: true }));
  }

  healthCheck(): Promise<Health> {
    return checkHealth(() => this.listModels());
  }

  private body(request: ChatRequest, stream: boolean): Record<string, unknown> {
    return {
      model: request.model,
      max_tokens: request.maxOutputTokens ?? 8192,
      stream,
      system: request.cache
        ? [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }]
        : request.system,
      messages: toAnthropicMessages(request.messages, request.cache === true),
      ...(request.tools?.length
        ? { tools: request.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })) }
        : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    };
  }

  async countTokens(request: ChatRequest): Promise<number | undefined> {
    const fetchFn = this.http.fetch ?? fetch;
    const { stream: _stream, max_tokens: _max, ...body } = this.body(request, false);
    const response = await fetchFn(joinUrl(this.http.baseUrl, "/v1/messages/count_tokens"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!response.ok) return undefined;
    return ((await response.json()) as { input_tokens?: number }).input_tokens;
  }

  async *stream(request: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent> {
    const fetchFn = this.http.fetch ?? fetch;
    let response: Response;
    try {
      response = await fetchFn(joinUrl(this.http.baseUrl, "/v1/messages"), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(this.body(request, true)),
        signal,
      });
    } catch (e) {
      yield { type: "error", kind: "unavailable", message: (e as Error).message };
      return;
    }
    const limits = rateLimitSnapshot(response.headers);
    if (limits) yield { type: "rate_limits", snapshot: limits };
    if (!response.ok || !response.body) {
      yield await errorEvent(response);
      return;
    }
    const tools = new Map<number, { id: string; name: string; json: string }>();
    let input = 0;
    let cached = 0;
    let output = 0;
    let stopReason: string | undefined;
    for await (const { data } of readSse(response.body, signal)) {
      const event = safeJson(data) as Record<string, any> | undefined;
      if (!event) continue;
      switch (event.type) {
        case "message_start": {
          const usage = event.message?.usage ?? {};
          input = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
          cached = usage.cache_read_input_tokens ?? 0;
          output = usage.output_tokens ?? 0;
          break;
        }
        case "content_block_start":
          if (event.content_block?.type === "tool_use") {
            tools.set(event.index, { id: event.content_block.id, name: event.content_block.name, json: "" });
          }
          break;
        case "content_block_delta":
          if (event.delta?.type === "text_delta") yield { type: "text", delta: event.delta.text };
          else if (event.delta?.type === "input_json_delta") {
            const tool = tools.get(event.index);
            if (tool) tool.json += event.delta.partial_json ?? "";
          }
          break;
        case "content_block_stop": {
          const tool = tools.get(event.index);
          if (tool) {
            yield { type: "tool_call", id: tool.id, name: tool.name, args: tool.json ? (safeJson(tool.json) ?? {}) : {} };
            tools.delete(event.index);
          }
          break;
        }
        case "message_delta":
          output = event.usage?.output_tokens ?? output;
          stopReason = event.delta?.stop_reason ?? stopReason;
          break;
        case "error": {
          const type = String(event.error?.type ?? "");
          const message = String(event.error?.message ?? "stream error");
          yield { type: "error", kind: streamErrorKind(type, message), message };
          return;
        }
        default:
          break;
      }
    }
    yield { type: "usage", input, output, cached };
    yield { type: "done", ...(stopReason ? { stopReason } : {}) };
  }
}
