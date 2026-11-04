import type { DiscoveryServer, ModelInfo, ProviderAdapter } from "@delamain/core";
import type { FetchLike } from "./http.ts";
import { joinUrl } from "./http.ts";
import { withOllamaContext } from "./ollama.ts";
import { toModelInfo } from "./openai-chat.ts";

export interface DiscoveredServer extends DiscoveryServer {
  models: ModelInfo[];
  latencyMs: number;
}

/**
 * Probes the known local apps (Jan, Ollama, LM Studio, llama.cpp, vLLM) with GET /v1/models.
 * Each probe has a short timeout so startup is never held up by servers that are not running.
 */
export async function discoverLocalServers(
  servers: readonly DiscoveryServer[],
  timeoutMs = 300,
  fetchFn: FetchLike = fetch,
): Promise<DiscoveredServer[]> {
  const results = await Promise.all(
    servers.map(async (server): Promise<DiscoveredServer | undefined> => {
      const started = Date.now();
      try {
        const response = await fetchFn(joinUrl(server.base_url, "/models"), { signal: AbortSignal.timeout(timeoutMs) });
        if (!response.ok) return undefined;
        const data = (await response.json()) as { data?: unknown[]; models?: unknown[] };
        const models = ((data.data ?? data.models ?? []) as { id: string }[]).filter((m) => typeof m?.id === "string").map((m) => toModelInfo(m));
        await withOllamaContext(server.base_url, models, fetchFn);
        return { ...server, models, latencyMs: Date.now() - started };
      } catch {
        return undefined;
      }
    }),
  );
  return results.filter((r): r is DiscoveredServer => r !== undefined);
}

const PROBE_TOOL = {
  name: "get_magic_number",
  description: "Returns the magic number. Always call this tool when asked for the magic number.",
  parameters: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] },
};

/**
 * Detects tool calling with a test request that carries a dummy tool. The result is stored on
 * the favorite and the user can correct it.
 */
export async function probeToolCalling(adapter: ProviderAdapter, model: string, timeoutMs = 60_000): Promise<{ toolCalling: boolean | undefined; message: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("probe timed out")), timeoutMs);
  try {
    let sawTool = false;
    let text = "";
    for await (const event of adapter.stream(
      {
        model,
        system: "You are a test harness. Use the tools you are given.",
        messages: [{ role: "user", content: "What is the magic number? Call get_magic_number to find out." }],
        tools: [PROBE_TOOL],
        maxOutputTokens: 200,
      },
      controller.signal,
    )) {
      if (event.type === "tool_call" && event.name === PROBE_TOOL.name) sawTool = true;
      if (event.type === "text") text += event.delta;
      if (event.type === "error") {
        if (/tool/i.test(event.message)) return { toolCalling: false, message: event.message };
        return { toolCalling: undefined, message: event.message };
      }
    }
    return sawTool
      ? { toolCalling: true, message: "The model called the test tool." }
      : { toolCalling: false, message: `The model answered without calling the tool: ${text.slice(0, 120)}` };
  } catch (e) {
    return { toolCalling: undefined, message: (e as Error).message };
  } finally {
    clearTimeout(timer);
  }
}
