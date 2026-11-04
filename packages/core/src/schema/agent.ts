import { z } from "zod";
import { AgentRole, ModelTarget, schemaVersion } from "./common.ts";

export const AGENT_TOOLS = [
  "read",
  "search",
  "web",
  "edit",
  "command",
  "delegate",
  "raise_escalation",
  "triage",
] as const;
export const AgentTool = z.enum(AGENT_TOOLS);
export type AgentTool = z.infer<typeof AgentTool>;

export const AgentFrontmatter = z
  .strictObject({
    schema_version: schemaVersion.optional(),
    name: z.string().min(1),
    description: z.string().optional(),
    role: AgentRole.optional().describe("Defaults to the agent name when it is a known role."),
    tier: z
      .union([z.literal("auto"), ModelTarget])
      .optional()
      .describe("auto lets the router decide; otherwise pins a favorite."),
    tools: z.array(AgentTool).optional(),
    edit_scope: z
      .enum(["task", "tests", "none"])
      .optional()
      .describe("task: the spec's edit list; tests: the task's test files; none: read-only."),
    diff_mode: z
      .boolean()
      .optional()
      .describe("Accept models without tool calling by exchanging unified diffs."),
    max_turns: z.int().min(1).optional(),
  })
  .meta({ id: "AgentFrontmatter", title: "Harness agent frontmatter" });
export type AgentFrontmatter = z.infer<typeof AgentFrontmatter>;

export interface AgentDefinition extends AgentFrontmatter {
  role: AgentRole;
  tools: AgentTool[];
  edit_scope: "task" | "tests" | "none";
  prompt: string;
  /** Where the agent was loaded from, for the UI. */
  source?: string;
}
