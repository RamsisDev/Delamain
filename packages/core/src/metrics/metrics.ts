import type { HarnessEvent } from "../events/types.ts";
import type { RateLimitSnapshot } from "../providers/types.ts";

export interface Counter {
  tokens: number;
  input: number;
  output: number;
  cached: number;
  costUsd: number;
  calls: number;
}

export interface SessionMetrics {
  session: string;
  byRole: Record<string, Counter>;
  byModel: Record<string, Counter & { local: boolean }>;
  byProfile: Record<string, Counter>;
  /** Last reading of each profile's rate-limit headers. */
  rateLimits: Record<string, RateLimitSnapshot & { at: number }>;
  attempts: Record<string, number>;
  escalations: { total: number; byTask: Record<string, number>; byRaiser: Record<string, number> };
  findings: { byRoute: Record<string, number>; promoted: number; qaRoundsAvoided: number };
  modelSwitches: Record<string, number>;
  durationMs: number;
}

function counter(): Counter {
  return { tokens: 0, input: 0, output: 0, cached: 0, costUsd: 0, calls: 0 };
}

function add(target: Counter, input: number, output: number, cached: number, cost: number): void {
  target.input += input;
  target.output += output;
  target.cached += cached;
  target.tokens += input + output;
  target.costUsd += cost;
  target.calls += 1;
}

/**
 * Aggregated counters per session, role, model and profile. Kept locally only; they show how
 * much of the quota goes to the expensive model and how much was delegated.
 */
export function computeMetrics(events: readonly HarnessEvent[], localProviders: ReadonlySet<string> = new Set()): SessionMetrics {
  const metrics: SessionMetrics = {
    session: events[0]?.session ?? "",
    byRole: {},
    byModel: {},
    byProfile: {},
    rateLimits: {},
    attempts: {},
    escalations: { total: 0, byTask: {}, byRaiser: {} },
    findings: { byRoute: {}, promoted: 0, qaRoundsAvoided: 0 },
    modelSwitches: {},
    durationMs: events.length ? events.at(-1)!.ts - events[0]!.ts : 0,
  };
  const reviewRounds = new Map<string, { mechanical: number; needsQa: boolean }>();
  for (const event of events) {
    switch (event.type) {
      case "usage": {
        const cached = event.cached ?? 0;
        const cost = event.costUsd ?? 0;
        add((metrics.byRole[event.role] ??= counter()), event.input, event.output, cached, cost);
        const model = (metrics.byModel[event.model] ??= { ...counter(), local: localProviders.has(event.provider) });
        add(model, event.input, event.output, cached, cost);
        const profile = event.profile ? `${event.provider}@${event.profile}` : event.provider;
        add((metrics.byProfile[profile] ??= counter()), event.input, event.output, cached, cost);
        break;
      }
      case "provider.limits": {
        const { provider, profile, requestsRemaining, tokensRemaining, resetAt } = event;
        metrics.rateLimits[profile ? `${provider}@${profile}` : provider] = {
          ...(requestsRemaining !== undefined ? { requestsRemaining } : {}),
          ...(tokensRemaining !== undefined ? { tokensRemaining } : {}),
          ...(resetAt !== undefined ? { resetAt } : {}),
          at: event.ts,
        };
        break;
      }
      case "loop.iteration":
        if (event.task) metrics.attempts[event.task] = (metrics.attempts[event.task] ?? 0) + 1;
        break;
      case "escalation.raised": {
        metrics.escalations.total++;
        const task = event.escalation.task ?? "session";
        metrics.escalations.byTask[task] = (metrics.escalations.byTask[task] ?? 0) + 1;
        metrics.escalations.byRaiser[event.escalation.raised_by] = (metrics.escalations.byRaiser[event.escalation.raised_by] ?? 0) + 1;
        break;
      }
      case "finding.routed": {
        if (event.status !== "pending" || event.promotedFrom) {
          if (event.promotedFrom) metrics.findings.promoted++;
        }
        if (event.status === "pending" && !event.promotedFrom) {
          metrics.findings.byRoute[event.route] = (metrics.findings.byRoute[event.route] ?? 0) + 1;
        }
        const round = reviewRounds.get(event.key) ?? { mechanical: 0, needsQa: false };
        if (event.status === "fixed") round.mechanical++;
        if (event.route === "worker_then_qa" && event.status === "pending") round.needsQa = true;
        reviewRounds.set(event.key, round);
        break;
      }
      case "router.switch":
        metrics.modelSwitches[event.cause] = (metrics.modelSwitches[event.cause] ?? 0) + 1;
        break;
      default:
        break;
    }
  }
  for (const round of reviewRounds.values()) if (round.mechanical > 0 && !round.needsQa) metrics.findings.qaRoundsAvoided++;
  return metrics;
}

/** Share of tokens spent on the principal versus delegated and local work. */
export function tokenSplit(metrics: SessionMetrics): { principal: number; delegated: number; local: number } {
  const principal = metrics.byRole.principal?.tokens ?? 0;
  const local = Object.values(metrics.byModel).filter((m) => m.local).reduce((a, m) => a + m.tokens, 0);
  const total = Object.values(metrics.byRole).reduce((a, c) => a + c.tokens, 0);
  return { principal, local, delegated: Math.max(0, total - principal - local) };
}
