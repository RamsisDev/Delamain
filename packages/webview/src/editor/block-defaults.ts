import type { Block, BlockType } from "@delamain/core";

export type BlockFamily = "ai" | "deterministic" | "control" | "container";

export const BLOCK_META: Record<BlockType, { label: string; icon: string; family: BlockFamily; hint: string }> = {
  agent: { label: "Agent", icon: "◆", family: "ai", hint: "Runs a role with its prompt" },
  foreach: { label: "For each", icon: "⇉", family: "container", hint: "Runs its body for every task" },
  command: { label: "Command", icon: "$", family: "deterministic", hint: "Runs a command; its exit code is the verdict" },
  review: { label: "Review", icon: "⌕", family: "ai", hint: "Bugbot review with findings routing" },
  condition: { label: "Condition", icon: "◇", family: "control", hint: "Picks a path from an expression" },
  loop: { label: "Loop", icon: "↻", family: "container", hint: "Repeats its body until a condition, with limits" },
  approval: { label: "Approval", icon: "✔", family: "control", hint: "Automatic or user approval" },
  subflow: { label: "Subflow", icon: "⎘", family: "control", hint: "Runs another reusable flow" },
  script: { label: "Script", icon: "{}", family: "deterministic", hint: "External command returning JSON outputs" },
};

/** A new block of `type`. Required fields without a sensible default stay empty so validation asks for them. */
export function defaultBlock(type: BlockType, id: string): Block {
  switch (type) {
    case "agent":
      return { id, type, agent: "worker" };
    case "foreach":
      return { id, type, over: "spec.pending_tasks", body: [] };
    case "command":
      return { id, type, run: "{{commands.test}}" };
    case "review":
      return { id, type, agent: "bugbot", scope: "task.diff" };
    case "condition":
      return { id, type, expr: "" };
    case "loop":
      return { id, type, max_iterations: 3, until: "", body: [] };
    case "approval":
      return { id, type, mode: "auto" };
    case "subflow":
      return { id, type, flow: "flows/verify.yml" };
    case "script":
      return { id, type, run: "" };
  }
}

/** One-line summary shown on a node. */
export function blockSummary(block: Block): string {
  switch (block.type) {
    case "agent":
      return `${block.agent}${block.model ? ` · ${block.model}` : ""}`;
    case "review":
      return `${block.agent}${block.scope ? ` · ${block.scope}` : ""}`;
    case "command":
    case "script":
      return block.run;
    case "condition":
      return block.expr;
    case "loop":
      return `≤ ${block.max_iterations} × until ${block.until || "?"}`;
    case "foreach":
      return `over ${block.over}${block.max_parallel ? ` · ${block.max_parallel} parallel` : ""}`;
    case "approval":
      return block.mode ?? "auto";
    case "subflow":
      return block.flow;
  }
}
