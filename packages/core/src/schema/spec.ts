import { z } from "zod";
import { TaskKind } from "./common.ts";

export const AcceptanceCriterion = z
  .strictObject({
    id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/, "Use an id such as AC1"),
    text: z.string().min(1),
    verify: z.enum(["test", "command", "review"]).default("test"),
  })
  .meta({ id: "AcceptanceCriterion" });
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterion>;

export const TestPlanEntry = z
  .strictObject({
    covers: z.array(z.string()).min(1),
    test: z.string().min(1).describe("Test reference, e.g. `orders.test.ts > retries 429`."),
    file: z.string().optional().describe("Test file; inferred from `test` when omitted."),
    added_by: z.enum(["worker", "qa"]).optional(),
  })
  .meta({ id: "TestPlanEntry" });
export type TestPlanEntry = z.infer<typeof TestPlanEntry>;

export const TaskSpec = z
  .strictObject({
    id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/, "Use an id such as t1"),
    goal: z.string().min(1),
    kind: TaskKind,
    edit: z.array(z.string().min(1)).min(1).describe("The only files the worker may change."),
    read: z.array(z.string()).default([]).describe("Read-only context."),
    instructions: z.string().optional(),
    acceptance_criteria: z.array(AcceptanceCriterion).min(1),
    test_plan: z.array(TestPlanEntry).default([]),
    acceptance: z.array(z.string()).default([]).describe("Commands that must pass."),
    depends_on: z.array(z.string()).default([]),
    needs_tools: z.boolean().optional(),
    max_cost: z.number().positive().optional(),
    notes: z.array(z.string()).default([]).describe("Feedback attached by the principal."),
  })
  .meta({ id: "TaskSpec" });
export type TaskSpec = z.infer<typeof TaskSpec>;
export type TaskSpecInput = z.input<typeof TaskSpec>;

export const Spec = z
  .strictObject({
    spec_version: z.int().min(1),
    summary: z.string().optional(),
    tasks: z.array(TaskSpec),
  })
  .meta({ id: "Spec" });
export type Spec = z.infer<typeof Spec>;

/** What the principal submits: a full task list, plus tasks to redo when it is a delta. */
export const SpecSubmission = z.strictObject({
  summary: z.string().optional(),
  tasks: z.array(TaskSpec),
  reopen: z.array(z.string()).default([]),
});
export type SpecSubmission = z.infer<typeof SpecSubmission>;

export function testFilesOf(task: TaskSpec): string[] {
  const files = new Set<string>();
  for (const entry of task.test_plan) {
    const file = entry.file ?? entry.test.split(">")[0]?.trim();
    if (!file) continue;
    const match = task.edit.find((path) => path === file || path.endsWith(`/${file}`));
    files.add(match ?? file);
  }
  return [...files];
}
