import { z } from "zod";
import { DURATION_PATTERN } from "../util/duration.ts";

export const SCHEMA_VERSION = 1;

export const schemaVersion = z
  .literal(SCHEMA_VERSION)
  .describe("Format version of this file. The extension migrates older versions on load.");

/** Roles a favorite model can take; the router resolves `role:<name>` against them. */
export const FAVORITE_ROLES = [
  "orchestrator",
  "orchestrator-fallback",
  "worker",
  "reviewer",
  "qa",
  "short-tasks",
] as const;
export const FavoriteRole = z.enum(FAVORITE_ROLES);
export type FavoriteRole = z.infer<typeof FavoriteRole>;

/** Which flow step is asking the router for a model. */
export const ROUTER_ROLES = ["orchestrator", "worker", "qa", "reviewer", "short-tasks"] as const;
export const RouterRole = z.enum(ROUTER_ROLES);
export type RouterRole = z.infer<typeof RouterRole>;

/** Roles an agent file can play inside a flow. */
export const AGENT_ROLES = ["principal", "worker", "qa", "bugbot"] as const;
export const AgentRole = z.enum(AGENT_ROLES);
export type AgentRole = z.infer<typeof AgentRole>;

export const AGENT_ROLE_TO_ROUTER_ROLE: Record<AgentRole, RouterRole> = {
  principal: "orchestrator",
  worker: "worker",
  qa: "qa",
  bugbot: "reviewer",
};

export const TASK_KINDS = [
  "rename",
  "docstring",
  "format",
  "small-edit",
  "feature",
  "tests",
  "refactor",
  "review",
  "research",
] as const;
export const TaskKind = z.enum(TASK_KINDS);
export type TaskKind = z.infer<typeof TaskKind>;

export const TASK_SIZES = ["short", "medium", "large"] as const;
export const TaskSize = z.enum(TASK_SIZES);
export type TaskSize = z.infer<typeof TaskSize>;

export const FINDING_SEVERITIES = ["high", "medium", "low"] as const;
export const FindingSeverity = z.enum(FINDING_SEVERITIES);
export type FindingSeverity = z.infer<typeof FindingSeverity>;

export const FINDING_CATEGORIES = [
  "format",
  "lint",
  "typecheck",
  "logic",
  "security",
  "performance",
  "test-gap",
] as const;
export const FindingCategory = z.enum(FINDING_CATEGORIES);
export type FindingCategory = z.infer<typeof FindingCategory>;

export const FINDING_ROUTES = [
  "command_fix",
  "worker_then_command",
  "worker_then_qa",
  "report_only",
] as const;
export const FindingRoute = z.enum(FINDING_ROUTES);
export type FindingRoute = z.infer<typeof FindingRoute>;

export const ESCALATION_TYPES = [
  "business_inconsistency",
  "decision_gap",
  "spec_conflict",
  "missing_info",
  "out_of_scope",
] as const;
export const EscalationType = z.enum(ESCALATION_TYPES);
export type EscalationType = z.infer<typeof EscalationType>;

export const AUTO_TRIGGERS = [
  "chain_exhausted",
  "no_progress",
  "qa_ping_pong",
  "reviewer_conflict",
] as const;
export const AutoTrigger = z.enum(AUTO_TRIGGERS);
export type AutoTrigger = z.infer<typeof AutoTrigger>;

export const Duration = z
  .union([
    z.string().regex(DURATION_PATTERN, "Use a duration such as 300s, 10m, 1h or 500ms"),
    z.number().positive(),
  ])
  .describe("Duration such as 300s, 10m or 1h; a bare number means seconds.");
export type Duration = z.infer<typeof Duration>;

export const Identifier = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, "Use letters, digits, '-', '_' or '.'");

/** `<provider>/<model-id>` with an optional `@<profile>` suffix. */
export const ModelRefString = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*\/.+$/, "Use <provider>/<model-id>[@<profile>]")
  .describe("Model reference: <provider>/<model-id>, optionally pinned to a profile with @<label>.");

/** A model reference or `role:<favorite-role>`. */
export const ModelTarget = z
  .string()
  .refine(
    (value) =>
      /^role:/.test(value)
        ? (FAVORITE_ROLES as readonly string[]).includes(value.slice(5))
        : /^[A-Za-z0-9][A-Za-z0-9_.-]*\/.+$/.test(value),
    { message: "Use <provider>/<model-id>[@<profile>] or role:<role>" },
  )
  .describe("A model reference (<provider>/<model-id>[@<profile>]) or role:<favorite-role>.");

export function oneOrMany<T extends z.ZodType>(schema: T) {
  return z.union([schema, z.array(schema).min(1)]);
}

export function toArray<T>(value: T | readonly T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? [...(value as readonly T[])] : [value as T];
}
