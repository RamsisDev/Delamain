import { describe, expect, it } from "vitest";
import { Flow, PRESET_FLOWS, parseYaml, walkBlocks, type Block, type LoopBlock } from "@delamain/core";
import {
  addBlockNode,
  blockIdAtPath,
  connectBlocks,
  containerAt,
  deriveEdges,
  disconnectBlocks,
  flowToGraph,
  graphOf,
  graphToFlow,
  markMoved,
  markResized,
  removeNodes,
  renameBlock,
  setEdgeWhen,
  type GraphNode,
} from "../src/editor/flow-graph";
import { defaultBlock } from "../src/editor/block-defaults";

function parseFlow(yaml: string): Flow {
  return Flow.parse(parseYaml(yaml).value) as Flow;
}

function nodeOf(nodes: readonly GraphNode[], blockId: string): GraphNode {
  const node = nodes.find((n) => n.data.block.id === blockId);
  if (!node) throw new Error(`no node for ${blockId}`);
  return node;
}

function blockOf(flow: Flow, id: string): Block {
  let found: Block | undefined;
  walkBlocks(flow.steps, ({ block }) => {
    if (block.id === id) found = block;
  });
  if (!found) throw new Error(`no block ${id}`);
  return found;
}

// The core index re-exports the presets as PRESET_FLOWS; `default` is DEFAULT_FLOW.
const flow = parseFlow(PRESET_FLOWS.default!);

