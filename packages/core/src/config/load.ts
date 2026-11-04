import type { AgentDefinition } from "../schema/agent.ts";
import { ConfigFile, type HarnessConfig } from "../schema/config.ts";
import { DecisionsFile, type Decision } from "../schema/escalation.ts";
import { Flow } from "../schema/flow.ts";
import { resolveLimits } from "../schema/limits.ts";
import { migrate, type MigrationResult } from "../schema/versions.ts";
import { flowLibrary, validateFlow, type FlowLibrary } from "../flow/graph.ts";
import type { Issue } from "../util/issues.ts";
import { error } from "../util/issues.ts";
import { parseAgentFile } from "./agent-file.ts";
import { mergeLayers, originOf, type LayerName, type Origin } from "./merge.ts";
import { validateConfig } from "./validate.ts";
import { parseYaml } from "./yaml.ts";
import { validateWith } from "./zod-issues.ts";
import type { SchemaKind } from "../schema/json-schema.ts";

export interface SourceFile {
  layer: LayerName;
  /** Path for messages and diagnostics; preset files use a virtual path. */
  path: string;
  text: string;
}

export interface LoadedFile<T> {
  layer: LayerName;
  path: string;
  value?: T;
  issues: Issue[];
  migratedFrom?: number;
  /** The migrated content, to write back next to a .bak copy. */
  migrated?: Record<string, unknown>;
}

export interface FlowEntry {
  flow: Flow;
  layer: LayerName;
  path: string;
}

export interface ResolvedHarness {
  config: HarnessConfig;
  origins: Record<string, Origin>;
  configFiles: LoadedFile<ConfigFile>[];
  agents: Map<string, AgentDefinition>;
  flows: Map<string, FlowEntry>;
  /** Flows that parse but fail validation: editable to fix them, never run. */
  invalidFlows: Map<string, FlowEntry>;
  /** Reusable subflows by relative path (flows/<name>.yml) and by name. */
  subflows: Map<string, Flow>;
  decisions: Decision[];
  /** Every issue, attributed to its file. */
  issues: Issue[];
}

export interface HarnessSources {
  configs: SourceFile[];
  agents: SourceFile[];
  workflows: SourceFile[];
  subflows: SourceFile[];
  decisions: SourceFile[];
}

export function loadYamlFile<T>(kind: SchemaKind, source: SourceFile, schema: { safeParse(v: unknown): unknown }): LoadedFile<T> {
  const parsed = parseYaml(source.text);
  const base = { layer: source.layer, path: source.path };
  const syntax = parsed.issues.filter((i) => i.severity === "error");
  if (syntax.length) return { ...base, issues: parsed.issues.map((i) => ({ ...i, file: source.path })) };
  const migrated: MigrationResult = migrate(kind, parsed.value ?? {});
  if (!migrated.ok) return { ...base, issues: [{ ...error(["schema_version"], migrated.message), file: source.path }] };
  const result = validateWith(schema as never, migrated.value) as { ok: true; value: T } | { ok: false; issues: Issue[] };
  if (!result.ok) return { ...base, issues: result.issues.map((i) => ({ ...i, file: source.path })) };
  return {
    ...base,
    value: result.value,
    issues: [],
    ...(migrated.migratedFrom !== undefined ? { migratedFrom: migrated.migratedFrom, migrated: migrated.value } : {}),
  };
}

const LAYER_ORDER: Record<LayerName, number> = { preset: 0, global: 1, project: 2, session: 3 };

function byLayer<T extends { layer: LayerName }>(items: T[]): T[] {
  return [...items].sort((a, b) => LAYER_ORDER[a.layer] - LAYER_ORDER[b.layer]);
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop()!.replace(/\.(ya?ml|md)$/, "");
}

