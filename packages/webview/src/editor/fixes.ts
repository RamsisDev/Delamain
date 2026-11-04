import {
  blockOutputs,
  dependenciesOf,
  findBlock,
  walkBlocks,
  type Block,
  type BlockVisit,
  type Flow,
  type Issue,
  type LoopBlock,
  type ResolvedLimits,
  type WorstCase,
} from "@delamain/core";
import {
  disconnectBlocks,
  flowToGraph,
  removeNodes,
  renameBlock,
  setDependencies,
  uniqueBlockId,
  updateBlock,
  withField,
  type GraphEdge,
  type GraphNode,
} from "./flow-graph";
import { cycleMembers } from "./verify";

/** A one-click correction, applied to the editor's current nodes and the flow they draw. */
export interface Fix {
  label: string;
  apply: (nodes: readonly GraphNode[], flow: Flow) => GraphNode[];
}

/** What the verifier shows under one issue. */
export interface Advice {
  blockId?: string;
  /** Why it is a problem and the way out, in plain words. */
  hint?: string;
  fixes: Fix[];
}

export interface AdviceContext {
  flow: Flow;
  nodes: readonly GraphNode[];
  edges: readonly GraphEdge[];
  limits: ResolvedLimits;
  worst: WorstCase;
}

function nodeIdOf(nodes: readonly GraphNode[], blockId: string): string | undefined {
  return nodes.find((n) => n.data.block.id === blockId)?.id;
}

function names(ids: readonly string[]): string {
  return ids.length < 2 ? (ids[0] ?? "") : `${ids.slice(0, -1).join(", ")} and ${ids[ids.length - 1]}`;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

function onBlock(blockId: string, label: string, update: (nodes: readonly GraphNode[], nodeId: string) => GraphNode[]): Fix {
  return {
    label,
    apply: (nodes) => {
      const id = nodeIdOf(nodes, blockId);
      return id ? update(nodes, id) : [...nodes];
    },
  };
}

function editBlock(blockId: string, label: string, edit: (block: Block) => Block): Fix {
  return onBlock(blockId, label, (nodes, id) => updateBlock(nodes, id, edit));
}

/** The innermost block an issue path points into, with where it sits. */
function visitAt(flow: Flow, path: Issue["path"]): BlockVisit | undefined {
  let best: BlockVisit | undefined;
  walkBlocks(flow.steps, (visit) => {
    const inside = visit.path.length <= path.length && visit.path.every((segment, i) => String(segment) === String(path[i]));
    if (inside && (!best || visit.path.length > best.path.length)) best = visit;
  });
  return best;
}

/** Replaces `from` where it is a whole reference, not part of a longer name. */
export function replaceReference(text: string, from: string, to: string): string {
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`(?<![\\w.-])${escaped}(?![\\w-])`, "g"), to);
}

// A single `input` string is reported as input[0], so a string ends the walk wherever it is.
function mapText(value: unknown, path: readonly (string | number)[], edit: (text: string) => string): unknown {
  if (typeof value === "string") return edit(value);
  if (!path.length || value === null || typeof value !== "object") return value;
  const [head, ...rest] = path;
  if (Array.isArray(value)) return value.map((item, i) => (i === head ? mapText(item, rest, edit) : item));
  const record = value as Record<string, unknown>;
  return { ...record, [head!]: mapText(record[String(head)], rest, edit) };
}

function replaceSiblings(steps: Block[], parentPath: readonly (string | number)[], next: Block[]): Block[] {
  if (parentPath.length <= 1) return next;
  const index = parentPath[1];
  return steps.map((block, i) =>
    i === index && "body" in block ? ({ ...block, body: replaceSiblings(block.body, parentPath.slice(2), next) } as Block) : block,
  );
}

/**
 * Moves sibling blocks into a new Loop that repeats them until the last one passes. Arrows that
 * pointed back up the list are dropped, since the Loop is what repeats now; arrows from outside
 * go to the Loop, and blocks that waited for a member wait for the Loop.
 */
