import { z } from "zod";
import type { SubmitTool } from "../flow/ports.ts";
import type { ToolDefinition } from "../providers/types.ts";
import type { AgentTool } from "../schema/agent.ts";
import { EscalationRequest } from "../schema/escalation.ts";
import { matchesAnyGlob, normalizePath } from "../util/glob.ts";

/** File system access for agent tools; paths are relative to the agent's working directory. */
export interface ToolHost {
  readFile(cwd: string, path: string): Promise<string | undefined>;
  writeFile(cwd: string, path: string, content: string): Promise<void>;
  listFiles(cwd: string, dir: string, glob?: string): Promise<string[]>;
  search(cwd: string, pattern: string, glob?: string): Promise<{ file: string; line: number; text: string }[]>;
  fetchUrl?(url: string, signal?: AbortSignal): Promise<string>;
}

const schemaOf = (schema: z.ZodType): Record<string, unknown> => {
  const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  delete json.$schema;
  return json;
};

const READ_FILE: ToolDefinition = {
  name: "read_file",
  description: "Read a file of the repository. Use start_line/end_line for large files.",
  parameters: schemaOf(
    z.object({
      path: z.string(),
      start_line: z.int().min(1).optional(),
      end_line: z.int().min(1).optional(),
    }),
  ),
};

const LIST_FILES: ToolDefinition = {
  name: "list_files",
  description: "List files under a directory, optionally filtered by a glob such as src/**/*.ts.",
  parameters: schemaOf(z.object({ path: z.string().default("."), glob: z.string().optional() })),
};

const SEARCH: ToolDefinition = {
  name: "search",
  description: "Search the repository with a regular expression; returns file, line and text.",
  parameters: schemaOf(z.object({ pattern: z.string(), glob: z.string().optional() })),
};

const WEB_FETCH: ToolDefinition = {
  name: "web_fetch",
  description: "Fetch a web page or document as text.",
  parameters: schemaOf(z.object({ url: z.url() })),
};

const EDIT_FILE: ToolDefinition = {
  name: "edit_file",
  description:
    "Replace an exact, unique snippet of a file. Include enough context in old_string to make it unique. Only files in your edit list can be changed.",
  parameters: schemaOf(z.object({ path: z.string(), old_string: z.string(), new_string: z.string() })),
};

const WRITE_FILE: ToolDefinition = {
  name: "write_file",
  description: "Create or overwrite a whole file. Only files in your edit list can be written.",
  parameters: schemaOf(z.object({ path: z.string(), content: z.string() })),
};

const RUN_COMMAND: ToolDefinition = {
  name: "run_command",
  description: "Run a shell command in the task's worktree; returns the exit status and the output tail.",
  parameters: schemaOf(z.object({ command: z.string() })),
};

const RAISE_ESCALATION: ToolDefinition = {
  name: "raise_escalation",
  description:
    "Stop guessing: raise a business inconsistency, a decision gap, a spec conflict, missing information, or an out-of-scope need. The principal triages it; you get a reply or the task restarts with a new spec.",
  parameters: schemaOf(EscalationRequest),
};

export function toolDefinitions(tools: readonly AgentTool[], editScope: readonly string[], submit: readonly SubmitTool[]): ToolDefinition[] {
  const defs: ToolDefinition[] = [];
  if (tools.includes("read")) defs.push(READ_FILE, LIST_FILES);
  if (tools.includes("search")) defs.push(SEARCH);
  if (tools.includes("web")) defs.push(WEB_FETCH);
  if (tools.includes("edit") && editScope.length) defs.push(EDIT_FILE, WRITE_FILE);
  if (tools.includes("command")) defs.push(RUN_COMMAND);
  if (tools.includes("raise_escalation")) defs.push(RAISE_ESCALATION);
  for (const tool of submit) {
    defs.push({ name: tool.name, description: tool.description, parameters: schemaOf(tool.schema) });
  }
  return defs;
}

export class ToolInputError extends Error {}

/** Resolves a tool path inside the working directory; absolute paths and `..` escapes fail. */
export function safeRelativePath(path: string): string {
  const normalized = normalizePath(path.trim());
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
    throw new ToolInputError(`Use a path relative to the repository root, not "${path}"`);
  }
  const parts: string[] = [];
  for (const part of normalized.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (!parts.length) throw new ToolInputError(`"${path}" points outside the repository`);
      parts.pop();
    } else parts.push(part);
  }
  if (parts[0] === ".git") throw new ToolInputError("The .git folder is off limits");
  return parts.join("/") || ".";
}

/** The extension enforces the task's edit list: any edit outside it is rejected. */
export function assertEditable(path: string, editScope: readonly string[]): void {
  if (!matchesAnyGlob(path, editScope)) {
    throw new ToolInputError(
      `${path} is not in your edit list (${editScope.join(", ")}). If the task needs it, call raise_escalation with type out_of_scope.`,
    );
  }
}

export function applyEdit(content: string, oldString: string, newString: string, path: string): string {
  if (oldString === "") throw new ToolInputError("old_string is empty; use write_file to create a file");
  const first = content.indexOf(oldString);
  if (first === -1) throw new ToolInputError(`old_string was not found in ${path}`);
  if (content.indexOf(oldString, first + oldString.length) !== -1) {
    throw new ToolInputError(`old_string appears more than once in ${path}; add more context`);
  }
  return content.slice(0, first) + newString + content.slice(first + oldString.length);
}

export function sliceLines(content: string, start?: number, end?: number): string {
  const lines = content.split("\n");
  const from = Math.max(1, start ?? 1);
  const to = Math.min(lines.length, end ?? Math.min(lines.length, from + 1999));
  const body = lines
    .slice(from - 1, to)
    .map((line, i) => `${String(from + i).padStart(5)}| ${line}`)
    .join("\n");
  return to < lines.length ? `${body}\n… ${lines.length - to} more lines` : body;
}
