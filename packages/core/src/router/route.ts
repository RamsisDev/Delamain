import type { RouterRole, TaskKind, TaskSize } from "../schema/common.ts";
import { toArray } from "../schema/common.ts";
import type { HarnessConfig } from "../schema/config.ts";
import {
  DEFAULT_THRESHOLDS,
  type NumberCondition,
  type RouterRule,
  type RuleWhen,
  type Thresholds,
} from "../schema/router.ts";
import { matchesAnyGlob } from "../util/glob.ts";
import { lookupModel, profileKey, resolveTarget, type Catalog, type CatalogModel } from "./catalog.ts";

export interface RouteRequest {
  role: RouterRole;
  kind?: TaskKind;
  est_tokens: number;
  files: number;
  paths: string[];
  needs_tools: boolean;
  max_cost?: number;
  /** Expected output tokens, for the cost estimate. Defaults to a quarter of the input. */
  est_output_tokens?: number;
  /** The step can run on a model without tool calling by exchanging diffs. */
  accepts_diff_mode?: boolean;
  /** Base refs to avoid when possible (QA and bugbot avoid the worker's model). */
  avoid?: string[];
}

export interface ProviderHealthState {
  status: "online" | "offline" | "rate_limited";
  /** When the provider may be tried again. An offline provider without it stays down. */
  untilMs?: number;
}

export interface RouterState {
  now: number;
  providers: Record<string, ProviderHealthState | undefined>;
  /** Base refs a local server no longer has loaded, or that a provider answered 404 for. */
  unavailableModels?: ReadonlySet<string>;
  /** Profile keys (provider@profile) whose session budget ran out. */
  exhaustedProfiles?: ReadonlySet<string>;
  /** Profile keys that cannot authenticate, with the reason: no key stored, or a rejected key. */
  credentialProblems?: ReadonlyMap<string, string>;
}

export interface RouteOptions {
  /** Session override of the principal's model. */
  principal?: string;
  /** Rules matched against the request before the configured ones (agent-block pins). */
  pinned?: { use: string; fallback: string[]; stay_local?: boolean };
}

export interface ChainLink {
  ref: string;
  model: CatalogModel;
  source: "use" | "fallback" | "role" | "principal";
}

export interface SkippedLink {
  ref: string;
  reason: string;
}

export interface RuleEvaluation {
  rule: string;
  matched: boolean;
  /** First condition that did not hold. */
  failed?: string;
}

export interface RouteDecision {
  rule: string;
  reason: string;
  size: TaskSize;
  stayLocal: boolean;
  chain: ChainLink[];
  /** Index in `chain` of the chosen model, or -1 when nothing passes the pre-filter. */
  chosenIndex: number;
  chosen?: ChainLink;
  skipped: SkippedLink[];
  warnings: string[];
  evaluations: RuleEvaluation[];
}

export const DEFAULT_CONTEXT_MARGIN = 2000;

export function computeSize(estTokens: number, files: number, thresholds: Thresholds | undefined): TaskSize {
  const short = thresholds?.short ?? DEFAULT_THRESHOLDS.short;
  const medium = thresholds?.medium ?? DEFAULT_THRESHOLDS.medium;
  if (estTokens <= short.max_tokens && files <= short.max_files) return "short";
  if (estTokens <= medium.max_tokens && files <= medium.max_files) return "medium";
  return "large";
}

function matchNumber(value: number | undefined, condition: NumberCondition): boolean {
  if (value === undefined) return false;
  if (typeof condition === "number") return value === condition;
  if (condition.eq !== undefined && value !== condition.eq) return false;
  if (condition.lt !== undefined && !(value < condition.lt)) return false;
  if (condition.lte !== undefined && !(value <= condition.lte)) return false;
  if (condition.gt !== undefined && !(value > condition.gt)) return false;
  if (condition.gte !== undefined && !(value >= condition.gte)) return false;
  return true;
}

/** Returns the name of the first condition that fails, or undefined when the rule matches. */
export function failedCondition(when: RuleWhen, request: RouteRequest, size: TaskSize): string | undefined {
  if (when.kind && (!request.kind || !toArray(when.kind).includes(request.kind))) return "kind";
  if (when.size && !toArray(when.size).includes(size)) return "size";
  if (when.est_tokens !== undefined && !matchNumber(request.est_tokens, when.est_tokens)) return "est_tokens";
  if (when.files !== undefined && !matchNumber(request.files, when.files)) return "files";
  if (when.paths && !request.paths.some((path) => matchesAnyGlob(path, when.paths!))) return "paths";
  if (when.needs_tools !== undefined && when.needs_tools !== request.needs_tools) return "needs_tools";
  if (when.role && !toArray(when.role).includes(request.role)) return "role";
  if (when.max_cost !== undefined && !matchNumber(request.max_cost, when.max_cost)) return "max_cost";
  return undefined;
}

