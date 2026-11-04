import { spawn } from "node:child_process";
import type { CommandResult, CommandRunner } from "@delamain/core";
import { killProcessTree } from "./process.ts";

const MAX_OUTPUT = 2_000_000;

/** Runs shell commands in a worktree, with a timeout that kills the whole process group. */
export class NodeCommandRunner implements CommandRunner {
  constructor(private readonly baseEnv: NodeJS.ProcessEnv = process.env) {}

  run(input: { command: string; cwd: string; timeoutMs: number; env?: Record<string, string>; signal?: AbortSignal }): Promise<CommandResult> {
    const started = Date.now();
    if (input.signal?.aborted) return Promise.resolve({ exitCode: null, output: "Cancelled", timedOut: false, durationMs: 0 });
    return new Promise((resolve) => {
      let output = "";
      let timedOut = false;
      let settled = false;
      const child = spawn(input.command, {
        cwd: input.cwd,
        shell: true,
        detached: process.platform !== "win32",
        windowsHide: true,
        env: { ...this.baseEnv, ...input.env, CI: "1", FORCE_COLOR: "0" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const append = (chunk: Buffer) => {
        output += chunk.toString("utf8");
        if (output.length > MAX_OUTPUT) output = output.slice(-MAX_OUTPUT);
      };
      child.stdout.on("data", append);
      child.stderr.on("data", append);
      const kill = () => {
        killProcessTree(child);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, input.timeoutMs);
      const onAbort = () => kill();
      input.signal?.addEventListener("abort", onAbort, { once: true });
      const finish = (exitCode: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", onAbort);
        resolve({ exitCode, output, timedOut, durationMs: Date.now() - started });
      };
      child.on("error", (e) => {
        output += `\n${e.message}`;
        finish(null);
      });
      child.on("close", (code) => finish(timedOut ? null : code));
    });
  }
}
