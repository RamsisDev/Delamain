import { stayLocalIssues } from "../config/validate.ts";
import type { AgentDefinition } from "../schema/agent.ts";
import { AGENT_ROLES, type AgentRole } from "../schema/common.ts";
import type { HarnessConfig } from "../schema/config.ts";
import type { AgentBlock, Block, Flow, LoopBlock } from "../schema/flow.ts";
import { isContainer } from "../schema/flow.ts";
import type { ResolvedLimits } from "../schema/limits.ts";
import { error, warning, type Issue } from "../util/issues.ts";
import { closestMatch } from "../util/suggest.ts";
import { ExpressionError, parseExpression, references } from "./expression.ts";

export interface BlockVisit {
  block: Block;
  /** Path of the block inside the flow file, e.g. ["steps", 0, "body", 1]. */
  path: (string | number)[];
  /** Enclosing containers, outermost first. */
  ancestors: Block[];
  siblings: Block[];
  index: number;
}

export function walkBlocks(steps: Block[], visit: (v: BlockVisit) => void, base: (string | number)[] = ["steps"], ancestors: Block[] = []): void {
  steps.forEach((block, index) => {
    const path = [...base, index];
    visit({ block, path, ancestors, siblings: steps, index });
    if (isContainer(block)) walkBlocks(block.body, visit, [...path, "body"], [...ancestors, block]);
  });
}

export function findBlock(steps: Block[], id: string): BlockVisit | undefined {
  let found: BlockVisit | undefined;
  walkBlocks(steps, (v) => {
    if (!found && v.block.id === id) found = v;
  });
  return found;
}

/** Effective dependencies: explicit `after`, or the previous sibling. */
export function dependenciesOf(block: Block, siblings: Block[], index: number): string[] {
  if (block.after) return block.after;
  return index > 0 ? [siblings[index - 1]!.id] : [];
}

export function agentRoleOf(block: { agent: string }, agents?: ReadonlyMap<string, AgentDefinition>): AgentRole | undefined {
  const agent = agents?.get(block.agent);
  if (agent) return agent.role;
  return (AGENT_ROLES as readonly string[]).includes(block.agent) ? (block.agent as AgentRole) : undefined;
}

export function producesSpec(block: AgentBlock, agents?: ReadonlyMap<string, AgentDefinition>): boolean {
  return agentRoleOf(block, agents) === "principal" && block.output === "spec";
}

const COMMON_OUTPUTS = ["status"];
const AGENT_OUTPUTS: Record<AgentRole | "principal-spec", string[]> = {
  "principal-spec": ["spec", "pending_tasks", "tasks", "version", "summary", "answer"],
  principal: ["approved", "delta", "notes", "rejected_tasks"],
  worker: ["diff", "notes", "files_changed"],
  qa: ["passed", "missing", "results", "added_tests"],
  bugbot: ["findings", "passed"],
};
const TYPE_OUTPUTS: Record<Exclude<Block["type"], "agent" | "script">, string[]> = {
  command: ["passed", "exit_code", "failures", "output", "signature", "duration_ms"],
  review: ["passed", "needs_qa", "routed_findings", "report_only", "findings", "round"],
  condition: ["value"],
  loop: ["passed", "iterations", "exhausted"],
  foreach: ["passed", "diff", "results", "failed_tasks", "done_tasks"],
  approval: ["approved", "note"],
  subflow: ["passed", "outputs"],
};

/** Outputs a block exposes, or undefined when any field is allowed (scripts, unknown agents). */
export function blockOutputs(block: Block, agents?: ReadonlyMap<string, AgentDefinition>): string[] | undefined {
  if (block.type === "script") return undefined;
  if (block.type === "agent") {
    const role = agentRoleOf(block, agents);
    if (!role) return undefined;
    const key = producesSpec(block, agents) ? "principal-spec" : role;
    return [...COMMON_OUTPUTS, "text", "model", "tokens", ...AGENT_OUTPUTS[key]];
  }
  return [...COMMON_OUTPUTS, ...TYPE_OUTPUTS[block.type]];
}

const SPECIAL_ROOTS = new Set(["loop", "task", "spec", "session", "success", "failure", "always", "finding"]);

/** The rules every flow issue is filed under (`Issue.check`), in the order verifiers list them. */
export const FLOW_CHECKS = ["cycles", "orphans", "references", "subflows", "caps", "worst-case", "structure"] as const;
export type FlowCheck = (typeof FLOW_CHECKS)[number];

function tagged(check: FlowCheck, issue: Issue, replace?: Issue["replace"]): Issue {
  return { ...issue, check, ...(replace ? { replace } : {}) };
}

