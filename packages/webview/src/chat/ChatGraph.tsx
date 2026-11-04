import { useMemo } from "react";
import type { Flow, TreeRow } from "@delamain/core";
import { FlowCanvas } from "../editor/FlowCanvas";
import { flowToGraph } from "../editor/flow-graph";
import type { CanvasNode } from "../editor/nodes";
import { blockStatuses } from "./chat-model";

/** Read-only graph of the running flow, each block colored by its latest live status. */
export function ChatGraph({ flow, rows }: { flow: Flow; rows: TreeRow[] }) {
  const graph = useMemo(() => flowToGraph(flow), [flow]);
  const statuses = useMemo(() => blockStatuses(rows), [rows]);
  const nodes = useMemo(
    () =>
      graph.nodes.map((n) => {
        const status = statuses[n.data.block.id];
        return { ...n, data: { ...n.data, readOnly: true, ...(status ? { status } : {}) } } as CanvasNode;
      }),
    [graph, statuses],
  );
  return <FlowCanvas nodes={nodes} edges={graph.edges} readOnly height={420} />;
}
