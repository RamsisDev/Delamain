import { z } from "zod";
import {
  FindingCategory,
  FindingRoute,
  FindingSeverity,
  oneOrMany,
} from "./common.ts";

export const Finding = z
  .strictObject({
    id: z.string().min(1),
    severity: FindingSeverity,
    category: FindingCategory,
    file: z.string().min(1),
    line: z.int().min(1).optional(),
    end_line: z.int().min(1).optional(),
    message: z.string().min(1),
    affects_ac: z.array(z.string()).default([]).describe("Affected acceptance criteria ids."),
    behavior_change: z.boolean().default(false),
    autofix: z.boolean().default(false),
    suggestion: z.string().optional(),
  })
  .meta({ id: "Finding" });
export type Finding = z.infer<typeof Finding>;

export const FindingsWhen = z
  .strictObject({
    category: oneOrMany(FindingCategory).optional(),
    severity: oneOrMany(FindingSeverity).optional(),
    autofix: z.boolean().optional(),
    behavior_change: z.boolean().optional(),
    affects_ac: z
      .union([z.enum(["none", "any"]), z.array(z.string()).min(1)])
      .optional()
      .describe("none, any, or a list of criterion ids."),
    files: z.array(z.string()).min(1).optional().describe("Globs matched against the finding file."),
  })
  .meta({ id: "FindingsWhen" });
export type FindingsWhen = z.infer<typeof FindingsWhen>;

export const FindingsRule = z
  .strictObject({
    name: z.string().min(1),
    enabled: z.boolean().optional(),
    when: FindingsWhen,
    route: FindingRoute,
    fix: z.string().optional().describe("Command that fixes it (command_fix)."),
    verify: z.string().optional().describe("Command that verifies the fix."),
  })
  .meta({ id: "FindingsRule" });
export type FindingsRule = z.infer<typeof FindingsRule>;

export const FindingsDefault = z
  .strictObject({
    default: z.strictObject({
      route: FindingRoute,
      fix: z.string().optional(),
      verify: z.string().optional(),
    }),
  })
  .meta({ id: "FindingsDefault" });
export type FindingsDefault = z.infer<typeof FindingsDefault>;

export const FindingsRoutingEntry = z.union([FindingsRule, FindingsDefault]);
export type FindingsRoutingEntry = z.infer<typeof FindingsRoutingEntry>;

export const FindingsRouting = z
  .array(FindingsRoutingEntry)
  .describe("Ordered rule table; the first match wins. A final `default` entry catches the rest.")
  .meta({ id: "FindingsRouting" });
export type FindingsRouting = z.infer<typeof FindingsRouting>;

export function isFindingsDefault(entry: FindingsRoutingEntry): entry is FindingsDefault {
  return "default" in entry;
}
