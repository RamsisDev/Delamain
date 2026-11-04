import { describe, expect, it } from "vitest";
import {
  advanceChain,
  buildCatalog,
  computeSize,
  lookupModel,
  route,
  usageCost,
  type HarnessConfig,
  type RouteRequest,
  type RouterState,
} from "../src/index.ts";

const config: HarnessConfig = {
  providers: [
    { id: "anthropic", type: "anthropic", profiles: [{ label: "Personal", secret: "a.p" }, { label: "Work", secret: "a.w" }], active_profile: "Personal" },
    { id: "openrouter", type: "openrouter", profiles: [{ label: "Personal", secret: "or.p" }] },
    { id: "openai", type: "openai", profiles: [{ label: "Personal", secret: "oa.p" }] },
    { id: "jan", type: "openai-compatible", base_url: "http://localhost:1337/v1", local: true },
    { id: "ollama", type: "openai-compatible", base_url: "http://localhost:11434/v1", local: true },
  ],
  models: [
    { ref: "anthropic/claude", label: "Claude", roles: ["orchestrator"], context_window: 200000, pricing: { input_per_mtok: 3, output_per_mtok: 15 } },
    { ref: "anthropic/claude@Work", label: "Claude (Work)", roles: ["orchestrator-fallback"], context_window: 200000 },
    { ref: "openrouter/anthropic/claude", label: "Claude (OpenRouter)", roles: ["orchestrator-fallback"], context_window: 200000 },
    { ref: "openrouter/deepseek/deepseek-chat", label: "DeepSeek", roles: ["worker"], context_window: 64000, pricing: { input_per_mtok: 0.27, output_per_mtok: 1.1 } },
    { ref: "openai/gpt", label: "GPT", roles: ["qa"], context_window: 128000 },
    { ref: "jan/qwen2.5-coder-7b", label: "Local Qwen", roles: ["short-tasks"], context_window: 8192, tool_calling: false },
    { ref: "ollama/qwen2.5-coder-14b", label: "Ollama Qwen", context_window: 32000, tool_calling: true },
  ],
  router: {
    thresholds: { short: { max_tokens: 4000, max_files: 2 }, medium: { max_tokens: 30000, max_files: 8 } },
    rules: [
      { name: "Short tasks stay local", when: { size: "short", kind: ["rename", "docstring", "format", "small-edit"] }, use: "jan/qwen2.5-coder-7b", fallback: ["openrouter/deepseek/deepseek-chat"] },
      { name: "Private code stays local", when: { paths: ["src/secrets/**"] }, use: "role:short-tasks", fallback: ["ollama/qwen2.5-coder-14b"], stay_local: true },
      { name: "Tests and refactors", when: { kind: ["tests", "refactor"], size: ["short", "medium"] }, use: "role:worker", fallback: ["anthropic/claude"] },
    ],
    default: { use: "role:orchestrator", fallback: ["role:orchestrator-fallback"] },
  },
};

const catalog = buildCatalog(config);
const lookup = (ref: string) => lookupModel(catalog, ref)!;
const healthy: RouterState = { now: 1000, providers: {} };
const request = (over: Partial<RouteRequest>): RouteRequest => ({
  role: "worker",
  est_tokens: 2000,
  files: 1,
  paths: ["src/a.ts"],
  needs_tools: true,
  accepts_diff_mode: true,
  ...over,
});

describe("size thresholds", () => {
  it("classifies by tokens and files", () => {
    expect(computeSize(3000, 2, config.router?.thresholds)).toBe("short");
    expect(computeSize(3000, 3, config.router?.thresholds)).toBe("medium");
    expect(computeSize(40000, 1, config.router?.thresholds)).toBe("large");
  });
});

