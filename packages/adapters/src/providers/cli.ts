import { spawn } from "node:child_process";
import type { ChatEvent, ChatRequest, Health, ModelInfo, ProviderAdapter } from "@delamain/core";

/** Splits a command line into argv, honoring single and double quotes. */
export function splitCommand(command: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: string | undefined;
  let has = false;
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      has = true;
    } else if (/\s/.test(char)) {
      if (current || has) args.push(current);
      current = "";
      has = false;
    } else {
      current += char;
      has = true;
    }
  }
  if (current || has) args.push(current);
  return args;
}

export function renderConversation(request: ChatRequest): string {
  const parts = [request.system];
  for (const message of request.messages) {
    if (message.role === "user") parts.push(message.content);
    else if (message.role === "assistant" && message.content) parts.push(`(previous answer)\n${message.content}`);
    else if (message.role === "tool") parts.push(`(tool ${message.name})\n${message.content}`);
  }
  return parts.join("\n\n");
}

/** Linux caps a single argument at 128 KiB; longer prompts must go through stdin. */
const MAX_ARGUMENT_BYTES = 120_000;

export interface CliOptions {
  /** `argument` (default) appends the prompt to the command line; `stdin` writes it to standard input. */
  promptInput?: "argument" | "stdin";
}

/**
 * Runs the official, unmodified CLI (for example `codex exec`) with the user's own session.
 * It edits the worktree itself and is not restricted by the harness; token usage is unknown.
 */
export class CliAdapter implements ProviderAdapter {
  readonly type = "cli" as const;

  constructor(
    readonly id: string,
    private readonly command: string,
    private readonly options: CliOptions = {},
  ) {}

  async listModels(): Promise<ModelInfo[]> {
    return [{ id: "default", label: this.command, toolCalling: false }];
  }

  async healthCheck(): Promise<Health> {
    const [program] = splitCommand(this.command);
    if (!program) return { status: "offline", message: "No command configured" };
    const started = Date.now();
    return new Promise((resolve) => {
      const child = spawn(program, ["--version"], { stdio: "ignore", timeout: 10_000 });
      child.on("error", (e) => resolve({ status: "offline", message: `${program}: ${e.message}` }));
      child.on("exit", (code) =>
        resolve(code === 0 ? { status: "online", latencyMs: Date.now() - started } : { status: "offline", message: `${program} --version exited with ${code}` }),
      );
    });
  }

  async *stream(request: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent> {
    const [program, ...args] = splitCommand(this.command);
    if (!program) {
      yield { type: "error", kind: "bad_request", message: "No command configured" };
      return;
    }
    const prompt = renderConversation(request);
    const viaStdin = this.options.promptInput === "stdin";
    const bytes = Buffer.byteLength(prompt);
    if (!viaStdin && bytes > MAX_ARGUMENT_BYTES) {
      yield {
        type: "error",
        kind: "bad_request",
        message: `The prompt is ${Math.round(bytes / 1024)} KiB, too long for one command-line argument; set prompt_input: stdin on provider ${this.id}`,
      };
      return;
    }
    const child = spawn(program, viaStdin ? args : [...args, prompt], { cwd: request.cwd, signal, stdio: [viaStdin ? "pipe" : "ignore", "pipe", "pipe"] });
    if (viaStdin) {
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(prompt);
    }
    const queue: ChatEvent[] = [];
    let wake: (() => void) | undefined;
    let finished = false;
    let stderr = "";
    const push = (event: ChatEvent) => {
      queue.push(event);
      wake?.();
    };
    child.stdout!.setEncoding("utf8").on("data", (chunk: string) => push({ type: "text", delta: chunk }));
    child.stderr!.setEncoding("utf8").on("data", (chunk: string) => (stderr = (stderr + chunk).slice(-4000)));
    child.on("error", (e) => {
      push({ type: "error", kind: "unavailable", message: e.message });
      finished = true;
      wake?.();
    });
    child.on("close", (code) => {
      if (code !== 0 && !signal.aborted) push({ type: "error", kind: "unavailable", message: `${program} exited with ${code}: ${stderr.trim()}` });
      else push({ type: "done", stopReason: "exit" });
      finished = true;
      wake?.();
    });
    while (!finished || queue.length) {
      if (!queue.length) await new Promise<void>((resolve) => (wake = resolve));
      wake = undefined;
      while (queue.length) {
        const event = queue.shift()!;
        yield event;
        if (event.type === "error") return;
      }
    }
  }
}
