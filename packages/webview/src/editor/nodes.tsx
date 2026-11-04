import { createContext, useContext } from "react";
import { Handle, NodeResizer, Position, type Node, type NodeProps, type NodeTypes } from "@xyflow/react";
import { StatusIcon } from "../components/badges";
import { cx } from "../components/controls";
import { BLOCK_META, blockSummary } from "./block-defaults";
import { CONTAINER_HEADER, NODE_WIDTH, type BlockNodeData } from "./flow-graph";

export type CanvasNode = Node<BlockNodeData>;

/** What the editor lets a node do; absent in read-only graphs. */
export const NodeActions = createContext<{ openSettings(nodeId: string): void } | undefined>(undefined);

/** What an agent or review block adds to its defaults, for the gear's tooltip and colour. */
function customizations(data: BlockNodeData): string[] {
  const { block } = data;
  if (block.type !== "agent" && block.type !== "review") return [];
  return [
    ...(block.instructions?.trim() ? [`Instructions: ${block.instructions.trim()}`] : []),
    ...(block.retries ? [`Retries: ${block.retries}${block.retry_delay ? `, waiting ${block.retry_delay}` : ""}`] : []),
    ...(block.timeout ? [`Timeout: ${block.timeout}`] : []),
  ];
}

function SettingsGear({ nodeId, data }: { nodeId: string; data: BlockNodeData }) {
  const actions = useContext(NodeActions);
  const custom = customizations(data);
  if (!actions || data.readOnly) {
    return custom.length ? (
      <span className="flow-node-gear customized" title={custom.join("\n")}>
        ⚙
      </span>
    ) : null;
  }
  return (
    <button
      type="button"
      className={cx("flow-node-gear", "nodrag", custom.length > 0 && "customized")}
      title={["Block settings", ...custom].join("\n")}
      aria-label={`Settings of ${data.block.id}`}
      onClick={(event) => {
        event.stopPropagation();
        actions.openSettings(nodeId);
      }}
    >
      ⚙
    </button>
  );
}

function nodeClass(data: BlockNodeData, selected: boolean, base: string): string {
  const meta = BLOCK_META[data.block.type];
  return cx(
    base,
    `family-${meta.family}`,
    `type-${data.block.type}`,
    data.status && `node-status-${data.status}`,
    data.severity && `severity-${data.severity}`,
    data.focus && "verify-focus",
    data.dimmed && "verify-dim",
    selected && "selected",
  );
}

function Title({ nodeId, data }: { nodeId: string; data: BlockNodeData }) {
  const { block } = data;
  const meta = BLOCK_META[block.type];
  return (
    <div className="flow-node-title">
      <span className="flow-node-icon" title={meta.label}>
        {meta.icon}
      </span>
      <span className="flow-node-name">{block.label ?? block.id}</span>
      <SettingsGear nodeId={nodeId} data={data} />
      {block.on_finish?.length ? (
        <span className="flow-node-flag" title={`${block.on_finish.length} completion action(s)`}>
          ⚑
        </span>
      ) : null}
      {data.severity ? (
        <span className={`issue-${data.severity}`} title="This block has validation issues">
          {data.severity === "error" ? "✗" : "⚠"}
        </span>
      ) : null}
      {data.status ? <StatusIcon status={data.status} /> : null}
    </div>
  );
}

function BlockNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const connectable = !data.readOnly;
  return (
    <div className={nodeClass(data, selected, "flow-node")} style={{ width: NODE_WIDTH }}>
      <Handle type="target" position={Position.Top} isConnectable={connectable} />
      <Title nodeId={id} data={data} />
      <div className="flow-node-summary" title={blockSummary(data.block)}>
        {blockSummary(data.block)}
      </div>
      <Handle type="source" position={Position.Bottom} isConnectable={connectable} />
    </div>
  );
}

function ContainerNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const connectable = !data.readOnly;
  return (
    <div className={nodeClass(data, selected, "flow-container")}>
      <NodeResizer isVisible={selected && !data.readOnly} minWidth={NODE_WIDTH} minHeight={CONTAINER_HEADER + 40} />
      <Handle type="target" position={Position.Top} isConnectable={connectable} />
      <div className="flow-container-header" style={{ height: CONTAINER_HEADER }}>
        <Title nodeId={id} data={data} />
        <div className="flow-node-summary">{blockSummary(data.block)}</div>
      </div>
      <Handle type="source" position={Position.Bottom} isConnectable={connectable} />
    </div>
  );
}

// Defined once at module level: React Flow re-mounts every node when nodeTypes changes identity.
export const nodeTypes: NodeTypes = { block: BlockNode, container: ContainerNode };
