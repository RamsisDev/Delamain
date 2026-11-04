import { useCallback, useDeferredValue, useMemo, useRef, useState, type CSSProperties } from "react";
import { applyNodeChanges, useNodesState, type Connection, type EdgeChange, type NodeChange, type OnDelete, type XYPosition } from "@xyflow/react";
import { worstCase, type Block, type BlockType, type Flow, type FlowCheck, type Issue, type LayerName, type ResolvedLimits } from "@delamain/core";
import { LayerBadge } from "../components/badges";
import { Button, Checkbox, Collapsible, Field, OptionalText, TextInput, cx } from "../components/controls";
import { PolicyEditor } from "../config/PolicyEditor";
import type { Destination } from "../config/layers";
import { deepEqual } from "../util/deep";
import { issuesAt } from "../util/issues";
import { defaultBlock } from "./block-defaults";
import { adviseIssue, type Fix } from "./fixes";
import { FlowCanvas } from "./FlowCanvas";
import {
  CONTAINER_HEADER,
  CONTAINER_PADDING,
  NODE_GAP,
  NODE_HEIGHT,
  NODE_WIDTH,
  absolutePosition,
  addBlockNode,
  connectBlocks,
  containerAt,
  deriveEdges,
  disconnectBlocks,
  flowToGraph,
  graphToFlow,
  markMoved,
  markResized,
  nodeSize,
  removeNodes,
  renameBlock,
  setDependencies,
  setEdgeWhen,
  siblingsOf,
  uniqueBlockId,
  updateBlock,
  withField,
} from "./flow-graph";
import { BlockSettingsDialog } from "./BlockSettingsDialog";
import { NodeActions, type CanvasNode } from "./nodes";
import { Palette } from "./Palette";
import { BlockProperties, EdgeProperties, blockSections, type EditorContext } from "./PropertiesPanel";
import { libraryOf, severityByBlock, validateDraft } from "./validation";
import { focusNodes, verifyFlow, type CheckStatus } from "./verify";
import { VerifyPanel } from "./VerifyPanel";

const FOCUS_COLOR: Record<CheckStatus, string> = { pass: "var(--ok)", warning: "var(--warn)", error: "var(--fail)" };

export interface FlowDraftSource {
  name: string;
  layer: LayerName;
  path?: string;
  flow: Flow;
  isNew?: boolean;
}

type FlowMeta = Omit<Flow, "steps">;

function metaOf(flow: Flow): FlowMeta {
  const { steps: _steps, ...meta } = flow;
  return meta;
}

