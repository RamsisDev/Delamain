import type { Finding } from "../schema/findings.ts";
import { normalizePath } from "../util/glob.ts";
import { parseUnifiedDiff, touchedOldLines } from "../util/diff.ts";

export interface ScopeViolation {
  file: string;
  lines: number[];
}

/**
 * First half of the deterministic safeguard: a mechanical fix may only touch the findings'
 * files, and within them only the findings' lines plus `margin`. A finding without a line
 * allows its whole file.
 */
export function checkFixScope(diff: string, findings: readonly Finding[], margin: number): ScopeViolation[] {
  const allowed = new Map<string, { whole: boolean; ranges: [number, number][] }>();
  for (const finding of findings) {
    const file = normalizePath(finding.file);
    const entry = allowed.get(file) ?? { whole: false, ranges: [] };
    if (finding.line === undefined) entry.whole = true;
    else entry.ranges.push([finding.line - margin, (finding.end_line ?? finding.line) + margin]);
    allowed.set(file, entry);
  }
  const violations: ScopeViolation[] = [];
  for (const file of parseUnifiedDiff(diff)) {
    const path = normalizePath(file.path);
    const scope = allowed.get(path);
    const touched = touchedOldLines(file);
    if (!scope) {
      violations.push({ file: path, lines: touched });
      continue;
    }
    if (scope.whole) continue;
    const outside = touched.filter((line) => !scope.ranges.some(([from, to]) => line >= from && line <= to));
    if (outside.length) violations.push({ file: path, lines: outside });
  }
  return violations;
}

export function describeViolations(violations: readonly ScopeViolation[]): string {
  return violations
    .map((v) => `${v.file}${v.lines.length ? ` lines ${v.lines.slice(0, 8).join(", ")}` : ""}`)
    .join("; ");
}
