import { z } from "zod";
import { ModelTarget, RouterRole, TaskKind, TaskSize, oneOrMany } from "./common.ts";

export const NumberCondition = z
  .union([
    z.number(),
    z
      .strictObject({
        eq: z.number().optional(),
        lt: z.number().optional(),
        lte: z.number().optional(),
        gt: z.number().optional(),
        gte: z.number().optional(),
      })
      .refine((value) => Object.values(value).some((v) => v !== undefined), {
        message: "Set at least one of eq, lt, lte, gt, gte",
      }),
  ])
  .meta({ id: "NumberCondition" });
export type NumberCondition = z.infer<typeof NumberCondition>;

export const RuleWhen = z
  .strictObject({
    kind: oneOrMany(TaskKind).optional().describe("Type of work, set by the principal."),
    size: oneOrMany(TaskSize).optional().describe("Computed from tokens and files."),
    est_tokens: NumberCondition.optional().describe("Estimated tokens of the context."),
    files: NumberCondition.optional().describe("Number of files in the task's edit list."),
    paths: z
      .array(z.string().min(1))
      .min(1)
      .optional()
      .describe("Globs; matches when any path the task touches matches any glob."),
    needs_tools: z.boolean().optional(),
    role: oneOrMany(RouterRole).optional().describe("Which flow step asks for a model."),
    max_cost: NumberCondition.optional().describe("The task's cost cap in USD."),
  })
  .meta({ id: "RuleWhen" });
export type RuleWhen = z.infer<typeof RuleWhen>;

export const RULE_PARAMETERS = [
  "kind",
  "size",
  "est_tokens",
  "files",
  "paths",
  "needs_tools",
  "role",
  "max_cost",
] as const satisfies readonly (keyof RuleWhen)[];

export const RouterRule = z
  .strictObject({
    name: z.string().min(1).describe("Unique name; a project rule with the same name replaces it."),
    description: z.string().optional(),
    enabled: z.boolean().optional(),
    when: RuleWhen,
    use: ModelTarget,
    fallback: z
      .array(ModelTarget)
      .min(1, "Every rule needs at least one backup model")
      .describe("Backup models, in order. At least one is required."),
    stay_local: z
      .boolean()
      .optional()
      .describe("Only local providers in the chain; the principal's model is not appended."),
  })
  .meta({ id: "RouterRule" });
export type RouterRule = z.infer<typeof RouterRule>;

export const RouterDefault = z
  .strictObject({
    use: ModelTarget,
    fallback: z.array(ModelTarget).min(1, "The default route needs at least one backup model"),
  })
  .meta({ id: "RouterDefault" });
export type RouterDefault = z.infer<typeof RouterDefault>;

export const SizeThreshold = z.strictObject({
  max_tokens: z.int().positive(),
  max_files: z.int().positive(),
});
export type SizeThreshold = z.infer<typeof SizeThreshold>;

export const Thresholds = z
  .strictObject({
    short: SizeThreshold.optional(),
    medium: SizeThreshold.optional(),
  })
  .describe("What short and medium mean; anything bigger is large.");
export type Thresholds = z.infer<typeof Thresholds>;

export const DEFAULT_THRESHOLDS = {
  short: { max_tokens: 4000, max_files: 2 },
  medium: { max_tokens: 30000, max_files: 8 },
} as const satisfies Required<Thresholds>;

export const RouterConfig = z
  .strictObject({
    thresholds: Thresholds.optional(),
    context_margin_tokens: z
      .int()
      .min(0)
      .optional()
      .describe("Free tokens a model must have on top of the estimated context. Default 2000."),
    rules: z.array(RouterRule).optional().describe("Ordered; the first matching rule wins."),
    default: RouterDefault.optional(),
  })
  .meta({ id: "Router" });
export type RouterConfig = z.infer<typeof RouterConfig>;
