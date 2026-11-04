import { z } from "zod";
import { EscalationRequest, TriageOutcome } from "../schema/escalation.ts";
import { Finding } from "../schema/findings.ts";
import { SpecSubmission, TestPlanEntry } from "../schema/spec.ts";
import type { AgentMode, SubmitTool } from "../flow/ports.ts";

export const AnswerSubmission = z.strictObject({
  text: z.string().min(1).describe("The answer to the user, in markdown."),
});

export const VerdictSubmission = z.strictObject({
  approved: z.boolean(),
  notes: z.string().default(""),
  reopen: z
    .array(z.strictObject({ task: z.string(), note: z.string() }))
    .default([])
    .describe("Tasks to redo and what is wrong with each."),
});
export type VerdictSubmission = z.infer<typeof VerdictSubmission>;

export const SteerSubmission = z.strictObject({
  action: z.enum(["continue", "stop"]).describe("stop ends the whole session; continue keeps it running."),
  reply: z.string().min(1).describe("Answer shown to the user."),
  reopen: z
    .array(z.strictObject({ task: z.string(), note: z.string() }))
    .default([])
    .describe("Tasks whose requirements change because of the message, with what changes."),
});
export type SteerSubmission = z.infer<typeof SteerSubmission>;

export const FinishSubmission = z.strictObject({
  notes: z.string().default("").describe("What changed and why, in a few lines."),
});

export const QaSubmission = z.strictObject({
  results: z
    .array(
      z.strictObject({
        ac: z.string(),
        passed: z.boolean(),
        evidence: z.string().default(""),
      }),
    )
    .min(1),
  missing: z
    .array(z.string())
    .default([])
    .describe("Unmet criteria and uncovered cases, each actionable by the worker."),
  added_tests: z.array(TestPlanEntry).default([]),
});
export type QaSubmission = z.infer<typeof QaSubmission>;

export const FindingsSubmission = z.strictObject({
  findings: z.array(Finding),
});
export type FindingsSubmission = z.infer<typeof FindingsSubmission>;

export { EscalationRequest, SpecSubmission, TriageOutcome };

const SUBMIT_SPEC: SubmitTool = {
  name: "submit_spec",
  description:
    "Submit the task spec. Send the full task list; on a delta, also list in `reopen` the done tasks that must start over.",
  schema: SpecSubmission,
};

const ANSWER: SubmitTool = {
  name: "answer",
  description: "Answer the user directly, without starting the orchestration.",
  schema: AnswerSubmission,
};

export const SUBMIT_TOOLS: Record<AgentMode, SubmitTool[]> = {
  spec: [SUBMIT_SPEC, ANSWER],
  verify: [
    {
      name: "submit_verdict",
      description: "Approve the combined result, or reject it and list the tasks to redo.",
      schema: VerdictSubmission,
    },
  ],
  triage: [
    {
      name: "submit_triage",
      description:
        "Resolve the escalation (citing where the answer is), reject it (reply to the agent), or ask the human with 2 to 4 options.",
      schema: TriageOutcome,
    },
  ],
  steer: [
    {
      name: "submit_steer",
      description: "Decide what the user's message means for the running session: stop it, or continue and list the tasks whose requirements change.",
      schema: SteerSubmission,
    },
  ],
  work: [{ name: "finish", description: "Finish the task once the work is done.", schema: FinishSubmission }],
  fix: [{ name: "finish", description: "Finish once every finding is fixed.", schema: FinishSubmission }],
  qa: [
    {
      name: "submit_qa",
      description: "Report each acceptance criterion with evidence, the missing cases, and the tests you added.",
      schema: QaSubmission,
    },
  ],
  review: [
    {
      name: "submit_findings",
      description: "Submit the classified findings. An empty list means the diff is fine.",
      schema: FindingsSubmission,
    },
  ],
};