export function estimateCost(model: CatalogModel, request: RouteRequest): number | undefined {
  const output = request.est_output_tokens ?? Math.ceil(request.est_tokens / 4);
  return usageCost(model, { input: request.est_tokens, output });
}

/**
 * Cost of the tokens a call used, or undefined when the model has no pricing. `input` includes
 * the cached tokens, which use the cached price when the model has one.
 */
export function usageCost(model: CatalogModel, usage: { input: number; output: number; cached?: number }): number | undefined {
  if (!model.pricing) return model.local ? 0 : undefined;
  const { input_per_mtok, output_per_mtok, cached_per_mtok } = model.pricing;
  const cached = Math.min(usage.cached ?? 0, usage.input);
  return ((usage.input - cached) * input_per_mtok + cached * (cached_per_mtok ?? input_per_mtok) + usage.output * output_per_mtok) / 1_000_000;
}

/** The principal's model: the session override, else the first model of the default route. */
export function principalModel(config: HarnessConfig, catalog: Catalog, options: RouteOptions = {}): CatalogModel | undefined {
  if (options.principal) return lookupModel(catalog, options.principal);
  const fallback = config.router?.default;
  const targets = fallback ? [fallback.use] : ["role:orchestrator"];
  for (const target of targets) {
    const [first] = resolveTarget(catalog, target);
    if (first) return first;
  }
  return resolveTarget(catalog, "role:orchestrator")[0];
}

/** Why a model cannot serve the request right now, or undefined when it can. */
export function prefilterReason(
  model: CatalogModel,
  request: RouteRequest,
  catalog: Catalog,
  state: RouterState,
  margin: number,
): string | undefined {
  const provider = catalog.providers.get(model.provider);
  if (!provider) return "provider not configured";
  const health = state.providers[model.provider];
  if (health?.status === "offline") {
    if (health.untilMs === undefined) return "provider offline";
    if (health.untilMs > state.now) return `provider offline, retried in ${Math.ceil((health.untilMs - state.now) / 1000)} s`;
  }
  if (health?.status === "rate_limited" && (health.untilMs ?? 0) > state.now) {
    return `rate limited for ${Math.ceil(((health.untilMs ?? 0) - state.now) / 1000)} s`;
  }
  if (state.unavailableModels?.has(model.baseRef)) return "model not available";
  const credential = state.credentialProblems?.get(profileKey(model));
  if (credential) return credential;
  if (state.exhaustedProfiles?.has(profileKey(model))) return "session budget of this profile ran out";
  if (model.contextWindow !== undefined && model.contextWindow < request.est_tokens + margin) {
    return `context window ${model.contextWindow} < ${request.est_tokens + margin} tokens needed`;
  }
  const tools = model.providerType === "cli" || (model.toolCalling ?? !model.local);
  if (request.needs_tools && !tools && !request.accepts_diff_mode) return "no tool calling";
  if (request.max_cost !== undefined) {
    const cost = estimateCost(model, request);
    if (cost !== undefined && cost > request.max_cost) {
      return `estimated cost $${cost.toFixed(4)} above max_cost $${request.max_cost}`;
    }
  }
  return undefined;
}

/**
 * Pure routing function: picks a rule, builds the model chain and selects the first model that
 * passes the pre-filter. Same inputs, same decision.
 */
