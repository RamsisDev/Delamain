import type { ChatEvent, ChatMessage, ChatRequest, ErrorKind, Health, ModelInfo, ProviderAdapter } from "@delamain/core";
import { checkHealth, errorEvent, getJson, joinUrl, rateLimitSnapshot, readSse, safeJson, type HttpOptions } from "./http.ts";

export function toResponsesInput(messages: ChatMessage[]): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (message.role === "user") items.push({ role: "user", content: message.content });
    else if (message.role === "assistant") {
      if (message.content) items.push({ role: "assistant", content: message.content });
      for (const call of message.toolCalls ?? []) {
        items.push({ type: "function_call", call_id: call.id, name: call.name, arguments: JSON.stringify(call.args ?? {}) });
      }
    } else {
      items.push({ type: "function_call_output", call_id: message.toolCallId, output: message.content });
    }
  }
  return items;
}

function responseErrorKind(code: string, message: string): ErrorKind {
  if (code === "rate_limit_exceeded") return "rate_limit";
  if (code === "model_not_found") return "not_found";
  if (code === "invalid_api_key") return "auth";
  if (/context/i.test(code + message)) return "context_length";
  return "unavailable";
}

/** OpenAI Responses API; some Codex models only work with it. */
export class ResponsesAdapter implements ProviderAdapter {
  readonly type = "openai" as const;

  constructor(
    readonly id: string,
    private readonly http: HttpOptions,
  ) {}

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      ...(this.http.apiKey ? { authorization: `Bearer ${this.http.apiKey}` } : {}),
      ...this.http.headers,
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    const data = await getJson<{ data: { id: string }[] }>(this.http, "/models", this.headers());
    return data.data.map((m) => ({ id: m.id }));
  }

  healthCheck(): Promise<Health> {
    return checkHealth(() => this.listModels());
  }

  async *stream(request: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent> {
    const fetchFn = this.http.fetch ?? fetch;
    const body = {
      model: request.model,
      stream: true,
      instructions: request.system,
      input: toResponsesInput(request.messages),
      store: false,
      ...(request.tools?.length
        ? { tools: request.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters, strict: false })) }
        : {}),
      ...(request.maxOutputTokens ? { max_output_tokens: request.maxOutputTokens } : {}),
    };
    let response: Response;
    try {
      response = await fetchFn(joinUrl(this.http.baseUrl, "/responses"), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
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
    for await (const { data } of readSse(response.body, signal)) {
      const event = safeJson(data) as Record<string, any> | undefined;
      if (!event) continue;
      switch (event.type) {
        case "response.output_text.delta":
          if (event.delta) yield { type: "text", delta: event.delta };
          break;
        case "response.output_item.done":
          if (event.item?.type === "function_call") {
            yield { type: "tool_call", id: event.item.call_id ?? event.item.id, name: event.item.name, args: safeJson(event.item.arguments ?? "{}") ?? {} };
          }
          break;
        case "response.completed":
        case "response.incomplete": {
          const usage = event.response?.usage ?? {};
          yield { type: "usage", input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0, cached: usage.input_tokens_details?.cached_tokens ?? 0 };
          const stopReason = event.response?.incomplete_details?.reason ?? event.response?.status ?? "completed";
          yield { type: "done", stopReason };
          return;
        }
        case "response.failed":
        case "error": {
          const error = event.response?.error ?? event.error ?? event;
          const message = String(error.message ?? "response failed");
          const code = String(error.code ?? "");
          yield { type: "error", kind: responseErrorKind(code, message), message };
          return;
        }
        default:
          break;
      }
    }
    yield { type: "done" };
  }
}
