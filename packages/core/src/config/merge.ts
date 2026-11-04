import type { ConfigFile, HarnessConfig } from "../schema/config.ts";
import { isFindingsDefault, type FindingsRoutingEntry } from "../schema/findings.ts";
import type { IssuePath } from "../util/issues.ts";

export const LAYER_NAMES = ["preset", "global", "project", "session"] as const;
export type LayerName = (typeof LAYER_NAMES)[number];

export interface ConfigLayer {
  name: LayerName;
  config: Partial<ConfigFile> | undefined;
  source?: string;
}

export interface Origin {
  layer: LayerName;
  /** Path of the value inside its own layer file. */
  path: (string | number)[];
}

export interface MergedConfig {
  config: HarnessConfig;
  /** Merged path (joined with ".") to where the value came from. */
  origins: Record<string, Origin>;
}

type Json = Record<string, unknown>;

const SETS: Record<string, string> = { providers: "id", models: "ref" };
const DEEP_SECTIONS = ["commands", "limits", "worktree", "discovery", "security", "safeguard", "defaults"];

/**
 * Merges layers in order: preset, global, project, session. Single values are replaced,
 * ordered lists put the upper layer's entries first (same name replaces), sets are unions
 * (same id replaces), and destructive command patterns can only be added, never removed.
 */
export function mergeLayers(layers: readonly ConfigLayer[]): MergedConfig {
  const origins: Record<string, Origin> = {};
  const result: Json = {};
  for (const layer of layers) {
    if (!layer.config) continue;
    const config = layer.config as Json;

    for (const [section, key] of Object.entries(SETS)) {
      const entries = config[section];
      if (!Array.isArray(entries)) continue;
      const current = (result[section] as Json[] | undefined) ?? [];
      entries.forEach((entry, index) => {
        const id = (entry as Json)[key];
        const at = current.findIndex((c) => c[key] === id);
        if (at >= 0) current[at] = entry as Json;
        else current.push(entry as Json);
        const merged = at >= 0 ? at : current.length - 1;
        setOrigin(origins, [section, merged], { layer: layer.name, path: [section, index] });
      });
      result[section] = current;
    }

    const router = config.router as Json | undefined;
    if (router) {
      const target = (result.router as Json | undefined) ?? {};
      if (router.thresholds) {
        target.thresholds = deepMerge(target.thresholds, router.thresholds, origins, ["router", "thresholds"], layer.name);
      }
      if (router.context_margin_tokens !== undefined) {
        target.context_margin_tokens = router.context_margin_tokens;
        setOrigin(origins, ["router", "context_margin_tokens"], { layer: layer.name, path: ["router", "context_margin_tokens"] });
      }
      if (Array.isArray(router.rules)) {
        target.rules = mergeOrdered(
          (target.rules as Json[] | undefined) ?? [],
          router.rules as Json[],
          origins,
          ["router", "rules"],
          layer.name,
        );
      }
      if (router.default) {
        target.default = router.default;
        setOrigin(origins, ["router", "default"], { layer: layer.name, path: ["router", "default"] });
      }
      result.router = target;
    }

    if (Array.isArray(config.findings_routing)) {
      result.findings_routing = mergeFindings(
        (result.findings_routing as FindingsRoutingEntry[] | undefined) ?? [],
        config.findings_routing as FindingsRoutingEntry[],
        origins,
        layer.name,
      );
    }

    const previousPatterns =
      ((result.security as Json | undefined)?.destructive_patterns as string[] | undefined) ?? [];
    for (const section of DEEP_SECTIONS) {
      if (config[section] === undefined) continue;
      result[section] = deepMerge(result[section], config[section], origins, [section], layer.name);
    }
    const patterns = (config.security as Json | undefined)?.destructive_patterns;
    if (Array.isArray(patterns)) {
      (result.security as Json).destructive_patterns = [
        ...new Set([...previousPatterns, ...(patterns as string[])]),
      ];
    }
  }
  return { config: result as HarnessConfig, origins };
}

