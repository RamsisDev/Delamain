import { z } from "zod";
import type { AgentRunInput, AgentRunner, AgentRunResult, Journal, ModelCursor } from "../flow/ports.ts";
import type { ChatMessage, ErrorKind, ProviderAdapter, ToolCall } from "../providers/types.ts";
import type { ChainLink } from "../router/route.ts";
import type { Clock } from "../router/service.ts";
import { EscalationRequest } from "../schema/escalation.ts";
import { applyFileDiff, extractDiff, parseUnifiedDiff, PatchError } from "../util/diff.ts";
import { DIFF_MODE_INSTRUCTIONS } from "./prompts.ts";
import {
  applyEdit,
  assertEditable,
  safeRelativePath,
  sliceLines,
  ToolInputError,
  toolDefinitions,
  type ToolHost,
} from "./tools.ts";

export interface ProviderRegistry {
  /** Adapter for a provider, authenticated with the given profile (or the active one). */
  get(provider: string, profile?: string): Promise<ProviderAdapter | undefined>;
}

const MAX_TOOL_OUTPUT = 20_000;
const MAX_NUDGES = 2;
const MAX_RATE_LIMIT_WAIT_MS = 120_000;
const MAX_SWITCHES = 12;

function clip(text: string, max = MAX_TOOL_OUTPUT): string {
  return text.length > max ? `${text.slice(0, max)}\n… ${text.length - max} more characters` : text;
}

function maxOutput(link: ChainLink): { maxOutputTokens?: number } {
  return link.model.maxOutputTokens ? { maxOutputTokens: link.model.maxOutputTokens } : {};
}

/**
 * Local servers limit simultaneous conversations, not requests: their slot is kept between turns
 * so another conversation does not evict this one's cached prompt. Cloud slots are per request.
 */
class ConversationSlot {
  private held: { provider: string; release: () => void } | undefined;

  constructor(private readonly models: ModelCursor) {}

  async acquire(link: ChainLink, signal: AbortSignal): Promise<() => void> {
    if (!link.model.local) {
      this.release();
      return this.models.acquireSlot(signal);
    }
    if (this.held?.provider !== link.model.provider) {
      this.release();
      this.held = { provider: link.model.provider, release: await this.models.acquireSlot(signal) };
    }
    return () => undefined;
  }

  release(): void {
    this.held?.release();
    this.held = undefined;
  }
}

/**
 * The agent's own prompt, the block's instructions, then the working rules. It is rebuilt on
 * every model switch, so a fallback model gets the same instructions.
 */
export function systemPromptFor(input: Pick<AgentRunInput, "agent" | "editScope" | "blockInstructions">): string {
  const scope = input.editScope.length
    ? `You may edit only these files: ${input.editScope.join(", ")}.`
    : "You cannot edit files in this step.";
  const block = input.blockInstructions?.trim() ? `\n\n# Instructions for this step\n${input.blockInstructions.trim()}` : "";
  return `${input.agent.prompt}${block}\n\n# Working rules\n- ${scope}\n- Paths are relative to the repository root.\n- Keep tool calls focused; read only what you need.`;
}

/**
 * Runs one agent step as a tool-calling conversation. When a model fails (rate limit, outage,
 * context too small, budget), the next model of the chain resumes the same conversation; the
 * interrupted attempt does not count against any loop.
 */
