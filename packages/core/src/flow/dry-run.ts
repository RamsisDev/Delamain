import type { Catalog } from "../router/catalog.ts";
import { route, type RouteDecision, type RouteRequest, type RouterState } from "../router/route.ts";
import type { AgentDefinition } from "../schema/agent.ts";
import { AGENT_ROLE_TO_ROUTER_ROLE } from "../schema/common.ts";
import type { HarnessConfig } from "../schema/config.ts";
import type { Block, Flow } from "../schema/flow.ts";
import { resolveLimits } from "../schema/limits.ts";
import type { Issue } from "../util/issues.ts";
import { agentRoleOf, validateFlow, walkBlocks, worstCase, type FlowLibrary, type WorstCase } from "./graph.ts";

export interface DryRunStep {
  id: string;
  type: Block["type"];
  depth: number;
  label: string;
  detail?: string;
  model?: string;
  rule?: string;
  chain?: string[];
  warnings?: string[];
}

export interface DryRunReport {
  flow: string;
  steps: DryRunStep[];
  worstCase: WorstCase;
  issues: Issue[];
}

/** Shows the steps, the models that would be used and the worst case, without spending tokens. */
export function dryRun(
  flow: Flow,
  config: HarnessConfig,
  agents: ReadonlyMap<string, AgentDefinition>,
  catalog: Catalog,
  options: { principal?: string; sample?: Partial<RouteRequest>; library?: FlowLibrary } = {},
): DryRunReport {
  const state: RouterState = { now: Date.now(), providers: {} };
  const steps: DryRunStep[] = [];
  let longestChain = 0;
  walkBlocks(flow.steps, ({ block, ancestors }) => {
    const step: DryRunStep = { id: block.id, type: block.type, depth: ancestors.length, label: block.label ?? block.id };
    if (block.type === "agent" || block.type === "review") {
      const role = agentRoleOf(block, agents);
      if (role) {
        const request: RouteRequest = {
          role: AGENT_ROLE_TO_ROUTER_ROLE[role],
          est_tokens: 8000,
          files: 2,
          paths: [],
          needs_tools: true,
          ...(role === "worker" ? { kind: "feature" as const } : {}),
          ...options.sample,
        };
        const pin = block.model ? { pinned: { use: block.model, fallback: block.fallback ?? [], ...(block.type === "agent" && block.stay_local ? { stay_local: true } : {}) } } : {};
        const decision: RouteDecision = route(request, config, catalog, state, { ...(options.principal ? { principal: options.principal } : {}), ...pin });
        step.model = decision.chosen?.model.label ?? "no model available";
        step.rule = decision.rule;
        step.chain = decision.chain.map((l) => l.ref);
        step.warnings = decision.warnings;
        longestChain = Math.max(longestChain, decision.chain.length);
      }
      step.detail = `${block.agent}${role ? ` (${role})` : ""}`;
    } else if (block.type === "command") step.detail = block.run;
    else if (block.type === "loop") step.detail = `up to ${block.max_iterations} × until ${block.until}`;
    else if (block.type === "foreach") step.detail = `for each in ${block.over}`;
    else if (block.type === "approval") step.detail = block.mode ?? "auto";
    else if (block.type === "condition") step.detail = block.expr;
    else if (block.type === "subflow") step.detail = block.flow;
    else if (block.type === "script") step.detail = block.run;
    steps.push(step);
  });
  const limits = resolveLimits(config.limits);
  const library = options.library ? { library: options.library } : {};
  return {
    flow: flow.name,
    steps,
    worstCase: worstCase(flow, { agents, chainLength: longestChain || 1, ...library }),
    issues: validateFlow(flow, { limits, agents, config, ...library }),
  };
}
