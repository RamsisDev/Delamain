import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatEvent } from "@delamain/core";
import {
  AnthropicAdapter,
  ChatCompletionsAdapter,
  CliAdapter,
  ResponsesAdapter,
  classifyHttpError,
  createAdapter,
  discoverLocalServers,
  probeToolCalling,
  splitCommand,
  toModelInfo,
  type FetchLike,
} from "../src/index.ts";

function sse(events: unknown[], headers: Record<string, string> = {}): Response {
  const body = events.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join("");
  return new Response(new Blob([body]).stream(), { status: 200, headers: { "content-type": "text/event-stream", ...headers } });
}

async function collect(stream: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  for await (const e of stream) events.push(e);
  return events;
}

const request = { model: "m", system: "sys", messages: [{ role: "user" as const, content: "hi" }], tools: [{ name: "t", description: "d", parameters: { type: "object" } }] };

describe("anthropic adapter", () => {
  it("streams text, tool calls, usage and rate-limit headers", async () => {
    let sent: Record<string, unknown> = {};
    const fetchFn: FetchLike = async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      return sse(
        [
          { type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 1 } } },
          { type: "content_block_start", index: 0, content_block: { type: "text" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
          { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu1", name: "read_file" } },
          { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":' } },
          { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"a.ts"}' } },
          { type: "content_block_stop", index: 1 },
          { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 20 } },
          { type: "message_stop" },
        ],
        { "anthropic-ratelimit-requests-remaining": "49", "anthropic-ratelimit-tokens-remaining": "9000" },
      );
    };
    const adapter = new AnthropicAdapter("anthropic", { baseUrl: "https://api.anthropic.com", apiKey: "k", fetch: fetchFn });
    const events = await collect(adapter.stream({ ...request, cache: true }, new AbortController().signal));
    expect(events).toContainEqual({ type: "rate_limits", snapshot: { requestsRemaining: 49, tokensRemaining: 9000 } });
    expect(events).toContainEqual({ type: "text", delta: "Hello" });
    expect(events).toContainEqual({ type: "tool_call", id: "tu1", name: "read_file", args: { path: "a.ts" } });
    expect(events).toContainEqual({ type: "usage", input: 15, output: 20, cached: 5 });
    expect((sent.system as { cache_control?: unknown }[])[0]?.cache_control).toEqual({ type: "ephemeral" });
    expect((sent.tools as { input_schema: unknown }[])[0]?.input_schema).toEqual({ type: "object" });
  });

  it("normalizes a 429 with Retry-After", async () => {
    const fetchFn: FetchLike = async () => new Response(JSON.stringify({ error: { message: "slow down" } }), { status: 429, headers: { "retry-after": "12" } });
    const adapter = new AnthropicAdapter("anthropic", { baseUrl: "https://x", fetch: fetchFn });
    const [event] = await collect(adapter.stream(request, new AbortController().signal));
    expect(event).toMatchObject({ type: "error", kind: "rate_limit", retryAfterMs: 12000 });
  });

  it("accepts a base URL with or without /v1", async () => {
    const urls: string[] = [];
    const fetchFn: FetchLike = async (url) => {
      urls.push(url);
      return sse([{ type: "message_stop" }]);
    };
    await collect(new AnthropicAdapter("anthropic", { baseUrl: "https://proxy/v1/", fetch: fetchFn }).stream(request, new AbortController().signal));
    expect(urls).toEqual(["https://proxy/v1/messages"]);
  });

  it("reports a 429 on the health check as rate limited, not offline", async () => {
    const fetchFn: FetchLike = async () => new Response("{}", { status: 429, headers: { "retry-after": "5" } });
    const health = await new AnthropicAdapter("anthropic", { baseUrl: "https://x", fetch: fetchFn }).healthCheck();
    expect(health.status).toBe("rate_limited");
  });
});

