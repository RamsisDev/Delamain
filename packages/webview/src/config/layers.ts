import {
  ConfigFile,
  blockingErrors,
  isFindingsDefault,
  mergeLayers,
  originOf,
  validateConfig,
  validateWith,
  type HarnessSnapshot,
  type Issue,
  type LayerName,
  type MergedConfig,
  type Origin,
} from "@delamain/core";
import { clone, deepEqual, type Path } from "../util/deep";
import { pathKey } from "../util/issues";

export type Destination = "global" | "project";
export type WorkingConfig = Partial<ConfigFile>;

const RANK: Record<LayerName, number> = { preset: 0, global: 1, project: 2, session: 3 };

export function layerRank(layer: LayerName): number {
  return RANK[layer];
}

/** The destination layer as the working copy starts: always with its schema version. */
export function baselineOf(snapshot: HarnessSnapshot, destination: Destination): WorkingConfig {
  return { schema_version: 1, ...clone(snapshot.layers[destination] ?? {}) };
}

export function isDirty(snapshot: HarnessSnapshot, destination: Destination, working: WorkingConfig): boolean {
  return !deepEqual(baselineOf(snapshot, destination), { schema_version: 1, ...working });
}

/** Preset, global and project merged with the working copy in place of the destination layer. */
export function effectiveConfig(snapshot: HarnessSnapshot, destination: Destination, working: WorkingConfig): MergedConfig {
  const names = ["preset", "global", "project"] as const;
  return mergeLayers(
    names.map((name) => ({ name, config: name === destination ? working : snapshot.layers[name] })),
  );
}

/** Layer a merged value comes from; undefined means nobody sets it and the built-in default applies. */
export function ownerOf(origins: Record<string, Origin>, path: Path): LayerName | undefined {
  return originOf(origins, path)?.layer;
}

/** An entry can be edited from the destination unless a higher layer defines it. */
export function canEditFrom(owner: LayerName | undefined, destination: Destination): boolean {
  return owner === undefined || layerRank(owner) <= layerRank(destination);
}

function parseKey(key: string): (string | number)[] {
  return key.split(".").map((segment) => (/^\d+$/.test(segment) ? Number(segment) : segment));
}

/** Maps a path inside one layer's file to the merged path where that value is shown. */
export function layerToMergedPath(origins: Record<string, Origin>, layer: LayerName, path: Path): (string | number)[] {
  const reverse = new Map<string, string>();
  for (const [merged, origin] of Object.entries(origins)) {
    if (origin.layer === layer) reverse.set(pathKey(origin.path), merged);
  }
  for (let length = path.length; length > 0; length--) {
    const merged = reverse.get(pathKey(path.slice(0, length)));
    if (merged !== undefined) return [...parseKey(merged), ...path.slice(length)];
  }
  return [...path];
}

export interface ConfigValidation {
  /** Every issue, with paths in the merged configuration. */
  issues: Issue[];
  /** Errors that must be fixed before saving. */
  blocking: Issue[];
}

function crossIssues(merged: MergedConfig, flows: readonly string[]): Issue[] {
  try {
    return validateConfig(merged.config, { complete: true, flows });
  } catch (e) {
    return [{ severity: "error", path: [], message: `Validation failed: ${(e as Error).message}` }];
  }
}

/**
 * Schema errors of the working copy plus cross-field errors of the merged result. Errors that
 * already existed in other layers before editing are shown but do not block saving.
 */
export function validateWorking(
  snapshot: HarnessSnapshot,
  destination: Destination,
  working: WorkingConfig,
  merged: MergedConfig,
): ConfigValidation {
  const flows = snapshot.flows.filter((f) => !f.invalid).map((f) => f.name);
  const schema = validateWith(ConfigFile, { ...working, schema_version: 1 });
  const schemaIssues = schema.ok
    ? []
    : schema.issues.map((issue) => ({ ...issue, path: layerToMergedPath(merged.origins, destination, issue.path) }));
  const cross = crossIssues(merged, flows);

  const before = effectiveConfig(snapshot, destination, baselineOf(snapshot, destination));
  const blocking = [
    ...schemaIssues.filter((issue) => issue.severity === "error"),
    ...blockingErrors(destination, { merged, issues: cross }, { merged: before, issues: crossIssues(before, flows) }),
  ];
  return { issues: [...schemaIssues, ...cross], blocking };
}

type Keyed = Record<string, unknown>;

function listIn(draft: WorkingConfig, path: readonly string[]): Keyed[] {
  let holder = draft as Keyed;
  for (const segment of path.slice(0, -1)) {
    if (holder[segment] === null || typeof holder[segment] !== "object") holder[segment] = {};
    holder = holder[segment] as Keyed;
  }
  const last = path[path.length - 1]!;
  if (!Array.isArray(holder[last])) holder[last] = [];
  return holder[last] as Keyed[];
}

/**
 * Applies `mutate` to the destination's copy of a keyed entry (provider id, favorite ref, rule
 * name). An inherited entry is copied into the destination first, which then overrides it.
 */
export function editKeyedEntry<T extends object>(
  draft: WorkingConfig,
  listPath: readonly string[],
  keyField: string,
  entry: T,
  mutate: (entry: T) => void,
): void {
  const list = listIn(draft, listPath);
  const key = (entry as Keyed)[keyField];
  const at = list.findIndex((item) => item[keyField] === key);
  if (at >= 0) {
    mutate(list[at] as T);
    return;
  }
  const copy = clone(entry);
  mutate(copy);
  list.push(copy as Keyed);
}

export function removeKeyedEntry(draft: WorkingConfig, listPath: readonly string[], keyField: string, key: unknown): void {
  const list = listIn(draft, listPath);
  const at = list.findIndex((item) => item[keyField] === key);
  if (at >= 0) list.splice(at, 1);
}

export function addEntry(draft: WorkingConfig, listPath: readonly string[], entry: object): void {
  listIn(draft, listPath).push(clone(entry) as Keyed);
}

/** Keeps the findings `default` entry last in the destination file, where the merge expects it. */
export function keepFindingsDefaultLast(draft: WorkingConfig): void {
  const list = draft.findings_routing;
  if (!list) return;
  const defaults = list.filter(isFindingsDefault);
  draft.findings_routing = [...list.filter((entry) => !isFindingsDefault(entry)), ...defaults];
}

/**
 * Drag-and-drop reorder of an ordered list (router rules, findings rules) shown merged. The
 * destination's list takes the new relative order; a moved inherited entry is copied into it.
 */
export function reorderNamed<T extends { name: string }>(
  merged: readonly T[],
  layerList: readonly T[],
  from: number,
  to: number,
): T[] {
  const moved = merged[from];
  if (!moved || to < 0 || to >= merged.length || from === to) return [...layerList];
  const order = [...merged];
  order.splice(from, 1);
  order.splice(to, 0, moved);
  const owned = new Map(layerList.map((entry) => [entry.name, entry]));
  return order
    .filter((entry) => owned.has(entry.name) || entry.name === moved.name)
    .map((entry) => owned.get(entry.name) ?? clone(entry));
}
