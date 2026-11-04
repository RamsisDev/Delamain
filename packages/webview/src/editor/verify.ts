import { FLOW_CHECKS, type Flow, type FlowCheck, type Issue, type ResolvedLimits, type WorstCase } from "@delamain/core";
import { blockIdAtPath, pathOfBlock, type GraphEdge, type GraphNode } from "./flow-graph";

export type CheckStatus = "pass" | "warning" | "error";

export interface CheckResult {
  id: FlowCheck;
  label: string;
  status: CheckStatus;
  /** Short figure shown next to the label, e.g. the worst case. */
  detail: string;
  issues: Issue[];
  /** Canvas node and edge ids the check points at. */
  nodes: string[];
  edges: string[];
}

const LABELS: Record<FlowCheck, string> = {
  cycles: "Cycles only inside a Loop",
  orphans: "No orphan blocks",
  references: "Conditions point to existing outputs",
  subflows: "Reused flows exist and never call themselves",
  caps: "Global caps are respected",
  "worst-case": "Worst case under the warning",
  structure: "Blocks and links are well formed",
};

function checkOf(issue: Issue): FlowCheck {
  return (FLOW_CHECKS as readonly string[]).includes(issue.check ?? "") ? (issue.check as FlowCheck) : "structure";
}

function statusOf(issues: readonly Issue[]): CheckStatus {
  if (issues.some((i) => i.severity === "error")) return "error";
  return issues.length ? "warning" : "pass";
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function reachability(edges: readonly GraphEdge[]): (from: string, to: string) => boolean {
  const next = new Map<string, string[]>();
  for (const e of edges) next.set(e.source, [...(next.get(e.source) ?? []), e.target]);
  return (from, to) => {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length) {
      const id = stack.pop()!;
      if (id === to) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...(next.get(id) ?? []));
    }
    return false;
  };
}

/** Edges on a dependency cycle: their target leads back to their source. */
export function cycleEdges(edges: readonly GraphEdge[]): GraphEdge[] {
  const reaches = reachability(edges);
  return edges.filter((e) => reaches(e.target, e.source));
}

/** Nodes on a cycle through `nodeId`, the node included; empty when it is on none. */
export function cycleMembers(edges: readonly GraphEdge[], nodes: readonly GraphNode[], nodeId: string): GraphNode[] {
  const reaches = reachability(edges);
  if (!edges.some((e) => e.source === nodeId && reaches(e.target, nodeId))) return [];
  return nodes.filter((n) => n.id === nodeId || (reaches(nodeId, n.id) && reaches(n.id, nodeId)));
}

/**
 * Files the validation issues under the plan's live-validation rules and works out what each
 * rule points at on the canvas, so the editor can show a checklist and highlight a rule.
 */
export function verifyFlow(
  flow: Flow,
  issues: readonly Issue[],
  graph: { nodes: readonly GraphNode[]; edges: readonly GraphEdge[] },
  worst: WorstCase,
  limits: ResolvedLimits,
): CheckResult[] {
  const nodesOf = (blockId: string) => graph.nodes.filter((n) => n.data.block.id === blockId).map((n) => n.id);
  // A block's `when` is drawn as the label of the arrows into it.
  const isArrowCondition = (issue: Issue, blockId: string) => {
    const path = pathOfBlock(flow, blockId);
    return path !== undefined && issue.path.length === path.length + 1 && issue.path[path.length] === "when";
  };

  return FLOW_CHECKS.map((id) => {
    const own = issues.filter((issue) => checkOf(issue) === id);
    const nodes = new Set<string>();
    const edges = new Set<string>();
    for (const issue of own) {
      const blockId = blockIdAtPath(flow, issue.path);
      if (!blockId) continue;
      const targets = nodesOf(blockId);
      for (const node of targets) nodes.add(node);
      if (id === "references" && isArrowCondition(issue, blockId)) {
        for (const e of graph.edges) if (targets.includes(e.target)) edges.add(e.id);
      }
    }
    if (id === "cycles") {
      for (const e of cycleEdges(graph.edges)) {
        edges.add(e.id);
        nodes.add(e.source);
        nodes.add(e.target);
      }
    }
    if (id === "worst-case") for (const loop of worst.loops) for (const node of nodesOf(loop.via ?? loop.id)) nodes.add(node);

    const errors = own.filter((i) => i.severity === "error").length;
    const warnings = own.length - errors;
    let detail = [errors ? plural(errors, "error") : "", warnings ? plural(warnings, "warning") : ""].filter(Boolean).join(", ");
    if (id === "worst-case") detail = `${worst.perModel} / ${limits.worst_case_warning}`;
    if (id === "caps" && !own.length) detail = `≤ ${limits.max_loop_iterations} iterations, ≤ ${limits.max_nested_loops} nested`;
    return { id, label: LABELS[id], status: statusOf(own), detail, issues: own, nodes: [...nodes], edges: [...edges] };
  });
}

/** Marks the highlighted nodes and fades the rest, except the containers around them. */
export function focusNodes<N extends GraphNode>(nodes: readonly N[], lit: ReadonlySet<string>): N[] {
  const parents = new Map(nodes.map((n) => [n.id, n.parentId]));
  const around = new Set<string>();
  for (const id of lit) for (let p = parents.get(id); p; p = parents.get(p)) around.add(p);
  return nodes.map((n) => {
    if (lit.has(n.id)) return { ...n, data: { ...n.data, focus: true } };
    return around.has(n.id) ? n : { ...n, data: { ...n.data, dimmed: true } };
  });
}
