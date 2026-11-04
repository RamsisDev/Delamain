import {
  ConfigFile,
  Flow,
  PRESET_CONFIG_YAML,
  PRESET_FLOWS,
  PRESET_SUBFLOWS,
  mergeLayers,
  parseYaml,
  type HarnessSnapshot,
} from "@delamain/core";
import type { WorkingConfig } from "../src/config/layers";

export const preset = ConfigFile.parse(parseYaml(PRESET_CONFIG_YAML).value);

export function presetFlow(name: string): Flow {
  return Flow.parse(parseYaml(PRESET_FLOWS[name]!).value) as Flow;
}

export const globalLayer: WorkingConfig = {
  schema_version: 1,
  providers: [
    { id: "anthropic", type: "anthropic", profiles: [{ label: "Personal", secret: "anthropic.personal" }] },
    { id: "openrouter", type: "openrouter", headers: { "X-Title": "Harness" } },
    { id: "jan", type: "openai-compatible", base_url: "http://localhost:1337/v1", local: true },
  ],
  models: [
    { ref: "anthropic/claude", label: "Claude", roles: ["orchestrator"] },
    { ref: "openrouter/deepseek/deepseek-chat", roles: ["worker", "orchestrator-fallback"] },
    { ref: "jan/qwen", roles: ["short-tasks"], context_window: 8192, tool_calling: false },
  ],
  router: {
    rules: [{ name: "Docs", when: { kind: "docstring" }, use: "role:worker", fallback: ["anthropic/claude"] }],
  },
};

export function snapshotWith(global: WorkingConfig, project?: WorkingConfig): HarnessSnapshot {
  const layers: HarnessSnapshot["layers"] = { preset, global, ...(project ? { project } : {}) };
  const merged = mergeLayers([
    { name: "preset", config: preset },
    { name: "global", config: global },
    ...(project ? [{ name: "project" as const, config: project }] : []),
  ]);
  return {
    layers,
    layerPaths: { global: "/home/me/.harness/config.yml" },
    merged: merged.config,
    origins: merged.origins,
    flows: Object.keys(PRESET_FLOWS).map((name) => ({
      name,
      layer: "preset" as const,
      path: `preset:workflows/${name}.yml`,
      flow: presetFlow(name),
    })),
    subflows: Object.entries(PRESET_SUBFLOWS).map(([name, text]) => ({ ref: `flows/${name}.yml`, name, flow: Flow.parse(parseYaml(text).value) as Flow })),
    agents: [
      { name: "principal", role: "principal" },
      { name: "worker", role: "worker" },
    ],
    issues: [],
    secrets: { "anthropic.personal": true },
    health: { anthropic: { status: "online", latencyMs: 120 } },
    catalogs: { openrouter: [{ id: "deepseek/deepseek-chat", contextWindow: 64000, toolCalling: true }, { id: "qwen/qwen3", label: "Qwen 3" }] },
    discovered: [{ id: "ollama", label: "Ollama", base_url: "http://localhost:11434/v1", models: ["qwen2.5-coder"] }],
    trusted: true,
    hasProject: project !== undefined,
  };
}
