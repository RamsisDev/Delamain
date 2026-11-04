import { z } from "zod";
import { Duration } from "./common.ts";

export const ProfileBudget = z.strictObject({
  max_tokens: z.int().positive().optional(),
  max_cost_usd: z.number().positive().optional(),
});
export type ProfileBudget = z.infer<typeof ProfileBudget>;

export const SessionLimits = z.strictObject({
  max_minutes: z.number().positive().optional(),
  on_time_exhausted: z
    .enum(["fallback", "ask_user"])
    .optional()
    .describe("fallback moves tasks to the next link of their chain; ask_user pauses the session."),
  per_profile: ProfileBudget.optional().describe("Budget of each credential profile per session."),
});
export type SessionLimits = z.infer<typeof SessionLimits>;

export const Limits = z
  .strictObject({
    max_loop_iterations: z.int().min(1).max(20).optional(),
    max_nested_loops: z.int().min(1).max(10).optional(),
    worst_case_warning: z.int().min(1).optional(),
    max_escalations_per_task: z.int().min(0).optional(),
    max_human_questions_per_session: z.int().min(0).optional(),
    command_timeout_default: Duration.optional(),
    max_agent_turns: z.int().min(1).optional().describe("Tool-calling turns per agent run."),
    output_tail_lines: z.int().min(1).optional().describe("Lines of command output kept."),
    session: SessionLimits.optional(),
  })
  .meta({ id: "Limits" });
export type Limits = z.infer<typeof Limits>;

export const DEFAULT_LIMITS = {
  max_loop_iterations: 5,
  max_nested_loops: 4,
  worst_case_warning: 20,
  max_escalations_per_task: 3,
  max_human_questions_per_session: 5,
  command_timeout_default: "300s",
  max_agent_turns: 40,
  output_tail_lines: 80,
  session: {
    max_minutes: 60,
    on_time_exhausted: "fallback",
    per_profile: { max_tokens: 500_000, max_cost_usd: 5 },
  },
} as const;

export interface ResolvedLimits {
  max_loop_iterations: number;
  max_nested_loops: number;
  worst_case_warning: number;
  max_escalations_per_task: number;
  max_human_questions_per_session: number;
  command_timeout_default: Duration;
  max_agent_turns: number;
  output_tail_lines: number;
  session: {
    max_minutes: number;
    on_time_exhausted: "fallback" | "ask_user";
    per_profile: { max_tokens?: number; max_cost_usd?: number };
  };
}

export function resolveLimits(limits: Limits | undefined): ResolvedLimits {
  const l = limits ?? {};
  return {
    max_loop_iterations: l.max_loop_iterations ?? DEFAULT_LIMITS.max_loop_iterations,
    max_nested_loops: l.max_nested_loops ?? DEFAULT_LIMITS.max_nested_loops,
    worst_case_warning: l.worst_case_warning ?? DEFAULT_LIMITS.worst_case_warning,
    max_escalations_per_task: l.max_escalations_per_task ?? DEFAULT_LIMITS.max_escalations_per_task,
    max_human_questions_per_session:
      l.max_human_questions_per_session ?? DEFAULT_LIMITS.max_human_questions_per_session,
    command_timeout_default: l.command_timeout_default ?? DEFAULT_LIMITS.command_timeout_default,
    max_agent_turns: l.max_agent_turns ?? DEFAULT_LIMITS.max_agent_turns,
    output_tail_lines: l.output_tail_lines ?? DEFAULT_LIMITS.output_tail_lines,
    session: {
      max_minutes: l.session?.max_minutes ?? DEFAULT_LIMITS.session.max_minutes,
      on_time_exhausted: l.session?.on_time_exhausted ?? DEFAULT_LIMITS.session.on_time_exhausted,
      per_profile: { ...DEFAULT_LIMITS.session.per_profile, ...l.session?.per_profile },
    },
  };
}
