import { describe, expect, it } from "vitest";
import { ConfigFile, PRESET_CONFIG_YAML, RuleWhen, parseYaml } from "@delamain/core";
import { availableParameters, defaultRow, rowsToWhen, whenToRows } from "../src/config/conditions";

describe("condition builder", () => {
  it("maps enums to is/in rows and back", () => {
    const when: RuleWhen = { size: "short", kind: ["rename", "docstring"] };
    const rows = whenToRows(when);
    expect(rows).toEqual([
      { param: "size", op: "is", values: ["short"] },
      { param: "kind", op: "in", values: ["rename", "docstring"] },
    ]);
    expect(rowsToWhen(rows)).toStrictEqual(when);
  });

  it("maps number conditions to one row per operator", () => {
    const when: RuleWhen = { est_tokens: { gt: 100, lte: 5000 }, files: 3, max_cost: { lt: 0.5 } };
    const rows = whenToRows(when);
    expect(rows).toEqual([
      { param: "est_tokens", op: ">", value: 100 },
      { param: "est_tokens", op: "<=", value: 5000 },
      { param: "files", op: "=", value: 3 },
      { param: "max_cost", op: "<", value: 0.5 },
    ]);
    expect(rowsToWhen(rows)).toStrictEqual({ est_tokens: { gt: 100, lte: 5000 }, files: 3, max_cost: { lt: 0.5 } });
  });

  it("maps paths and needs_tools", () => {
    const when: RuleWhen = { paths: ["src/secrets/**", "*.pem"], needs_tools: false, role: "worker" };
    expect(rowsToWhen(whenToRows(when))).toStrictEqual(when);
  });

  it("round-trips every preset rule", () => {
    const preset = ConfigFile.parse(parseYaml(PRESET_CONFIG_YAML).value);
    for (const rule of preset.router?.rules ?? []) {
      expect(rowsToWhen(whenToRows(rule.when))).toStrictEqual(rule.when);
    }
  });

  it("keeps incomplete rows invalid instead of dropping them", () => {
    const when = rowsToWhen([
      { param: "kind", op: "in", values: [] },
      { param: "files", op: "<", value: undefined },
      defaultRow("paths"),
    ]);
    expect(when).toStrictEqual({ kind: [], files: {}, paths: [] });
    const result = RuleWhen.safeParse(when);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path[0]).sort()).toEqual(["files", "kind", "paths"]);
  });

  it("offers each non-numeric parameter once", () => {
    const rows = whenToRows({ kind: "tests", files: { lt: 3 } });
    const available = availableParameters(rows);
    expect(available).not.toContain("kind");
    expect(available).toContain("files");
    expect(available).toContain("size");
  });
});
