import { toArray, type FindingRoute } from "../schema/common.ts";
import {
  isFindingsDefault,
  type Finding,
  type FindingsRouting,
  type FindingsWhen,
} from "../schema/findings.ts";
import { matchesAnyGlob } from "../util/glob.ts";

export interface RoutedFinding {
  finding: Finding;
  route: FindingRoute;
  rule: string;
  fix?: string;
  verify?: string;
  /** Set when the safeguard promoted the finding from a cheaper route. */
  promotedFrom?: FindingRoute;
  promotionReason?: string;
}

export function findingMatches(when: FindingsWhen, finding: Finding): boolean {
  if (when.category && !toArray(when.category).includes(finding.category)) return false;
  if (when.severity && !toArray(when.severity).includes(finding.severity)) return false;
  if (when.autofix !== undefined && when.autofix !== finding.autofix) return false;
  if (when.behavior_change !== undefined && when.behavior_change !== finding.behavior_change) return false;
  if (when.affects_ac !== undefined) {
    const affected = finding.affects_ac;
    if (when.affects_ac === "none" && affected.length > 0) return false;
    if (when.affects_ac === "any" && affected.length === 0) return false;
    if (Array.isArray(when.affects_ac) && !when.affects_ac.some((ac) => affected.includes(ac))) return false;
  }
  if (when.files && !matchesAnyGlob(finding.file, when.files)) return false;
  return true;
}

/**
 * The bugbot classifies; the table decides. The same finding always takes the same path.
 * Without a matching rule or default, findings go the safest way: worker then QA.
 */
export function routeFinding(finding: Finding, table: FindingsRouting | "report_only"): RoutedFinding {
  if (table === "report_only") return { finding, route: "report_only", rule: "report only" };
  for (const entry of table) {
    if (isFindingsDefault(entry)) {
      return {
        finding,
        route: entry.default.route,
        rule: "default",
        ...(entry.default.fix ? { fix: entry.default.fix } : {}),
        ...(entry.default.verify ? { verify: entry.default.verify } : {}),
      };
    }
    if (entry.enabled === false || !findingMatches(entry.when, finding)) continue;
    return {
      finding,
      route: entry.route,
      rule: entry.name,
      ...(entry.fix ? { fix: entry.fix } : {}),
      ...(entry.verify ? { verify: entry.verify } : {}),
    };
  }
  return { finding, route: "worker_then_qa", rule: "built-in default" };
}

/**
 * `behavior_change` comes from pluggable detectors; a finding is flagged when any says so.
 * The first detector is the bugbot's own claim, backed by the AC-test safeguard.
 */
export interface BehaviorChangeDetector {
  readonly name: string;
  detect(finding: Finding): boolean | Promise<boolean>;
}

export const bugbotClaimDetector: BehaviorChangeDetector = {
  name: "bugbot claim",
  detect: (finding) => finding.behavior_change,
};

export async function applyDetectors(findings: Finding[], detectors: readonly BehaviorChangeDetector[]): Promise<Finding[]> {
  const result: Finding[] = [];
  for (const finding of findings) {
    let flagged = false;
    for (const detector of detectors) {
      if (await detector.detect(finding)) {
        flagged = true;
        break;
      }
    }
    result.push({ ...finding, behavior_change: flagged });
  }
  return result;
}

export function promote(routed: RoutedFinding, reason: string): RoutedFinding {
  return { ...routed, route: "worker_then_qa", promotedFrom: routed.route, promotionReason: reason };
}
