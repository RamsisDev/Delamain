import { createContext, useContext } from "react";
import type { DryRunReport, HarnessConfig, HarnessSnapshot, Health, Issue, LayerName, ModelInfo, Origin } from "@delamain/core";
import type { Path } from "../util/deep";
import { issuesAt, issuesUnder } from "../util/issues";
import { canEditFrom, effectiveConfig, ownerOf, validateWorking, type ConfigValidation, type Destination, type WorkingConfig } from "./layers";

export interface ProbeResult {
  toolCalling: boolean | undefined;
  contextWindow?: number;
  message?: string;
}

export interface SavedResult {
  ok: boolean;
  issues: Issue[];
  path?: string;
  at: number;
}

export interface ConfigModel {
  snapshot: HarnessSnapshot;
  destination: Destination;
  working: WorkingConfig;
  /** Effective configuration: every layer merged with the working copy in place. */
  merged: HarnessConfig;
  origins: Record<string, Origin>;
  /** Issues with paths in the merged configuration. */
  issues: Issue[];
  health: Record<string, Health>;
  catalogs: Record<string, ModelInfo[]>;
  probes: Record<string, ProbeResult>;
  dryrun: DryRunReport | undefined;
  saved: SavedResult | undefined;
  /** Mutates a clone of the working copy. */
  edit: (mutate: (draft: WorkingConfig) => void) => void;
  owner: (path: Path) => LayerName | undefined;
  /** False when a layer above the destination defines the value. */
  editable: (path: Path) => boolean;
  issuesAt: (path: Path) => Issue[];
  issuesUnder: (path: Path) => Issue[];
}

export interface LiveState {
  health: Record<string, Health>;
  catalogs: Record<string, ModelInfo[]>;
  probes: Record<string, ProbeResult>;
  dryrun: DryRunReport | undefined;
  saved: SavedResult | undefined;
}

/** Everything the tabs read, derived from the snapshot and the working copy. */
export function createConfigModel(
  snapshot: HarnessSnapshot,
  destination: Destination,
  working: WorkingConfig,
  live: LiveState,
  edit: ConfigModel["edit"],
): { model: ConfigModel; validation: ConfigValidation } {
  const merged = effectiveConfig(snapshot, destination, working);
  const validation = validateWorking(snapshot, destination, working, merged);
  const model: ConfigModel = {
    snapshot,
    destination,
    working,
    merged: merged.config,
    origins: merged.origins,
    issues: validation.issues,
    health: { ...snapshot.health, ...live.health },
    catalogs: { ...snapshot.catalogs, ...live.catalogs },
    probes: live.probes,
    dryrun: live.dryrun,
    saved: live.saved,
    edit,
    owner: (path) => ownerOf(merged.origins, path),
    editable: (path) => canEditFrom(ownerOf(merged.origins, path), destination),
    issuesAt: (path) => issuesAt(validation.issues, path),
    issuesUnder: (path) => issuesUnder(validation.issues, path),
  };
  return { model, validation };
}

export const ConfigContext = createContext<ConfigModel | null>(null);

export function useConfig(): ConfigModel {
  const model = useContext(ConfigContext);
  if (!model) throw new Error("useConfig must be used inside the configuration panel");
  return model;
}
