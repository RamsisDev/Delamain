import { describe, expect, it } from "vitest";
import { Flow, PRESET_FLOWS, parseYaml, resolveLimits, worstCase } from "@delamain/core";
import { edgeId, flowToGraph, type GraphNode } from "../src/editor/flow-graph";
import { validateDraft } from "../src/editor/validation";
import { focusNodes, verifyFlow } from "../src/editor/verify";

const limits = resolveLimits(undefined);

function parseFlow(yaml: string): Flow {
  return Flow.parse(parseYaml(yaml).value) as Flow;
}

function verify(flow: Flow) {
  const graph = flowToGraph(flow);
  const checks = verifyFlow(flow, validateDraft(flow, limits), graph, worstCase(flow), limits);
  const node = (blockId: string) => graph.nodes.find((n) => n.data.block.id === blockId)!.id;
  return { graph, node, check: (id: string) => checks.find((c) => c.id === id)!, checks };
}

const broken = parseFlow(`
schema_version: 1
name: broken
steps:
  - { id: a, type: command, run: echo a, after: [b] }
  - { id: b, type: command, run: echo b, after: [a] }
  - { id: c, type: command, run: echo c, after: [] }
  - { id: d, type: command, run: echo d, after: [a], when: "nothing.here" }
`);

describe("flow verifier", () => {
  it("passes every check on a clean flow", () => {
    const { checks } = verify(parseFlow("schema_version: 1\nname: ok\nsteps:\n  - { id: a, type: command, run: echo a }\n  - { id: b, type: command, run: echo b }"));
    expect(checks.map((c) => [c.id, c.status])).toEqual([
      ["cycles", "pass"],
      ["orphans", "pass"],
      ["references", "pass"],
      ["subflows", "pass"],
      ["caps", "pass"],
      ["worst-case", "pass"],
      ["structure", "pass"],
    ]);
  });

  it("highlights the arrows of a cycle, but not the ones leaving it", () => {
    const { check, node } = verify(broken);
    const cycles = check("cycles");
    expect(cycles.status).toBe("error");
    expect(cycles.edges.sort()).toEqual([edgeId(node("a"), node("b")), edgeId(node("b"), node("a"))].sort());
    expect(cycles.nodes).toEqual(expect.arrayContaining([node("a"), node("b")]));
    expect(cycles.nodes).not.toContain(node("d"));
  });

  it("points an arrow condition at the arrows into its block", () => {
    const { check, node } = verify(broken);
    const references = check("references");
    expect(references.status).toBe("error");
    expect(references.nodes).toEqual([node("d")]);
    expect(references.edges).toEqual([edgeId(node("a"), node("d"))]);
  });

  it("reports orphans as a warning on the loose block", () => {
    const { check, node } = verify(broken);
    expect(check("orphans").status).toBe("warning");
    expect(check("orphans").nodes).toEqual([node("c")]);
  });

  it("shows the loops behind the worst case", () => {
    const { check, node } = verify(parseFlow(PRESET_FLOWS.default!));
    const worst = check("worst-case");
    expect(worst.status).toBe("warning");
    expect(worst.detail).toBe(`36 / ${limits.worst_case_warning}`);
    expect(worst.nodes.sort()).toEqual(["delivery-loop", "bugbot-loop", "qa-loop", "test-loop"].map(node).sort());
  });

  it("fades everything but the highlighted nodes and the containers around them", () => {
    const { graph, node } = verify(parseFlow(PRESET_FLOWS.default!));
    const shown = focusNodes(graph.nodes, new Set([node("code")]));
    const data = (blockId: string) => shown.find((n: GraphNode) => n.id === node(blockId))!.data;
    expect(data("code").focus).toBe(true);
    expect(data("test-loop").dimmed).toBeUndefined();
    expect(data("delivery-loop").dimmed).toBeUndefined();
    expect(data("tests").dimmed).toBe(true);
    expect(data("approve").dimmed).toBe(true);
  });
});