describe("rules", () => {
  it("first match wins and the principal's model closes the chain", () => {
    const decision = route(request({ kind: "rename" }), config, catalog, healthy);
    expect(decision.rule).toBe("Short tasks stay local");
    expect(decision.chosen?.ref).toBe("jan/qwen2.5-coder-7b");
    expect(decision.chain.map((l) => l.ref)).toEqual(["jan/qwen2.5-coder-7b", "openrouter/deepseek/deepseek-chat", "anthropic/claude"]);
    expect(decision.evaluations[0]).toEqual({ rule: "Short tasks stay local", matched: true });
  });

  it("stay_local chains never append the principal", () => {
    const decision = route(request({ kind: "feature", paths: ["src/secrets/keys.ts"], est_tokens: 6000 }), config, catalog, healthy);
    expect(decision.rule).toBe("Private code stays local");
    expect(decision.chain.map((l) => l.ref)).toEqual(["jan/qwen2.5-coder-7b", "ollama/qwen2.5-coder-14b"]);
    expect(decision.stayLocal).toBe(true);
  });

  it("falls to the default route and explains which condition failed", () => {
    const decision = route(request({ kind: "rename", est_tokens: 20000, files: 4 }), config, catalog, healthy);
    expect(decision.rule).toBe("default");
    expect(decision.chosen?.ref).toBe("anthropic/claude");
    expect(decision.evaluations.find((e) => e.rule === "Short tasks stay local")?.failed).toBe("size");
    expect(decision.evaluations.find((e) => e.rule === "Tests and refactors")?.failed).toBe("kind");
  });

  it("a cli reviewer such as Codex passes the tool filter: it brings its own tools", () => {
    const withCodex: HarnessConfig = {
      ...config,
      providers: [...config.providers!, { id: "codex", type: "cli", command: "codex exec" }],
      models: [...config.models!, { ref: "codex/default", label: "Codex CLI", roles: ["reviewer"], tool_calling: false }],
    };
    const decision = route(request({ role: "reviewer", accepts_diff_mode: false }), withCodex, buildCatalog(withCodex), healthy);
    expect(decision.chosen?.ref).toBe("codex/default");
  });

  it("QA prefers qa favorites and avoids the worker's model", () => {
    const decision = route(request({ role: "qa", avoid: ["openai/gpt"] }), config, catalog, healthy);
    expect(decision.chain[0]?.ref).toBe("openai/gpt");
    expect(decision.chosen?.ref).not.toBe("openai/gpt");
  });
});

describe("pre-filter", () => {
  it("drops offline, rate-limited, small-context, tool-less and too-expensive models", () => {
    const state: RouterState = { now: 1000, providers: { jan: { status: "offline" } } };
    const decision = route(request({ kind: "rename" }), config, catalog, state);
    expect(decision.chosen?.ref).toBe("openrouter/deepseek/deepseek-chat");
    expect(decision.skipped[0]).toEqual({ ref: "jan/qwen2.5-coder-7b", reason: "provider offline" });

    const limited = route(request({ kind: "rename" }), config, catalog, {
      now: 1000,
      providers: { jan: { status: "rate_limited", untilMs: 31000 } },
    });
    expect(limited.skipped[0]?.reason).toContain("rate limited for 30 s");

    const noTools = route(request({ kind: "rename", accepts_diff_mode: false }), config, catalog, healthy);
    expect(noTools.skipped[0]?.reason).toBe("no tool calling");

    const big = route(request({ kind: "tests", est_tokens: 25000, files: 3 }), config, catalog, healthy);
    expect(big.chosen?.ref).toBe("openrouter/deepseek/deepseek-chat");
    const private_ = route(request({ kind: "feature", paths: ["src/secrets/a.ts"], est_tokens: 7000 }), config, catalog, healthy);
    expect(private_.skipped[0]).toEqual({ ref: "jan/qwen2.5-coder-7b", reason: "context window 8192 < 9000 tokens needed" });
    expect(private_.chosen?.ref).toBe("ollama/qwen2.5-coder-14b");

    const capped = route(request({ kind: "feature", est_tokens: 20000, files: 4, max_cost: 0.01 }), config, catalog, healthy);
    expect(capped.skipped.some((s) => s.ref === "anthropic/claude" && s.reason.includes("max_cost"))).toBe(true);
  });

  it("retries an offline provider once its cooldown ends", () => {
    const down = (now: number): RouterState => ({ now, providers: { jan: { status: "offline", untilMs: 2000 } } });
    expect(route(request({ kind: "rename" }), config, catalog, down(1000)).skipped[0]).toEqual({ ref: "jan/qwen2.5-coder-7b", reason: "provider offline, retried in 1 s" });
    expect(route(request({ kind: "rename" }), config, catalog, down(2500)).chosen?.ref).toBe("jan/qwen2.5-coder-7b");
  });

  it("skips profiles that cannot authenticate", () => {
    const state: RouterState = { now: 1000, providers: {}, credentialProblems: new Map([["anthropic@Personal", "no API key stored"]]) };
    const decision = route(request({ kind: "feature", est_tokens: 20000, files: 4 }), config, catalog, state);
    expect(decision.skipped[0]).toEqual({ ref: "anthropic/claude", reason: "no API key stored" });
    expect(decision.chosen?.ref).toBe("anthropic/claude@Work");
  });
});

