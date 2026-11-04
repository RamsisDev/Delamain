import { AGENT_ROLES, type AgentRole } from "../schema/common.ts";
import { AgentFrontmatter, type AgentDefinition, type AgentTool } from "../schema/agent.ts";
import { error, type Issue } from "../util/issues.ts";
import { migrate } from "../schema/versions.ts";
import { parseYaml } from "./yaml.ts";
import { validateWith } from "./zod-issues.ts";

const DEFAULT_TOOLS: Record<AgentRole, AgentTool[]> = {
  principal: ["read", "search", "web", "delegate", "triage"],
  worker: ["read", "search", "edit", "command", "raise_escalation"],
  qa: ["read", "search", "edit", "command", "raise_escalation"],
  bugbot: ["read", "search", "raise_escalation"],
};

const DEFAULT_EDIT_SCOPE: Record<AgentRole, AgentDefinition["edit_scope"]> = {
  principal: "none",
  worker: "task",
  qa: "tests",
  bugbot: "none",
};

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export interface ParsedAgentFile {
  agent?: AgentDefinition;
  issues: Issue[];
  /** Character offset where the frontmatter YAML starts, to map issue positions. */
  frontmatterOffset: number;
  frontmatterText: string;
}

/** Parses a Claude Code-style agent file: YAML frontmatter followed by the system prompt. */
export function parseAgentFile(text: string, source?: string): ParsedAgentFile {
  const match = FRONTMATTER.exec(text);
  if (!match) {
    return {
      issues: [error([], "Agent files start with a YAML frontmatter block between --- lines")],
      frontmatterOffset: 0,
      frontmatterText: "",
    };
  }
  const frontmatterText = match[1]!;
  const frontmatterOffset = text.indexOf(frontmatterText);
  const parsed = parseYaml(frontmatterText);
  if (parsed.issues.some((i) => i.severity === "error")) {
    return { issues: parsed.issues, frontmatterOffset, frontmatterText };
  }
  const migrated = migrate("agent", parsed.value);
  if (!migrated.ok) {
    return { issues: [error([], migrated.message)], frontmatterOffset, frontmatterText };
  }
  const result = validateWith(AgentFrontmatter, migrated.value);
  if (!result.ok) return { issues: result.issues, frontmatterOffset, frontmatterText };
  const front = result.value;
  const role = front.role ?? (AGENT_ROLES as readonly string[]).find((r) => r === front.name);
  if (!role) {
    return {
      issues: [error(["role"], `Set role to one of ${AGENT_ROLES.join(", ")}`)],
      frontmatterOffset,
      frontmatterText,
    };
  }
  const agentRole = role as AgentRole;
  const prompt = match[2]!.trim();
  const issues: Issue[] = [];
  if (!prompt) issues.push(error([], "The agent needs a prompt below the frontmatter"));
  const agent: AgentDefinition = {
    ...front,
    role: agentRole,
    tools: front.tools ?? DEFAULT_TOOLS[agentRole],
    edit_scope: front.edit_scope ?? DEFAULT_EDIT_SCOPE[agentRole],
    prompt,
    ...(source ? { source } : {}),
  };
  return { agent, issues, frontmatterOffset, frontmatterText };
}

export function defaultToolsFor(role: AgentRole): AgentTool[] {
  return [...DEFAULT_TOOLS[role]];
}
