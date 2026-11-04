import { describe, expect, it } from "vitest";
import {
  blockingErrors,
  harnessLibrary,
  jsonSchemaFor,
  loadHarness,
  locate,
  mergeLayers,
  originOf,
  parseYaml,
  presetSources,
  resolveLimits,
  updateYamlText,
  validateConfig,
  validateFlow,
  validateSingleFile,
  type ConfigFile,
} from "../src/index.ts";

describe("presets", () => {
  it("load without errors", () => {
    const harness = loadHarness(presetSources());
    expect(harness.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect([...harness.flows.keys()].sort()).toEqual(["default", "local-only", "review-only", "single-agent"]);
    expect([...harness.agents.keys()].sort()).toEqual(["bugbot", "principal", "qa", "solo", "worker"]);
    expect(harness.config.router?.default?.use).toBe("role:orchestrator");
  });

  it("generate JSON Schemas for every file kind", () => {
    for (const kind of ["config", "flow", "agent", "decisions", "spec"] as const) {
      const schema = jsonSchemaFor(kind);
      expect(schema.$id).toContain(kind);
      expect(JSON.stringify(schema).length).toBeGreaterThan(200);
    }
  });
});

describe("layered merge", () => {
  const global: Partial<ConfigFile> = {
    providers: [{ id: "anthropic", type: "anthropic", profiles: [{ label: "Personal", secret: "a.p" }] }],
    models: [{ ref: "anthropic/claude", roles: ["orchestrator"] }],
    router: {
      thresholds: { short: { max_tokens: 4000, max_files: 2 } },
      rules: [
        { name: "A", when: { kind: "rename" }, use: "anthropic/claude", fallback: ["role:worker"] },
        { name: "B", when: { kind: "tests" }, use: "anthropic/claude", fallback: ["role:worker"] },
      ],
    },
    limits: { max_loop_iterations: 5, session: { max_minutes: 60 } },
    security: { destructive_patterns: ["rm -rf"] },
  };
  const project: Partial<ConfigFile> = {
    providers: [{ id: "anthropic", type: "anthropic", profiles: [{ label: "Work", secret: "a.w" }] }],
    router: { rules: [{ name: "B", when: { kind: "refactor" }, use: "anthropic/claude", fallback: ["role:qa"] }, { name: "C", when: { size: "short" }, use: "anthropic/claude", fallback: ["role:qa"] }] },
    limits: { session: { max_minutes: 30 } },
    security: { destructive_patterns: ["git push"] },
  };

  it("replaces single values, prepends ordered lists and unions sets", () => {
    const { config, origins } = mergeLayers([
      { name: "global", config: global },
      { name: "project", config: project },
    ]);
    expect(config.limits).toEqual({ max_loop_iterations: 5, session: { max_minutes: 30 } });
    expect(config.router?.rules?.map((r) => r.name)).toEqual(["B", "C", "A"]);
    expect(config.router?.rules?.[0]?.when).toEqual({ kind: "refactor" });
    expect(config.providers).toHaveLength(1);
    expect(config.providers?.[0]?.profiles?.[0]?.label).toBe("Work");
    expect(config.security?.destructive_patterns).toEqual(["rm -rf", "git push"]);
    expect(origins["limits.session.max_minutes"]?.layer).toBe("project");
    expect(origins["limits.max_loop_iterations"]?.layer).toBe("global");
    expect(originOf(origins, ["router", "rules", 2, "use"])).toEqual({ layer: "global", path: ["router", "rules", 0, "use"] });
    expect(originOf(origins, ["router", "rules", 1])).toEqual({ layer: "project", path: ["router", "rules", 1] });
  });
});

describe("validation", () => {
  it("reports schema errors with a path that maps to a text position", () => {
    const text = "schema_version: 1\nrouter:\n  rules:\n    - name: x\n      when: { size: tiny }\n      use: role:worker\n      fallback: []\n";
    const issues = validateSingleFile("config", { layer: "project", path: "config.yml", text });
    expect(issues.some((i) => i.path.join(".") === "router.rules.0.when.size")).toBe(true);
    expect(issues.some((i) => i.path.join(".") === "router.rules.0.fallback")).toBe(true);
    const parsed = parseYaml(text);
    const range = locate(parsed.doc, ["router", "rules", 0, "when", "size"]);
    expect(text.slice(range!.start, range!.end)).toBe("tiny");
  });

  it("rejects unknown keys and newer schema versions", () => {
    const unknown = validateSingleFile("config", { layer: "project", path: "c.yml", text: "schema_version: 1\nroutr: {}\n" });
    expect(unknown[0]?.message).toContain("Unknown key");
    const newer = validateSingleFile("config", { layer: "project", path: "c.yml", text: "schema_version: 9\n" });
    expect(newer[0]?.message).toContain("Update the extension");
  });

  it("checks cross-field rules on the merged config", () => {
    const sources = presetSources();
    sources.configs.push({
      layer: "project",
      path: "/repo/.harness/config.yml",
      text: [
        "schema_version: 1",
        "providers:",
        "  - { id: ollama, type: openai-compatible, base_url: 'http://localhost:11434/v1', local: true }",
        "  - { id: openrouter, type: openrouter }",
        "models:",
        "  - { ref: openrouter/deepseek/deepseek-chat, roles: [worker] }",
        "router:",
        "  rules:",
        "    - name: Private code stays local",
        "      when: { paths: ['src/secrets/**'] }",
        "      use: ollama/qwen",
        "      fallback: [openrouter/deepseek/deepseek-chat]",
        "      stay_local: true",
        "    - name: Unknown provider",
        "      when: { kind: rename }",
        "      use: nope/model",
        "      fallback: [role:worker]",
      ].join("\n"),
    });
    const harness = loadHarness(sources);
    const errors = harness.issues.filter((i) => i.severity === "error");
    expect(errors.some((i) => i.message.includes("stay_local") && i.file === "/repo/.harness/config.yml")).toBe(true);
    expect(errors.some((i) => i.message.includes('Unknown provider "nope"') && i.path.join(".") === "router.rules.1.use")).toBe(true);
  });

  it("lets orchestrations reuse the ones marked reusable, but not in a circle", () => {
    const sources = presetSources();
    const flow = (name: string, target: string) => ({
      layer: "project" as const,
      path: `/repo/.harness/workflows/${name}.yml`,
      text: `schema_version: 1\nname: ${name}\nreusable: true\nsteps:\n  - { id: run, type: subflow, flow: ${target} }\n`,
    });
    sources.workflows.push(flow("lint", "flows/verify.yml"), flow("release", "lint"), flow("legacy", "single-agent"), flow("ping", "pong"), flow("pong", "ping"));
    const harness = loadHarness(sources);
    expect(harness.flows.has("release")).toBe(true);
    expect(harness.invalidFlows.has("legacy")).toBe(true);
    expect(harness.issues.some((i) => i.message === '"single-agent" is not marked as reusable')).toBe(true);
    expect(harness.invalidFlows.has("ping")).toBe(true);
    expect(harness.invalidFlows.has("pong")).toBe(true);
    expect(harnessLibrary(harness).resolve("lint")?.name).toBe("lint");
    expect(harnessLibrary(harness).resolve("single-agent")).toBeUndefined();
    expect(harnessLibrary(harness).resolve("flows/verify.yml")?.name).toBe("verify");
    expect(harnessLibrary(harness).resolve("ping")).toBeUndefined();
  });

  it("only blocks a save on errors the saved layer owns or introduces", () => {
    const preset = loadHarness(presetSources()).configFiles[0]!.value;
    const project: Partial<ConfigFile> = { providers: [{ id: "lan", type: "openai-compatible" }] };
    const check = (global: Partial<ConfigFile>, projectLayer = project) => {
      const merged = mergeLayers([
        { name: "preset", config: preset },
        { name: "global", config: global },
        { name: "project", config: projectLayer },
      ]);
      return { merged, issues: validateConfig(merged.config, { complete: true }) };
    };
    const before = check({});
    expect(before.issues.some((i) => i.message.includes("need a base_url"))).toBe(true);

    expect(blockingErrors("global", check({ limits: { worst_case_warning: 40 } }), before)).toEqual([]);
    expect(blockingErrors("project", before, before).map((i) => i.message)).toContain("openai-compatible providers need a base_url");

    const introduced = blockingErrors("global", check({ providers: [{ id: "lan2", type: "openai-compatible" }] }), before);
    expect(introduced).toHaveLength(1);
    expect(introduced[0]!.message).toContain("need a base_url");
  });

  it("warns about keys, prices and disabled providers the router cannot use", () => {
    const issues = validateConfig({
      providers: [
        { id: "anthropic", type: "anthropic" },
        { id: "openrouter", type: "openrouter", profiles: [{ label: "Personal", secret: "or.p" }] },
        { id: "old", type: "deepseek", enabled: false, profiles: [{ label: "Personal", secret: "ds.p" }] },
      ],
      models: [{ ref: "anthropic/claude" }, { ref: "openrouter/deepseek/deepseek-chat" }, { ref: "old/deepseek-chat", pricing: { input_per_mtok: 1, output_per_mtok: 2 } }],
    });
    const at = (path: string) => issues.filter((i) => i.path.join(".") === path).map((i) => i.message);
    expect(at("providers.0.profiles")).toEqual(["anthropic needs an API key: add a credential profile"]);
    expect(at("models.0.pricing")[0]).toContain("No pricing");
    expect(at("models.1.pricing")).toEqual([]);
    expect(at("models.2.ref")).toEqual(['Provider "old" is disabled; the router skips this model']);
  });

  it("rejects remote models pinned on stay_local blocks and warns about remote role members", () => {
    const config = {
      providers: [
        { id: "jan", type: "openai-compatible" as const, base_url: "http://localhost:1337/v1", local: true },
        { id: "openrouter", type: "openrouter" as const },
      ],
      models: [
        { ref: "jan/qwen", roles: ["worker" as const] },
        { ref: "openrouter/deepseek", roles: ["worker" as const] },
      ],
    };
    const flow = {
      schema_version: 1 as const,
      name: "private",
      steps: [
        { id: "a", type: "agent" as const, agent: "worker", model: "openrouter/deepseek", fallback: ["role:worker"], stay_local: true },
        { id: "b", type: "agent" as const, agent: "worker", stay_local: true },
      ],
    };
    const issues = validateFlow(flow, { limits: resolveLimits(undefined), config });
    const at = (path: string) => issues.filter((i) => i.path.join(".") === path).map((i) => `${i.severity}: ${i.message}`);
    expect(at("steps.0.model")).toEqual(['error: stay_local only allows local providers; "openrouter/deepseek" is not on a local provider']);
    expect(at("steps.0.fallback.0")).toEqual(['warning: stay_local skips "openrouter/deepseek" from role:worker: not on a local provider']);
    expect(at("steps.1.stay_local")).toEqual(["warning: stay_local only applies to a pinned model; set one on this block"]);
  });
});

describe("lossless YAML round trip", () => {
  it("keeps comments and order of untouched parts", () => {
    const original = [
      "schema_version: 1",
      "# Routing rules",
      "router:",
      "  rules:",
      "    # cheap first",
      "    - name: A",
      "      when: { kind: rename }",
      "      use: role:worker",
      "      fallback: [role:qa]",
      "    - name: B # tests",
      "      when: { kind: tests }",
      "      use: role:worker",
      "      fallback: [role:qa]",
      "",
    ].join("\n");
    const value = parseYaml(original).value as { router: { rules: { name: string; use: string }[] } };
    value.router.rules.reverse();
    value.router.rules[0]!.use = "role:qa";
    const updated = updateYamlText(original, value);
    expect(updated).toContain("# Routing rules");
    expect(updated).toContain("# cheap first");
    expect(updated).toContain("# tests");
    expect(updated.indexOf("name: B")).toBeLessThan(updated.indexOf("name: A"));
    expect(parseYaml(updated).value).toEqual(value);
    expect(updateYamlText(updated, parseYaml(updated).value)).toBe(updated);
  });
});