export function wrapInLoop(flow: Flow, memberIds: readonly string[], loopId: string, maxIterations: number): Flow {
  const first = memberIds[0] ? findBlock(flow.steps, memberIds[0]) : undefined;
  if (!first) return flow;
  const siblings = first.siblings;
  const members = new Set(memberIds);
  const order = new Map(siblings.map((b, i) => [b.id, i]));
  const deps = new Map(siblings.map((b, i) => [b.id, dependenciesOf(b, siblings, i)]));
  const inside = siblings.filter((b) => members.has(b.id));

  const body = inside.map((block, i) => {
    const forward = deps.get(block.id)!.filter((d) => members.has(d) && order.get(d)! < order.get(block.id)!);
    const { ui: _ui, after: _after, ...rest } = block;
    return (sameSet(forward, i > 0 ? [inside[i - 1]!.id] : []) ? rest : { ...rest, after: forward }) as Block;
  });
  const passing = [...inside].reverse().find((b) => blockOutputs(b)?.includes("passed"));
  const until = passing ? `${passing.id}.passed` : `${inside[inside.length - 1]!.id}.status == "succeeded"`;
  const loop = { id: loopId, type: "loop", max_iterations: maxIterations, until, body } as LoopBlock;

  const arranged: Block[] = [];
  siblings.forEach((block, i) => {
    if (i === order.get(inside[0]!.id)) arranged.push(loop);
    if (!members.has(block.id)) arranged.push(block);
  });
  const outside = [...new Set(inside.flatMap((b) => deps.get(b.id)!.filter((d) => !members.has(d))))];
  const next = arranged.map((block, i) => {
    const wanted = block === loop ? outside : [...new Set(deps.get(block.id)!.map((d) => (members.has(d) ? loopId : d)))];
    const implicit = i > 0 ? [arranged[i - 1]!.id] : [];
    return block.after === undefined && sameSet(wanted, implicit) ? block : ({ ...block, after: wanted } as Block);
  });
  return { ...flow, steps: replaceSiblings(flow.steps, first.path.slice(0, -1), next) };
}