describe("chat completions adapter", () => {
  it("assembles tool calls split across chunks", async () => {
    const fetchFn: FetchLike = async () =>
      sse([
        { choices: [{ delta: { content: "ok" } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "search", arguments: '{"pat' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'tern":"x"}' } }] }, finish_reason: "tool_calls" }] },
        { choices: [], usage: { prompt_tokens: 7, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 2 } } },
        "[DONE]",
      ]);
    const adapter = new ChatCompletionsAdapter("openrouter", "openrouter", { baseUrl: "https://openrouter.ai/api/v1", fetch: fetchFn });
    const events = await collect(adapter.stream(request, new AbortController().signal));
    expect(events).toEqual([
      { type: "text", delta: "ok" },
      { type: "tool_call", id: "c1", name: "search", args: { pattern: "x" } },
      { type: "usage", input: 7, output: 3, cached: 2 },
      { type: "done", stopReason: "tool_calls" },
    ]);
  });

  it("separates tool calls from servers that omit the index or repeat the name", async () => {
    const fetchFn: FetchLike = async () =>
      sse([
        { choices: [{ delta: { tool_calls: [{ id: "a", function: { name: "read_file", arguments: '{"path":' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ function: { name: "read_file", arguments: '"a.ts"}' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ id: "b", function: { name: "search", arguments: '{"pattern":"x"}' } }] } }] },
        "[DONE]",
      ]);
    const adapter = new ChatCompletionsAdapter("ollama", "openai-compatible", { baseUrl: "http://x/v1", fetch: fetchFn });
    const calls = (await collect(adapter.stream(request, new AbortController().signal))).filter((e) => e.type === "tool_call");
    expect(calls).toEqual([
      { type: "tool_call", id: "a", name: "read_file", args: { path: "a.ts" } },
      { type: "tool_call", id: "b", name: "search", args: { pattern: "x" } },
    ]);
  });

  it("marks the system prompt for caching on OpenRouter's Anthropic models only", async () => {
    let sent: { messages: { content: unknown }[] } = { messages: [] };
    const fetchFn: FetchLike = async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      return sse(["[DONE]"]);
    };
    const adapter = new ChatCompletionsAdapter("openrouter", "openrouter", { baseUrl: "https://openrouter.ai/api/v1", fetch: fetchFn });
    await collect(adapter.stream({ ...request, model: "anthropic/claude", cache: true }, new AbortController().signal));
    expect(sent.messages[0]!.content).toEqual([{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }]);
    await collect(adapter.stream({ ...request, model: "deepseek/deepseek-chat", cache: true }, new AbortController().signal));
    expect(sent.messages[0]!.content).toBe("sys");
  });

  it("fills Ollama's context windows on any port", async () => {
    const fetchFn: FetchLike = async (url) => {
      if (url.endsWith("/v1/models")) return new Response(JSON.stringify({ data: [{ id: "qwen" }] }));
      if (url.endsWith("/api/version")) return new Response(JSON.stringify({ version: "0.9.0" }));
      if (url.endsWith("/api/show")) return new Response(JSON.stringify({ model_info: { "qwen2.context_length": 32768 } }));
      return new Response("", { status: 404 });
    };
    const adapter = new ChatCompletionsAdapter("lan", "openai-compatible", { baseUrl: "http://192.168.1.20:9999/v1", fetch: fetchFn });
    expect(await adapter.listModels()).toEqual([{ id: "qwen", contextWindow: 32768 }]);
  });

  it("reads OpenRouter's catalog with context, pricing and tool support", () => {
    expect(
      toModelInfo({ id: "deepseek/deepseek-chat", name: "DeepSeek", context_length: 64000, pricing: { prompt: "0.00000027", completion: "0.0000011" }, supported_parameters: ["tools", "temperature"] }),
    ).toMatchObject({ id: "deepseek/deepseek-chat", contextWindow: 64000, toolCalling: true, pricing: { input_per_mtok: 0.27, output_per_mtok: 1.1 } });
  });
});

describe("responses adapter", () => {
  it("emits function calls and usage", async () => {
    const fetchFn: FetchLike = async () =>
      sse([
        { type: "response.output_text.delta", delta: "Hi" },
        { type: "response.output_item.done", item: { type: "function_call", call_id: "fc1", name: "finish", arguments: '{"notes":"x"}' } },
        { type: "response.completed", response: { status: "completed", usage: { input_tokens: 4, output_tokens: 2, input_tokens_details: { cached_tokens: 1 } } } },
      ]);
    const adapter = new ResponsesAdapter("openai", { baseUrl: "https://api.openai.com/v1", fetch: fetchFn });
    const events = await collect(adapter.stream(request, new AbortController().signal));
    expect(events).toContainEqual({ type: "tool_call", id: "fc1", name: "finish", args: { notes: "x" } });
    expect(events).toContainEqual({ type: "usage", input: 4, output: 2, cached: 1 });
  });

  it("keeps the usage of a response cut short by the output limit", async () => {
    const fetchFn: FetchLike = async () =>
      sse([{ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 9, output_tokens: 200 } } }]);
    const adapter = new ResponsesAdapter("openai", { baseUrl: "https://api.openai.com/v1", fetch: fetchFn });
    const events = await collect(adapter.stream(request, new AbortController().signal));
    expect(events).toEqual([
      { type: "usage", input: 9, output: 200, cached: 0 },
      { type: "done", stopReason: "max_output_tokens" },
    ]);
  });
});

