import { describe, expect, it } from "vitest";
import { Flow, flowLibrary, parseYaml, resolveLimits, worstCase, type Issue } from "@delamain/core";
import { adviseIssue, replaceReference, wrapInLoop } from "../src/editor/fixes";
import { deriveEdges, flowToGraph, graphToFlow, type GraphNode } from "../src/editor/flow-graph";
import { validateDraft } from "../src/editor/validation";

const limits = resolveLimits(undefined);

function parseFlow(yaml: string): Flow {
  return Flow.parse(parseYaml(yaml).value) as Flow;
}

const broken = parseFlow(`
schema_version: 1
name: broken
steps:
  - { id: plan, type: agent, agent: principal, output: spec }
  - { id: build, type: command, run: make build, after: [verify] }
  - { id: verify, type: command, run: make test, after: [build] }
  - { id: notes, type: command, run: echo notes, after: [] }
  - { id: ship, type: command, run: make ship, after: [build], when: "verify.passd" }
`);

/** Validates a flow the way the editor does and applies the first fix whose label matches. */
function editor(flow: Flow, library = flowLibrary(new Map(), new Map())) {
  const nodes: GraphNode[] = flowToGraph(flow).nodes;
  const edges = deriveEdges(nodes);
  const issues = validateDraft(flow, limits, library);
  const ctx = { flow, nodes, edges, limits, worst: worstCase(flow, { library }) };
  const find = (fragment: string) => issues.find((i) => i.message.includes(fragment))!;
  const advice = (issue: Issue) => adviseIssue(issue, ctx);
  const apply = (fragment: string, label: string) => {
    const fix = advice(find(fragment)).fixes.find((f) => f.label === label);
    if (!fix) throw new Error(`no fix "${label}": ${advice(find(fragment)).fixes.map((f) => f.label).join(", ")}`);
    const next = fix.apply(nodes, flow);
    return graphToFlow({ nodes: next, edges: deriveEdges(next) }, { ...flow, steps: [] });
  };
  return { issues, find, advice, apply };
}

const messages = (flow: Flow) => validateDraft(flow, limits).map((i) => i.message);

describe("verifier advice", () => {
  it("explains a cycle and offers to repeat it in a Loop or drop the arrow back", () => {
    const { find, advice } = editor(broken);
    const cycle = advice(find("Cycle"));
    expect(cycle.hint).toBe("build and verify wait for each other, so neither can ever start. Blocks only run again inside a Loop.");
    expect(cycle.fixes.map((f) => f.label)).toEqual(["Repeat build and verify in a Loop", "Remove arrow verify → build"]);
  });

  it("repeats the cycle in a Loop and keeps every other dependency", () => {
    const fixed = editor(broken).apply("Cycle", "Repeat build and verify in a Loop");
    const [plan, loop, notes, ship] = fixed.steps;
    expect([plan!.id, loop!.id, notes!.id, ship!.id]).toEqual(["plan", "repeat", "notes", "ship"]);
    expect(loop).toMatchObject({ type: "loop", max_iterations: 3, until: "verify.passed", after: [] });
    expect((loop as { body: { id: string; after?: string[] }[] }).body.map((b) => [b.id, b.after])).toEqual([
      ["build", undefined],
      ["verify", undefined],
    ]);
    expect(ship!.after).toEqual(["repeat"]);
    expect(messages(fixed).some((m) => m.startsWith("Cycle"))).toBe(false);
  });

  it("removes the arrow that closes the cycle", () => {
    const fixed = editor(broken).apply("Cycle", "Remove arrow verify → build");
    expect(fixed.steps[1]!.after).toEqual([]);
    expect(messages(fixed).some((m) => m.startsWith("Cycle"))).toBe(false);
  });

  it("corrects a misspelt output in place", () => {
    const fixed = editor(broken).apply('no output "passd"', 'Use "verify.passed"');
    expect(fixed.steps[4]!.when).toBe("verify.passed");
  });

  it("connects or deletes a loose block", () => {
    const { find, advice, apply } = editor(broken);
    expect(advice(find("not connected")).fixes.map((f) => f.label)).toEqual(["Run after verify", "Delete notes"]);
    expect(apply("not connected", "Run after verify").steps[3]!.after).toBeUndefined();
    expect(apply("not connected", "Delete notes").steps.map((s) => s.id)).not.toContain("notes");
  });

  it("caps a loop, renames a duplicate and lets the router pick a pinned model", () => {
    const flow = parseFlow(`
schema_version: 1
name: misc
steps:
  - { id: retry, type: loop, max_iterations: 9, until: tests.passed, body: [{ id: tests, type: command, run: make test }] }
  - { id: tests, type: command, run: make lint }
  - { id: code, type: agent, agent: worker, model: openai/gpt }
`);
    const { apply } = editor(flow);
    expect((apply("exceeds the global cap", `Set max iterations to ${limits.max_loop_iterations}`).steps[0] as { max_iterations: number }).max_iterations).toBe(
      limits.max_loop_iterations,
    );
    expect(apply("Duplicate block id", 'Rename to "tests-2"').steps[1]!.id).toBe("tests-2");
    expect(apply("backup model", "Let the router pick the model").steps[2]).not.toHaveProperty("model");
  });

  it("points a subflow at the flow it probably meant", () => {
    const library = flowLibrary(new Map(), new Map([["build", { ...broken, reusable: true }]]));
    const flow = parseFlow("schema_version: 1\nname: ship\nsteps:\n  - { id: run, type: subflow, flow: biuld }\n");
    const fixed = editor(flow, library).apply("biuld", 'Use "build"');
    expect(fixed.steps[0]).toMatchObject({ type: "subflow", flow: "build" });
  });

  it("explains that an orchestration has to be marked reusable first", () => {
    const library = flowLibrary(new Map(), new Map([["build", broken]]));
    const flow = parseFlow("schema_version: 1\nname: ship\nsteps:\n  - { id: run, type: subflow, flow: build }\n");
    const { find, advice } = editor(flow, library);
    expect(advice(find("not marked as reusable")).hint).toContain("tick Reusable in its toolbar");
  });
});

describe("fix helpers", () => {
  it("replaces whole references only", () => {
    expect(replaceReference("tests.passd and not my-tests.passd", "tests.passd", "tests.passed")).toBe("tests.passed and not my-tests.passd");
  });

  it("wraps blocks inside a container in a Loop of their own", () => {
    const flow = parseFlow(`
schema_version: 1
name: nested
steps:
  - id: outer
    type: loop
    max_iterations: 2
    until: b.passed
    body:
      - { id: a, type: command, run: echo a, after: [b] }
      - { id: b, type: command, run: echo b, after: [a] }
`);
    const fixed = wrapInLoop(flow, ["a", "b"], "inner", 2);
    const outer = fixed.steps[0] as { body: { id: string; type: string; body?: { id: string }[] }[] };
    expect(outer.body.map((b) => b.id)).toEqual(["inner"]);
    expect(outer.body[0]!.body!.map((b) => b.id)).toEqual(["a", "b"]);
  });
});