export function BlockEditor({
  source,
  destination,
  limits,
  context,
  onSave,
  onClose,
}: {
  source: FlowDraftSource;
  destination: Destination;
  limits: ResolvedLimits;
  context: EditorContext;
  onSave: (flow: Flow, previousName?: string) => void;
  onClose: () => void;
}) {
  const [initialNodes] = useState(() => flowToGraph(source.flow).nodes as CanvasNode[]);
  const [nodes, setNodes] = useNodesState<CanvasNode>(initialNodes);
  const [meta, setMeta] = useState<FlowMeta>(() => metaOf(source.flow));
  const [selectedEdge, setSelectedEdge] = useState<string>();
  const [focus, setFocus] = useState<FlowCheck>();
  const [settings, setSettings] = useState<{ nodeId: string; before: CanvasNode[] }>();
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const nodeActions = useMemo(() => ({ openSettings: (nodeId: string) => setSettings({ nodeId, before: nodesRef.current }) }), []);

  const library = useMemo(() => libraryOf(context.known), [context.known]);
  const editorContext = useMemo(() => ({ ...context, library }), [context, library]);
  const edges = useMemo(() => deriveEdges(nodes), [nodes]);
  const flow = useMemo(() => graphToFlow({ nodes, edges }, { ...meta, steps: [] }), [nodes, edges, meta]);
  const checked = useDeferredValue(flow);
  const issues = useMemo(() => validateDraft(checked, limits, library, context.config), [checked, limits, library, context.config]);
  const severity = useMemo(() => severityByBlock(checked, issues), [checked, issues]);
  const worst = useMemo(() => worstCase(flow, { library }), [flow, library]);
  const checks = useMemo(() => verifyFlow(checked, issues, { nodes, edges }, worst, limits), [checked, issues, nodes, edges, worst, limits]);
  const advise = useCallback(
    (issue: Issue) => adviseIssue(issue, { flow: checked, nodes, edges, limits, worst }),
    [checked, nodes, edges, limits, worst],
  );
  const applyFix = (fix: Fix) => {
    setFocus(undefined);
    setNodes((ns) => fix.apply(ns, graphToFlow({ nodes: ns, edges: deriveEdges(ns) }, { ...meta, steps: [] })) as CanvasNode[]);
  };
  const focused = checks.find((c) => c.id === focus);
  const lit = focused && (focused.nodes.length > 0 || focused.edges.length > 0) ? focused : undefined;
  const focusEdges = useMemo(() => (lit ? new Set(lit.edges) : undefined), [lit]);
  const dirty = source.isNew === true || !deepEqual(flow, source.flow);
  const errors = issues.filter((i) => i.severity === "error");

  const display = useMemo(() => {
    const marked = nodes.map((n) => {
      const s = severity.get(n.data.block.id);
      return s ? { ...n, data: { ...n.data, severity: s } } : n;
    });
    return lit ? focusNodes(marked, new Set(lit.nodes)) : marked;
  }, [nodes, severity, lit]);
  const selectedNode = nodes.find((n) => n.selected);
  const edge = selectedEdge ? edges.find((e) => e.id === selectedEdge) : undefined;
  const settingsNode = settings ? nodes.find((n) => n.id === settings.nodeId) : undefined;
  const settingsProps = (node: CanvasNode) => ({
    node,
    nodes,
    flow,
    issues,
    context: editorContext,
    onChange: (block: Block) => setNodes((ns) => updateBlock(ns, node.id, () => block)),
    onRename: (id: string) => setNodes((ns) => renameBlock(ns, node.id, id)),
    onDependencies: (after: string[] | undefined) => setNodes((ns) => setDependencies(ns, node.id, after)),
  });

  const onNodesChange = useCallback(
    (changes: NodeChange<CanvasNode>[]) => {
      // Removal goes through onDelete so sibling `after` lists are cleaned up together.
      const kept = changes.filter((c) => c.type !== "remove");
      const resized = kept.flatMap((c) => (c.type === "dimensions" && c.setAttributes ? [c.id] : []));
      setNodes((ns) => {
        const next = applyNodeChanges(kept, ns);
        return resized.length ? markResized(next, resized) : next;
      });
    },
    [setNodes],
  );

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    for (const c of changes) {
      if (c.type === "select") setSelectedEdge((current) => (c.selected ? c.id : current === c.id ? undefined : current));
    }
  }, []);

  const onDelete: OnDelete<CanvasNode> = useCallback(
    ({ nodes: gone, edges: cut }) => {
      setNodes((ns) => {
        let next = removeNodes(ns, gone.map((n) => n.id));
        for (const e of cut) {
          if (next.some((n) => n.id === e.source) && next.some((n) => n.id === e.target)) next = disconnectBlocks(next, e.source, e.target);
        }
        return next;
      });
      setSelectedEdge(undefined);
    },
    [setNodes],
  );

  const onConnect = useCallback((c: Connection) => setNodes((ns) => connectBlocks(ns, c.source, c.target)), [setNodes]);

  const add = (type: BlockType, parent: string | undefined, position: XYPosition) =>
    setNodes((ns) => addBlockNode(ns, defaultBlock(type, uniqueBlockId(ns, type)), parent, position) as CanvasNode[]);

  const onDropBlock = (type: BlockType, point: XYPosition) => {
    const parent = containerAt(nodes, point);
    const origin = parent ? absolutePosition(nodes, parent) : { x: 0, y: 0 };
    let x = point.x - origin.x - NODE_WIDTH / 2;
    let y = point.y - origin.y - NODE_HEIGHT / 2;
    if (parent) {
      x = Math.max(CONTAINER_PADDING, x);
      y = Math.max(CONTAINER_HEADER, y);
    }
    add(type, parent, { x: Math.round(x), y: Math.round(y) });
  };

  const onPaletteClick = (type: BlockType) => {
    const parent = selectedNode ? (selectedNode.type === "container" ? selectedNode.id : selectedNode.parentId) : undefined;
    const bottom = siblingsOf(nodes, parent).reduce(
      (max, s) => Math.max(max, s.position.y + nodeSize(s).height),
      parent ? CONTAINER_HEADER - NODE_GAP : -NODE_GAP,
    );
    add(type, parent, { x: parent ? CONTAINER_PADDING : 0, y: bottom + NODE_GAP });
  };

  const selectBlock = (blockId: string) => {
    setSelectedEdge(undefined);
    setNodes((ns) => ns.map((n) => ({ ...n, selected: n.data.block.id === blockId })));
  };

  const setMetaField = (key: keyof FlowMeta, value: unknown) =>
    setMeta((current) => {
      const next: Record<string, unknown> = { ...current };
      if (value === undefined) delete next[key];
      else next[key] = value;
      return next as FlowMeta;
    });

  const previousName = !source.isNew && source.layer === destination && flow.name !== source.name ? source.name : undefined;
  const worstWarning = worst.perModel > limits.worst_case_warning;

  return (
    <div className="block-editor">
      <div className="editor-toolbar">
        <Field label="Name" issues={issuesAt(issues, ["name"])}>
          <TextInput value={meta.name} onChange={(name) => setMetaField("name", name)} />
        </Field>
        <Field label="Description" wide>
          <OptionalText value={meta.description} onChange={(description) => setMetaField("description", description)} />
        </Field>
        <Checkbox
          label="Reusable"
          title="Other flows can run this one with a Subflow block"
          checked={meta.reusable === true}
          onChange={(on) => setMetaField("reusable", on ? true : undefined)}
        />
        <div className={cx("worst-case", worstWarning && "worst-case-warning")} title={worst.loops.map((l) => `${l.id} ${l.max}`).join(" × ")}>
          <div className="worst-case-figure">{worst.perModel}</div>
          <div className="worst-case-label">
            worst-case worker runs per task per model
            {worst.loops.length ? <div className="muted">{worst.loops.map((l) => `${l.id} ${l.max}`).join(" × ")}</div> : null}
            {worstWarning ? <div>Above the warning of {limits.worst_case_warning}</div> : null}
          </div>
        </div>
        <div className="editor-actions">
          <span className="muted">
            {source.isNew ? "New" : <LayerBadge layer={source.layer} />} → saves to <strong>{destination}</strong>
          </span>
          <Button
            variant="primary"
            disabled={!dirty || errors.length > 0}
            title={errors.length ? "Fix the errors first" : dirty ? "Save the flow" : "No changes"}
            onClick={() => onSave(flow, previousName)}
          >
            Save flow
          </Button>
          <Button onClick={onClose}>Close</Button>
        </div>
      </div>

      <Collapsible title="Escalation policy">
        <PolicyEditor
          policy={meta.policy?.escalation}
          issues={issues}
          onChange={(escalation) => setMetaField("policy", escalation ? { ...meta.policy, escalation } : undefined)}
        />
      </Collapsible>

      <div className="editor-body">
        <Palette onAdd={onPaletteClick} />
        <div className="editor-canvas" style={lit ? ({ "--verify-color": FOCUS_COLOR[lit.status] } as CSSProperties) : undefined}>
          <NodeActions.Provider value={nodeActions}>
            <FlowCanvas
              nodes={display}
              edges={edges}
              selectedEdge={selectedEdge}
              focusEdges={focusEdges}
              focusNodes={lit?.nodes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onDelete={onDelete}
              onNodesMoved={(ids) => setNodes((ns) => markMoved(ns, ids))}
              onDropBlock={onDropBlock}
            />
          </NodeActions.Provider>
        </div>
        <div className="editor-props">
          {edge ? (
            <EdgeProperties
              edge={edge}
              nodes={nodes}
              onWhen={(when) => setNodes((ns) => setEdgeWhen(ns, edge, when))}
              onJoin={(join) => setNodes((ns) => updateBlock(ns, edge.target, (b) => withField(b, "join", join)))}
              onDisconnect={() => {
                setNodes((ns) => disconnectBlocks(ns, edge.source, edge.target));
                setSelectedEdge(undefined);
              }}
            />
          ) : selectedNode ? (
            <BlockProperties key={selectedNode.id} {...settingsProps(selectedNode)} onDelete={() => setNodes((ns) => removeNodes(ns, [selectedNode.id]))} />
          ) : (
            <div className="props muted">
              <p>Select a block to edit its properties, or click an arrow to change its condition.</p>
              <p>Drag blocks from the palette onto the canvas, or into a Loop / For each to add them to its body.</p>
              <p>Draw an arrow from a block's bottom handle to another block at the same level to make it wait.</p>
            </div>
          )}
        </div>
      </div>

      <VerifyPanel checks={checks} focus={focus} onFocus={setFocus} advise={advise} onSelect={selectBlock} onFix={applyFix} />

      {settings && settingsNode ? (
        <BlockSettingsDialog
          key={settings.nodeId}
          block={settingsNode.data.block}
          sections={blockSections(settingsProps(settingsNode), true)}
          onDone={() => setSettings(undefined)}
          onCancel={() => {
            setNodes(settings.before);
            setSettings(undefined);
          }}
          onDelete={() => {
            setNodes((ns) => removeNodes(ns, [settings.nodeId]));
            setSettings(undefined);
          }}
        />
      ) : null}
    </div>
  );
}
