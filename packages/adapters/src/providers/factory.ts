import {
  activeProfile,
  providerBaseUrl,
  type HarnessConfig,
  type ModelInfo,
  type Provider,
  type ProviderAdapter,
  type ProviderRegistry,
} from "@delamain/core";
import { AnthropicAdapter } from "./anthropic.ts";
import { CliAdapter } from "./cli.ts";
import type { FetchLike } from "./http.ts";
import { ChatCompletionsAdapter } from "./openai-chat.ts";
import { ResponsesAdapter } from "./openai-responses.ts";

/** Reads API keys; in the extension this is VS Code SecretStorage. Files only hold the name. */
export interface SecretReader {
  get(name: string): Promise<string | undefined>;
}

export interface AdapterOptions {
  fetch?: FetchLike;
  /** Overrides the profile; defaults to the provider's active profile. */
  profile?: string;
}

const OPENROUTER_HEADERS = { "HTTP-Referer": "https://github.com/RamsisDev/Delamain", "X-Title": "Delamain Harness" };

export async function createAdapter(provider: Provider, secrets: SecretReader, options: AdapterOptions = {}): Promise<ProviderAdapter> {
  if (provider.type === "cli") {
    return new CliAdapter(provider.id, provider.command ?? "", provider.prompt_input ? { promptInput: provider.prompt_input } : {});
  }
  const profile = options.profile
    ? (provider.profiles ?? []).find((p) => p.label === options.profile)
    : activeProfile(provider);
  const apiKey = profile ? await secrets.get(profile.secret) : undefined;
  const baseUrl = providerBaseUrl(provider);
  if (!baseUrl) throw new Error(`Provider ${provider.id} needs a base_url`);
  const http = {
    baseUrl,
    ...(apiKey ? { apiKey } : {}),
    headers: { ...(provider.type === "openrouter" ? OPENROUTER_HEADERS : {}), ...provider.headers },
    ...(options.fetch ? { fetch: options.fetch } : {}),
  };
  switch (provider.type) {
    case "anthropic":
      return new AnthropicAdapter(provider.id, http);
    case "openai":
      return new ResponsesAdapter(provider.id, http);
    case "openrouter":
    case "deepseek":
    case "openai-compatible":
      return new ChatCompletionsAdapter(provider.id, provider.type, http);
  }
}

/** Adapters per provider and profile, created on demand and cached. */
export class AdapterRegistry implements ProviderRegistry {
  private readonly cache = new Map<string, Promise<ProviderAdapter>>();

  constructor(
    private config: HarnessConfig,
    private readonly secrets: SecretReader,
    private readonly fetchFn?: FetchLike,
  ) {}

  update(config: HarnessConfig): void {
    this.config = config;
    this.cache.clear();
  }

  invalidate(): void {
    this.cache.clear();
  }

  provider(id: string): Provider | undefined {
    return (this.config.providers ?? []).find((p) => p.id === id && p.enabled !== false);
  }

  async get(providerId: string, profile?: string): Promise<ProviderAdapter | undefined> {
    const provider = this.provider(providerId);
    if (!provider) return undefined;
    const key = `${providerId}@${profile ?? ""}`;
    let adapter = this.cache.get(key);
    if (!adapter) {
      adapter = createAdapter(provider, this.secrets, {
        ...(profile ? { profile } : {}),
        ...(this.fetchFn ? { fetch: this.fetchFn } : {}),
      });
      this.cache.set(key, adapter);
      adapter.catch(() => this.cache.delete(key));
    }
    return adapter;
  }
}

export type { ModelInfo };
