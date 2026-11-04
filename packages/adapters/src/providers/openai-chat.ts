import type { ChatEvent, ChatMessage, ChatRequest, Health, ModelInfo, Pricing, ProviderAdapter, ProviderType } from "@delamain/core";
import { checkHealth, classifyHttpError, errorEvent, getJson, joinUrl, rateLimitSnapshot, readSse, safeJson, type HttpOptions } from "./http.ts";
import { withOllamaContext } from "./ollama.ts";

/**
 * With `cacheSystem`, the system prompt carries an explicit cache breakpoint, which OpenRouter
 * needs for Anthropic models; other providers there cache on their own.
 */
export function toChatMessages(system: string, messages: ChatMessage[], cacheSystem = false): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [
    { role: "system", content: cacheSystem ? [{ type: "text", text: system, cache_control: { type: "ephemeral" } }] : system },
  ];
  for (const message of messages) {
    if (message.role === "user") out.push({ role: "user", content: message.content });
    else if (message.role === "assistant") {
      out.push({
        role: "assistant",
        content: message.content || null,
        ...(message.toolCalls?.length
          ? {
              tool_calls: message.toolCalls.map((c) => ({
                id: c.id,
                type: "function",
                function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
              })),
            }
          : {}),
      });
    } else {
      out.push({ role: "tool", tool_call_id: message.toolCallId, content: message.content });
    }
  }
  return out;
}

interface RawModel {
  id: string;
  name?: string;
  context_length?: number;
  max_model_len?: number;
  max_context_length?: number;
  meta?: { n_ctx_train?: number; n_ctx?: number };
  pricing?: { prompt?: string | number; completion?: string | number; input_cache_read?: string | number };
  supported_parameters?: string[];
  capabilities?: string[];
}

function perMillion(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 1_000_000 * 1e6) / 1e6 : undefined;
}

/** Normalizes the model list of OpenRouter, DeepSeek and local servers (vLLM, LM Studio, llama.cpp). */
export function toModelInfo(model: RawModel): ModelInfo {
  const contextWindow = model.context_length ?? model.max_model_len ?? model.max_context_length ?? model.meta?.n_ctx ?? model.meta?.n_ctx_train;
  const input = perMillion(model.pricing?.prompt);
  const output = perMillion(model.pricing?.completion);
  const cachedIn = perMillion(model.pricing?.input_cache_read);
  const pricing: Pricing | undefined =
    input !== undefined && output !== undefined
      ? { input_per_mtok: input, output_per_mtok: output, ...(cachedIn !== undefined ? { cached_per_mtok: cachedIn } : {}) }
      : undefined;
  const toolCalling = model.supported_parameters
    ? model.supported_parameters.includes("tools")
    : model.capabilities
      ? model.capabilities.includes("tools")
      : undefined;
  return {
    id: model.id,
    ...(model.name ? { label: model.name } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(pricing ? { pricing } : {}),
    ...(toolCalling !== undefined ? { toolCalling } : {}),
    ...(model.supported_parameters ? { supportedParameters: model.supported_parameters } : {}),
  };
}

/**
 * Slot of a streamed tool-call fragment. Some local servers omit `index`; then a fragment with a
 * new id starts a new call and one without an id continues the last.
 */
function toolCallIndex(calls: ReadonlyMap<number, { id: string }>, call: { index?: number; id?: string }): number {
  if (typeof call.index === "number") return call.index;
  const last = Math.max(-1, ...calls.keys());
  if (last < 0) return 0;
  return call.id && calls.get(last)!.id && call.id !== calls.get(last)!.id ? last + 1 : last;
}

/** OpenAI Chat Completions, used by OpenRouter, DeepSeek and every OpenAI-compatible server. */
export class ChatCompletionsAdapter implements ProviderAdapter {
  constructor(
    readonly id: string,
    readonly type: ProviderType,
    private readonly http: HttpOptions,
  ) {}

  protected headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      ...(this.http.apiKey ? { authorization: `Bearer ${this.http.apiKey}` } : {}),
      ...this.http.headers,
    };
  }

  private async rawModels(): Promise<RawModel[]> {
    const data = await getJson<{ data?: RawModel[]; models?: RawModel[] }>(this.http, "/models", this.headers(), 10_000);
    return data.data ?? data.models ?? [];
  }

  async listModels(): Promise<ModelInfo[]> {
    const models = (await this.rawModels()).map(toModelInfo);
    return this.type === "openai-compatible" ? withOllamaContext(this.http.baseUrl, models, this.http.fetch) : models;
  }

  healthCheck(): Promise<Health> {
    return checkHealth(() => this.rawModels());
  }

  async *stream(request: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent> {
    const fetchFn = this.http.fetch ?? fetch;
    const body = {
      model: request.model,
      stream: true,
      stream_options: { include_usage: true },
      messages: toChatMessages(request.system, request.messages, request.cache === true && this.type === "openrouter" && request.model.startsWith("anthropic/")),
      ...(request.tools?.length
        ? { tools: request.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })) }
        : {}),
      ...(request.maxOutputTokens ? { max_tokens: request.maxOutputTokens } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    };
    let response: Response;
    try {
      response = await fetchFn(joinUrl(this.http.baseUrl, "/chat/completions"), {
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
    const calls = new Map<number, { id: string; name: string; args: string }>();
    let usage: { input: number; output: number; cached: number } | undefined;
    let finish: string | undefined;
    for await (const { data } of readSse(response.body, signal)) {
      if (data === "[DONE]") break;
      const chunk = safeJson(data) as Record<string, any> | undefined;
      if (!chunk) continue;
      if (chunk.error) {
        const message = String(chunk.error.message ?? "stream error");
        const code = Number(chunk.error.code);
        yield { type: "error", kind: /context/i.test(message) ? "context_length" : Number.isFinite(code) ? classifyHttpError(code, message) : "unavailable", message };
        return;
      }
      if (chunk.usage) {
        usage = {
          input: chunk.usage.prompt_tokens ?? 0,
          output: chunk.usage.completion_tokens ?? 0,
          cached: chunk.usage.prompt_tokens_details?.cached_tokens ?? chunk.usage.prompt_cache_hit_tokens ?? 0,
        };
      }
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};
      if (typeof delta.content === "string" && delta.content) yield { type: "text", delta: delta.content };
      for (const call of delta.tool_calls ?? []) {
        const index = toolCallIndex(calls, call);
        const current = calls.get(index) ?? { id: "", name: "", args: "" };
        if (call.id) current.id = call.id;
        const name = call.function?.name;
        if (name && name !== current.name) current.name += name;
        if (call.function?.arguments) current.args += call.function.arguments;
        calls.set(index, current);
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
    for (const [index, call] of [...calls.entries()].sort(([a], [b]) => a - b)) {
      yield { type: "tool_call", id: call.id || `call_${index}`, name: call.name, args: call.args ? (safeJson(call.args) ?? {}) : {} };
    }
    if (usage) yield { type: "usage", ...usage };
    yield { type: "done", ...(finish ? { stopReason: finish } : {}) };
  }
}