/** The flows other flows can reuse: flows/<file>.yml files and orchestrations marked `reusable`. */
export interface FlowLibrary {
  resolve(ref: string): Flow | undefined;
  /** Every ref that resolves, for suggestions. */
  refs: readonly string[];
  /** Orchestrations that exist but are not marked `reusable`. */
  unmarked: readonly string[];
}

/**
 * A flows/ file is found by its path (flows/<file>.yml) or its name, an orchestration by its
 * name. flows/ files win when both have the same name.
 */
export function flowLibrary(subflows: ReadonlyMap<string, Flow>, orchestrations: ReadonlyMap<string, Flow>): FlowLibrary {
  const reusable = new Map([...orchestrations].filter(([, flow]) => flow.reusable === true));
  return {
    resolve: (ref) => {
      const base = ref.replace(/^flows\//, "").replace(/\.ya?ml$/, "");
      return subflows.get(ref) ?? subflows.get(`flows/${base}.yml`) ?? subflows.get(base) ?? reusable.get(ref);
    },
    refs: [...new Set([...subflows.keys(), ...reusable.keys()])],
    unmarked: [...orchestrations.keys()].filter((name) => !reusable.has(name)),
  };
}

/** Flows a block reuses: a subflow block's flow and its run_flow completion actions. */
export function reusedBy(block: Block): { ref: string; path: (string | number)[] }[] {
  return [
    ...(block.type === "subflow" ? [{ ref: block.flow, path: ["flow"] }] : []),
    ...(block.on_finish ?? []).flatMap((action, i) => (action.run_flow ? [{ ref: action.run_flow, path: ["on_finish", i, "run_flow"] }] : [])),
  ];
}

/** The library as it will be once `draft` is saved, even when the draft is new. */
function libraryWithDraft(library: FlowLibrary, draft: Flow): FlowLibrary {
  const reusable = draft.reusable === true;
  return {
    resolve: (ref) => {
      const found = library.resolve(ref);
      const isDraft = found?.name === draft.name || (!found && ref === draft.name);
      if (!isDraft) return found;
      return reusable ? draft : undefined;
    },
    refs: reusable ? [...new Set([...library.refs, draft.name])] : library.refs.filter((ref) => ref !== draft.name),
    unmarked: reusable ? library.unmarked.filter((name) => name !== draft.name) : [...new Set([...library.unmarked, draft.name])],
  };
}

/** The first chain of reuses from `flow` that comes back to a flow already in it, e.g. [a, b, a]. */
function reuseCycle(flow: Flow, library: FlowLibrary, chain: readonly string[], done: Set<string>): string[] | undefined {
  const at = chain.indexOf(flow.name);
  if (at >= 0) return [...chain.slice(at), flow.name];
  if (done.has(flow.name)) return undefined;
  let found: string[] | undefined;
  walkBlocks(flow.steps, ({ block }) => {
    for (const { ref } of reusedBy(block)) {
      const target = found ? undefined : library.resolve(ref);
      if (target) found = reuseCycle(target, library, [...chain, flow.name], done);
    }
  });
  if (!found) done.add(flow.name);
  return found;
}

export interface FlowValidationContext {
  limits: ResolvedLimits;
  agents?: ReadonlyMap<string, AgentDefinition>;
  /** Length of the longest model chain, to compute the worst case total. */
  chainLength?: number;
  /** Flows subflow blocks can reuse; without it reused flows are not checked. */
  library?: FlowLibrary;
  /** Providers and favorites, to check that stay_local blocks only pin local models. */
  config?: Pick<HarnessConfig, "providers" | "models">;
}

export function validateFlow(flow: Flow, context: FlowValidationContext): Issue[] {
  const issues: Issue[] = [];
  const ids = new Map<string, Block>();
  walkBlocks(flow.steps, ({ block, path }) => {
    if (ids.has(block.id)) issues.push(tagged("structure", error([...path, "id"], `Duplicate block id "${block.id}"`)));
    ids.set(block.id, block);
  });

  const checkExpression = (source: string, path: (string | number)[], insideLoop: boolean) => {
    const reference = (message: string, replace?: Issue["replace"]) =>
      issues.push(tagged("references", error(path, replace ? `${message}. Did you mean "${replace.to}"?` : message), replace));
    let refs: string[][];
    try {
      refs = references(parseExpression(source));
    } catch (e) {
      const position = e instanceof ExpressionError ? ` at ${e.position + 1}` : "";
      reference(`Invalid expression${position}: ${(e as Error).message}`);
      return;
    }
    for (const ref of refs) {
      const [root, field, ...rest] = ref;
      if (!root) continue;
      if (root === "loop" && !insideLoop) {
        reference("loop.* can only be used inside a Loop");
        continue;
      }
      const target = ids.get(root);
      if (!target) {
        if (SPECIAL_ROOTS.has(root)) continue;
        const guess = closestMatch(root, ids.keys());
        reference(`Unknown block or variable "${root}"`, guess ? { from: ref.join("."), to: [guess, ...ref.slice(1)].join(".") } : undefined);
        continue;
      }
      if (!field) continue;
      const outputs = blockOutputs(target, context.agents);
      if (outputs && !outputs.includes(field)) {
        const guess = closestMatch(field, outputs);
        reference(
          `Block "${root}" has no output "${field}". Available: ${outputs.join(", ")}`,
          guess ? { from: ref.join("."), to: [root, guess, ...rest].join(".") } : undefined,
        );
      }
    }
  };

  const library = context.library && libraryWithDraft(context.library, flow);
  const checkReuse = (ref: string, path: (string | number)[]) => {
    if (!library) return;
    const target = library.resolve(ref);
    if (!target && library.unmarked.includes(ref)) {
      issues.push(tagged("subflows", error(path, `"${ref}" is not marked as reusable`)));
      return;
    }
    if (!target) {
      const guess = closestMatch(ref, library.refs);
      const message = `No reusable flow named "${ref}"`;
      issues.push(
        tagged("subflows", error(path, guess ? `${message}. Did you mean "${guess}"?` : message), guess ? { from: ref, to: guess } : undefined),
      );
      return;
    }
    const cycle = reuseCycle(target, library, [flow.name], new Set());
    if (cycle) {
      const message =
        cycle.length === 2
          ? `"${cycle[0]}" reuses itself, so it would never finish`
          : `Flows reuse each other in a circle and would never finish: ${cycle.join(" → ")}`;
      issues.push(tagged("subflows", error(path, message)));
    }
  };

  walkBlocks(flow.steps, ({ block, path, ancestors, siblings, index }) => {
    const insideLoop = ancestors.some((a) => a.type === "loop") || block.type === "loop";
    const parentInLoop = ancestors.some((a) => a.type === "loop");
    const siblingIds = new Set(siblings.map((s) => s.id));
    (block.after ?? []).forEach((dep, i) => {
      if (dep === block.id) issues.push(tagged("structure", error([...path, "after", i], "A block cannot wait for itself")));
      else if (!siblingIds.has(dep)) {
        issues.push(tagged("structure", error([...path, "after", i], `"${dep}" is not a block at the same level`)));
      }
    });
    if (block.when && !["success", "failure", "always"].includes(block.when)) {
      checkExpression(block.when, [...path, "when"], parentInLoop);
    }
    (block.on_finish ?? []).forEach((action, i) => {
      if (action.when && !["success", "failure", "always"].includes(action.when)) {
        checkExpression(action.when, [...path, "on_finish", i, "when"], parentInLoop);
      }
    });
    for (const reuse of reusedBy(block)) checkReuse(reuse.ref, [...path, ...reuse.path]);

    switch (block.type) {
      case "loop": {
        checkExpression(block.until, [...path, "until"], true);
        if (block.max_iterations > context.limits.max_loop_iterations) {
          issues.push(
            tagged(
              "caps",
              error(
                [...path, "max_iterations"],
                `max_iterations ${block.max_iterations} exceeds the global cap of ${context.limits.max_loop_iterations}`,
              ),
            ),
          );
        }
        const depth = ancestors.filter((a) => a.type === "loop").length + 1;
        if (depth > context.limits.max_nested_loops) {
          issues.push(tagged("caps", error(path, `Loops are nested ${depth} deep; the cap is ${context.limits.max_nested_loops}`)));
        }
        break;
      }
      case "foreach":
        checkExpression(block.over, [...path, "over"], parentInLoop);
        break;
      case "condition":
        checkExpression(block.expr, [...path, "expr"], parentInLoop);
        break;
      case "agent":
      case "review": {
        if (context.agents && !context.agents.has(block.agent)) {
          issues.push(tagged("structure", error([...path, "agent"], `No agent named "${block.agent}"`)));
        }
        if (block.model && !block.model.startsWith("role:") && !(block.fallback?.length)) {
          issues.push(tagged("structure", error([...path, "fallback"], "A pinned model needs at least one backup model")));
        }
        if (block.type === "agent" && block.stay_local) {
          if (!block.model) {
            issues.push(tagged("structure", warning([...path, "stay_local"], "stay_local only applies to a pinned model; set one on this block")));
          } else if (context.config) {
            const config = context.config;
            const local = [
              ...stayLocalIssues(block.model, [...path, "model"], config),
              ...(block.fallback ?? []).flatMap((target, i) => stayLocalIssues(target, [...path, "fallback", i], config)),
            ];
            issues.push(...local.map((issue) => tagged("structure", issue)));
          }
        }
        if (block.type === "agent") {
          const inputs = Array.isArray(block.input) ? block.input : block.input ? [block.input] : [];
          inputs.forEach((input, i) => checkExpression(input, [...path, "input", i], parentInLoop));
          (block.feedback ?? []).forEach((f, i) => checkExpression(f, [...path, "feedback", i], parentInLoop));
        }
        break;
      }
      default:
        break;
    }
    void index;
  });

  checkSiblingGraphs(flow.steps, ["steps"], issues);

  const worst = worstCase(flow, context);
  if (worst.perModel > context.limits.worst_case_warning) {
    issues.push(
      tagged(
        "worst-case",
        warning(
          ["steps"],
          `Worst case: ${worst.perModel} worker runs per task per model (warning above ${context.limits.worst_case_warning})`,
        ),
      ),
    );
  }
  return issues;
}

function checkSiblingGraphs(steps: Block[], base: (string | number)[], issues: Issue[]): void {
  const deps = new Map<string, string[]>();
  steps.forEach((block, index) => deps.set(block.id, dependenciesOf(block, steps, index)));
  const state = new Map<string, "visiting" | "done">();
  const visit = (id: string, trail: string[]): boolean => {
    if (state.get(id) === "done") return false;
    if (state.get(id) === "visiting") {
      const index = steps.findIndex((s) => s.id === id);
      issues.push(
        tagged(
          "cycles",
          error([...base, index, "after"], `Cycle ${[...trail, id].join(" → ")}: cycles are only allowed inside a Loop`),
        ),
      );
      return true;
    }
    state.set(id, "visiting");
    for (const dep of deps.get(id) ?? []) if (deps.has(dep) && visit(dep, [...trail, id])) break;
    state.set(id, "done");
    return false;
  };
  for (const block of steps) visit(block.id, []);

  if (steps.length > 1) {
    const dependedOn = new Set([...deps.values()].flat());
    steps.forEach((block, index) => {
      const incoming = deps.get(block.id) ?? [];
      if (incoming.length === 0 && !dependedOn.has(block.id) && index > 0) {
        issues.push(tagged("orphans", warning([...base, index], `Block "${block.id}" is not connected to anything`)));
      }
    });
  }
  steps.forEach((block, index) => {
    if (isContainer(block)) checkSiblingGraphs(block.body, [...base, index, "body"], issues);
  });
}

export interface WorstCase {
  /** Maximum worker runs per task with a single model. */
  perModel: number;
  /** perModel multiplied by the model chain length, when known. */
  total?: number;
  /**
   * Loops multiplied to get the figure, outermost first. `via` is the block of this flow that
   * reuses the flow the loop belongs to.
   */
  loops: { id: string; max: number; via?: string }[];
}

/**
 * Multiplies the maxima of the loops around every worker block and keeps the largest. Reused
 * flows count as if their blocks were written where they are reused.
 */
export function worstCase(flow: Flow, context: Pick<FlowValidationContext, "agents" | "chainLength" | "library"> = {}): WorstCase {
  let best: WorstCase = { perModel: 0, loops: [] };
  const visit = (steps: Block[], outer: WorstCase["loops"], via: string | undefined, chain: readonly string[]) => {
    walkBlocks(steps, ({ block, ancestors }) => {
      const loops = [
        ...outer,
        ...ancestors
          .filter((a): a is LoopBlock => a.type === "loop")
          .map((loop) => ({ id: loop.id, max: loop.max_iterations, ...(via ? { via } : {}) })),
      ];
      if (block.type === "agent" && agentRoleOf(block, context.agents) === "worker") {
        const perModel = loops.reduce((acc, loop) => acc * loop.max, 1);
        if (perModel > best.perModel) best = { perModel, loops };
      }
      for (const { ref } of context.library ? reusedBy(block) : []) {
        const target = context.library!.resolve(ref);
        if (target && !chain.includes(target.name)) visit(target.steps, loops, via ?? block.id, [...chain, target.name]);
      }
    });
  };
  visit(flow.steps, [], undefined, [flow.name]);
  if (context.chainLength) best.total = best.perModel * context.chainLength;
  return best;
}