export function route(
  request: RouteRequest,
  config: HarnessConfig,
  catalog: Catalog,
  state: RouterState,
  options: RouteOptions = {},
): RouteDecision {
  const router = config.router ?? {};
  const size = computeSize(request.est_tokens, request.files, router.thresholds);
  const margin = router.context_margin_tokens ?? DEFAULT_CONTEXT_MARGIN;
  const evaluations: RuleEvaluation[] = [];
  const warnings: string[] = [];

  let matched: { name: string; use: string; fallback: string[]; stayLocal: boolean; reason: string } | undefined;
  if (options.pinned) {
    matched = {
      name: "pinned",
      use: options.pinned.use,
      fallback: options.pinned.fallback,
      stayLocal: options.pinned.stay_local === true,
      reason: "model pinned on the block",
    };
  } else if (request.role === "orchestrator" && options.principal) {
    matched = {
      name: "session principal",
      use: options.principal,
      fallback: router.default?.fallback ?? [],
      stayLocal: false,
      reason: "principal chosen for this conversation",
    };
  } else {
    for (const rule of router.rules ?? []) {
      if (rule.enabled === false) {
        evaluations.push({ rule: rule.name, matched: false, failed: "disabled" });
        continue;
      }
      const roleless = rule.when.role === undefined && request.role === "orchestrator";
      const failed = matched ? "skipped" : roleless ? "role" : failedCondition(rule.when, request, size);
      evaluations.push({ rule: rule.name, matched: !failed, ...(failed ? { failed } : {}) });
      if (!failed && !matched) matched = fromRule(rule);
    }
  }

  const links: ChainLink[] = [];
  const add = (target: string, source: ChainLink["source"]) => {
    for (const model of resolveTarget(catalog, target)) {
      if (!links.some((l) => l.ref === model.ref)) links.push({ ref: model.ref, model, source });
    }
    if (!target.startsWith("role:") && !lookupModel(catalog, target)) {
      warnings.push(`"${target}" points to an unknown provider and was left out of the chain`);
    }
  };

  let ruleName: string;
  let reason: string;
  const stayLocal = matched?.stayLocal ?? false;
  const reviewRole = request.role === "qa" || request.role === "reviewer" ? request.role : undefined;
  if (matched) {
    ruleName = matched.name;
    reason = matched.reason;
    const ruleNamesRole = (router.rules ?? []).find((r) => r.name === matched!.name)?.when.role !== undefined;
    if (reviewRole && !ruleNamesRole && !options.pinned) {
      add(`role:${reviewRole}`, "role");
      reason = `${reason}; ${reviewRole} favorites first`;
    }
    add(matched.use, "use");
    matched.fallback.forEach((t) => add(t, "fallback"));
  } else {
    if (reviewRole) add(`role:${reviewRole}`, "role");
    const fallback = router.default;
    ruleName = "default";
    reason = reviewRole ? `no rule matched; ${reviewRole} favorites first` : "no rule matched";
    if (fallback) {
      add(fallback.use, "use");
      fallback.fallback.forEach((t) => add(t, "fallback"));
    } else {
      add("role:orchestrator", "use");
    }
  }

  if (!stayLocal) {
    const principal = principalModel(config, catalog, options);
    if (principal && !links.some((l) => l.ref === principal.ref)) {
      links.push({ ref: principal.ref, model: principal, source: "principal" });
    }
  } else {
    const remote = links.filter((l) => !l.model.local);
    for (const link of remote) {
      warnings.push(`${link.ref} is not local and was removed from a stay_local chain`);
    }
    for (let i = links.length - 1; i >= 0; i--) if (!links[i]!.model.local) links.splice(i, 1);
  }

  const skipped: SkippedLink[] = [];
  const usable: number[] = [];
  links.forEach((link, index) => {
    const why = prefilterReason(link.model, request, catalog, state, margin);
    if (why) skipped.push({ ref: link.ref, reason: why });
    else usable.push(index);
  });

  const avoid = new Set(request.avoid ?? []);
  let chosenIndex = usable.find((i) => !avoid.has(links[i]!.model.baseRef)) ?? -1;
  if (chosenIndex === -1 && usable.length > 0) {
    chosenIndex = usable[0]!;
    if (avoid.size) warnings.push(`No other model available; ${links[chosenIndex]!.ref} is the same model as the worker`);
  }
  const chosen = chosenIndex >= 0 ? links[chosenIndex] : undefined;
  return {
    rule: ruleName,
    reason,
    size,
    stayLocal,
    chain: links,
    chosenIndex,
    ...(chosen ? { chosen } : {}),
    skipped,
    warnings,
    evaluations,
  };
}

function fromRule(rule: RouterRule) {
  return {
    name: rule.name,
    use: rule.use,
    fallback: rule.fallback,
    stayLocal: rule.stay_local === true,
    reason: `rule: ${rule.name}`,
  };
}

export type AdvanceCause = "rate_limit" | "unavailable" | "not_found" | "auth" | "context_length" | "budget" | "loop_exhausted";

/**
 * Next usable link after `from`. On provider limits it skips every other link of the same
 * provider: switching accounts never works around a provider's limits. Budget exhaustion and a
 * rejected key may move to the same model on another of the user's profiles; a model the
 * provider does not have is skipped under every profile.
 */
export function advanceChain(
  decision: Pick<RouteDecision, "chain">,
  from: number,
  cause: AdvanceCause,
  request: RouteRequest,
  catalog: Catalog,
  state: RouterState,
  margin = DEFAULT_CONTEXT_MARGIN,
): number | undefined {
  const current = decision.chain[from];
  for (let i = from + 1; i < decision.chain.length; i++) {
    const link = decision.chain[i]!;
    if (current && (cause === "rate_limit" || cause === "unavailable") && link.model.provider === current.model.provider) {
      continue;
    }
    if (current && (cause === "budget" || cause === "auth") && profileKey(link.model) === profileKey(current.model)) continue;
    if (current && cause === "not_found" && link.model.baseRef === current.model.baseRef) continue;
    if (
      cause === "context_length" &&
      current?.model.contextWindow !== undefined &&
      (link.model.contextWindow ?? Infinity) <= current.model.contextWindow
    ) {
      continue;
    }
    if (!prefilterReason(link.model, request, catalog, state, margin)) return i;
  }
  return undefined;
}

export function describeDecision(decision: RouteDecision, task?: string): string {
  const who = decision.chosen ? decision.chosen.model.label : "no model available";
  return `${task ? `${task} → ` : ""}${who} (${decision.reason})`;
}