describe("cost", () => {
  it("prices cached input at the cached rate and leaves unknown prices undefined", () => {
    const model = { ...catalog.favorites[0]!, pricing: { input_per_mtok: 3, output_per_mtok: 15, cached_per_mtok: 0.3 } };
    expect(usageCost(model, { input: 1_000_000, output: 0, cached: 500_000 })).toBeCloseTo(1.65);
    expect(usageCost({ ...model, pricing: { input_per_mtok: 3, output_per_mtok: 15 } }, { input: 1_000_000, output: 0, cached: 500_000 })).toBeCloseTo(3);
    expect(usageCost(lookup("openai/gpt"), { input: 1000, output: 1000 })).toBeUndefined();
    expect(usageCost(lookup("jan/qwen2.5-coder-7b"), { input: 1000, output: 1000 })).toBe(0);
  });
});

describe("model chain", () => {
  it("on a rate limit skips other profiles of the same provider", () => {
    const decision = route(request({ kind: "feature", est_tokens: 20000, files: 4 }), config, catalog, healthy);
    expect(decision.chain.map((l) => l.ref)).toEqual(["anthropic/claude", "anthropic/claude@Work", "openrouter/anthropic/claude"]);
    const next = advanceChain(decision, 0, "rate_limit", request({}), catalog, healthy);
    expect(decision.chain[next!]?.ref).toBe("openrouter/anthropic/claude");
  });

  it("on budget exhaustion may use the same model on another profile", () => {
    const decision = route(request({ kind: "feature", est_tokens: 20000, files: 4 }), config, catalog, healthy);
    const next = advanceChain(decision, 0, "budget", request({}), catalog, healthy);
    expect(decision.chain[next!]?.ref).toBe("anthropic/claude@Work");
  });

  it("on context errors only moves to larger windows, and the chain is finite", () => {
    const decision = route(request({ kind: "rename" }), config, catalog, healthy);
    const next = advanceChain(decision, 0, "context_length", request({}), catalog, healthy);
    expect(decision.chain[next!]?.ref).toBe("openrouter/deepseek/deepseek-chat");
    expect(advanceChain(decision, decision.chain.length - 1, "loop_exhausted", request({}), catalog, healthy)).toBeUndefined();
  });

  it("a rejected key may use another profile; a missing model is skipped under every profile", () => {
    const decision = route(request({ kind: "feature", est_tokens: 20000, files: 4 }), config, catalog, healthy);
    expect(decision.chain[advanceChain(decision, 0, "auth", request({}), catalog, healthy)!]?.ref).toBe("anthropic/claude@Work");
    expect(decision.chain[advanceChain(decision, 0, "not_found", request({}), catalog, healthy)!]?.ref).toBe("openrouter/anthropic/claude");
  });

  it("is a pure function", () => {
    const a = route(request({ kind: "tests" }), config, catalog, healthy);
    const b = route(request({ kind: "tests" }), config, catalog, healthy);
    expect(a).toEqual(b);
  });
});
