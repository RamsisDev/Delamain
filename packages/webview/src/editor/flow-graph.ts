import {
  dependenciesOf,
  isContainer,
  walkBlocks,
  type Block,
  type Flow,
  type IssuePath,
  type StepStatus,
} from "@delamain/core";
import { unique } from "../util/deep";

/*
 * Pure conversion between a Flow and the node/edge graph drawn by React Flow. No DOM or React
 * here: the same functions back the block editor, the chat's graph view and the unit tests.
 */

export const NODE_WIDTH = 220;
export const NODE_HEIGHT = 60;
export const CONTAINER_PADDING = 20;
export const CONTAINER_HEADER = 52;
export const NODE_GAP = 40;

export type BlockNodeData = {
  /** The block as written, unknown fields included. Containers keep `body: []` as a placeholder. */
  block: Block;
  /** Index among its siblings; the YAML order. */
  order: number;
  /** Set once the user drags the node; only then is `ui` written back. */
  moved?: boolean;
  resized?: boolean;
  status?: StepStatus;
  severity?: "error" | "warning";
  /** Highlighted or faded by the verifier's selected check. */
  focus?: boolean;
  dimmed?: boolean;
  readOnly?: boolean;
};

export interface GraphNode {
  id: string;
  type?: string;
  position: { x: number; y: number };
  data: BlockNodeData;
  parentId?: string;
  width?: number;
  height?: number;
  measured?: { width?: number; height?: number };
}

export type FlowNode = GraphNode & { type: "block" | "container"; extent?: "parent" };

export type EdgeData = {
  /** The dependency comes from the YAML default (previous sibling), not from an `after`. */
  implicit: boolean;
  /** The target block's `when`, shown as the edge label. */
  when: string;
};

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  data?: EdgeData;
}

export interface FlowGraph {
  nodes: FlowNode[];
  edges: GraphEdge[];
}

interface GraphLike {
  nodes: readonly GraphNode[];
  edges: readonly GraphEdge[];
}

export function edgeId(source: string, target: string): string {
  return `${source}->${target}`;
}

function nextNodeId(used: Set<string>, blockId: string): string {
  let id = `b:${blockId}`;
  for (let n = 2; used.has(id); n++) id = `b:${blockId}~${n}`;
  used.add(id);
  return id;
}

export function nodeSize(node: GraphNode): { width: number; height: number } {
  return {
    width: node.width ?? node.measured?.width ?? NODE_WIDTH,
    height: node.height ?? node.measured?.height ?? NODE_HEIGHT,
  };
}

export function groupByParent<N extends GraphNode>(nodes: readonly N[]): Map<string | undefined, N[]> {
  const groups = new Map<string | undefined, N[]>();
  for (const node of nodes) {
    const group = groups.get(node.parentId);
    if (group) group.push(node);
    else groups.set(node.parentId, [node]);
  }
  for (const group of groups.values()) group.sort((a, b) => a.data.order - b.data.order);
  return groups;
}

export function siblingsOf<N extends GraphNode>(nodes: readonly N[], parentId: string | undefined): N[] {
  return nodes.filter((n) => n.parentId === parentId).sort((a, b) => a.data.order - b.data.order);
}

export function flowToGraph(flow: Flow): FlowGraph {
  const nodes: FlowNode[] = [];
  const used = new Set<string>();

  const place = (blocks: readonly Block[], parentId: string | undefined) => {
    const start = parentId ? { x: CONTAINER_PADDING, y: CONTAINER_HEADER } : { x: 0, y: 0 };
    let cursor = start.y;
    let right = 0;
    let bottom = 0;
    blocks.forEach((block, order) => {
      const id = nextNodeId(used, block.id);
      const container = isContainer(block);
      const position = block.ui ? { x: block.ui.x, y: block.ui.y } : { x: start.x, y: cursor };
      const node: FlowNode = {
        id,
        type: container ? "container" : "block",
        position,
        data: { block: container && "body" in block ? { ...block, body: [] } : { ...block }, order },
        ...(parentId ? { parentId, extent: "parent" as const } : {}),
      };
      nodes.push(node);
      let size = { width: NODE_WIDTH, height: NODE_HEIGHT };
      if (container) {
        const inner = place(block.body ?? [], id);
        size = {
          width: block.ui?.width ?? Math.max(NODE_WIDTH + 2 * CONTAINER_PADDING, inner.right + CONTAINER_PADDING),
          height: block.ui?.height ?? Math.max(CONTAINER_HEADER + NODE_HEIGHT + CONTAINER_PADDING, inner.bottom + CONTAINER_PADDING),
        };
        node.width = size.width;
        node.height = size.height;
      }
      cursor = Math.max(cursor, position.y + size.height + NODE_GAP);
      right = Math.max(right, position.x + size.width);
      bottom = Math.max(bottom, position.y + size.height);
    });
    return { right, bottom };
  };

  place(flow.steps, undefined);
  return { nodes, edges: deriveEdges(nodes) };
}