/** Loads every layer: invalid files are reported and skipped, never half-applied. */
export function loadHarness(sources: HarnessSources): ResolvedHarness {
  const issues: Issue[] = [];
  const configFiles = byLayer(sources.configs).map((source) => loadYamlFile<ConfigFile>("config", source, ConfigFile));
  for (const file of configFiles) issues.push(...file.issues);
  const merged = mergeLayers(configFiles.filter((f) => f.value).map((f) => ({ name: f.layer, config: f.value, source: f.path })));
  const pathOf = new Map(configFiles.map((f) => [f.layer, f.path]));

  const agents = new Map<string, AgentDefinition>();
  for (const source of byLayer(sources.agents)) {
    const parsed = parseAgentFile(source.text, source.path);
    issues.push(...parsed.issues.map((i) => ({ ...i, file: source.path })));
    if (parsed.agent) agents.set(parsed.agent.name, parsed.agent);
  }

  const subflows = new Map<string, Flow>();
  for (const source of byLayer(sources.subflows)) {
    const file = loadYamlFile<Flow>("flow", source, Flow);
    issues.push(...file.issues);
    if (file.value) {
      subflows.set(`flows/${baseName(source.path)}.yml`, file.value);
      subflows.set(file.value.name, file.value);
    }
  }

  const limits = resolveLimits(merged.config.limits);
  const workflows = byLayer(sources.workflows).map((source) => ({ source, file: loadYamlFile<Flow>("flow", source, Flow) }));
  const library = flowLibrary(subflows, new Map(workflows.flatMap(({ file }) => (file.value ? [[file.value.name, file.value]] : []))));
  const flows = new Map<string, FlowEntry>();
  const invalidFlows = new Map<string, FlowEntry>();
  for (const { source, file } of workflows) {
    issues.push(...file.issues);
    if (!file.value) continue;
    const flowIssues = validateFlow(file.value, { limits, agents, library, config: merged.config });
    issues.push(...flowIssues.map((i) => ({ ...i, file: source.path })));
    const entry = { flow: file.value, layer: source.layer, path: source.path };
    if (flowIssues.some((i) => i.severity === "error")) {
      invalidFlows.set(file.value.name, entry);
    } else {
      flows.set(file.value.name, entry);
      invalidFlows.delete(file.value.name);
    }
  }

  const semantic = validateConfig(merged.config, { complete: true, flows: [...flows.keys()] });
  for (const issue of semantic) {
    const origin = originOf(merged.origins, issue.path);
    const file = origin ? pathOf.get(origin.layer) : undefined;
    issues.push({ ...issue, path: origin?.path ?? issue.path, ...(file ? { file } : {}) });
  }

  const decisions: Decision[] = [];
  for (const source of sources.decisions) {
    const file = loadYamlFile<DecisionsFile>("decisions", source, DecisionsFile);
    issues.push(...file.issues);
    if (file.value) decisions.push(...file.value.decisions);
  }

  return { config: merged.config, origins: merged.origins, configFiles, agents, flows, invalidFlows, subflows, decisions, issues };
}

/**
 * The flows subflow blocks can reuse. Invalid orchestrations are included only when asked, to
 * check cycles while editing; they never run.
 */
export function harnessLibrary(harness: Pick<ResolvedHarness, "subflows" | "flows" | "invalidFlows">, { includeInvalid = false } = {}): FlowLibrary {
  const entries = [...(includeInvalid ? harness.invalidFlows : []), ...harness.flows].map(([name, entry]) => [name, entry.flow] as const);
  return flowLibrary(harness.subflows, new Map(entries));
}

/** Validates one file on its own, for editor diagnostics while typing. */
export function validateSingleFile(kind: SchemaKind | "agent-md", source: SourceFile, context?: ResolvedHarness): Issue[] {
  if (kind === "agent-md") {
    return parseAgentFile(source.text, source.path).issues.map((i) => ({ ...i, file: source.path }));
  }
  if (kind === "flow") {
    const file = loadYamlFile<Flow>("flow", source, Flow);
    if (!file.value) return file.issues;
    const limits = resolveLimits(context?.config.limits);
    const known = context ? { agents: context.agents, library: harnessLibrary(context, { includeInvalid: true }), config: context.config } : {};
    return validateFlow(file.value, { limits, ...known }).map((i) => ({ ...i, file: source.path }));
  }
  if (kind === "decisions") return loadYamlFile("decisions", source, DecisionsFile).issues;
  if (kind === "config") {
    const file = loadYamlFile<ConfigFile>("config", source, ConfigFile);
    if (!file.value || !context) return file.issues;
    const others = context.configFiles.filter((f) => f.layer !== source.layer && f.value);
    const merged = mergeLayers(
      byLayer([...others.map((f) => ({ layer: f.layer, value: f.value })), { layer: source.layer, value: file.value }]).map((f) => ({ name: f.layer, config: f.value })),
    );
    return validateConfig(merged.config, { complete: true, flows: [...context.flows.keys()] })
      .map((issue) => ({ issue, origin: originOf(merged.origins, issue.path) }))
      .filter(({ origin }) => origin?.layer === source.layer)
      .map(({ issue, origin }) => ({ ...issue, path: origin!.path, file: source.path }));
  }
  return [];
}