function mergeOrdered(
  lower: Json[],
  upper: Json[],
  origins: Record<string, Origin>,
  path: string[],
  layer: LayerName,
): Json[] {
  const names = new Set(upper.map((entry) => entry.name));
  const kept = lower
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => !names.has(entry.name));
  const previous = snapshotOrigins(origins, path, lower.length);
  clearOrigins(origins, path);
  upper.forEach((entry, index) => {
    setOrigin(origins, [...path, index], { layer, path: [...path, index] });
  });
  kept.forEach(({ index }, offset) => {
    const origin = previous[index];
    if (origin) setOrigin(origins, [...path, upper.length + offset], origin);
  });
  return [...upper, ...kept.map(({ entry }) => entry)];
}

function mergeFindings(
  lower: FindingsRoutingEntry[],
  upper: FindingsRoutingEntry[],
  origins: Record<string, Origin>,
  layer: LayerName,
): FindingsRoutingEntry[] {
  const path = ["findings_routing"];
  const previous = snapshotOrigins(origins, path, lower.length);
  const lowerDefaultIndex = lower.findIndex(isFindingsDefault);
  const upperDefaultIndex = upper.findIndex(isFindingsDefault);
  const lowerRules = lower
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => !isFindingsDefault(entry));
  const upperRules = upper
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => !isFindingsDefault(entry));
  const names = new Set(upperRules.map(({ entry }) => (entry as { name: string }).name));
  const kept = lowerRules.filter(({ entry }) => !names.has((entry as { name: string }).name));
  clearOrigins(origins, path);
  const merged: FindingsRoutingEntry[] = [];
  for (const { entry, index } of upperRules) {
    setOrigin(origins, [...path, merged.length], { layer, path: [...path, index] });
    merged.push(entry);
  }
  for (const { entry, index } of kept) {
    const origin = previous[index];
    if (origin) setOrigin(origins, [...path, merged.length], origin);
    merged.push(entry);
  }
  if (upperDefaultIndex >= 0) {
    setOrigin(origins, [...path, merged.length], { layer, path: [...path, upperDefaultIndex] });
    merged.push(upper[upperDefaultIndex]!);
  } else if (lowerDefaultIndex >= 0) {
    const origin = previous[lowerDefaultIndex];
    if (origin) setOrigin(origins, [...path, merged.length], origin);
    merged.push(lower[lowerDefaultIndex]!);
  }
  return merged;
}

function deepMerge(
  lower: unknown,
  upper: unknown,
  origins: Record<string, Origin>,
  path: (string | number)[],
  layer: LayerName,
): unknown {
  if (!isPlainObject(upper) || !isPlainObject(lower)) {
    markLeaves(origins, path, upper, layer);
    return structuredClone(upper);
  }
  const result: Json = { ...lower };
  for (const [key, value] of Object.entries(upper)) {
    if (value === undefined) continue;
    result[key] = deepMerge(lower[key], value, origins, [...path, key], layer);
  }
  return result;
}

function markLeaves(origins: Record<string, Origin>, path: (string | number)[], value: unknown, layer: LayerName) {
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) markLeaves(origins, [...path, key], child, layer);
    return;
  }
  setOrigin(origins, path, { layer, path: [...path] });
}

function isPlainObject(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function key(path: IssuePath): string {
  return path.join(".");
}

function setOrigin(origins: Record<string, Origin>, path: IssuePath, origin: Origin) {
  origins[key(path)] = origin;
}

function snapshotOrigins(origins: Record<string, Origin>, path: string[], count: number): (Origin | undefined)[] {
  return Array.from({ length: count }, (_, index) => origins[key([...path, index])]);
}

function clearOrigins(origins: Record<string, Origin>, path: string[]) {
  const prefix = `${key(path)}.`;
  for (const k of Object.keys(origins)) if (k.startsWith(prefix)) delete origins[k];
}

/** Maps a path of the merged config to the layer and the path inside that layer's file. */
export function originOf(origins: Record<string, Origin>, path: IssuePath): Origin | undefined {
  for (let length = path.length; length > 0; length--) {
    const origin = origins[key(path.slice(0, length))];
    if (origin) return { layer: origin.layer, path: [...origin.path, ...path.slice(length)] };
  }
  return undefined;
}