/** Edges for every effective dependency, including the implicit "previous sibling" ones. */
export function deriveEdges(nodes: readonly GraphNode[]): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  for (const group of groupByParent(nodes).values()) {
    const blocks = group.map((n) => n.data.block);
    group.forEach((node, index) => {
      for (const dep of dependenciesOf(node.data.block, blocks, index)) {
        const source = group.find((n) => n.data.block.id === dep);
        if (!source || source.id === node.id) continue;
        const id = edgeId(source.id, node.id);
        if (seen.has(id)) continue;
        seen.add(id);
        edges.push({
          id,
          source: source.id,
          target: node.id,
          data: { implicit: node.data.block.after === undefined, when: node.data.block.when ?? "success" },
        });
      }
    });
  }
  return edges;
}

function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((item) => right.has(item));
}

function positionOf(node: GraphNode, block: Block): NonNullable<Block["ui"]> {
  const ui: NonNullable<Block["ui"]> = { ...block.ui, x: Math.round(node.position.x), y: Math.round(node.position.y) };
  if (node.data.resized) {
    const { width, height } = nodeSize(node);
    ui.width = Math.round(width);
    ui.height = Math.round(height);
  }
  return ui;
}

/**
 * Rebuilds the flow from the graph. `after` is only rewritten when the drawn edges differ from
 * the block's effective dependencies, and `ui` only for nodes the user moved or resized, so an
 * untouched graph gives back exactly the original flow.
 */
export function graphToFlow(graph: GraphLike, original: Flow): Flow {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const grouped = groupByParent(graph.nodes);
  const incoming = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target || source === target || source.parentId !== target.parentId) continue;
    const list = incoming.get(target.id) ?? [];
    list.push(source.data.block.id);
    incoming.set(target.id, list);
  }

  const build = (parentId: string | undefined): Block[] => {
    const group = grouped.get(parentId) ?? [];
    const blocks = group.map((n) => n.data.block);
    const ids = new Set(blocks.map((b) => b.id));
    return group.map((node, index) => {
      const source = node.data.block;
      const block: Record<string, unknown> = { ...source };
      const drawn = unique(incoming.get(node.id) ?? []);
      const declared = dependenciesOf(source, blocks, index).filter((id) => ids.has(id) && id !== source.id);
      if (!sameMembers(drawn, declared)) {
        const dangling = (source.after ?? []).filter((id) => !ids.has(id));
        block.after = unique([
          ...declared.filter((id) => drawn.includes(id)),
          ...drawn.filter((id) => !declared.includes(id)),
          ...dangling,
        ]);
      }
      if (node.data.moved || node.data.resized) block.ui = positionOf(node, source);
      if (isContainer(source) && ("body" in source || grouped.has(node.id))) block.body = build(node.id);
      return block as unknown as Block;
    });
  };

  return { ...original, steps: build(undefined) };
}

export function graphOf<N extends GraphNode>(nodes: N[]): { nodes: N[]; edges: GraphEdge[] } {
  return { nodes, edges: deriveEdges(nodes) };
}

/** Copy of `block` with `key` set, or removed when `value` is undefined. */
export function withField(block: Block, key: string, value: unknown): Block {
  const next: Record<string, unknown> = { ...block };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next as unknown as Block;
}

export function updateBlock<N extends GraphNode>(nodes: readonly N[], nodeId: string, update: (block: Block) => Block): N[] {
  return nodes.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, block: update(n.data.block) } } : n));
}

