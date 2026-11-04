import type { ChatMessage, ErrorKind, RateLimitSnapshot } from "../providers/types.ts";
import type { ChainLink, AdvanceCause } from "../router/route.ts";
import type { AgentDefinition } from "../schema/agent.ts";
import type { EscalationRequest } from "../schema/escalation.ts";
import type { TaskSpec } from "../schema/spec.ts";
import type { StepKey } from "../events/types.ts";
import type { z } from "zod";

export interface CommandResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  durationMs: number;
}

export interface CommandRunner {
  run(input: {
    command: string;
    cwd: string;
    timeoutMs: number;
    env?: Record<string, string>;
    signal?: AbortSignal;
  }): Promise<CommandResult>;
}

/** Access to files by absolute path, for command reports. */
export interface FileAccess {
  read(path: string): Promise<string | undefined>;
  remove(path: string): Promise<void>;
  join(...parts: string[]): string;
}

export interface SessionWorkspace {
  path: string;
  branch: string;
  baseCommit: string;
}

export interface TaskWorktree {
  path: string;
  branch: string;
  created: boolean;
}

export type MergeResult = { ok: true; commit?: string } | { ok: false; conflicts: string[] };

export interface Workspace {
  /** Creates (or reuses on resume) the session branch and its worktree. */
  startSession(sessionId: string): Promise<SessionWorkspace>;
  /** Worktree for one task attempt, branched from the session branch's current head. */
  createTaskWorktree(sessionId: string, taskId: string, attempt: number): Promise<TaskWorktree>;
  /** Diff of a worktree against its starting point, including new files. */
  diff(path: string, files?: readonly string[]): Promise<string>;
  changedFiles(path: string): Promise<string[]>;
  /** An opaque marker of the worktree's current content, to diff a single fix later. */
  checkpoint(path: string): Promise<string>;
  diffSince(path: string, checkpoint: string): Promise<string>;
  /** Discards changes to files outside the allowed list (setup side effects, stray edits). */
  restoreOthers(path: string, keep: readonly string[]): Promise<void>;
  /** Commits only `files` (one commit per task) and merges it into the session branch. */
  commitAndMerge(sessionId: string, path: string, taskId: string, files: readonly string[], message: string): Promise<MergeResult>;
  removeTaskWorktree(path: string): Promise<void>;
  sessionDiff(sessionId: string): Promise<string>;
  workingTreeDiff(): Promise<string>;
}

export interface RecordedStep {
  status: "succeeded" | "failed" | "skipped";
  outputs: Record<string, unknown>;
  fatal?: boolean;
  error?: string;
  /** Effects to re-apply on replay (spec versions, chain position, usage). */
  effects?: StepEffects;
}

export interface StepEffects {
  spec?: unknown;
  chainIndex?: number;
  usage?: { ref: string; tokens: number; costUsd: number }[];
  testPlanAdditions?: unknown[];
  answer?: string;
  /** The user's note when the final review was rejected. */
  rejection?: string;
}

/** Recorded results, used to resume a session after a restart without redoing finished steps. */
export interface Journal {
  get(key: StepKey): RecordedStep | undefined;
  put(key: StepKey, record: RecordedStep): void;
  conversation(key: StepKey): ChatMessage[] | undefined;
  saveConversation(key: StepKey, messages: ChatMessage[]): void;
  getValue<T>(key: string): T | undefined;
  putValue(key: string, value: unknown): void;
}

export class MemoryJournal implements Journal {
  readonly steps = new Map<string, RecordedStep>();
  readonly conversations = new Map<string, ChatMessage[]>();
  readonly values = new Map<string, unknown>();
  get(key: string) {
    return this.steps.get(key);
  }
  put(key: string, record: RecordedStep) {
    this.steps.set(key, record);
  }
  conversation(key: string) {
    return this.conversations.get(key);
  }
  saveConversation(key: string, messages: ChatMessage[]) {
    this.conversations.set(key, messages);
  }
  getValue<T>(key: string) {
    return this.values.get(key) as T | undefined;
  }
  putValue(key: string, value: unknown) {
    this.values.set(key, value);
  }
}

export interface ModelCursor {
  readonly role: string;
  current(): ChainLink | undefined;
  /** Moves to the next usable link; undefined when the chain is exhausted. */
  advance(cause: AdvanceCause): ChainLink | undefined;
  /** Goes back to the first usable link, e.g. once a rate limit has expired. */
  rewind(): ChainLink | undefined;
  acquireSlot(signal?: AbortSignal): Promise<() => void>;
  /** Records a failure of the current link so the router skips it for as long as it applies. */
  reportFailure(failure: { kind: ErrorKind; message: string; retryAfterMs?: number }): void;
  /** Returns true when this usage exhausted the current profile's session budget. */
  recordUsage(usage: { input: number; output: number; cached?: number }): boolean;
  /** Earliest time a rate-limited link of the chain becomes usable again. */
  nextRetryAt(): number | undefined;
  /** Usage counters read from the provider's rate-limit headers, per credential profile. */
  reportRateLimits?(snapshot: RateLimitSnapshot): void;
}

export type AgentMode = "spec" | "verify" | "triage" | "steer" | "work" | "fix" | "qa" | "review";

export interface SubmitTool {
  name: string;
  description: string;
  schema: z.ZodType;
  /** Semantic checks beyond the schema; errors go back to the model so it can fix them. */
  validate?(value: unknown): string[];
}

export type EscalationReply = { kind: "continue"; message: string } | { kind: "abort"; reason: string };

export interface AgentRunInput {
  key: StepKey;
  agent: AgentDefinition;
  mode: AgentMode;
  task?: TaskSpec;
  cwd: string;
  /** Globs the agent may edit; empty means read-only. */
  editScope: string[];
  /** Mode-specific instructions, sent as the first user message. */
  instructions: string;
  /** What the flow author wrote on this block, added to the system prompt after the agent's own. */
  blockInstructions?: string;
  /** Spec, inputs, feedback and decisions, rendered as text. */
  context: string;
  /** Files sent inline to models in diff mode. */
  diffModeFiles?: string[];
  submit: SubmitTool[];
  /** True when one of the submit tools must be called to finish. */
  requireSubmit: boolean;
  models: ModelCursor;
  maxTurns: number;
  signal: AbortSignal;
  onEscalation(request: EscalationRequest): Promise<EscalationReply>;
  runCommand(command: string): Promise<{ ok: boolean; output: string }>;
  onText(delta: string): void;
  onTool(tool: string, summary: string, ok: boolean): void;
}

export interface AgentRunResult {
  status: "completed" | "failed" | "aborted";
  /** Soft failures use up an attempt (e.g. a diff that does not apply); hard ones stop the step. */
  soft?: boolean;
  error?: string;
  submission?: { tool: string; value: unknown };
  text: string;
  usage: { input: number; output: number; cached: number };
  model?: string;
  filesChanged: string[];
  chainExhausted?: boolean;
}

export interface AgentRunner {
  run(input: AgentRunInput): Promise<AgentRunResult>;
}
