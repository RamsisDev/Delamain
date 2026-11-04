import { z } from "zod";
import { Identifier } from "./common.ts";

export const PROVIDER_TYPES = [
  "anthropic",
  "openai",
  "openrouter",
  "deepseek",
  "openai-compatible",
  "cli",
] as const;
export const ProviderType = z.enum(PROVIDER_TYPES);
export type ProviderType = z.infer<typeof ProviderType>;

export const MAX_PROFILES_PER_PROVIDER = 3;

export const CredentialProfile = z
  .strictObject({
    label: z.string().min(1).describe("Name shown in the UI and used in `<model>@<label>` refs."),
    secret: z
      .string()
      .min(1)
      .describe("Name of the secret in VS Code SecretStorage. The key itself never lives in files."),
  })
  .meta({ id: "CredentialProfile" });
export type CredentialProfile = z.infer<typeof CredentialProfile>;

export const Provider = z
  .strictObject({
    id: Identifier.describe("Unique provider id, used as the first segment of model refs."),
    type: ProviderType,
    label: z.string().optional(),
    base_url: z
      .url()
      .optional()
      .describe("Endpoint base URL. Required for openai-compatible; optional override otherwise."),
    local: z
      .boolean()
      .optional()
      .describe("Served by an app on this machine or network (Jan, Ollama, LM Studio...)."),
    max_concurrent: z
      .int()
      .min(1)
      .max(64)
      .optional()
      .describe("Maximum simultaneous requests. Defaults to 1 for local providers and 4 otherwise."),
    profiles: z
      .array(CredentialProfile)
      .max(MAX_PROFILES_PER_PROVIDER)
      .optional()
      .describe("Up to 3 credential profiles, each a billing context owned by the user."),
    active_profile: z.string().optional().describe("Label of the profile used by default."),
    command: z
      .string()
      .optional()
      .describe("Command line for cli providers, for example `codex exec`."),
    prompt_input: z
      .enum(["argument", "stdin"])
      .optional()
      .describe("How a cli provider receives the prompt: as its last argument (default) or on stdin. Long prompts do not fit in one argument."),
    headers: z
      .record(z.string(), z.string())
      .optional()
      .describe("Extra request headers, for example HTTP-Referer and X-Title for OpenRouter."),
    enabled: z.boolean().optional(),
  })
  .meta({ id: "Provider" });
export type Provider = z.infer<typeof Provider>;

export const DEFAULT_BASE_URLS: Partial<Record<ProviderType, string>> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  deepseek: "https://api.deepseek.com",
};

const KEYED_TYPES: ReadonlySet<ProviderType> = new Set(["anthropic", "openai", "openrouter", "deepseek"]);

/** Cloud APIs reject requests without a key; local and compatible servers may not need one. */
export function requiresApiKey(provider: Provider): boolean {
  return KEYED_TYPES.has(provider.type) && !provider.local;
}

/** Only OpenRouter's catalog reports prices; other favorites need them set by hand. */
export function catalogReportsPricing(type: ProviderType): boolean {
  return type === "openrouter";
}

export function providerMaxConcurrent(provider: Provider): number {
  return provider.max_concurrent ?? (provider.local ? 1 : 4);
}

export function providerBaseUrl(provider: Provider): string | undefined {
  return provider.base_url ?? DEFAULT_BASE_URLS[provider.type];
}

export function activeProfile(provider: Provider): CredentialProfile | undefined {
  const profiles = provider.profiles ?? [];
  return profiles.find((p) => p.label === provider.active_profile) ?? profiles[0];
}
