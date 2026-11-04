import type { FavoriteRole } from "../schema/common.ts";
import type { HarnessConfig } from "../schema/config.ts";
import { parseModelRef, type Pricing } from "../schema/models.ts";
import { activeProfile, type Provider, type ProviderType } from "../schema/providers.ts";
import type { ModelInfo } from "../providers/types.ts";

export interface CatalogModel {
  /** The ref as written, with its profile suffix if pinned. */
  ref: string;
  /** provider/model, without profile. */
  baseRef: string;
  provider: string;
  providerType: ProviderType;
  model: string;
  /** Effective credential profile: the pinned one, or the provider's active one. */
  profile?: string;
  label: string;
  roles: FavoriteRole[];
  contextWindow?: number;
  toolCalling?: boolean;
  maxOutputTokens?: number;
  pricing?: Pricing;
  local: boolean;
  favorite: boolean;
}

export interface Catalog {
  providers: Map<string, Provider>;
  favorites: CatalogModel[];
  /** Models reported by providers, keyed by base ref. */
  discovered: Map<string, ModelInfo>;
}

export interface DiscoveredModels {
  provider: string;
  models: ModelInfo[];
}

export function buildCatalog(config: HarnessConfig, discovered: readonly DiscoveredModels[] = []): Catalog {
  const providers = new Map((config.providers ?? []).filter((p) => p.enabled !== false).map((p) => [p.id, p]));
  const discoveredMap = new Map<string, ModelInfo>();
  for (const entry of discovered) {
    for (const info of entry.models) discoveredMap.set(`${entry.provider}/${info.id}`, info);
  }
  const catalog: Catalog = { providers, favorites: [], discovered: discoveredMap };
  for (const favorite of config.models ?? []) {
    const model = describeModel(catalog, favorite.ref, {
      label: favorite.label,
      roles: favorite.roles,
      contextWindow: favorite.context_window,
      toolCalling: favorite.tool_calling,
      maxOutputTokens: favorite.max_output_tokens,
      pricing: favorite.pricing,
      favorite: true,
    });
    if (model) catalog.favorites.push(model);
  }
  return catalog;
}

interface Overrides {
  label?: string;
  roles?: FavoriteRole[];
  contextWindow?: number;
  toolCalling?: boolean;
  maxOutputTokens?: number;
  pricing?: Pricing;
  favorite?: boolean;
}

function describeModel(catalog: Catalog, ref: string, overrides: Overrides = {}): CatalogModel | undefined {
  let parsed;
  try {
    parsed = parseModelRef(ref);
  } catch {
    return undefined;
  }
  const provider = catalog.providers.get(parsed.provider);
  if (!provider) return undefined;
  const baseRef = `${parsed.provider}/${parsed.model}`;
  const info = catalog.discovered.get(baseRef);
  const profile = parsed.profile ?? activeProfile(provider)?.label;
  return {
    ref,
    baseRef,
    provider: parsed.provider,
    providerType: provider.type,
    model: parsed.model,
    ...(profile ? { profile } : {}),
    label: overrides.label ?? info?.label ?? parsed.model,
    roles: overrides.roles ?? [],
    contextWindow: overrides.contextWindow ?? info?.contextWindow,
    toolCalling: overrides.toolCalling ?? info?.toolCalling,
    maxOutputTokens: overrides.maxOutputTokens,
    pricing: overrides.pricing ?? info?.pricing,
    local: provider.local === true,
    favorite: overrides.favorite ?? false,
  };
}

/** Looks up a ref: the favorite with that exact ref, or a non-favorite description of it. */
export function lookupModel(catalog: Catalog, ref: string): CatalogModel | undefined {
  return catalog.favorites.find((m) => m.ref === ref) ?? describeModel(catalog, ref);
}

/** Expands a target (`role:<role>` or a ref) into catalog models, in favorites order. */
export function resolveTarget(catalog: Catalog, target: string): CatalogModel[] {
  if (target.startsWith("role:")) {
    const role = target.slice(5) as FavoriteRole;
    return catalog.favorites.filter((m) => m.roles.includes(role));
  }
  const model = lookupModel(catalog, target);
  return model ? [model] : [];
}

/** Billing context of a model, used for per-profile budgets and rate-limit bookkeeping. */
export function profileKey(model: Pick<CatalogModel, "provider" | "profile">): string {
  return model.profile ? `${model.provider}@${model.profile}` : model.provider;
}