describe("errors, discovery and probe", () => {
  it("classifies HTTP errors", () => {
    expect(classifyHttpError(429, "")).toBe("rate_limit");
    expect(classifyHttpError(401, "")).toBe("auth");
    expect(classifyHttpError(400, "This model's maximum context length is 8192 tokens")).toBe("context_length");
    expect(classifyHttpError(503, "")).toBe("unavailable");
    expect(classifyHttpError(404, "model not found")).toBe("not_found");
    expect(classifyHttpError(400, "bad field")).toBe("bad_request");
  });

  it("finds the local servers that answer and skips the rest", async () => {
    const fetchFn: FetchLike = async (url) => {
      if (url.startsWith("http://localhost:1234")) return new Response(JSON.stringify({ data: [{ id: "qwen", max_context_length: 32768 }] }));
      throw new Error("ECONNREFUSED");
    };
    const found = await discoverLocalServers(
      [
        { id: "lmstudio", label: "LM Studio", base_url: "http://localhost:1234/v1" },
        { id: "jan", label: "Jan", base_url: "http://localhost:1337/v1" },
      ],
      300,
      fetchFn,
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ id: "lmstudio", models: [{ id: "qwen", contextWindow: 32768 }] });
  });

  it("detects tool calling with a dummy tool", async () => {
    const withTools = new ChatCompletionsAdapter("jan", "openai-compatible", {
      baseUrl: "http://x/v1",
      fetch: async () => sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "a", function: { name: "get_magic_number", arguments: "{}" } }] } }] }, "[DONE]"]),
    });
    expect((await probeToolCalling(withTools, "m")).toolCalling).toBe(true);
    const without = new ChatCompletionsAdapter("jan", "openai-compatible", {
      baseUrl: "http://x/v1",
      fetch: async () => sse([{ choices: [{ delta: { content: "42" } }] }, "[DONE]"]),
    });
    expect((await probeToolCalling(without, "m")).toolCalling).toBe(false);
  });

  it("splits cli commands", () => {
    expect(splitCommand(`codex exec --sandbox "workspace write"`)).toEqual(["codex", "exec", "--sandbox", "workspace write"]);
  });
});

describe("cli adapter", () => {
  it.runIf(process.platform === "win32")("runs npm-style command shims from paths with spaces without interpreting the prompt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness cli "));
    const script = join(dir, "echo.cjs");
    writeFileSync(script, "if (process.argv.includes('--version')) process.stdout.write('qa-cli 1.0'); else process.stdin.pipe(process.stdout);");
    const shim = join(dir, "echo.cmd");
    writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    const adapter = new CliAdapter("echo", `"${shim}"`, { promptInput: "stdin" });
    expect(await adapter.healthCheck()).toMatchObject({ status: "online" });
    const prompt = 'hello & echo NOT_A_COMMAND | (safe) "quoted"';
    const events = await collect(adapter.stream({ model: "default", system: "sys", messages: [{ role: "user", content: prompt }] }, new AbortController().signal));
    expect(events.filter(e => e.type === "text").map(e => e.type === "text" ? e.delta : "").join("")).toBe(`sys\n\n${prompt}`);
    expect(events.at(-1)).toMatchObject({ type: "done" });
    const argumentAdapter = new CliAdapter("echo", `"${shim}"`);
    const rejected = await collect(argumentAdapter.stream({ model: "default", system: "sys", messages: [{ role: "user", content: prompt }] }, new AbortController().signal));
    expect(rejected).toEqual([{ type: "error", kind: "bad_request", message: "Multiline prompts on Windows require prompt_input: stdin on provider echo" }]);
  });

  it("does not start a cancelled request", async () => {
    const controller = new AbortController();
    controller.abort();
    const adapter = new CliAdapter("echo", `"${process.execPath}" -e "process.stdout.write('unexpected')"`);
    expect(await collect(adapter.stream({ model: "default", system: "sys", messages: [] }, controller.signal))).toEqual([]);
  });
  const single = { model: "default", system: "sys", messages: [{ role: "user" as const, content: "hello" }] };

  it("writes the prompt to stdin when configured", async () => {
    const adapter = await createAdapter({ id: "echo", type: "cli", command: `"${process.execPath}" -e "process.stdin.pipe(process.stdout)"`, prompt_input: "stdin" }, { get: async () => undefined });
    const events = await collect(adapter.stream(single, new AbortController().signal));
    expect(events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("")).toBe("sys\n\nhello");
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "exit" });
  });

  it("refuses a prompt too long for one argument instead of failing to spawn", async () => {
    const adapter = new CliAdapter("codex", "codex exec");
    const [event] = await collect(adapter.stream({ ...single, messages: [{ role: "user", content: "x".repeat(200_000) }] }, new AbortController().signal));
    expect(event).toMatchObject({ type: "error", kind: "bad_request" });
    expect((event as { message: string }).message).toContain("prompt_input: stdin");
  });
});
