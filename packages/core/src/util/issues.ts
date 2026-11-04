export type IssuePath = readonly (string | number)[];

export interface Issue {
  severity: "error" | "warning";
  path: IssuePath;
  message: string;
  /** File the issue belongs to, when validating several files at once. */
  file?: string;
  /** The check that raised it, so verifiers can group issues by rule. */
  check?: string;
  /** A likely correction of the value at `path`: replace the text `from` with `to`. */
  replace?: { from: string; to: string };
}

export function error(path: IssuePath, message: string): Issue {
  return { severity: "error", path, message };
}

export function warning(path: IssuePath, message: string): Issue {
  return { severity: "warning", path, message };
}

export function hasErrors(issues: readonly Issue[]): boolean {
  return issues.some((issue) => issue.severity === "error");
}

export function formatPath(path: IssuePath): string {
  return path.reduce<string>((acc, part) => {
    if (typeof part === "number") return `${acc}[${part}]`;
    return acc ? `${acc}.${part}` : part;
  }, "");
}

export function formatIssue(issue: Issue): string {
  const where = [issue.file, formatPath(issue.path)].filter(Boolean).join(": ");
  return `${issue.severity}${where ? ` at ${where}` : ""}: ${issue.message}`;
}
