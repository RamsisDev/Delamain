import { useEffect, useState } from "react";
import type { Issue, RuleWhen } from "@delamain/core";
import { Button, Chips, FieldIssues, ListInput, NumberInput, Select, type Option } from "../components/controls";
import type { Path } from "../util/deep";
import { deepEqual } from "../util/deep";
import {
  PARAMETER_LABELS,
  availableParameters,
  defaultRow,
  enumValues,
  operatorsFor,
  rowsToWhen,
  whenToRows,
  type ConditionRow,
  type RuleParameter,
} from "./conditions";

function ValueEditor({ row, onChange, disabled }: { row: ConditionRow; onChange: (row: ConditionRow) => void; disabled: boolean }) {
  switch (row.param) {
    case "kind":
    case "size":
    case "role": {
      const options = enumValues(row.param);
      if (row.op === "is") {
        return (
          <Select
            value={row.values[0]}
            options={options.map((v) => ({ value: v, label: v }))}
            disabled={disabled}
            onChange={(v) => onChange({ ...row, values: v ? [v] : [] })}
          />
        );
      }
      return <Chips options={options} values={row.values} disabled={disabled} onChange={(values) => onChange({ ...row, values })} />;
    }
    case "est_tokens":
    case "files":
    case "max_cost":
      return (
        <NumberInput
          value={row.value}
          step={row.param === "max_cost" ? "any" : 1}
          min={0}
          disabled={disabled}
          onChange={(value) => onChange({ ...row, value })}
        />
      );
    case "paths":
      return <ListInput value={row.globs} placeholder="src/secrets/**, *.pem" disabled={disabled} onChange={(globs) => onChange({ ...row, globs })} />;
    case "needs_tools":
      return (
        <Select<"yes" | "no">
          value={row.value ? "yes" : "no"}
          options={[
            { value: "yes", label: "yes" },
            { value: "no", label: "no" },
          ]}
          disabled={disabled}
          onChange={(v) => onChange({ ...row, value: v === "yes" })}
        />
      );
  }
}

function withOperator(row: ConditionRow, op: string): ConditionRow {
  switch (row.param) {
    case "kind":
    case "size":
    case "role":
      return { ...row, op: op as "is" | "in", values: op === "is" ? row.values.slice(0, 1) : row.values };
    case "est_tokens":
    case "files":
    case "max_cost":
      return { ...row, op: op as typeof row.op };
    default:
      return row;
  }
}

/**
 * Condition builder for a router rule. Rows are local state so half-filled rows keep their
 * operator; they resync when `when` changes from outside (undo, reload, another layer).
 */
export function RuleConditions({
  when,
  onChange,
  issuesUnder,
  path,
  disabled,
}: {
  when: RuleWhen;
  onChange: (when: RuleWhen) => void;
  issuesUnder: (path: Path) => Issue[];
  path: Path;
  disabled: boolean;
}) {
  const [rows, setRows] = useState(() => whenToRows(when));
  useEffect(() => {
    if (!deepEqual(rowsToWhen(rows), when)) setRows(whenToRows(when));
  }, [when]);

  const change = (next: ConditionRow[]) => {
    setRows(next);
    onChange(rowsToWhen(next));
  };
  const available = availableParameters(rows);

  return (
    <div className="conditions">
      {rows.length === 0 ? <div className="muted">No conditions: this rule matches every task.</div> : null}
      {rows.map((row, index) => {
        const params: Option<RuleParameter>[] = [row.param, ...available.filter((p) => p !== row.param)].map((p) => ({
          value: p,
          label: PARAMETER_LABELS[p],
        }));
        return (
          <div className="condition-row" key={index}>
            <Select<RuleParameter>
              value={row.param}
              options={params}
              disabled={disabled}
              onChange={(param) => param && change(rows.map((r, i) => (i === index ? defaultRow(param) : r)))}
            />
            <Select<string>
              value={row.op}
              options={operatorsFor(row.param).map((op) => ({ value: op, label: op }))}
              disabled={disabled}
              onChange={(op) => op && change(rows.map((r, i) => (i === index ? withOperator(r, op) : r)))}
            />
            <div className="condition-value">
              <ValueEditor row={row} disabled={disabled} onChange={(next) => change(rows.map((r, i) => (i === index ? next : r)))} />
            </div>
            <Button small variant="link" disabled={disabled} title="Remove condition" onClick={() => change(rows.filter((_, i) => i !== index))}>
              ✕
            </Button>
            <FieldIssues issues={issuesUnder([...path, row.param])} />
          </div>
        );
      })}
      <Select<RuleParameter>
        value={undefined}
        empty="+ Add condition…"
        options={available.map((p) => ({ value: p, label: PARAMETER_LABELS[p] }))}
        disabled={disabled}
        onChange={(param) => param && change([...rows, defaultRow(param)])}
      />
    </div>
  );
}