/** Edits the condition shown on an edge: the `when` of the block it points to. */
export function setEdgeWhen<N extends GraphNode>(nodes: readonly N[], edge: Pick<GraphEdge, "target">, when: string | undefined): N[] {
  return updateBlock(nodes, edge.target, (block) => withField(block, "when", when));
}

/** Current dependencies of a node as block ids, resolving the implicit default. */
export function currentDependencies(nodes: readonly GraphNode[], nodeId: string): string[] {
  const node = nodes.find((n) => n.id === nodeId);
  if (!node) return [];
  const siblings = siblingsOf(nodes, node.parentId);
  const index = siblings.findIndex((n) => n.id === nodeId);
  return dependenciesOf(node.data.block, siblings.map((n) => n.data.block), index);
}

export function setDependencies<N extends GraphNode>(nodes: readonly N[], nodeId: string, after: string[] | undefined): N[] {
  return updateBlock(nodes, nodeId, (block) => withField(block, "after", after));
}

export function connectBlocks<N extends GraphNode>(nodes: readonly N[], sourceId: string, targetId: string): N[] {
  const source = nodes.find((n) => n.id === sourceId);
  const target = nodes.find((n) => n.id === targetId);
  if (!source || !target || source === target || source.parentId !== target.parentId) return [...nodes];
  const current = currentDependencies(nodes, targetId);
  if (current.includes(source.data.block.id)) return [...nodes];
  return setDependencies(nodes, targetId, [...current, source.data.block.id]);
}

export function disconnectBlocks<N extends GraphNode>(nodes: readonly N[], sourceId: string, targetId: string): N[] {
  const source = nodes.find((n) => n.id === sourceId);
  if (!source) return [...nodes];
  const current = currentDependencies(nodes, targetId);
  return setDependencies(nodes, targetId, current.filter((id) => id !== source.data.block.id));
}

/** Renames a block and the `after` references of its siblings. Expressions are left to the user. */
export function renameBlock<N extends GraphNode>(nodes: readonly N[], nodeId: string, newId: string): N[] {
  const node = nodes.find((n) => n.id === nodeId);
  if (!node) return [...nodes];
  const oldId = node.data.block.id;
  return nodes.map((n) => {
    if (n.id === nodeId) return { ...n, data: { ...n.data, block: withField(n.data.block, "id", newId) } };
    if (n.parentId !== node.parentId || !n.data.block.after?.includes(oldId)) return n;
    const after = n.data.block.after.map((id) => (id === oldId ? newId : id));
    return { ...n, data: { ...n.data, block: withField(n.data.block, "after", after) } };
  });
}

export function descendantsOf(nodes: readonly GraphNode[], ids: readonly string[]): Set<string> {
  const out = new Set(ids);
  let grew = true;
  while (grew) {
    grew = false;
    for (const node of nodes) {
      if (node.parentId && out.has(node.parentId) && !out.has(node.id)) {
        out.add(node.id);
        grew = true;
      }
    }
  }
  return out;
}

/** Removes nodes with their container contents and drops sibling `after` entries pointing to them. */
export function removeNodes<N extends GraphNode>(nodes: readonly N[], ids: readonly string[]): N[] {
  const removed = descendantsOf(nodes, ids);
  const gone = nodes.filter((n) => removed.has(n.id));
  const goneIds = new Set(gone.map((n) => n.data.block.id));
  const parents = new Set(gone.map((n) => n.parentId));
  return nodes
    .filter((n) => !removed.has(n.id))
    .map((n) => {
      const after = n.data.block.after;
      if (!after || !parents.has(n.parentId) || !after.some((id) => goneIds.has(id))) return n;
      return { ...n, data: { ...n.data, block: withField(n.data.block, "after", after.filter((id) => !goneIds.has(id))) } };
    });
}

