import { z } from "zod";
import { AutoTrigger, Duration, ModelTarget, oneOrMany, schemaVersion } from "./common.ts";

export const BlockId = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]*$/, "Start with a letter; use letters, digits, '-' or '_'");

export const FinishAction = z
  .strictObject({
    when: z.string().optional().describe("success, failure, always (default) or an expression."),
    run: z.string().optional().describe("Command to run."),
    run_flow: z.string().optional().describe("Subflow file to run."),
  })
  .refine((a) => (a.run === undefined) !== (a.run_flow === undefined), {
    message: "Set exactly one of run or run_flow",
  })
  .meta({ id: "FinishAction" });
export type FinishAction = z.infer<typeof FinishAction>;

export const BlockPosition = z.strictObject({
  x: z.number(),
  y: z.number(),
  width: z.number().optional(),
  height: z.number().optional(),
});

const base = {
  id: BlockId.describe("Unique id; expressions reference outputs as <id>.<output>."),
  label: z.string().optional(),
  after: z.array(z.string()).optional().describe("Blocks to wait for. Defaults to the previous block."),
  when: z
    .string()
    .optional()
    .describe("success (default), failure, always, or an expression over outputs."),
  join: z.enum(["all", "any"]).optional().describe("all (default) waits for every block in after."),
  on_finish: z.array(FinishAction).optional(),
  timeout: Duration.optional(),
  ui: BlockPosition.optional().describe("Position in the block editor."),
};

const BlockInstructions = z
  .string()
  .optional()
  .describe("Extra instructions for this block only, added to the system prompt after the agent's own.");

/** Retry policy of agent and review blocks. `timeout` applies to each attempt. */
const retryPolicy = {
  retries: z
    .int()
    .min(0)
    .max(5)
    .optional()
    .describe("Extra attempts when the block fails. Model errors such as rate limits switch models without using one."),
  retry_delay: Duration.optional().describe("Wait before the first retry, e.g. 10s."),
  retry_backoff: z
    .number()
    .min(1)
    .max(10)
    .optional()
    .describe("Each following wait is multiplied by this; 1 (the default) keeps it fixed."),
};

export const AgentBlock = z
  .strictObject({
    ...base,
    type: z.literal("agent"),
    agent: z.string().min(1).describe("Agent file name (principal, worker, qa, bugbot...)."),
    model: ModelTarget.optional().describe("Pins a model; omit to let the router decide."),
    fallback: z.array(ModelTarget).optional().describe("Backups for a pinned model."),
    stay_local: z.boolean().optional(),
    input: oneOrMany(z.string()).optional().describe("Outputs passed to the agent as context."),
    output: z.string().optional().describe("Name of the produced artifact, e.g. spec."),
    feedback: z
      .array(z.string())
      .optional()
      .describe("Outputs fed back to the agent on the next loop attempt."),
    ...retryPolicy,
    instructions: BlockInstructions,
  })
  .meta({ id: "AgentBlock" });
export type AgentBlock = z.infer<typeof AgentBlock>;

export const PARSE_FORMAT = /^(none|json|junit:.+|json:.+|regex:.+)$/;

export const CommandBlock = z
  .strictObject({
    ...base,
    type: z.literal("command"),
    run: z.string().min(1),
    also_run: z
      .string()
      .optional()
      .describe("Extra commands that must also pass, e.g. task.acceptance."),
    cwd: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    success_codes: z.array(z.int()).optional(),
    parse: z
      .string()
      .regex(PARSE_FORMAT, "Use none, json, json:<file>, junit:<file> or regex:<pattern>")
      .optional(),
    tail_lines: z.int().min(1).optional(),
  })
  .meta({ id: "CommandBlock" });
export type CommandBlock = z.infer<typeof CommandBlock>;

export const ReviewBlock = z
  .strictObject({
    ...base,
    type: z.literal("review"),
    agent: z.string().min(1),
    model: ModelTarget.optional(),
    fallback: z.array(ModelTarget).optional(),
    scope: z.enum(["task.diff", "session.diff", "working_tree"]).optional(),
    routing: z.string().optional().describe("Findings routing table; defaults to findings_routing."),
    ...retryPolicy,
    instructions: BlockInstructions,
  })
  .meta({ id: "ReviewBlock" });
export type ReviewBlock = z.infer<typeof ReviewBlock>;

export const ConditionBlock = z
  .strictObject({
    ...base,
    type: z.literal("condition"),
    expr: z.string().min(1).describe("Expression; its value is exposed as <id>.value."),
  })
  .meta({ id: "ConditionBlock" });
export type ConditionBlock = z.infer<typeof ConditionBlock>;

export const ApprovalBlock = z
  .strictObject({
    ...base,
    type: z.literal("approval"),
    mode: z.enum(["auto", "review"]).optional(),
    on_reject: z.enum(["feedback_to_workers", "fail"]).optional(),
  })
  .meta({ id: "ApprovalBlock" });