/** Plain-language reason and one-click fixes for an issue of the flow verifier. */
export function adviseIssue(issue: Issue, ctx: AdviceContext): Advice {
  const visit = visitAt(ctx.flow, issue.path);
  const blockId = visit?.block.id;
  const field = visit ? issue.path.slice(visit.path.length) : [];
  const fixes: Fix[] = [];
  let hint: string | undefined;

  if (issue.replace && blockId) {
    const { from, to } = issue.replace;
    fixes.push(editBlock(blockId, `Use "${to}"`, (block) => mapText(block, field, (text) => replaceReference(text, from, to)) as Block));
  }

  switch (issue.check) {
    case "cycles": {
      const nodeId = blockId ? nodeIdOf(ctx.nodes, blockId) : undefined;
      const members = nodeId ? cycleMembers(ctx.edges, ctx.nodes, nodeId).sort((a, b) => a.data.order - b.data.order) : [];
      const ids = members.map((n) => n.data.block.id);
      if (ids.length < 2) break;
      hint = `${names(ids)} wait for each other, so ${ids.length === 2 ? "neither" : "none of them"} can ever start. Blocks only run again inside a Loop.`;
      const max = Math.min(3, ctx.limits.max_loop_iterations);
      fixes.push({
        label: `Repeat ${names(ids)} in a Loop`,
        apply: (nodes, flow) => flowToGraph(wrapInLoop(flow, ids, uniqueBlockId(nodes, "repeat"), max)).nodes,
      });
      const position = new Map(members.map((n) => [n.id, n.data.order]));
      for (const edge of ctx.edges) {
        if (!position.has(edge.source) || !position.has(edge.target) || position.get(edge.source)! < position.get(edge.target)!) continue;
        const source = ctx.nodes.find((n) => n.id === edge.source)!.data.block.id;
        const target = ctx.nodes.find((n) => n.id === edge.target)!.data.block.id;
        fixes.push({
          label: `Remove arrow ${source} → ${target}`,
          apply: (nodes) => {
            const from = nodeIdOf(nodes, source);
            const to = nodeIdOf(nodes, target);
            return from && to ? disconnectBlocks(nodes, from, to) : [...nodes];
          },
        });
      }
      break;
    }
    case "orphans": {
      if (!visit || !blockId) break;
      hint = `${blockId} does not wait for any block and no block waits for it, so it runs right at the start, next to everything else.`;
      const previous = visit.siblings[visit.index - 1];
      if (previous) fixes.push(onBlock(blockId, `Run after ${previous.id}`, (nodes, id) => setDependencies(nodes, id, undefined)));
      fixes.push(onBlock(blockId, `Delete ${blockId}`, (nodes, id) => removeNodes(nodes, [id])));
      break;
    }
    case "references":
      if (issue.message.startsWith("loop.*")) {
        hint = "loop.first and loop.iteration only exist inside a Loop: move the block into one, or take loop.* out of the condition.";
      } else if (issue.message.startsWith("Invalid expression")) {
        hint = "Conditions combine outputs with and, or, not and comparisons, for example: tests.passed and not bugbot.needs_qa";
      } else if (!issue.replace) {
        hint = "Conditions can read the outputs of the blocks in this flow, and loop, task, spec and session.";
      }
      break;
    case "subflows":
      if (issue.message.endsWith("is not marked as reusable")) {
        hint = "Only flows marked Reusable can run inside others: open that flow and tick Reusable in its toolbar, or pick one that already is.";
      } else if (issue.message.startsWith("No ")) {
        hint = "Pick a flow marked Reusable, or one from flows/, in the Flow field of the block.";
      } else {
        hint = "A flow that reuses itself, directly or through others, never ends. Reuse a different flow, or repeat the blocks with a Loop.";
      }
      break;
    case "caps": {
      if (field[0] === "max_iterations" && blockId) {
        const cap = ctx.limits.max_loop_iterations;
        hint = `Every Loop is capped at ${cap} iterations; raise Max loop iterations in Limits if you need more.`;
        fixes.push(editBlock(blockId, `Set max iterations to ${cap}`, (block) => withField(block, "max_iterations", cap)));
      } else {
        hint = `Loops can only be nested ${ctx.limits.max_nested_loops} deep: move this Loop out of its parent, or raise Max nested loops in Limits.`;
      }
      break;
    }
    case "worst-case": {
      const loops = ctx.worst.loops.map((l) => `${l.id} ×${l.max}`).join(", ");
      hint = `A task can run a worker up to ${ctx.worst.perModel} times per model because its loops multiply (${loops}). Lower the max iterations of one of them to bring it down.`;
      break;
    }
    default:
      if (!blockId || !visit) break;
      if (field[0] === "id" && issue.message.startsWith("Duplicate")) {
        hint = "Each block needs its own id: arrows and conditions find blocks by it.";
        fixes.push({
          label: `Rename to "${uniqueBlockId(ctx.nodes, blockId)}"`,
          apply: (nodes) => {
            const last = [...nodes].reverse().find((n) => n.data.block.id === blockId);
            return last ? renameBlock(nodes, last.id, uniqueBlockId(nodes, blockId)) : [...nodes];
          },
        });
      } else if (field[0] === "after" && typeof field[1] === "number") {
        const dep = visit.block.after?.[field[1]];
        if (dep === undefined) break;
        hint =
          dep === blockId
            ? "A block cannot wait for itself."
            : "Arrows only join blocks at the same level: a block inside a Loop or For each cannot wait for one outside it, or the other way round.";
        fixes.push(
          onBlock(blockId, `Stop waiting for ${dep}`, (nodes, id) => {
            const after = nodes.find((n) => n.id === id)?.data.block.after?.filter((d) => d !== dep);
            return setDependencies(nodes, id, after?.length ? after : undefined);
          }),
        );
      } else if (field[0] === "fallback") {
        hint = "A pinned model needs a backup for when it fails or hits its rate limit: add one in Fallback, or let the router choose.";
        fixes.push(editBlock(blockId, "Let the router pick the model", (block) => withField(withField(block, "model", undefined), "fallback", undefined)));
      } else if (field[0] === "agent") {
        hint = "Pick one of the agents of .harness/agents/ or the presets.";
      }
  }
  return { ...(blockId ? { blockId } : {}), ...(hint ? { hint } : {}), fixes };
}
