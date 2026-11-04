import type { Issue } from "@delamain/core";
import type { Path } from "./deep";

export function pathKey(path: Path): string {
  return path.map(String).join(".");
}

export function samePath(a: Path, b: Path): boolean {
  return a.length === b.length && a.every((segment, i) => String(segment) === String(b[i]));
}

export function isUnder(path: Path, prefix: Path): boolean {
  return prefix.length <= path.length && prefix.every((segment, i) => String(segment) === String(path[i]));
}

/** Issues reported exactly at `path`: the ones a single field shows next to itself. */
export function issuesAt(issues: readonly Issue[], path: Path): Issue[] {
  return issues.filter((issue) => samePath(issue.path, path));
}

/** Issues at `path` or anywhere below it, e.g. every problem inside one rule card. */
export function issuesUnder(issues: readonly Issue[], path: Path): Issue[] {
  return issues.filter((issue) => isUnder(issue.path, path));
}

export function hasError(issues: readonly Issue[]): boolean {
  return issues.some((issue) => issue.severity === "error");
}

export function formatIssuePath(path: Path): string {
  return path.reduce<string>((acc, part) => (typeof part === "number" ? `${acc}[${part}]` : acc ? `${acc}.${part}` : part), "");
}
