import type { ChatEvent, ErrorKind, Health, RateLimitSnapshot } from "@delamain/core";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpOptions {
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  fetch?: FetchLike;
}

/** Parses a Server-Sent Events stream into `{event, data}` records. */
export async function* readSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<{ event?: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event: string | undefined;
  let data: string[] = [];
  const onAbort = () => void reader.cancel().catch(() => undefined);
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line === "") {
          if (data.length) yield { ...(event ? { event } : {}), data: data.join("\n") };
          event = undefined;
          data = [];
        } else if (line.startsWith(":")) {
          continue;
        } else if (line.startsWith("event:")) {
          event = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          data.push(line.slice(5).replace(/^ /, ""));
        }
      }
    }
    if (data.length) yield { ...(event ? { event } : {}), data: data.join("\n") };
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

export function retryAfterMs(headers: Headers): number | undefined {
  const value = headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

/** Usage counters from the rate-limit headers of a response, per credential profile. */
export function rateLimitSnapshot(headers: Headers): RateLimitSnapshot | undefined {
  const pick = (...names: string[]) => {
    for (const name of names) {
      const value = headers.get(name);
      if (value !== null && value !== "" && Number.isFinite(Number(value))) return Number(value);
    }
    return undefined;
  };
  const requestsRemaining = pick("anthropic-ratelimit-requests-remaining", "x-ratelimit-remaining-requests");
  const tokensRemaining = pick("anthropic-ratelimit-tokens-remaining", "anthropic-ratelimit-input-tokens-remaining", "x-ratelimit-remaining-tokens");
  const reset = headers.get("anthropic-ratelimit-tokens-reset") ?? headers.get("x-ratelimit-reset-tokens");
  const resetAt = reset ? Date.parse(reset) : undefined;
  if (requestsRemaining === undefined && tokensRemaining === undefined) return undefined;
  return {
    ...(requestsRemaining !== undefined ? { requestsRemaining } : {}),
    ...(tokensRemaining !== undefined ? { tokensRemaining } : {}),
    ...(resetAt !== undefined && Number.isFinite(resetAt) ? { resetAt } : {}),
  };
}

const CONTEXT_PATTERNS = [/context[_ ]length/i, /maximum context/i, /prompt is too long/i, /too many tokens/i, /context window/i];

/** Maps an HTTP failure to the normalized error the router reacts to. */
export function classifyHttpError(status: number, body: string): ErrorKind {
  if (status === 429) return "rate_limit";
  if (status === 401 || status === 403) return "auth";
  if (CONTEXT_PATTERNS.some((p) => p.test(body))) return "context_length";
  if (status === 408 || status === 409 || status >= 500) return "unavailable";
  if (status === 404) return "not_found";
  return "bad_request";
}

export async function errorEvent(response: Response): Promise<ChatEvent> {
  const body = await response.text().catch(() => "");
  let message = body;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
    message = typeof parsed.error === "string" ? parsed.error : (parsed.error?.message ?? parsed.message ?? body);
  } catch {
    // Plain-text error bodies are used as they are.
  }
  const retry = retryAfterMs(response.headers);
  return {
    type: "error",
    kind: classifyHttpError(response.status, body),
    message: `HTTP ${response.status}: ${message.slice(0, 500)}`,
    ...(retry !== undefined ? { retryAfterMs: retry } : {}),
  };
}

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

export async function getJson<T>(options: HttpOptions, path: string, extraHeaders: Record<string, string> = {}, timeoutMs = 15_000): Promise<T> {
  const fetchFn = options.fetch ?? fetch;
  const response = await fetchFn(joinUrl(options.baseUrl, path), {
    headers: { ...options.headers, ...extraHeaders },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const event = await errorEvent(response);
    if (event.type !== "error") throw Object.assign(new Error("request failed"), { kind: "unavailable" });
    throw Object.assign(new Error(event.message), { kind: event.kind, retryAfterMs: event.retryAfterMs });
  }
  return (await response.json()) as T;
}

/** Health from listing the models: a 429 means rate limited, not offline. */
export async function checkHealth(list: () => Promise<readonly unknown[]>): Promise<Health> {
  const started = Date.now();
  try {
    const models = await list();
    return { status: "online", latencyMs: Date.now() - started, models: models.length };
  } catch (e) {
    const { kind, retryAfterMs } = e as { kind?: ErrorKind; retryAfterMs?: number };
    const message = (e as Error).message;
    if (kind === "auth") return { status: "auth_error", message };
    if (kind === "rate_limit") return { status: "rate_limited", untilMs: Date.now() + (retryAfterMs ?? 30_000) };
    return { status: "offline", message };
  }
}

export function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
