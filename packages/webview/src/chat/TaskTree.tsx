import { useEffect, useRef } from "react";
import type { TreeRow } from "@delamain/core";
import { StatusIcon } from "../components/badges";
import { Button, cx } from "../components/controls";
import { JsonView } from "../components/JsonView";
import { formatDuration, formatTokens } from "../util/format";

export type TaskAction = "cancel" | "retry" | "retry-model" | "skip";

const ACTIONS: { action: TaskAction; label: string; title: string }[] = [
  { action: "cancel", label: "Cancel", title: "Stop this task; the rest continues" },
  { action: "retry", label: "Retry", title: "Run the task again from the start" },
  { action: "retry-model", label: "Other model", title: "Retry with another model" },
  { action: "skip", label: "Skip", title: "Mark the task as skipped" },
];

function actionEnabled(action: TaskAction, row: TreeRow): boolean {
  const active = row.status === "running" || row.status === "waiting" || row.status === "paused";
  if (action === "cancel") return active;
  if (action === "skip") return row.status !== "succeeded" && row.status !== "skipped";
  return row.status !== "skipped";
}

function StreamedText({ text }: { text: string }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text]);
  return (
    <pre ref={ref} className="stream">
      {text}
    </pre>
  );
}

function RowDetail({ row, text, onOpen }: { row: TreeRow; text: string | undefined; onOpen: (key: string) => void }) {
  const hasOutputs = row.outputs && Object.keys(row.outputs).length > 0;
  return (
    <div className="row-detail">
      {row.detail ? <div className="muted">{row.detail}</div> : null}
      {row.error ? <div className="issue-error">✗ {row.error}</div> : null}
      {text ? <StreamedText text={text} /> : null}
      {hasOutputs ? (
        <div>
          <div className="section-title">Outputs</div>
          <JsonView value={row.outputs} />
        </div>
      ) : null}
      {row.kind !== "task" && row.kind !== "finding" ? (
        <Button small variant="link" onClick={() => onOpen(row.id)}>
          Open the full log
        </Button>
      ) : null}
      {!text && !hasOutputs && !row.error && !row.detail ? <div className="muted">No details yet.</div> : null}
    </div>
  );
}

function Row({
  row,
  depth,
  text,
  expanded,
  onToggle,
  onAction,
  onOpen,
  running,
}: {
  row: TreeRow;
  depth: number;
  text: Record<string, string>;
  expanded: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onAction: (task: string, action: TaskAction) => void;
  onOpen: (key: string) => void;
  running: boolean;
}) {
  const open = expanded.has(row.id);
  const budget = row.budget;
  return (
    <li className={cx("tree-row", `kind-${row.kind}`, `row-status-${row.status}`)}>
      <div
        className="tree-line"
        style={{ paddingLeft: 4 + depth * 14 }}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => onToggle(row.id)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle(row.id);
          }
        }}
      >
        <span className="chevron">{open ? "▾" : "▸"}</span>
        <StatusIcon status={row.status} />
        <span className="tree-label" title={row.id}>
          {row.label}
        </span>
        {row.model ? <span className="tree-model">{row.model}</span> : null}
        {row.attempt ? (
          <span className="tree-meta" title="Attempt">
            {row.attempt.current}/{row.attempt.max}
          </span>
        ) : null}
        {row.durationMs !== undefined ? <span className="tree-meta">{formatDuration(row.durationMs)}</span> : null}
        {row.tokens ? <span className="tree-meta">{formatTokens(row.tokens)} tok</span> : null}
        {row.rule ? (
          <span className="tree-rule" title="Router rule">
            rule: {row.rule}
          </span>
        ) : null}
        {row.kind === "task" && row.task && running ? (
          <span className="task-actions" onClick={(e) => e.stopPropagation()}>
            {ACTIONS.map(({ action, label, title }) => (
              <Button key={action} small variant="link" title={title} disabled={!actionEnabled(action, row)} onClick={() => onAction(row.task!, action)}>
                {label}
              </Button>
            ))}
          </span>
        ) : null}
      </div>
      {budget ? (
        <div className="tree-sub" style={{ paddingLeft: 36 + depth * 14 }}>
          budget {formatTokens(budget.tokens)}
          {budget.maxTokens ? ` / ${formatTokens(budget.maxTokens)}` : ""} tok · {Math.round(budget.minutes)}
          {budget.maxMinutes ? ` / ${budget.maxMinutes}` : ""} min
        </div>
      ) : null}
      {row.status === "waiting" && (row.waitingFor?.length || row.detail) ? (
        <div className="tree-sub waiting" style={{ paddingLeft: 36 + depth * 14 }}>
          {row.waitingFor?.length ? `waiting for ${row.waitingFor.join(", ")}` : "waiting"}
          {row.detail ? ` · ${row.detail}` : ""}
        </div>
      ) : null}
      {open ? (
        <div style={{ paddingLeft: 22 + depth * 14 }}>
          <RowDetail row={row} text={text[row.id]} onOpen={onOpen} />
        </div>
      ) : null}
      {row.children.length ? (
        <ul className="tree">
          {row.children.map((child) => (
            <Row
              key={child.id}
              row={child}
              depth={depth + 1}
              text={text}
              expanded={expanded}
              onToggle={onToggle}
              onAction={onAction}
              onOpen={onOpen}
              running={running}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** The live subtask tree of an orchestrated run. Click a row for its detail. */
export function TaskTree(props: {
  rows: TreeRow[];
  text: Record<string, string>;
  expanded: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onAction: (task: string, action: TaskAction) => void;
  onOpen: (key: string) => void;
  running: boolean;
}) {
  const { rows, ...rest } = props;
  return (
    <ul className="tree tree-root">
      {rows.map((row) => (
        <Row key={row.id} row={row} depth={0} {...rest} />
      ))}
    </ul>
  );
}
