import {
  RULE_PARAMETERS,
  ROUTER_ROLES,
  TASK_KINDS,
  TASK_SIZES,
  type NumberCondition,
  type RuleWhen,
} from "@delamain/core";

/** Rows of the router's condition builder: parameter → operator → value. */

export type RuleParameter = (typeof RULE_PARAMETERS)[number];
export type EnumParameter = "kind" | "size" | "role";
export type NumberParameter = "est_tokens" | "files" | "max_cost";
export type NumberOperator = "=" | "<" | "<=" | ">" | ">=";

export type ConditionRow =
  | { param: EnumParameter; op: "is" | "in"; values: string[] }
  | { param: NumberParameter; op: NumberOperator; value: number | undefined }
  | { param: "paths"; op: "matches"; globs: string[] }
  | { param: "needs_tools"; op: "is"; value: boolean };

type NumberObject = Exclude<NumberCondition, number>;

export const NUMBER_OPERATORS: readonly NumberOperator[] = ["=", "<", "<=", ">", ">="];

const OPERATOR_KEY: Record<NumberOperator, keyof NumberObject> = { "=": "eq", "<": "lt", "<=": "lte", ">": "gt", ">=": "gte" };
const KEY_OPERATOR: Record<keyof NumberObject, NumberOperator> = { eq: "=", lt: "<", lte: "<=", gt: ">", gte: ">=" };

export const PARAMETER_LABELS: Record<RuleParameter, string> = {
  kind: "Kind",
  size: "Size",
  est_tokens: "Estimated tokens",
  files: "Files",
  paths: "Paths",
  needs_tools: "Needs tools",
  role: "Role",
  max_cost: "Max cost (USD)",
};

export function parameterKind(param: RuleParameter): "enum" | "number" | "paths" | "boolean" {
  if (param === "kind" || param === "size" || param === "role") return "enum";
  if (param === "paths") return "paths";
  if (param === "needs_tools") return "boolean";
  return "number";
}

export function enumValues(param: EnumParameter): readonly string[] {
  if (param === "kind") return TASK_KINDS;
  if (param === "size") return TASK_SIZES;
  return ROUTER_ROLES;
}

export function operatorsFor(param: RuleParameter): readonly string[] {
  switch (parameterKind(param)) {
    case "enum":
      return ["is", "in"];
    case "number":
      return NUMBER_OPERATORS;
    case "paths":
      return ["matches"];
    case "boolean":
      return ["is"];
  }
}

export function defaultRow(param: RuleParameter): ConditionRow {
  switch (param) {
    case "kind":
    case "size":
    case "role":
      return { param, op: "is", values: [enumValues(param)[0]!] };
    case "est_tokens":
    case "files":
    case "max_cost":
      return { param, op: "<=", value: undefined };
    case "paths":
      return { param, op: "matches", globs: [] };
    case "needs_tools":
      return { param, op: "is", value: true };
  }
}

/** Parameters that can only appear once; numbers may take several rows (e.g. > 10 and <= 50). */
export function availableParameters(rows: readonly ConditionRow[]): RuleParameter[] {
  const used = new Set(rows.map((r) => r.param));
  return RULE_PARAMETERS.filter((p) => parameterKind(p) === "number" || !used.has(p));
}

export function whenToRows(when: RuleWhen): ConditionRow[] {
  const rows: ConditionRow[] = [];
  for (const key of Object.keys(when) as (keyof RuleWhen)[]) {
    if (!(RULE_PARAMETERS as readonly string[]).includes(key)) continue;
    const param = key as RuleParameter;
    switch (param) {
      case "kind":
      case "size":
      case "role": {
        const value = when[param];
        if (value === undefined) break;
        rows.push(Array.isArray(value) ? { param, op: "in", values: [...value] } : { param, op: "is", values: [value as string] });
        break;
      }
      case "est_tokens":
      case "files":
      case "max_cost": {
        const value = when[param];
        if (value === undefined) break;
        if (typeof value === "number") {
          rows.push({ param, op: "=", value });
          break;
        }
        const keys = (Object.keys(value) as (keyof NumberObject)[]).filter((k) => value[k] !== undefined);
        if (!keys.length) rows.push({ param, op: "=", value: undefined });
        for (const k of keys) rows.push({ param, op: KEY_OPERATOR[k], value: value[k] });
        break;
      }
      case "paths":
        if (when.paths) rows.push({ param, op: "matches", globs: [...when.paths] });
        break;
      case "needs_tools":
        if (when.needs_tools !== undefined) rows.push({ param, op: "is", value: when.needs_tools });
        break;
    }
  }
  return rows;
}

/**
 * Builds the rule's `when` from the rows. Incomplete rows are kept as invalid values (an empty
 * list, an empty number condition) so schema validation flags them instead of silently widening
 * the rule.
 */
export function rowsToWhen(rows: readonly ConditionRow[]): RuleWhen {
  const when: Record<string, unknown> = {};
  const numbers = new Map<NumberParameter, NumberObject[]>();
  for (const row of rows) {
    switch (row.param) {
      case "kind":
      case "size":
      case "role":
        when[row.param] = row.op === "is" ? (row.values[0] ?? []) : [...row.values];
        break;
      case "est_tokens":
      case "files":
      case "max_cost": {
        const list = numbers.get(row.param) ?? [];
        list.push(row.value === undefined ? {} : { [OPERATOR_KEY[row.op]]: row.value });
        numbers.set(row.param, list);
        when[row.param] = undefined;
        break;
      }
      case "paths":
        when.paths = [...row.globs];
        break;
      case "needs_tools":
        when.needs_tools = row.value;
        break;
    }
  }
  for (const [param, parts] of numbers) {
    const merged: NumberObject = Object.assign({}, ...parts);
    const keys = Object.keys(merged);
    when[param] = keys.length === 1 && merged.eq !== undefined ? merged.eq : merged;
  }
  return when as RuleWhen;
}