describe("flowToGraph / graphToFlow", () => {
  it("round-trips the shipped default flow losslessly", () => {
    const graph = flowToGraph(flow);
    const back = graphToFlow(graph, flow);
    expect(back).toStrictEqual(flow);
    expect(JSON.stringify(back)).toBe(JSON.stringify(flow));
  });

  it("round-trips every preset flow", () => {
    for (const yaml of Object.values(PRESET_FLOWS)) {
      const preset = parseFlow(yaml);
      expect(graphToFlow(flowToGraph(preset), preset)).toStrictEqual(preset);
    }
  });

  it("keeps unknown fields of blocks and of the flow", () => {
    const custom = {
      ...flow,
      x_owner: "team-a",
      steps: [{ ...flow.steps[0]!, x_note: { keep: [1, 2] } } as unknown as Block, ...flow.steps.slice(1)],
    } as Flow;
    expect(graphToFlow(flowToGraph(custom), custom)).toStrictEqual(custom);
  });

  it("does not add ui to blocks nobody moved, and auto-lays them out", () => {
    const graph = flowToGraph(flow);
    const back = graphToFlow(graph, flow);
    walkBlocks(back.steps, ({ block }) => expect(block.ui).toBeUndefined());
    const code = nodeOf(graph.nodes, "code");
    const tests = nodeOf(graph.nodes, "tests");
    expect(tests.position.y).toBeGreaterThan(code.position.y);
  });

  it("puts container bodies inside their container nodes and maps them back", () => {
    const graph = flowToGraph(flow);
    const testLoop = nodeOf(graph.nodes, "test-loop");
    expect(nodeOf(graph.nodes, "code").parentId).toBe(testLoop.id);
    expect(nodeOf(graph.nodes, "tests").parentId).toBe(testLoop.id);
    expect(nodeOf(graph.nodes, "qa").parentId).toBe(nodeOf(graph.nodes, "qa-loop").id);
    expect(nodeOf(graph.nodes, "delivery-loop").parentId).toBeUndefined();
    expect(testLoop.type).toBe("container");
    const parentIndex = graph.nodes.findIndex((n) => n.id === testLoop.id);
    expect(graph.nodes.findIndex((n) => n.data.block.id === "code")).toBeGreaterThan(parentIndex);

    const nodes = addBlockNode(graph.nodes, defaultBlock("command", "lint"), testLoop.id, { x: 20, y: 200 });
    const back = graphToFlow(graphOf(nodes), flow);
    const loop = blockOf(back, "test-loop") as LoopBlock;
    expect(loop.body.map((b) => b.id)).toEqual(["code", "tests", "lint"]);
    expect(loop.body[2]!.ui).toEqual({ x: 20, y: 200 });
    expect(back.steps.map((b) => b.id)).toEqual(["delivery-loop", "approve"]);
  });

  it("draws implicit edges for blocks without after and never writes them back", () => {
    const graph = flowToGraph(flow);
    const code = nodeOf(graph.nodes, "code");
    const tests = nodeOf(graph.nodes, "tests");
    const implicit = graph.edges.find((e) => e.source === code.id && e.target === tests.id);
    expect(implicit?.data).toEqual({ implicit: true, when: "success" });
    const explicit = graph.edges.find((e) => e.target === nodeOf(graph.nodes, "approve").id);
    expect(explicit?.data?.implicit).toBe(false);
    expect(blockOf(graphToFlow(graph, flow), "tests").after).toBeUndefined();
  });

  it("sets ui only on the node that was moved", () => {
    const graph = flowToGraph(flow);
    const qa = nodeOf(graph.nodes, "qa");
    const moved = markMoved(
      graph.nodes.map((n) => (n.id === qa.id ? { ...n, position: { x: 140.4, y: 333.6 } } : n)),
      [qa.id],
    );
    const back = graphToFlow({ nodes: moved, edges: graph.edges }, flow);
    expect(blockOf(back, "qa").ui).toEqual({ x: 140, y: 334 });
    walkBlocks(back.steps, ({ block }) => {
      if (block.id !== "qa") expect(block.ui).toBeUndefined();
    });
  });

  it("writes width and height of a resized container", () => {
    const graph = flowToGraph(flow);
    const loop = nodeOf(graph.nodes, "test-loop");
    const nodes = markResized(
      graph.nodes.map((n) => (n.id === loop.id ? { ...n, width: 500, height: 400 } : n)),
      [loop.id],
    );
    expect(blockOf(graphToFlow(graphOf(nodes), flow), "test-loop").ui).toEqual({
      x: loop.position.x,
      y: loop.position.y,
      width: 500,
      height: 400,
    });
  });

  it("editing an edge's condition updates only the target block's when", () => {
    const graph = flowToGraph(flow);
    const qa = nodeOf(graph.nodes, "qa");
    const edge = graph.edges.find((e) => e.target === qa.id)!;
    const nodes = setEdgeWhen(graph.nodes, edge, "failure");
    const back = graphToFlow({ nodes, edges: deriveEdges(nodes) }, flow);

    const expected = structuredClone(flow);
    (blockOf(expected, "qa") as { when?: string }).when = "failure";
    expect(back).toStrictEqual(expected);
    expect(deriveEdges(nodes).find((e) => e.target === qa.id)?.data?.when).toBe("failure");

    const cleared = setEdgeWhen(nodes, edge, undefined);
    expect(graphToFlow(graphOf(cleared), flow)).toStrictEqual(flow);
  });

  it("materializes after when the user changes connections", () => {
    const graph = flowToGraph(flow);
    const code = nodeOf(graph.nodes, "code");
    const tests = nodeOf(graph.nodes, "tests");
    const removed = disconnectBlocks(graph.nodes, code.id, tests.id);
    expect(blockOf(graphToFlow(graphOf(removed), flow), "tests").after).toEqual([]);

    const spec = nodeOf(graph.nodes, "spec");
    const checks = nodeOf(graph.nodes, "final-checks");
    const connected = connectBlocks(graph.nodes, spec.id, checks.id);
    expect(blockOf(graphToFlow(graphOf(connected), flow), "final-checks").after).toEqual(["build", "spec"]);

    expect(connectBlocks(graph.nodes, code.id, checks.id)).toStrictEqual(graph.nodes);
  });

  it("reconciles edges drawn directly on the graph", () => {
    const graph = flowToGraph(flow);
    const spec = nodeOf(graph.nodes, "spec");
    const final = nodeOf(graph.nodes, "final");
    const edges = [...graph.edges, { id: "extra", source: spec.id, target: final.id }];
    expect(blockOf(graphToFlow({ nodes: graph.nodes, edges }, flow), "final").after).toEqual(["final-checks", "spec"]);
  });

  it("removes nodes with their bodies and cleans sibling references", () => {
    const graph = flowToGraph(flow);
    const nodes = removeNodes(graph.nodes, [nodeOf(graph.nodes, "build").id]);
    expect(nodes.some((n) => n.data.block.id === "code")).toBe(false);
    const back = graphToFlow(graphOf(nodes), flow);
    const delivery = back.steps[0] as LoopBlock;
    expect(delivery.body.map((b) => b.id)).toEqual(["spec", "final-checks", "final"]);
    expect(blockOf(back, "final-checks").after).toEqual([]);
  });

  it("renames a block and the after lists that reference it", () => {
    const graph = flowToGraph(flow);
    const nodes = renameBlock(graph.nodes, nodeOf(graph.nodes, "final-checks").id, "checks");
    const back = graphToFlow(graphOf(nodes), flow);
    expect(blockOf(back, "checks").type).toBe("command");
    expect(blockOf(back, "final").after).toEqual(["checks"]);
  });

  it("finds the innermost container under a point and the block of an issue path", () => {
    const graph = flowToGraph(flow);
    const code = nodeOf(graph.nodes, "code");
    let x = 0;
    let y = 0;
    for (let n: GraphNode | undefined = code; n; n = graph.nodes.find((p) => p.id === n!.parentId)) {
      x += n.position.x;
      y += n.position.y;
    }
    expect(containerAt(graph.nodes, { x: x + 5, y: y + 5 })).toBe(nodeOf(graph.nodes, "test-loop").id);
    expect(containerAt(graph.nodes, { x: -500, y: -500 })).toBeUndefined();

    expect(blockIdAtPath(flow, ["steps", 0, "body", 1, "body", 0, "until"])).toBe("bugbot-loop");
    expect(blockIdAtPath(flow, ["steps", 1, "after", 0])).toBe("approve");
    expect(blockIdAtPath(flow, ["steps"])).toBeUndefined();
  });
});
