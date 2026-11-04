import type { ModelInfo } from "@delamain/core";
import type { FetchLike } from "./http.ts";

function ollamaRoot(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
}

/** Ollama reports the context window through /api/show rather than /v1/models. */
export async function ollamaContextWindow(baseUrl: string, model: string, fetchFn: FetchLike = fetch): Promise<number | undefined> {
  try {
    const response = await fetchFn(`${ollamaRoot(baseUrl)}/api/show`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return undefined;
    const data = (await response.json()) as { model_info?: Record<string, unknown>; parameters?: string };
    const fromInfo = Object.entries(data.model_info ?? {}).find(([k]) => k.endsWith(".context_length"))?.[1];
    if (typeof fromInfo === "number") return fromInfo;
    const fromParams = /num_ctx\s+(\d+)/.exec(data.parameters ?? "")?.[1];
    return fromParams ? Number(fromParams) : undefined;
  } catch {
    return undefined;
  }
}

async function isOllama(baseUrl: string, fetchFn: FetchLike): Promise<boolean> {
  try {
    const response = await fetchFn(`${ollamaRoot(baseUrl)}/api/version`, { signal: AbortSignal.timeout(1000) });
    if (!response.ok) return false;
    return typeof ((await response.json()) as { version?: unknown }).version === "string";
  } catch {
    return false;
  }
}

/**
 * Fills the context windows /v1/models left out when the server is Ollama, on any port or host.
 * Models are updated in place and returned.
 */
export async function withOllamaContext(baseUrl: string, models: ModelInfo[], fetchFn: FetchLike = fetch): Promise<ModelInfo[]> {
  const missing = models.filter((m) => m.contextWindow === undefined);
  if (!missing.length || !(await isOllama(baseUrl, fetchFn))) return models;
  await Promise.all(
    missing.map(async (m) => {
      const context = await ollamaContextWindow(baseUrl, m.id, fetchFn);
      if (context) m.contextWindow = context;
    }),
  );
  return models;
}
