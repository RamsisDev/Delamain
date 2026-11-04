import { z } from "zod";
import { EscalationType, schemaVersion } from "./common.ts";

export const Evidence = z.strictObject({
  file: z.string().optional(),
  line: z.int().optional(),
  url: z.string().optional(),
  quote: z.string().optional(),
});

export const EscalationRequest = z
  .strictObject({
    type: EscalationType,
    summary: z.string().min(1),
    evidence: z.array(Evidence).default([]),
    blocks: z.array(z.string()).default([]).describe("Acceptance criteria ids it blocks."),
    options_seen: z.array(z.string()).default([]),
  })
  .meta({ id: "EscalationRequest" });
export type EscalationRequest = z.infer<typeof EscalationRequest>;

export interface Escalation extends EscalationRequest {
  id: string;
  task?: string;
  raised_by: string;
  automatic?: string;
  created_at: number;
}

export const HumanOption = z.strictObject({
  label: z.string().min(1),
  impact: z.string().optional(),
  recommended: z.boolean().optional(),
});
export type HumanOption = z.infer<typeof HumanOption>;

/** The principal's triage outcome. */
export const TriageOutcome = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("resolved"),
    answer: z.string().min(1),
    citation: z.string().min(1).describe("Where the answer was found."),
    spec_change: z.string().optional().describe("How the affected tasks change."),
  }),
  z.strictObject({
    outcome: z.literal("rejected"),
    reply: z.string().min(1).describe("Reply sent back to the agent, e.g. 'this is in AC3'."),
  }),
  z.strictObject({
    outcome: z.literal("ask_human"),
    question: z.string().min(1),
    options: z.array(HumanOption).min(2).max(4),
    blocked: z.string().optional().describe("What is blocked until the human answers."),
  }),
]);
export type TriageOutcome = z.infer<typeof TriageOutcome>;

export const Decision = z
  .strictObject({
    id: z.string().min(1),
    question: z.string().min(1),
    answer: z.string().min(1),
    decided_by: z.enum(["human", "principal"]),
    spec_version: z.int().min(1).optional(),
    affects: z.array(z.string()).default([]),
    task: z.string().optional(),
    date: z.string().optional(),
  })
  .meta({ id: "Decision" });
export type Decision = z.infer<typeof Decision>;

export const DecisionsFile = z
  .strictObject({
    schema_version: schemaVersion,
    decisions: z.array(Decision),
  })
  .meta({ id: "DecisionsFile", title: "Harness decision log" });
export type DecisionsFile = z.infer<typeof DecisionsFile>;
