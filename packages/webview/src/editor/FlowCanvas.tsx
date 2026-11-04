import { useEffect, useMemo, type DragEvent } from "react";
import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
  type OnDelete,
  type XYPosition,
} from "@xyflow/react";
import type { BlockType } from "@delamain/core";
import { BLOCK_TYPES } from "@delamain/core";
import type { GraphEdge } from "./flow-graph";
import { nodeTypes, type CanvasNode } from "./nodes";

export const BLOCK_DRAG_TYPE = "application/x-harness-block";

export interface FlowCanvasProps {
  nodes: CanvasNode[];
  edges: GraphEdge[];
  readOnly?: boolean;
  selectedEdge?: string | undefined;
  /** When set, these edges are highlighted and the others faded. */
  focusEdges?: ReadonlySet<string> | undefined;
  /** Nodes to zoom to when they change. */
  focusNodes?: readonly string[] | undefined;
  height?: number | string;
  onNodesChange?: (changes: NodeChange<CanvasNode>[]) => void;
  onEdgesChange?: (changes: EdgeChange[]) => void;
  onConnect?: (connection: Connection) => void;
  onDelete?: OnDelete<CanvasNode>;
  onNodesMoved?: (ids: string[]) => void;
  onDropBlock?: (type: BlockType, position: XYPosition) => void;
}

function toEdge(edge: GraphEdge, selected: boolean, verify: "focus" | "dim" | undefined): Edge {
  const when = edge.data?.when ?? "success";
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    selected,
    label: when,
    data: edge.data,
    className: `flow-edge when-${["success", "failure", "always"].includes(when) ? when : "expression"}${edge.data?.implicit ? " implicit" : ""}${verify ? ` verify-${verify}` : ""}`,
    animated: verify === "focus",
    markerEnd: { type: MarkerType.ArrowClosed },
    style: edge.data?.implicit ? { strokeDasharray: "5 4" } : undefined,
    labelBgPadding: [4, 2],
    labelBgBorderRadius: 3,
  };
}

function Canvas(props: FlowCanvasProps) {
  const { screenToFlowPosition, fitView } = useReactFlow();
  const { readOnly = false, nodes, selectedEdge, focusEdges } = props;
  const edges = useMemo(
    () => props.edges.map((e) => toEdge(e, e.id === selectedEdge, focusEdges ? (focusEdges.has(e.id) ? "focus" : "dim") : undefined)),
    [props.edges, selectedEdge, focusEdges],
  );
  const parentOf = useMemo(() => new Map(nodes.map((n) => [n.id, n.parentId])), [nodes]);

  const focusKey = props.focusNodes?.join("\n") ?? "";
  useEffect(() => {
    if (focusKey) void fitView({ nodes: focusKey.split("\n").map((id) => ({ id })), duration: 300, padding: 0.4, maxZoom: 1.2 });
  }, [focusKey, fitView]);

  const onDragOver = (event: DragEvent) => {
    if (readOnly || !event.dataTransfer.types.includes(BLOCK_DRAG_TYPE)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const onDrop = (event: DragEvent) => {
    const type = event.dataTransfer.getData(BLOCK_DRAG_TYPE) as BlockType;
    if (readOnly || !(BLOCK_TYPES as readonly string[]).includes(type)) return;
    event.preventDefault();
    props.onDropBlock?.(type, screenToFlowPosition({ x: event.clientX, y: event.clientY }));
  };

  return (
    <div className="flow-canvas" style={{ height: props.height ?? "100%" }} onDragOver={onDragOver} onDrop={onDrop}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        minZoom={0.15}
        maxZoom={2}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        elementsSelectable={!readOnly}
        edgesFocusable={!readOnly}
        deleteKeyCode={readOnly ? null : ["Backspace", "Delete"]}
        onNodesChange={props.onNodesChange}
        onEdgesChange={props.onEdgesChange}
        onConnect={props.onConnect}
        onDelete={props.onDelete}
        isValidConnection={(c) => c.source !== c.target && parentOf.get(c.source) === parentOf.get(c.target)}
        onNodeDragStop={(_event, _node, dragged) => props.onNodesMoved?.(dragged.map((n) => n.id))}
      >
        <Background gap={16} />
        <Controls showInteractive={false} />
        {readOnly ? null : <MiniMap pannable zoomable />}
      </ReactFlow>
    </div>
  );
}

/** The React Flow canvas shared by the block editor and the chat's read-only graph view. */
export function FlowCanvas(props: FlowCanvasProps) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}
