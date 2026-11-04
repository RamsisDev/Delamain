import type { HarnessSources, SourceFile } from "../config/load.ts";
import { PRESET_AGENTS } from "./agents.ts";
import { PRESET_CONFIG_YAML } from "./config.ts";
import { PRESET_FLOWS, PRESET_SUBFLOWS } from "./flows.ts";
import { DECISIONS_REFERENCE } from "./reference.ts";

export * from "./reference.ts";
export * from "./agents.ts";
export * from "./config.ts";
export * from "./flows.ts";

export const PRESET_ROOT = "preset:";

/** The preset layer as files, the same shape as the global and project folders. */
export function presetSources(): HarnessSources {
  const file = (path: string, text: string): SourceFile => ({ layer: "preset", path: `${PRESET_ROOT}${path}`, text });
  return {
    configs: [file("config.yml", PRESET_CONFIG_YAML)],
    agents: Object.entries(PRESET_AGENTS).map(([name, text]) => file(`agents/${name}.md`, text)),
    workflows: Object.entries(PRESET_FLOWS).map(([name, text]) => file(`workflows/${name}.yml`, text)),
    subflows: Object.entries(PRESET_SUBFLOWS).map(([name, text]) => file(`flows/${name}.yml`, text)),
    decisions: [],
  };
}

/** Relative paths and contents written by "Harness: Customize". */
export function presetFiles(): { path: string; text: string }[] {
  return [
    { path: "config.yml", text: PRESET_CONFIG_YAML },
    { path: "decisions/_REFERENCE.md", text: DECISIONS_REFERENCE },
    ...Object.entries(PRESET_AGENTS).map(([name, text]) => ({ path: `agents/${name}.md`, text })),
    ...Object.entries(PRESET_FLOWS).map(([name, text]) => ({ path: `workflows/${name}.yml`, text })),
    ...Object.entries(PRESET_SUBFLOWS).map(([name, text]) => ({ path: `flows/${name}.yml`, text })),
  ];
}

export function mergeSources(...layers: HarnessSources[]): HarnessSources {
  return {
    configs: layers.flatMap((l) => l.configs),
    agents: layers.flatMap((l) => l.agents),
    workflows: layers.flatMap((l) => l.workflows),
    subflows: layers.flatMap((l) => l.subflows),
    decisions: layers.flatMap((l) => l.decisions),
  };
}