export function addBlockNode<N extends GraphNode>(
  nodes: readonly N[],
  block: Block,
  parentId: string | undefined,
  position: { x: number; y: number },
): (N | FlowNode)[] {
  const used = new Set(nodes.map((n) => n.id));
  const siblings = siblingsOf(nodes, parentId);
  const container = isContainer(block);
  const node: FlowNode = {
    id: nextNodeId(used, block.id),
    type: container ? "container" : "block",
    position,
    data: { block, order: siblings.length ? Math.max(...siblings.map((s) => s.data.order)) + 1 : 0, moved: true },
    ...(parentId ? { parentId, extent: "parent" as const } : {}),
    ...(container ? { width: NODE_WIDTH + 2 * CONTAINER_PADDING, height: CONTAINER_HEADER + NODE_HEIGHT + CONTAINER_PADDING } : {}),
  };
  return fitContainers([...nodes, node]);
}

export function markMoved<N extends GraphNode>(nodes: readonly N[], ids: readonly string[]): N[] {
  const set = new Set(ids);
  return nodes.map((n) => (set.has(n.id) && !n.data.moved ? { ...n, data: { ...n.data, moved: true } } : n));
}

export function markResized<N extends GraphNode>(nodes: readonly N[], ids: readonly string[]): N[] {
  const set = new Set(ids);
  return nodes.map((n) => (set.has(n.id) && !n.data.resized ? { ...n, data: { ...n.data, resized: true } } : n));
}

/** Grows containers the user did not resize so their children fit, innermost first. */
export function fitContainers<N extends GraphNode>(nodes: readonly N[]): N[] {
  const next = [...nodes];
  for (let i = next.length - 1; i >= 0; i--) {
    const node = next[i]!;
    if (node.type !== "container" || node.data.resized) continue;
    const children = next.filter((n) => n.parentId === node.id);
    if (!children.length) continue;
    const size = nodeSize(node);
    const width = Math.max(size.width, ...children.map((c) => c.position.x + nodeSize(c).width + CONTAINER_PADDING));
    const height = Math.max(size.height, ...children.map((c) => c.position.y + nodeSize(c).height + CONTAINER_PADDING));
    if (width !== size.width || height !== size.height) next[i] = { ...node, width, height };
  }
  return next;
}

export function absolutePosition(nodes: readonly GraphNode[], id: string): { x: number; y: number } {
  let x = 0;
  let y = 0;
  for (let node = nodes.find((n) => n.id === id); node; node = node.parentId ? nodes.find((n) => n.id === node!.parentId) : undefined) {
    x += node.position.x;
    y += node.position.y;
  }
  return { x, y };
}

function depthOf(nodes: readonly GraphNode[], id: string): number {
  let depth = 0;
  for (let node = nodes.find((n) => n.id === id); node?.parentId; node = nodes.find((n) => n.id === node!.parentId)) depth++;
  return depth;
}

/** The innermost container under a point in flow coordinates. */
export function containerAt(nodes: readonly GraphNode[], point: { x: number; y: number }): string | undefined {
  let best: { id: string; depth: number } | undefined;
  for (const node of nodes) {
    if (node.type !== "container") continue;
    const at = absolutePosition(nodes, node.id);
    const { width, height } = nodeSize(node);
    if (point.x < at.x || point.y < at.y || point.x > at.x + width || point.y > at.y + height) continue;
    const depth = depthOf(nodes, node.id);
    if (!best || depth > best.depth) best = { id: node.id, depth };
  }
  return best?.id;
}

export function uniqueBlockId(nodes: readonly GraphNode[], base: string): string {
  const ids = new Set(nodes.map((n) => n.data.block.id));
  if (!ids.has(base)) return base;
  let n = 2;
  while (ids.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/** The block an issue path such as ["steps", 0, "body", 1, "until"] points into. */
export function blockIdAtPath(flow: Flow, path: IssuePath): string | undefined {
  let best: { id: string; length: number } | undefined;
  walkBlocks(flow.steps, ({ block, path: blockPath }) => {
    const matches = blockPath.length <= path.length && blockPath.every((segment, i) => String(segment) === String(path[i]));
    if (matches && (!best || blockPath.length > best.length)) best = { id: block.id, length: blockPath.length };
  });
  return best?.id;
}

/** Path of a block inside the flow, e.g. ["steps", 0, "body", 1]. */
export function pathOfBlock(flow: Flow, blockId: string): (string | number)[] | undefined {
  let found: (string | number)[] | undefined;
  walkBlocks(flow.steps, ({ block, path }) => {
    if (!found && block.id === blockId) found = path;
  });
  return found;
}
