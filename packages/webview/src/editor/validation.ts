import { Flow, flowLibrary, validateFlow, validateWith, type FlowLibrary, type FlowValidationContext, type Issue, type ResolvedLimits } from "@delamain/core";
import { pathKey } from "../util/issues";
import { blockIdAtPath } from "./flow-graph";
import type { KnownFlow } from "./PropertiesPanel";

/** The flows a subflow block can reuse, invalid ones included so cycles through them show up. */
export function libraryOf(known: readonly KnownFlow[]): FlowLibrary {
  const subflows = new Map<string, Flow>();
  const orchestrations = new Map<string, Flow>();
  for (const entry of known) {
    if (entry.ref.startsWith("flows/")) {
      subflows.set(entry.ref, entry.flow);
      subflows.set(entry.flow.name, entry.flow);
    } else {
      orchestrations.set(entry.ref, entry.flow);
    }
  }
  return flowLibrary(subflows, orchestrations);
}

/** Schema issues plus the graph checks (cycles, orphans, outputs, reuse, caps) for a draft flow. */
export function validateDraft(flow: Flow, limits: ResolvedLimits, library?: FlowLibrary, config?: FlowValidationContext["config"]): Issue[] {
  const schema = validateWith(Flow, flow);
  const issues: Issue[] = schema.ok ? [] : [...schema.issues];
  try {
    issues.push(...validateFlow(flow, { limits, ...(library ? { library } : {}), ...(config ? { config } : {}) }));
  } catch (e) {
    issues.push({ severity: "error", path: [], message: `Validation failed: ${(e as Error).message}` });
  }
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${pathKey(issue.path)}|${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Worst severity per block id, to highlight the offending nodes. */
export function severityByBlock(flow: Flow, issues: readonly Issue[]): Map<string, "error" | "warning"> {
  const out = new Map<string, "error" | "warning">();
  for (const issue of issues) {
    const id = blockIdAtPath(flow, issue.path);
    if (!id) continue;
    if (issue.severity === "error" || !out.has(id)) out.set(id, issue.severity);
  }
  return out;
}