export type ApprovalBlock = z.infer<typeof ApprovalBlock>;

export const SubflowBlock = z
  .strictObject({
    ...base,
    type: z.literal("subflow"),
    flow: z.string().min(1).describe("Path of a reusable flow, e.g. flows/verify-python.yml."),
    inputs: z.record(z.string(), z.string()).optional(),
  })
  .meta({ id: "SubflowBlock" });
export type SubflowBlock = z.infer<typeof SubflowBlock>;

export const ScriptBlock = z
  .strictObject({
    ...base,
    type: z.literal("script"),
    run: z.string().min(1).describe("Command whose stdout is a JSON object of outputs."),
    cwd: z.string().optional(),
  })
  .meta({ id: "ScriptBlock" });
export type ScriptBlock = z.infer<typeof ScriptBlock>;

export const LoopBudget = z.strictObject({
  max_tokens: z.int().positive().optional(),
  max_minutes: z.number().positive().optional(),
});

export const ON_EXHAUSTED = ["escalate_model", "escalate_to_principal", "fail", "ask_user"] as const;

export interface LoopBlock extends z.infer<typeof LoopBlockShape> {
  body: Block[];
}
export interface ForeachBlock extends z.infer<typeof ForeachBlockShape> {
  body: Block[];
}

const LoopBlockShape = z.strictObject({
  ...base,
  type: z.literal("loop"),
  max_iterations: z.int().min(1).describe("Repair attempts; capped by limits.max_loop_iterations."),
  reset: z.enum(["per_parent_iteration", "never"]).optional(),
  budget: LoopBudget.optional(),
  stop_if_no_progress: z.boolean().optional(),
  until: z.string().min(1).describe("Exit condition, e.g. tests.passed."),
  on_exhausted: z.enum(ON_EXHAUSTED).optional(),
});

const ForeachBlockShape = z.strictObject({
  ...base,
  type: z.literal("foreach"),
  over: z.string().min(1).describe("Collection to iterate, e.g. spec.pending_tasks."),
  max_parallel: z.int().min(1).optional(),
});

export type Block =
  | AgentBlock
  | CommandBlock
  | ReviewBlock
  | ConditionBlock
  | ApprovalBlock
  | SubflowBlock
  | ScriptBlock
  | LoopBlock
  | ForeachBlock;
export type BlockType = Block["type"];

export const BLOCK_TYPES = [
  "agent",
  "foreach",
  "command",
  "review",
  "condition",
  "loop",
  "approval",
  "subflow",
  "script",
] as const satisfies readonly BlockType[];

const LoopBlockSchema = LoopBlockShape.extend({
  get body(): z.ZodArray<z.ZodType<Block>> {
    return z.array(Block).min(1);
  },
}).meta({ id: "LoopBlock" });

const ForeachBlockSchema = ForeachBlockShape.extend({
  get body(): z.ZodArray<z.ZodType<Block>> {
    return z.array(Block).min(1);
  },
}).meta({ id: "ForeachBlock" });

export const LoopBlock = LoopBlockSchema as unknown as z.ZodType<LoopBlock>;
export const ForeachBlock = ForeachBlockSchema as unknown as z.ZodType<ForeachBlock>;

export const Block: z.ZodType<Block> = z
  .discriminatedUnion("type", [
    AgentBlock,
    CommandBlock,
    ReviewBlock,
    ConditionBlock,
    ApprovalBlock,
    SubflowBlock,
    ScriptBlock,
    LoopBlockSchema,
    ForeachBlockSchema,
  ])
  .meta({ id: "Block" }) as unknown as z.ZodType<Block>;

export const EscalationPolicy = z
  .strictObject({
    triage: z.literal("principal").optional(),
    auto_triggers: z.array(AutoTrigger).optional(),
    max_per_task: z.int().min(0).optional(),
    pause: z.enum(["affected_only", "all"]).optional(),
    persist_decisions: z.enum(["project", "global", "none"]).optional(),
  })
  .meta({ id: "EscalationPolicy" });
export type EscalationPolicy = z.infer<typeof EscalationPolicy>;

export const FlowPolicy = z.strictObject({
  escalation: EscalationPolicy.optional(),
});

export const Flow = z
  .strictObject({
    schema_version: schemaVersion,
    name: z.string().min(1),
    description: z.string().optional(),
    reusable: z
      .boolean()
      .optional()
      .describe("Other flows can run this one with a Subflow block. Flows in flows/ are always reusable."),
    policy: FlowPolicy.optional(),
    steps: z.array(Block).min(1),
  })
  .meta({ id: "Flow", title: "Harness orchestration flow" });
export type Flow = Omit<z.infer<typeof Flow>, "steps"> & { steps: Block[] };

export function isContainer(block: Block): block is LoopBlock | ForeachBlock {
  return block.type === "loop" || block.type === "foreach";
}