export class ToolLoopRunner implements AgentRunner {
  constructor(
    private readonly providers: ProviderRegistry,
    private readonly host: ToolHost,
    private readonly journal: Journal,
    private readonly clock: Clock,
  ) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const slot = new ConversationSlot(input.models);
    try {
      return await this.converse(input, slot);
    } finally {
      slot.release();
    }
  }

  private async converse(input: AgentRunInput, slot: ConversationSlot): Promise<AgentRunResult> {
    const usage = { input: 0, output: 0, cached: 0 };
    const filesChanged = new Set<string>();
    const tools = toolDefinitions(input.agent.tools, input.editScope, input.submit);
    const submitNames = new Set(input.submit.map((t) => t.name));
    const system = this.systemPrompt(input);
    const messages: ChatMessage[] = this.journal.conversation(input.key) ?? [
      { role: "user", content: `${input.instructions}\n\n${input.context}`.trim() },
    ];
    let text = "";
    let nudges = 0;
    let switches = 0;
    let model: string | undefined;

    for (let turn = 0; turn < input.maxTurns; turn++) {
      if (input.signal.aborted) return this.result("failed", { usage, filesChanged, text, model, error: "Cancelled" });
      let link = input.models.current();
      if (!link) {
        const retryAt = input.models.nextRetryAt();
        if (retryAt !== undefined && retryAt - this.clock.now() <= MAX_RATE_LIMIT_WAIT_MS) {
          await this.clock.sleep(Math.max(0, retryAt - this.clock.now()), input.signal);
          link = input.models.rewind();
        }
        if (!link) {
          return this.result("failed", { usage, filesChanged, text, model, error: "No model of the chain is available", chainExhausted: true });
        }
      }
      model = link.ref;
      const adapter = await this.providers.get(link.model.provider, link.model.profile).catch(() => undefined);
      if (!adapter) {
        input.models.reportFailure({ kind: "unavailable", message: `${link.model.provider} could not be set up` });
        input.models.advance("unavailable");
        continue;
      }
      if (link.model.providerType === "cli") {
        slot.release();
        return this.runSingleShot(input, adapter, link, system, usage, filesChanged, false);
      }
      const toolCalling = link.model.toolCalling ?? !link.model.local;
      if (!toolCalling && input.agent.diff_mode) {
        slot.release();
        return this.runSingleShot(input, adapter, link, system, usage, filesChanged, true);
      }

      const release = await slot.acquire(link, input.signal);
      let turnText = "";
      const calls: ToolCall[] = [];
      let failure: { kind: ErrorKind; message: string; retryAfterMs?: number } | undefined;
      try {
        for await (const event of adapter.stream(
          { model: link.model.model, system, messages, tools, cache: true, cwd: input.cwd, ...maxOutput(link) },
          input.signal,
        )) {
          if (event.type === "text") {
            turnText += event.delta;
            input.onText(event.delta);
          } else if (event.type === "tool_call") {
            calls.push({ id: event.id, name: event.name, args: event.args });
          } else if (event.type === "usage") {
            usage.input += event.input;
            usage.output += event.output;
            usage.cached += event.cached ?? 0;
            if (input.models.recordUsage(event)) input.models.advance("budget");
          } else if (event.type === "rate_limits") {
            input.models.reportRateLimits?.(event.snapshot);
          } else if (event.type === "error") {
            failure = event;
          }
        }
      } catch (e) {
        if (input.signal.aborted) return this.result("failed", { usage, filesChanged, text, model, error: "Cancelled" });
        failure = { kind: "unavailable", message: (e as Error).message };
      } finally {
        release();
      }

      if (failure) {
        if (failure.kind === "bad_request") {
          return this.result("failed", { usage, filesChanged, text, model, error: `${link.ref}: ${failure.message}` });
        }
        if (++switches > MAX_SWITCHES) {
          return this.result("failed", { usage, filesChanged, text, model, error: `Too many provider errors; last: ${failure.message}`, chainExhausted: true });
        }
        input.models.reportFailure(failure);
        input.models.advance(failure.kind as Exclude<ErrorKind, "bad_request">);
        turn--;
        continue;
      }

      text = turnText || text;
      messages.push({ role: "assistant", content: turnText, ...(calls.length ? { toolCalls: calls } : {}) });

      if (!calls.length) {
        this.journal.saveConversation(input.key, messages);
        if (!input.requireSubmit) return this.result("completed", { usage, filesChanged, text, model });
        if (nudges++ >= MAX_NUDGES) {
          return this.result("failed", { usage, filesChanged, text, model, error: "The agent did not submit its result", soft: true });
        }
        messages.push({ role: "user", content: `Finish by calling ${[...submitNames].join(" or ")}.` });
        continue;
      }

      let submission: { tool: string; value: unknown } | undefined;
      for (const call of calls) {
        if (submitNames.has(call.name)) {
          const tool = input.submit.find((t) => t.name === call.name)!;
          const parsed = tool.schema.safeParse(call.args);
          const problems = parsed.success ? (tool.validate?.(parsed.data) ?? []) : [z.prettifyError(parsed.error)];
          if (problems.length) {
            messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: `Rejected:\n${problems.join("\n")}`, isError: true });
            input.onTool(call.name, "rejected", false);
          } else {
            submission = { tool: call.name, value: parsed.data };
            messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: "Received." });
            input.onTool(call.name, "submitted", true);
          }
          continue;
        }
        if (call.name === "raise_escalation") {
          const request = EscalationRequest.safeParse(call.args);
          if (!request.success) {
            messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: z.prettifyError(request.error), isError: true });
            continue;
          }
          input.onTool(call.name, request.data.summary, true);
          this.journal.saveConversation(input.key, messages);
          slot.release();
          const reply = await input.onEscalation(request.data);
          if (reply.kind === "abort") {
            return this.result("aborted", { usage, filesChanged, text, model, error: reply.reason });
          }
          messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: reply.message });
          continue;
        }
        const outcome = await this.executeTool(call, input, filesChanged);
        messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: clip(outcome.content), ...(outcome.ok ? {} : { isError: true }) });
        input.onTool(call.name, outcome.summary, outcome.ok);
      }
      this.journal.saveConversation(input.key, messages);
      if (submission) return this.result("completed", { usage, filesChanged, text, model, submission });
    }
    return this.result("failed", { usage, filesChanged, text, model, error: `Stopped after ${input.maxTurns} turns`, soft: true });
  }

  private systemPrompt(input: AgentRunInput): string {
    return systemPromptFor(input);
  }

  private async executeTool(call: ToolCall, input: AgentRunInput, filesChanged: Set<string>): Promise<{ ok: boolean; content: string; summary: string }> {
    const args = (call.args ?? {}) as Record<string, unknown>;
    const str = (name: string): string => {
      const value = args[name];
      if (typeof value !== "string") throw new ToolInputError(`${name} must be a string`);
      return value;
    };
    const allowed = (tool: string) => input.agent.tools.includes(tool as never);
    try {
      switch (call.name) {
        case "read_file": {
          if (!allowed("read")) throw new ToolInputError("read is not allowed for this agent");
          const path = safeRelativePath(str("path"));
          const content = await this.host.readFile(input.cwd, path);
          if (content === undefined) return { ok: false, content: `${path} does not exist`, summary: `read ${path} (missing)` };
          return { ok: true, content: sliceLines(content, args.start_line as number | undefined, args.end_line as number | undefined), summary: `read ${path}` };
        }
        case "list_files": {
          if (!allowed("read")) throw new ToolInputError("read is not allowed for this agent");
          const dir = safeRelativePath(typeof args.path === "string" ? args.path : ".");
          const files = await this.host.listFiles(input.cwd, dir, typeof args.glob === "string" ? args.glob : undefined);
          return { ok: true, content: files.slice(0, 500).join("\n") + (files.length > 500 ? `\n… ${files.length - 500} more` : ""), summary: `list ${dir}` };
        }
        case "search": {
          if (!allowed("search")) throw new ToolInputError("search is not allowed for this agent");
          const pattern = str("pattern");
          const hits = await this.host.search(input.cwd, pattern, typeof args.glob === "string" ? args.glob : undefined);
          return { ok: true, content: hits.slice(0, 200).map((h) => `${h.file}:${h.line}: ${h.text}`).join("\n") || "No matches", summary: `search ${pattern}` };
        }
        case "web_fetch": {
          if (!allowed("web") || !this.host.fetchUrl) throw new ToolInputError("web is not allowed for this agent");
          const url = str("url");
          return { ok: true, content: await this.host.fetchUrl(url, input.signal), summary: `fetch ${url}` };
        }
        case "edit_file": {
          if (!allowed("edit")) throw new ToolInputError("edit is not allowed for this agent");
          const path = safeRelativePath(str("path"));
          assertEditable(path, input.editScope);
          const content = await this.host.readFile(input.cwd, path);
          if (content === undefined) throw new ToolInputError(`${path} does not exist; use write_file to create it`);
          await this.host.writeFile(input.cwd, path, applyEdit(content, str("old_string"), str("new_string"), path));
          filesChanged.add(path);
          return { ok: true, content: `Edited ${path}`, summary: `edit ${path}` };
        }
        case "write_file": {
          if (!allowed("edit")) throw new ToolInputError("edit is not allowed for this agent");
          const path = safeRelativePath(str("path"));
          assertEditable(path, input.editScope);
          await this.host.writeFile(input.cwd, path, str("content"));
          filesChanged.add(path);
          return { ok: true, content: `Wrote ${path}`, summary: `write ${path}` };
        }
        case "run_command": {
          if (!allowed("command")) throw new ToolInputError("command is not allowed for this agent");
          const command = str("command");
          const outcome = await input.runCommand(command);
          return { ok: outcome.ok, content: `${outcome.ok ? "Exit 0" : "Failed"}\n${outcome.output}`, summary: command };
        }
        default:
          return { ok: false, content: `Unknown tool ${call.name}`, summary: call.name };
      }
    } catch (e) {
      const message = e instanceof ToolInputError ? e.message : `Tool error: ${(e as Error).message}`;
      return { ok: false, content: message, summary: `${call.name} failed` };
    }
  }

  /**
   * One prompt, one answer. In diff mode (models without tool calling) the files go in the
   * prompt and a unified diff comes back: a worker whose diff does not apply uses up one
   * attempt, while QA's extra tests are discarded. cli providers edit the worktree themselves.
   */
  private async runSingleShot(
    input: AgentRunInput,
    adapter: ProviderAdapter,
    link: ChainLink,
    system: string,
    usage: { input: number; output: number; cached: number },
    filesChanged: Set<string>,
    diffMode: boolean,
  ): Promise<AgentRunResult> {
    const files: string[] = [];
    for (const file of diffMode ? (input.diffModeFiles ?? []) : []) {
      const path = safeRelativePath(file);
      const content = await this.host.readFile(input.cwd, path);
      files.push(`### ${path}${input.editScope.length && input.editScope.includes(path) ? " (editable)" : " (read-only)"}\n\n\`\`\`\n${content ?? "(new file)"}\n\`\`\``);
    }
    const submitFields = input.submit
      .map((t) => `- ${t.name}: ${JSON.stringify(z.toJSONSchema(t.schema, { io: "input", unrepresentable: "any" }))}`)
      .join("\n");
    const closing = diffMode
      ? DIFF_MODE_INSTRUCTIONS
      : submitFields
        ? "Do the work directly in the repository. When you are done, print the result as a ```json block with the fields below."
        : "Do the work directly in the repository.";
    const prompt = [input.instructions, input.context, files.length ? `## Files\n\n${files.join("\n\n")}` : "", closing, submitFields ? `Submissions:\n${submitFields}` : ""]
      .filter(Boolean)
      .join("\n\n");
    const modelId = link.model.model;
    const release = await input.models.acquireSlot(input.signal);
    let text = "";
    try {
      for await (const event of adapter.stream({ model: modelId, system, messages: [{ role: "user", content: prompt }], cwd: input.cwd, ...maxOutput(link) }, input.signal)) {
        if (event.type === "text") {
          text += event.delta;
          input.onText(event.delta);
        } else if (event.type === "usage") {
          usage.input += event.input;
          usage.output += event.output;
          input.models.recordUsage(event);
        } else if (event.type === "error") {
          return this.result("failed", { usage, filesChanged, text, model: modelId, error: event.message, soft: true });
        }
      }
    } finally {
      release();
    }

    const json = /```json\s*\n([\s\S]*?)```/.exec(text)?.[1];
    let submission: { tool: string; value: unknown } | undefined;
    if (json && input.submit[0]) {
      try {
        const parsed = input.submit[0].schema.safeParse(JSON.parse(json));
        if (parsed.success) submission = { tool: input.submit[0].name, value: parsed.data };
      } catch {
        // An unparsable submission is treated as missing.
      }
    }
    const diff = diffMode ? extractDiff(text) : undefined;
    const discardOnFailure = input.mode === "qa";
    if (diffMode && diff && input.editScope.length) {
      try {
        const patches = parseUnifiedDiff(diff);
        const updates: { path: string; content: string }[] = [];
        for (const patch of patches) {
          const path = safeRelativePath(patch.path);
          assertEditable(path, input.editScope);
          const original = await this.host.readFile(input.cwd, path);
          const next = applyFileDiff(original, patch);
          if (next !== undefined) updates.push({ path, content: next });
        }
        for (const update of updates) {
          await this.host.writeFile(input.cwd, update.path, update.content);
          filesChanged.add(update.path);
        }
        input.onTool("apply_diff", `${updates.length} file(s)`, true);
      } catch (e) {
        const reason = e instanceof PatchError || e instanceof ToolInputError ? e.message : String(e);
        input.onTool("apply_diff", reason, false);
        if (!discardOnFailure) {
          return this.result("failed", { usage, filesChanged, text, model: modelId, error: `The diff did not apply: ${reason}`, soft: true });
        }
      }
    } else if (diffMode && !diff && input.mode === "work" && input.editScope.length) {
      return this.result("failed", { usage, filesChanged, text, model: modelId, error: "The model returned no diff", soft: true });
    }
    if (input.requireSubmit && !submission) {
      return this.result("failed", { usage, filesChanged, text, model: modelId, error: "The model returned no submission", soft: true });
    }
    return this.result("completed", { usage, filesChanged, text, model: modelId, ...(submission ? { submission } : {}) });
  }

  private result(
    status: AgentRunResult["status"],
    data: {
      usage: { input: number; output: number; cached: number };
      filesChanged: Set<string>;
      text: string;
      model?: string | undefined;
      error?: string;
      soft?: boolean;
      chainExhausted?: boolean;
      submission?: { tool: string; value: unknown };
    },
  ): AgentRunResult {
    return {
      status,
      text: data.text,
      usage: data.usage,
      filesChanged: [...data.filesChanged],
      ...(data.model ? { model: data.model } : {}),
      ...(data.error ? { error: data.error } : {}),
      ...(data.soft ? { soft: true } : {}),
      ...(data.chainExhausted ? { chainExhausted: true } : {}),
      ...(data.submission ? { submission: data.submission } : {}),
    };
  }
}
