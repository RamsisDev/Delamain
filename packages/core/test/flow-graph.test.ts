import { describe, expect, it } from "vitest";
import {
  Flow,
  evaluateBoolean,
  flowLibrary,
  loadHarness,
  parseExpression,
  parseYaml,
  presetSources,
  references,
  resolveLimits,
  validateFlow,
  worstCase,
} from "../src/index.ts";

const harness = loadHarness(presetSources());
const limits = resolveLimits(harness.config.limits);

function flowFrom(yaml: string) {
  return Flow.parse(parseYaml(yaml).value);
}

describe("expressions", () => {
  it("evaluates paths, boolean operators and comparisons", () => {
    const scope = (path: readonly string[]) =>
      ({ "loop.first": false, "bugbot.needs_qa": true, "tests.exit_code": 0, "final-checks.passed": true } as Record<string, unknown>)[path.join(".")];
    expect(evaluateBoolean("loop.first or bugbot.needs_qa", scope)).toBe(true);
    expect(evaluateBoolean("not bugbot.needs_qa", scope)).toBe(false);
    expect(evaluateBoolean("tests.exit_code == 0 and final-checks.passed", scope)).toBe(true);
    expect(references(parseExpression("a.b and (c or not d.e)"))).toEqual([["a", "b"], ["c"], ["d", "e"]]);
    expect(() => parseExpression("a and")).toThrow();
  });
});

describe("flow validation", () => {
  it("computes the default flow's worst case: 2 x 2 x 3 x 3 = 36", () => {
    const flow = harness.flows.get("default")!.flow;
    const worst = worstCase(flow, { agents: harness.agents, chainLength: 3 });
    expect(worst.perModel).toBe(36);
    expect(worst.total).toBe(108);
    expect(worst.loops.map((l) => l.id)).toEqual(["delivery-loop", "bugbot-loop", "qa-loop", "test-loop"]);
    const issues = validateFlow(flow, { limits, agents: harness.agents });
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(issues.some((i) => i.message.startsWith("Worst case: 36"))).toBe(true);
  });

  it("rejects references to missing outputs, cycles outside loops and loops above the cap", () => {
    const flow = flowFrom(`
schema_version: 1
name: broken
steps:
  - id: a
    type: command
    run: echo a
    after: [b]
  - id: b
    type: command
    run: echo b
    after: [a]
  - id: c
    type: loop
    max_iterations: 9
    until: tests.passd
    body:
      - id: tests
        type: command
        run: make test
  - id: d
    type: agent
    agent: worker
    model: openai/gpt
    when: "nothing.here"
`);
    const issues = validateFlow(flow, { limits, agents: harness.agents });
    const checkOf = (fragment: string) => issues.find((i) => i.message.includes(fragment))?.check;
    expect(checkOf("Cycle")).toBe("cycles");
    expect(checkOf('has no output "passd"')).toBe("references");
    expect(checkOf("exceeds the global cap of 5")).toBe("caps");
    expect(checkOf('Unknown block or variable "nothing"')).toBe("references");
    expect(checkOf("needs at least one backup model")).toBe("structure");
    expect(issues.every((i) => i.check !== undefined)).toBe(true);
    expect(issues.find((i) => i.message.includes('has no output "passd"'))?.replace).toEqual({ from: "tests.passd", to: "tests.passed" });
  });
});

describe("reused flows", () => {
  const build = flowFrom("schema_version: 1\nname: build\nreusable: true\nsteps:\n  - { id: code, type: agent, agent: worker }\n");
  const reusing = (name: string, target: string) =>
    flowFrom(
      `schema_version: 1\nname: ${name}\nreusable: true\nsteps:\n  - { id: retry, type: loop, max_iterations: 3, until: run.passed, body: [{ id: run, type: subflow, flow: ${target} }] }\n`,
    );

  it("only reuses orchestrations marked reusable", () => {
    const plain = flowFrom("schema_version: 1\nname: plain\nsteps:\n  - { id: code, type: agent, agent: worker }\n");
    const library = flowLibrary(new Map(), new Map([["plain", plain], ["build", build]]));
    expect(library.resolve("plain")).toBeUndefined();
    expect(library.resolve("build")).toBe(build);
    const issues = validateFlow(reusing("ship", "plain"), { limits, library }).filter((i) => i.check === "subflows");
    expect(issues.map((i) => i.message)).toEqual(['"plain" is not marked as reusable']);
  });

  it("reports a missing flow with the closest name", () => {
    const library = flowLibrary(new Map(), new Map([["build", build]]));
    const issues = validateFlow(reusing("ship", "biuld"), { limits, library });
    const missing = issues.find((i) => i.check === "subflows")!;
    expect(missing.message).toContain('No reusable flow named "biuld". Did you mean "build"?');
    expect(missing.path).toEqual(["steps", 0, "body", 0, "flow"]);
    expect(missing.replace).toEqual({ from: "biuld", to: "build" });
  });

  it("rejects flows that reuse each other in a circle", () => {
    const a = reusing("a", "b");
    const library = flowLibrary(new Map(), new Map([["a", a], ["b", reusing("b", "a")]]));
    const messages = validateFlow(a, { limits, library }).filter((i) => i.check === "subflows").map((i) => i.message);
    expect(messages).toEqual(["Flows reuse each other in a circle and would never finish: a → b → a"]);
  });

  it("counts the loops of a reused flow in the worst case", () => {
    const library = flowLibrary(new Map([["flows/build.yml", reusing("inner", "none")]]), new Map());
    const outer = reusing("outer", "flows/build.yml");
    const withWorker = flowLibrary(new Map(), new Map([["build", build]]));
    expect(worstCase(reusing("outer", "build"), { library: withWorker }).perModel).toBe(3);
    expect(worstCase(outer, { library }).perModel).toBe(0);
    const nested = flowLibrary(new Map(), new Map([["mid", reusing("mid", "build")], ["build", build]]));
    const worst = worstCase(reusing("outer", "mid"), { library: nested });
    expect(worst.perModel).toBe(9);
    expect(worst.loops).toEqual([{ id: "retry", max: 3 }, { id: "retry", max: 3, via: "run" }]);
  });
});
