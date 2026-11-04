import type { FindingRoute } from "../schema/common.ts";
import type { Escalation, HumanOption, TriageOutcome } from "../schema/escalation.ts";
import type { BlockType } from "../schema/flow.ts";

export type StepStatus = "waiting" | "running" | "succeeded" | "failed" | "skipped" | "paused" | "cancelled";

interface Base {
  /** Monotonic sequence number within the session. */
  seq: number;
  ts: number;
  session: string;
}

/** Step key: a stable path such as delivery-loop#1/build/t2/test-loop#2/code. */
export type StepKey = string;

export type HarnessEventBody =
  | { type: "session.started"; message: string; flow: string; principal?: string; approval: "auto" | "review"; base?: string; branch?: string }
  | { type: "session.finished"; status: "succeeded" | "failed" | "cancelled" | "answered"; summary?: string }
  | { type: "session.paused"; reason: string }
  | { type: "session.resumed" }
  | { type: "step.waiting"; key: StepKey; block: string; blockType: BlockType; waitingFor: string[]; condition?: string; task?: string; label?: string }
  | { type: "step.started"; key: StepKey; block: string; blockType: BlockType; task?: string; label?: string; attempt?: number; maxAttempts?: number }
  | { type: "step.finished"; key: StepKey; block: string; status: StepStatus; outputs: Record<string, unknown>; durationMs: number; tokens?: number; model?: string; error?: string; record?: unknown }
  /** A failed agent or review block starts attempt `attempt` of `maxAttempts` after `delayMs`. */
  | { type: "step.retrying"; key: StepKey; block: string; attempt: number; maxAttempts: number; error: string; delayMs?: number; task?: string }
  | { type: "loop.iteration"; key: StepKey; block: string; iteration: number; max: number; task?: string; budget?: { tokens: number; maxTokens?: number; minutes: number; maxMinutes?: number } }
  | { type: "task.started"; task: string; goal: string; kind: string; worktree?: string }
  | { type: "task.delta"; task: string; key: StepKey; text: string }
  | { type: "task.finished"; task: string; commit?: string }
  | { type: "task.failed"; task: string; reason: string }
  | { type: "task.waiting"; task: string; waitingFor: string[]; reason: string }
  | { type: "router.decision"; key: StepKey; task?: string; role: string; model: string; modelLabel: string; rule: string; reason: string; chainIndex: number; chain: string[]; warnings: string[]; skipped: { ref: string; reason: string }[] }
  | { type: "router.switch"; key: StepKey; task?: string; from: string; to?: string; cause: string }
  | { type: "provider.slot_wait"; key: StepKey; provider: string }
  | { type: "provider.limits"; provider: string; profile?: string; requestsRemaining?: number; tokensRemaining?: number; resetAt?: number }
  | { type: "agent.tool"; key: StepKey; task?: string; tool: string; summary: string; ok: boolean }
  | { type: "usage"; key: StepKey; role: string; model: string; provider: string; profile?: string; input: number; output: number; cached?: number; costUsd?: number }
  | { type: "command.finished"; key: StepKey; command: string; exitCode: number | null; passed: boolean; failures: number; durationMs: number }
  | { type: "spec.published"; version: number; tasks: string[]; reopened: string[]; reason: string; spec: unknown }
  | { type: "finding.routed"; key: StepKey; task?: string; finding: string; severity: string; category: string; route: FindingRoute; rule: string; message: string; promotedFrom?: FindingRoute; promotionReason?: string; status?: "pending" | "fixed" | "failed" | "reported" }
  | { type: "escalation.raised"; escalation: Escalation }
  | { type: "escalation.triaged"; id: string; outcome: TriageOutcome["outcome"]; detail: string }
  | { type: "escalation.resolved"; id: string; answer: string; decidedBy: "human" | "principal" | "agent"; decision?: string }
  | { type: "question.asked"; id: string; escalation?: string; question: string; options: HumanOption[]; blocks: string[]; batched: boolean }
  | { type: "question.answered"; id: string; answer: string }
  | { type: "approval.requested"; key: StepKey }
  | { type: "approval.resolved"; key: StepKey; approved: boolean; note?: string }
  | { type: "message.user"; text: string }
  | { type: "message.assistant"; text: string }
  | { type: "warning"; key?: StepKey; task?: string; message: string };

export type HarnessEvent = Base & HarnessEventBody;
export type HarnessEventType = HarnessEvent["type"];

export interface EventSink {
  emit(event: HarnessEventBody): void;
}
