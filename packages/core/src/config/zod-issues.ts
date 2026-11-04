import type { z } from "zod";
import type { Issue } from "../util/issues.ts";

type ZodIssue = z.core.$ZodIssue;

/**
 * Flattens zod issues into harness issues. For unions it keeps only the branch that got
 * furthest, which is almost always the one the user meant.
 */
export function zodIssuesToIssues(issues: readonly ZodIssue[], prefix: (string | number)[] = []): Issue[] {
  const out: Issue[] = [];
  for (const issue of issues) {
    const path = [...prefix, ...issue.path.map((p) => (typeof p === "symbol" ? String(p) : p))];
    if (issue.code === "invalid_union" && issue.errors.length > 0) {
      const best = [...issue.errors].sort((a, b) => score(b) - score(a))[0] ?? [];
      const nested = zodIssuesToIssues(best, path);
      out.push(...(nested.length ? nested : [{ severity: "error" as const, path, message: issue.message }]));
      continue;
    }
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) {
        out.push({ severity: "error", path: [...path, key], message: `Unknown key "${key}"` });
      }
      continue;
    }
    out.push({ severity: "error", path, message: friendlyMessage(issue) });
  }
  return out;
}

function score(branch: readonly ZodIssue[]): number {
  const depth = Math.max(0, ...branch.map((issue) => issue.path.length));
  return depth * 10 - branch.length;
}

function friendlyMessage(issue: ZodIssue): string {
  if (issue.code === "invalid_type" && issue.message.includes("received undefined")) {
    return "Required";
  }
  return issue.message;
}

export function validateWith<T>(
  schema: z.ZodType<T>,
  value: unknown,
): { ok: true; value: T } | { ok: false; issues: Issue[] } {
  const result = schema.safeParse(value);
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, issues: zodIssuesToIssues(result.error.issues) };
}
