import { modeInstructions, renderDecisions, renderNamed, renderSpec, renderTask, renderValue, section } from "../agent/prompts.ts";
import {
  FindingsSubmission,
  QaSubmission,
  SteerSubmission,
  SUBMIT_TOOLS,
  VerdictSubmission,
} from "../agent/submissions.ts";
import { parseSpecOf, parseJunit, parseJsonFailures, parseRegexFailures, tailLines, failureSignature, type Failure } from "../commands/parse.ts";
import type { CommandGate, CommandSource } from "../commands/policy.ts";
import { renderTemplate, TemplateError } from "../commands/template.ts";
import { EscalationManager, type EscalationResolution, type HumanPort } from "../escalation/manager.ts";
import type { EventSink, HarnessEventBody } from "../events/types.ts";
import { applyDetectors, bugbotClaimDetector, promote, routeFinding, type BehaviorChangeDetector, type RoutedFinding } from "../findings/routing.ts";
import { checkFixScope, describeViolations } from "../findings/safeguard.ts";
import { approximateTokens, type ErrorKind, type RateLimitSnapshot } from "../providers/types.ts";
import { profileKey, type CatalogModel } from "../router/catalog.ts";
import { usageCost, type AdvanceCause, type ChainLink, type RouteDecision, type RouteRequest } from "../router/route.ts";
import type { Clock, RouterService } from "../router/service.ts";
import type { AgentDefinition } from "../schema/agent.ts";
import { AGENT_ROLE_TO_ROUTER_ROLE, type AutoTrigger } from "../schema/common.ts";
import type { HarnessConfig } from "../schema/config.ts";
import type { Decision, Escalation, EscalationRequest, TriageOutcome } from "../schema/escalation.ts";
import type { Finding } from "../schema/findings.ts";
import type {
  AgentBlock,
  ApprovalBlock,
  Block,
  CommandBlock,
  ConditionBlock,
  Flow,
  ForeachBlock,
  LoopBlock,
  ReviewBlock,
  ScriptBlock,
  SubflowBlock,
} from "../schema/flow.ts";
import { resolveLimits, type ResolvedLimits } from "../schema/limits.ts";
import { SpecSubmission, testFilesOf, type TaskSpec } from "../schema/spec.ts";
import { parseDuration } from "../util/duration.ts";
import { parseUnifiedDiff } from "../util/diff.ts";
import { formatIssue } from "../util/issues.ts";
import { evaluate, evaluateBoolean, getPath, parseExpression, truthy } from "./expression.ts";
import { Frame, combine, type TaskAction, type TaskRun } from "./frame.ts";
import { agentRoleOf, dependenciesOf, walkBlocks } from "./graph.ts";
import type {
  AgentMode,
  AgentRunner,
  AgentRunResult,
  CommandRunner,
  EscalationReply,
  FileAccess,
  Journal,
  ModelCursor,
  RecordedStep,
  StepEffects,
  SubmitTool,
  Workspace,
} from "./ports.ts";
import { SpecStore, validateSpecSubmission, type TaskState } from "./spec-store.ts";

export interface EngineOptions {
  sessionId: string;
  message: string;
  flow: Flow;
  config: HarnessConfig;
  agents: ReadonlyMap<string, AgentDefinition>;
  approval?: "auto" | "review";
  principal?: string;
  /** Decisions persisted by earlier sessions. */
  decisions?: Decision[];
  /** Earlier turns of this conversation, for context. */
  history?: string;
}

export interface EngineDeps {
  router: RouterService;
  runner: AgentRunner;
  commands: CommandRunner;
  files: FileAccess;
  workspace: Workspace;
  human: HumanPort;
  gate: CommandGate;
  journal: Journal;
  events: EventSink;
  clock: Clock;
  loadSubflow?(path: string): Promise<Flow>;
  detectors?: BehaviorChangeDetector[];
  persistDecision?(decision: Decision, scope: "project" | "global"): Promise<void>;
}

export interface SessionResult {
  status: "succeeded" | "failed" | "cancelled" | "answered";
  summary: string;
  answer?: string;
  branch?: string;
  worktree?: string;
  baseCommit?: string;
  diff?: string;
  reportOnly: Finding[];
}

interface BlockResult {
  status: "succeeded" | "failed" | "skipped";
  outputs: Record<string, unknown>;
  fatal?: boolean;
  error?: string;
  effects?: StepEffects;
  /** Not journaled, e.g. because it must run again after a restart. */
  transient?: boolean;
  tokens?: number;
  model?: string;
}

/** One run of a leaf block: the first one is 0, retries count up from 1. */
interface Attempt {
  index: number;
  signal: AbortSignal;
}

interface BodyResult {
  status: "succeeded" | "failed";
  fatal: boolean;
  results: Map<string, BlockResult>;
  error?: string;
}

class TaskRestart extends Error {
  constructor(
    readonly taskId: string,
    readonly reason: string,
  ) {
    super(`Task ${taskId} restarts: ${reason}`);
  }
}

class FlowAnswered extends Error {
  constructor(readonly answer: string) {
    super("answered");
  }
}

class ApprovalRejected extends Error {
  constructor(readonly note: string) {
    super("rejected");
  }
}

class PauseGate {
  private waiters: (() => void)[] = [];
  private holds = 0;
  hold(): () => void {
    this.holds++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds--;
      if (this.holds === 0) {
        const waiters = this.waiters;
        this.waiters = [];
        for (const w of waiters) w();
      }
    };
  }
  async wait(): Promise<void> {
    if (this.holds === 0) return;
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }
}

const CONTROL_ERRORS = [TaskRestart, FlowAnswered, ApprovalRejected];
function isControl(error: unknown): boolean {
  return CONTROL_ERRORS.some((type) => error instanceof type);
}

/**
 * Interprets a flow: blocks wait for their dependencies, loops repeat with bounded attempts,
 * commands deliver verdicts, and escalations pause only what they affect. Every finished
 * step is journaled, so a session can resume after a restart without redoing work.
 */
export class FlowEngine {
  readonly spec = new SpecStore();
  readonly escalations: EscalationManager;
  private readonly limits: ResolvedLimits;
  private readonly counters = new Map<string, number>();
  private readonly pauseGate = new PauseGate();
  private readonly abort = new AbortController();
  private readonly startedAt: number;
  private timeBaseline: number;
  private userFeedback: string[] = [];
  private session?: { path: string; branch: string; baseCommit: string };
  private implicitTask?: TaskRun;
  private principalCursor?: EngineCursor;
  private readonly reportOnly: Finding[] = [];
  private readonly runningTasks = new Map<string, TaskRun>();

  constructor(
    readonly options: EngineOptions,
    private readonly deps: EngineDeps,
  ) {
    this.limits = resolveLimits(options.config.limits);
    this.startedAt = deps.clock.now();
    this.timeBaseline = this.startedAt;
    this.escalations = new EscalationManager({
      events: deps.events,
      human: deps.human,
      limits: this.limits,
      policy: options.flow.policy?.escalation ?? {},
      now: () => deps.clock.now(),
      triage: (input, signal) => this.triage(input.escalation, signal),
      recorded: (id) => deps.journal.getValue<EscalationResolution>(`escalation:${id}`),
      record: (id, resolution) => deps.journal.putValue(`escalation:${id}`, resolution),
    });
    this.escalations.addDecisions(options.decisions ?? []);
  }

  cancel(reason = "Cancelled by the user"): void {
    this.abort.abort(new Error(reason));
  }

  /** Per-task actions from the chat: only that task's agents and commands are interrupted. */
  taskAction(taskId: string, action: TaskAction): boolean {
    const run = this.runningTasks.get(taskId);
    if (!run) return false;
    run.requested = action;
    run.control.abort(new Error(`${action} requested by the user`));
    return true;
  }

  /**
   * A message from the user during a run goes to the principal, which stops the session or
   * keeps it running; when the message changes requirements it publishes a spec delta and the
   * affected tasks start over.
   */
  async userMessage(text: string): Promise<{ action: "continue" | "stop"; reply: string }> {
    this.emit({ type: "message.user", text });
    const principal = [...this.options.agents.values()].find((a) => a.role === "principal");
    if (!principal) {
      this.userFeedback.push(`User: ${text}`);
      return { action: "continue", reply: "Noted; the agents will see your message." };
    }
    const key = `steer/${this.deps.clock.now()}`;
    let context = section("Current spec", renderSpec(this.spec.current));
    context += section(
      "Task status",
      this.spec.current ? this.spec.current.tasks.map((t) => `- ${t.id}: ${this.spec.state.get(t.id) ?? "pending"} — ${t.goal}`).join("\n") : undefined,
    );
    context += section("Original request", this.options.message);
    const cursor = this.principalCursor ?? this.cursorFor({ id: "steer", type: "review", agent: principal.name }, principal, key, undefined);
    const result = await this.callAgent({
      key,
      agent: { ...principal, tools: principal.tools.filter((t) => t !== "delegate") },
      mode: "steer",
      task: undefined,
      cwd: this.session?.path ?? ".",
      editScope: [],
      instructions: modeInstructions("steer", { message: text }),
      context,
      cursor,
      frame: new Frame(undefined, key, this.session?.path ?? "."),
    });
    const parsed = SteerSubmission.safeParse(result.submission?.value);
    const decision = parsed.success ? parsed.data : { action: "continue" as const, reply: result.text || "Noted.", reopen: [] };
    this.userFeedback.push(`User: ${text}`);
    for (const item of decision.reopen) {
      if (!this.spec.task(item.task)) continue;
      const change = this.spec.annotate([item.task], `User: ${item.note}`);
      if (change) this.emitSpec(change.version, change.pending, change.reopened, `user message → ${item.task}`);
      this.taskAction(item.task, "retry");
    }
    this.emit({ type: "message.assistant", text: decision.reply });
    if (decision.action === "stop") this.cancel("Stopped by the principal after the user's message");
    return { action: decision.action, reply: decision.reply };
  }

  private signalFor(task: TaskRun | undefined): AbortSignal {
    return task && !task.implicit ? AbortSignal.any([this.abort.signal, task.control.signal]) : this.abort.signal;
  }

  get signal(): AbortSignal {
    return this.abort.signal;
  }

  private emit(event: HarnessEventBody): void {
    this.deps.events.emit(event);
  }

  async run(): Promise<SessionResult> {
    const session = await this.deps.workspace.startSession(this.options.sessionId);
    this.session = session;
    const approval = this.options.approval ?? this.options.config.defaults?.approval ?? "auto";
    this.emit({
      type: "session.started",
      message: this.options.message,
      flow: this.options.flow.name,
      approval,
      branch: session.branch,
      base: session.baseCommit,
      ...(this.options.principal ? { principal: this.options.principal } : {}),
    });
    const maxRounds = this.limits.max_loop_iterations;
    try {
      for (let round = 1; ; round++) {
        const root = new Frame(undefined, round === 1 ? "" : `r${round}`, session.path);
        try {
          const body = await this.runSteps(this.options.flow.steps, root);
          return await this.finish(body.status === "succeeded" ? "succeeded" : "failed", body.error);
        } catch (e) {
          if (e instanceof ApprovalRejected && round < maxRounds) {
            this.userFeedback = [...this.userFeedback, `User review: ${e.note}`];
            if (this.implicitTask) this.implicitTask.notes.push(`User review: ${e.note}`);
            continue;
          }
          if (e instanceof ApprovalRejected) return await this.finish("failed", "Rejected in review too many times");
          throw e;
        }
      }
    } catch (e) {
      if (e instanceof FlowAnswered) {
        this.emit({ type: "message.assistant", text: e.answer });
        this.emit({ type: "session.finished", status: "answered", summary: e.answer.slice(0, 200) });
        return { status: "answered", summary: e.answer, answer: e.answer, reportOnly: [] };
      }
      if (this.abort.signal.aborted) {
        this.emit({ type: "session.finished", status: "cancelled" });
        return { status: "cancelled", summary: "Cancelled", branch: session.branch, reportOnly: this.reportOnly };
      }
      const message = (e as Error).message ?? String(e);
      this.emit({ type: "session.finished", status: "failed", summary: message });
      return { status: "failed", summary: message, branch: session.branch, reportOnly: this.reportOnly };
    }
  }

  private async finish(status: "succeeded" | "failed", error?: string): Promise<SessionResult> {
    const session = this.session!;
    const diff = await this.deps.workspace.sessionDiff(this.options.sessionId).catch(() => "");
    const summary =
      status === "succeeded"
        ? `Done: ${this.spec.current?.tasks.length ?? 0} task(s) on ${session.branch}`
        : `Stopped: ${error ?? "a step failed"}`;
    this.emit({ type: "session.finished", status, summary });
    return {
      status,
      summary,
      branch: session.branch,
      worktree: session.path,
      baseCommit: session.baseCommit,
      diff,
      reportOnly: this.reportOnly,
    };
  }

  // ---------------------------------------------------------------- scheduling

  private async runSteps(blocks: Block[], frame: Frame): Promise<BodyResult> {
    const ids = new Set(blocks.map((b) => b.id));
    const deps = new Map(blocks.map((b, i) => [b.id, dependenciesOf(b, blocks, i).filter((d) => ids.has(d))]));
    const results = new Map<string, BlockResult>();
    const started = new Set<string>();
    const announced = new Set<string>();
    const running = new Map<string, Promise<{ id: string; error?: unknown }>>();
    let firstError: unknown;

    const ready = (block: Block) => {
      const d = deps.get(block.id)!;
      if (d.length === 0) return true;
      return block.join === "any" ? d.some((x) => results.has(x)) : d.every((x) => results.has(x));
    };

    while (results.size < blocks.length) {
      for (const block of blocks) {
        if (started.has(block.id) || firstError) continue;
        if (!ready(block)) {
          if (!announced.has(block.id)) {
            announced.add(block.id);
            const waitingFor = deps.get(block.id)!.filter((d) => !results.has(d));
            this.emit({
              type: "step.waiting",
              key: this.keyOf(frame, block),
              block: block.id,
              blockType: block.type,
              waitingFor,
              ...(block.when ? { condition: block.when } : {}),
              ...(frame.task ? { task: frame.task.id } : {}),
              ...(block.label ? { label: block.label } : {}),
            });
          }
          continue;
        }
        started.add(block.id);
        const depResults = deps.get(block.id)!.map((d) => results.get(d)).filter((r): r is BlockResult => !!r);
        running.set(
          block.id,
          this.runGuarded(block, frame, depResults).then(
            (result) => {
              results.set(block.id, result);
              return { id: block.id };
            },
            (error: unknown) => ({ id: block.id, error }),
          ),
        );
      }
      if (running.size === 0) {
        if (firstError) break;
        for (const block of blocks) {
          if (!results.has(block.id)) results.set(block.id, { status: "skipped", outputs: {} });
        }
        break;
      }
      const done = await Promise.race(running.values());
      running.delete(done.id);
      if (done.error !== undefined && firstError === undefined) firstError = done.error;
      if (firstError && running.size === 0) break;
    }
    if (firstError !== undefined) throw firstError;

    const all = [...results.values()];
    const fatal = all.some((r) => r.fatal);
    const failed = all.find((r) => r.status === "failed");
    return {
      status: failed ? "failed" : "succeeded",
      fatal,
      results,
      ...(failed?.error ? { error: failed.error } : {}),
    };
  }

  private keyOf(frame: Frame, block: Block): string {
    return frame.key ? `${frame.key}/${block.id}` : block.id;
  }

  private async runGuarded(block: Block, frame: Frame, depResults: BlockResult[]): Promise<BlockResult> {
    const condition = block.when ?? "success";
    const success = block.join === "any"
      ? depResults.length === 0 || depResults.some((r) => r.status !== "failed")
      : depResults.every((r) => r.status !== "failed");
    const failure = depResults.some((r) => r.status === "failed");
    let shouldRun: boolean;
    if (condition === "success") shouldRun = success && !depResults.some((r) => r.fatal);
    else if (condition === "failure") shouldRun = failure;
    else if (condition === "always") shouldRun = true;
    else {
      try {
        shouldRun = evaluateBoolean(condition, (path) => {
          if (path.length === 1 && path[0] === "success") return success;
          if (path.length === 1 && path[0] === "failure") return failure;
          if (path.length === 1 && path[0] === "always") return true;
          return this.resolve(frame, path);
        });
      } catch (e) {
        return { status: "failed", outputs: {}, fatal: true, error: `when: ${(e as Error).message}` };
      }
    }
    const key = this.keyOf(frame, block);
    if (!shouldRun) {
      const result: BlockResult = { status: "skipped", outputs: { status: "skipped" } };
      frame.setOutputs(block.id, result.outputs);
      this.emit({ type: "step.finished", key, block: block.id, status: "skipped", outputs: {}, durationMs: 0 });
      return result;
    }
    const result = await this.runBlock(block, frame, key);
    frame.setOutputs(block.id, { ...result.outputs, status: result.status });
    if (block.on_finish?.length) await this.runOnFinish(block, frame, result);
    return result;
  }

  private async runBlock(block: Block, frame: Frame, key: string): Promise<BlockResult> {
    if (this.abort.signal.aborted) throw this.abort.signal.reason;
    if (block.type === "loop") return this.runLoop(block, frame, key);
    if (block.type === "foreach") return this.runForeach(block, frame, key);
    if (block.type === "subflow") return this.runSubflow(block, frame, key);

    const recorded = this.deps.journal.get(key);
    if (recorded) {
      this.replayEffects(recorded.effects, frame);
      this.emit({
        type: "step.finished",
        key,
        block: block.id,
        status: recorded.status,
        outputs: recorded.outputs,
        durationMs: 0,
      });
      return { ...recorded };
    }

    const loop = frame.nearestLoop();
    this.emit({
      type: "step.started",
      key,
      block: block.id,
      blockType: block.type,
      ...(frame.task ? { task: frame.task.id } : {}),
      ...(block.label ? { label: block.label } : {}),
      ...(loop ? { attempt: loop.iteration } : {}),
    });
    const startedAt = this.deps.clock.now();
    const retries = block.type === "agent" || block.type === "review" ? (block.retries ?? 0) : 0;
    const attemptKey = `attempt:${key}`;
    let index = this.deps.journal.getValue<number>(attemptKey) ?? 0;
    let result: BlockResult;
    for (;;) {
      result = await this.runAttempt(block, frame, key, index);
      if (result.status !== "failed" || index >= retries || this.abort.signal.aborted) break;
      index++;
      this.deps.journal.putValue(attemptKey, index);
      const delayMs = this.retryDelay(block as AgentBlock | ReviewBlock, index);
      this.emit({
        type: "step.retrying",
        key,
        block: block.id,
        attempt: index + 1,
        maxAttempts: retries + 1,
        error: result.error ?? "The block failed",
        ...(delayMs ? { delayMs } : {}),
        ...(frame.task ? { task: frame.task.id } : {}),
      });
      if (delayMs) await this.deps.clock.sleep(delayMs, this.signalFor(frame.task));
    }
    this.emit({
      type: "step.finished",
      key,
      block: block.id,
      status: result.status,
      outputs: summarizeOutputs(result.outputs),
      durationMs: this.deps.clock.now() - startedAt,
      ...(result.tokens !== undefined ? { tokens: result.tokens } : {}),
      ...(result.model ? { model: result.model } : {}),
      ...(result.error ? { error: result.error } : {}),
    });
    if (!result.transient) {
      const record: RecordedStep = {
        status: result.status,
        outputs: result.outputs,
        ...(result.fatal ? { fatal: true } : {}),
        ...(result.error ? { error: result.error } : {}),
        ...(result.effects ? { effects: result.effects } : {}),
      };
      this.deps.journal.put(key, record);
    }
    return result;
  }

  /** One attempt of a leaf block. A timeout also aborts the attempt, so a retry never runs next to it. */
  private async runAttempt(block: Block, frame: Frame, key: string, index: number): Promise<BlockResult> {
    const controller = new AbortController();
    const attempt: Attempt = { index, signal: AbortSignal.any([this.signalFor(frame.task), controller.signal]) };
    try {
      return await this.withTimeout(block, controller, () => this.runLeaf(block, frame, key, attempt));
    } catch (e) {
      if (isControl(e) || this.abort.signal.aborted) throw e;
      return { status: "failed", outputs: {}, fatal: true, transient: true, error: (e as Error).message ?? String(e) };
    }
  }

  private retryDelay(block: AgentBlock | ReviewBlock, retry: number): number {
    if (!block.retry_delay) return 0;
    return parseDuration(block.retry_delay) * (block.retry_backoff ?? 1) ** (retry - 1);
  }

  private async withTimeout<T>(block: Block, controller: AbortController, run: () => Promise<T>): Promise<T> {
    if (!block.timeout || block.type === "command") return run();
    const ms = parseDuration(block.timeout);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        run(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const error = new Error(`Timed out after ${block.timeout}`);
            controller.abort(error);
            reject(error);
          }, ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private runLeaf(block: Block, frame: Frame, key: string, attempt: Attempt): Promise<BlockResult> {
    switch (block.type) {
      case "agent":
        return this.runAgentBlock(block, frame, key, attempt);
      case "command":
        return this.runCommandBlock(block, frame, key);
      case "review":
        return this.runReview(block, frame, key, attempt);
      case "condition":
        return this.runCondition(block, frame);
      case "approval":
        return this.runApproval(block, frame, key);
      case "script":
        return this.runScript(block, frame, key);
      default:
        throw new Error(`Unsupported block type ${(block as Block).type}`);
    }
  }

  private replayEffects(effects: StepEffects | undefined, frame: Frame): void {
    if (!effects) return;
    if (effects.spec) {
      const submission = SpecSubmission.parse(effects.spec);
      const change = this.spec.publish(submission);
      this.emitSpec(change.version, change.pending, change.reopened, "resumed");
    }
    if (effects.answer) throw new FlowAnswered(effects.answer);
    if (effects.rejection !== undefined) throw new ApprovalRejected(effects.rejection);
    if (effects.chainIndex !== undefined && frame.task?.cursor instanceof EngineCursor) {
      frame.task.cursor.index = effects.chainIndex;
    }
    for (const usage of effects.usage ?? []) {
      const model = this.deps.router.catalog.favorites.find((m) => m.ref === usage.ref);
      if (model) this.deps.router.recordUsage(model, usage.tokens, usage.costUsd);
    }
    if (effects.testPlanAdditions?.length && frame.task) {
      this.addTests(frame.task, effects.testPlanAdditions as TaskSpec["test_plan"]);
    }
  }

  private async runOnFinish(block: Block, frame: Frame, result: BlockResult): Promise<void> {
    for (const action of block.on_finish ?? []) {
      const when = action.when ?? "always";
      const matches =
        when === "always" ||
        (when === "success" && result.status === "succeeded") ||
        (when === "failure" && result.status === "failed") ||
        (!["always", "success", "failure"].includes(when) && this.evalIn(frame, when));
      if (!matches) continue;
      try {
        if (action.run) {
          const command = renderTemplate(action.run, this.templateVars(frame));
          const outcome = await this.exec(command, frame.cwd, "on_finish");
          if (!outcome.passed) this.emit({ type: "warning", message: `on_finish of ${block.id}: ${command} failed` });
        } else if (action.run_flow) {
          await this.runSubflow(
            { id: `${block.id}-finish`, type: "subflow", flow: action.run_flow },
            frame,
            `${this.keyOf(frame, block)}/on_finish`,
          );
        }
      } catch (e) {
        if (isControl(e)) throw e;
        this.emit({ type: "warning", message: `on_finish of ${block.id}: ${(e as Error).message}` });
      }
    }
  }

  // ---------------------------------------------------------------- scope

  private resolve(frame: Frame, path: readonly string[]): unknown {
    const [root, ...rest] = path;
    if (!root) return undefined;
    if (root === "loop") {
      const loop = frame.nearestLoop();
      if (!loop) return undefined;
      if (rest[0] === "first") return loop.iteration === 1;
      if (rest[0] === "iteration") return loop.iteration;
      return undefined;
    }
    const own = frame.lookup(root);
    if (own) return rest.length ? getPath(own, rest) : own;
    if (root === "task") {
      const task = frame.task ?? this.implicitTask;
      return task ? getPath(this.taskVars(task), rest) : undefined;
    }
    if (root === "spec") {
      return getPath(this.specOutputs(), rest);
    }
    if (root === "session") {
      return getPath({ id: this.options.sessionId, message: this.options.message, branch: this.session?.branch, worktree: this.session?.path }, rest);
    }
    if (root === "commands") return getPath(this.options.config.commands ?? {}, rest);
    const aggregated = frame.aggregate(root);
    if (aggregated.length) {
      if (!rest.length) return aggregated;
      return combine(aggregated.map((outputs) => getPath(outputs, rest)).filter((v) => v !== undefined));
    }
    return undefined;
  }

  private evalIn(frame: Frame, source: string): boolean {
    return evaluateBoolean(source, (path) => this.resolve(frame, path));
  }

  private evalValue(frame: Frame, source: string): unknown {
    return evaluate(parseExpression(source), (path) => this.resolve(frame, path));
  }

  private taskVars(task: TaskRun): Record<string, unknown> {
    return {
      ...task.spec,
      worktree: task.worktree ?? this.session?.path,
      files: task.spec.edit,
      related_tests: testFilesOf(task.spec),
    };
  }

  private specOutputs(): Record<string, unknown> {
    const current = this.spec.current;
    return {
      spec: current,
      pending_tasks: this.spec.pendingTasks(),
      tasks: current?.tasks ?? [],
      version: this.spec.version,
      summary: current?.summary,
    };
  }

  private templateVars(frame: Frame, extra: Record<string, unknown> = {}): Record<string, unknown> {
    const task = frame.task ?? this.implicitTask;
    return {
      task: task ? this.taskVars(task) : {},
      commands: this.options.config.commands ?? {},
      session: { id: this.options.sessionId, branch: this.session?.branch, worktree: this.session?.path },
      ...extra,
    };
  }

  // ---------------------------------------------------------------- loops

  private async runLoop(block: LoopBlock, frame: Frame, key: string): Promise<BlockResult> {
    const max = Math.min(block.max_iterations, this.limits.max_loop_iterations);
    const counterKey = `${frame.task?.id ?? "session"}:${block.id}`;
    const persistent = block.reset === "never";
    this.emit({ type: "step.started", key, block: block.id, blockType: "loop", ...(frame.task ? { task: frame.task.id } : {}), maxAttempts: max });
    const startedAt = this.deps.clock.now();
    let iteration = 0;
    for (let restart = 0; ; restart++) {
      const base = restart ? `${key}@${restart}` : key;
      const body = frame.child(base);
      body.loop = { id: block.id, iteration: 0, tokens: 0, startedAt: this.deps.clock.now() };
      let used = persistent ? (this.counters.get(counterKey) ?? 0) : 0;
      let lastSignature: string | undefined;
      let outcome: "passed" | "exhausted" | "no_progress" | "budget" | undefined;
      iteration = 0;
      while (used < max) {
        iteration++;
        used++;
        if (persistent) this.counters.set(counterKey, used);
        body.loop.iteration = iteration;
        body.key = `${base}#${iteration}`;
        this.emit({
          type: "loop.iteration",
          key,
          block: block.id,
          iteration,
          max,
          ...(frame.task ? { task: frame.task.id } : {}),
          ...(block.budget
            ? {
                budget: {
                  tokens: body.loop.tokens,
                  minutes: (this.deps.clock.now() - body.loop.startedAt) / 60_000,
                  ...(block.budget.max_tokens ? { maxTokens: block.budget.max_tokens } : {}),
                  ...(block.budget.max_minutes ? { maxMinutes: block.budget.max_minutes } : {}),
                },
              }
            : {}),
        });
        const result = await this.runSteps(block.body, body);
        if (result.fatal) {
          return this.finishLoop(key, block, startedAt, {
            status: "failed",
            fatal: true,
            outputs: { passed: false, iterations: iteration, exhausted: false },
            error: result.error ?? "A step failed",
          });
        }
        if (this.evalIn(body, block.until)) {
          outcome = "passed";
          break;
        }
        if (block.stop_if_no_progress) {
          const signature = this.iterationSignature(result);
          if (signature && signature === lastSignature) {
            outcome = "no_progress";
            break;
          }
          lastSignature = signature;
        }
        if (block.budget) {
          const minutes = (this.deps.clock.now() - body.loop.startedAt) / 60_000;
          if (
            (block.budget.max_tokens !== undefined && body.loop.tokens >= block.budget.max_tokens) ||
            (block.budget.max_minutes !== undefined && minutes >= block.budget.max_minutes)
          ) {
            outcome = "budget";
            break;
          }
        }
      }
      if (outcome === "passed") {
        return this.finishLoop(key, block, startedAt, {
          status: "succeeded",
          outputs: { passed: true, iterations: iteration, exhausted: false },
        });
      }
      const action = await this.onLoopExhausted(block, frame, outcome ?? "exhausted", body);
      if (action === "restart") {
        if (persistent) this.counters.set(counterKey, 0);
        continue;
      }
      return this.finishLoop(key, block, startedAt, {
        status: "failed",
        fatal: true,
        outputs: { passed: false, iterations: iteration, exhausted: true },
        error: `${block.label ?? block.id} ran out of attempts`,
      });
    }
  }

  private finishLoop(key: string, block: LoopBlock, startedAt: number, result: BlockResult): BlockResult {
    this.emit({
      type: "step.finished",
      key,
      block: block.id,
      status: result.status,
      outputs: result.outputs,
      durationMs: this.deps.clock.now() - startedAt,
      ...(result.error ? { error: result.error } : {}),
    });
    return result;
  }

  private iterationSignature(result: BodyResult): string {
    const signatures: string[] = [];
    for (const [id, r] of result.results) {
      const signature = r.outputs.signature;
      if (typeof signature === "string" && signature) signatures.push(`${id}:${signature}`);
    }
    return signatures.sort().join("|");
  }

  private async onLoopExhausted(
    block: LoopBlock,
    frame: Frame,
    outcome: "exhausted" | "no_progress" | "budget",
    body: Frame,
  ): Promise<"restart" | "fail"> {
    const task = frame.task;
    const label = block.label ?? block.id;
    const lastFailures = this.lastFailuresIn(block, body);
    if (outcome === "no_progress" && this.escalations.isAutoTriggerEnabled("no_progress")) {
      return this.autoEscalate("no_progress", task, {
        type: "decision_gap",
        summary: `${label} stopped: two attempts in a row failed the same way. The problem may not be in the code.`,
        evidence: lastFailures,
        blocks: [],
        options_seen: [],
      });
    }
    const action = block.on_exhausted ?? "escalate_model";
    const reason = outcome === "budget" ? "ran out of budget" : "ran out of attempts";
    switch (action) {
      case "fail":
        return "fail";
      case "ask_user": {
        const answer = await this.deps.human.ask(
          {
            id: `ask-${body.key}`,
            question: `${label} ${reason}. Try again with a fresh set of attempts?`,
            options: [{ label: "Try again", recommended: true }, { label: "Stop" }],
            blocks: task ? [task.id] : [],
            batched: false,
          },
          this.abort.signal,
        );
        return answer.toLowerCase().startsWith("try") ? "restart" : "fail";
      }
      case "escalate_model": {
        const cursor = task?.cursor;
        if (cursor) {
          const previous = cursor.current();
          const next = cursor.advance("loop_exhausted");
          if (next) {
            this.emit({ type: "warning", task: task.id, message: `${label} ${reason} on ${previous?.model.label ?? "?"}; trying ${next.model.label}` });
            return "restart";
          }
          if (this.escalations.isAutoTriggerEnabled("chain_exhausted")) {
            return this.autoEscalate("chain_exhausted", task, {
              type: "decision_gap",
              summary: `${label} ${reason} on every model of the chain, including the principal's.`,
              evidence: lastFailures,
              blocks: [],
              options_seen: [],
            });
          }
          return "fail";
        }
        return this.autoEscalate("chain_exhausted", task, {
          type: "decision_gap",
          summary: `${label} ${reason}.`,
          evidence: lastFailures,
          blocks: [],
          options_seen: [],
        });
      }
      case "escalate_to_principal":
        return this.autoEscalate("chain_exhausted", task, {
          type: "decision_gap",
          summary: `${label} ${reason}.`,
          evidence: lastFailures,
          blocks: [],
          options_seen: [],
        });
    }
  }

  private lastFailuresIn(block: LoopBlock, body: Frame): EscalationRequest["evidence"] {
    const evidence: EscalationRequest["evidence"] = [];
    walkBlocks(block.body, ({ block: inner }) => {
      if (inner.type !== "command") return;
      const outputs = body.lookup(inner.id);
      const failures = (outputs?.failures as Failure[] | undefined) ?? [];
      for (const failure of failures.slice(0, 5)) {
        evidence.push({ quote: `${failure.test}: ${failure.message}`, ...(failure.file ? { file: failure.file } : {}), ...(failure.line ? { line: failure.line } : {}) });
      }
      if (!failures.length && outputs?.passed === false && typeof outputs.output === "string") {
        evidence.push({ quote: tailLines(outputs.output, 15) });
      }
    });
    return evidence;
  }

  private async autoEscalate(trigger: AutoTrigger, task: TaskRun | undefined, request: EscalationRequest): Promise<"restart" | "fail"> {
    const resolution = await this.raiseEscalation(request, task, "harness", trigger);
    return this.applyResolution(resolution, task);
  }

  private async raiseEscalation(request: EscalationRequest, task: TaskRun | undefined, raisedBy: string, automatic?: string): Promise<EscalationResolution> {
    const release = this.options.flow.policy?.escalation?.pause === "all" ? this.pauseGate.hold() : undefined;
    try {
      return await this.escalations.raise(
        request,
        {
          raisedBy,
          ...(task && !task.implicit ? { task: task.id } : {}),
          ...(automatic ? { automatic } : {}),
          specVersion: this.spec.version,
        },
        this.abort.signal,
      );
    } finally {
      release?.();
    }
  }

  /** A decision publishes a new spec version and restarts the task; a rejection retries it. */
  private async applyResolution(resolution: EscalationResolution, task: TaskRun | undefined): Promise<"restart" | "fail"> {
    if (resolution.kind === "rejected") {
      task?.notes.push(`Principal: ${resolution.reply}`);
      return "restart";
    }
    const decision = resolution.decision;
    if (/^stop this task$/i.test(decision.answer.trim())) return "fail";
    await this.recordDecision(decision);
    if (task && !task.implicit && this.spec.task(task.id)) {
      const change = this.spec.annotate([task.id], `Decision ${decision.id}: ${decision.answer}`);
      if (change) this.emitSpec(change.version, change.pending, change.reopened, `decision ${decision.id}`);
      throw new TaskRestart(task.id, `decision ${decision.id}`);
    }
    task?.notes.push(`Decision ${decision.id}: ${decision.answer}`);
    this.userFeedback.push(`Decision ${decision.id}: ${decision.answer}`);
    return "restart";
  }

  private async recordDecision(decision: Decision): Promise<void> {
    const persist = this.options.flow.policy?.escalation?.persist_decisions ?? "project";
    if (persist !== "none" && this.deps.persistDecision) {
      await this.deps.persistDecision(decision, persist).catch((e: Error) =>
        this.emit({ type: "warning", message: `Could not save decision ${decision.id}: ${e.message}` }),
      );
    }
  }

  private emitSpec(version: number, pending: string[], reopened: string[], reason: string): void {
    this.emit({
      type: "spec.published",
      version,
      tasks: (this.spec.current?.tasks ?? []).map((t) => t.id),
      reopened,
      reason,
      spec: this.spec.current,
    });
    void pending;
  }

  // ---------------------------------------------------------------- foreach and tasks

  private async runForeach(block: ForeachBlock, frame: Frame, key: string): Promise<BlockResult> {
    const items = this.evalValue(frame, block.over);
    if (!Array.isArray(items)) {
      return { status: "failed", fatal: true, outputs: {}, error: `${block.over} is not a list` };
    }
    const tasks = items.filter((item): item is TaskSpec => typeof item === "object" && item !== null && "id" in item && "edit" in item);
    this.emit({ type: "step.started", key, block: block.id, blockType: "foreach", ...(block.label ? { label: block.label } : {}) });
    const startedAt = this.deps.clock.now();
    const states = new Map<string, "pending" | "running" | "done" | "failed">(tasks.map((t) => [t.id, "pending"]));
    const runs = new Map<string, TaskRun>(tasks.map((t) => [t.id, newTaskRun(t)]));
    const running = new Map<string, Promise<{ id: string; state: "done" | "failed"; error?: unknown }>>();
    const waitingAnnounced = new Set<string>();
    const children: Frame[] = [];
    frame.foreachChildren.set(block.id, children);
    const maxParallel = block.max_parallel ?? Infinity;
    let firstError: unknown;

    const editing = () => new Set([...running.keys()].flatMap((id) => runs.get(id)!.spec.edit));
    const depState = (dep: string): TaskState | "missing" => {
      const local = states.get(dep);
      if (local) return local === "running" ? "running" : local;
      return this.spec.state.get(dep) ?? "missing";
    };

    while ([...states.values()].some((s) => s === "pending" || s === "running")) {
      for (const task of tasks) {
        if (states.get(task.id) !== "pending" || firstError) continue;
        const run = runs.get(task.id)!;
        const failedDep = run.spec.depends_on.find((d) => ["failed", "missing"].includes(depState(d)));
        if (failedDep) {
          states.set(task.id, "failed");
          this.spec.state.set(task.id, "failed");
          this.emit({ type: "task.failed", task: task.id, reason: `Depends on ${failedDep}, which did not finish` });
          continue;
        }
        const waitingOn = run.spec.depends_on.filter((d) => depState(d) !== "done");
        const busy = editing();
        const conflict = run.spec.edit.find((f) => busy.has(f));
        if (waitingOn.length || conflict || running.size >= maxParallel) {
          if (!waitingAnnounced.has(task.id)) {
            waitingAnnounced.add(task.id);
            this.emit({
              type: "task.waiting",
              task: task.id,
              waitingFor: waitingOn.length ? waitingOn : conflict ? [`file ${conflict}`] : ["a free slot"],
              reason: waitingOn.length ? "dependencies" : conflict ? "shares a file with a running task" : "parallel limit",
            });
          }
          continue;
        }
        states.set(task.id, "running");
        running.set(
          task.id,
          this.runTask(run, block, frame, key, children).then(
            (state) => ({ id: task.id, state }),
            (error: unknown) => ({ id: task.id, state: "failed" as const, error }),
          ),
        );
      }
      if (running.size === 0) break;
      const done = await Promise.race(running.values());
      running.delete(done.id);
      states.set(done.id, done.state);
      if (done.error !== undefined && firstError === undefined) {
        firstError = done.error;
      }
      if (firstError && running.size === 0) break;
    }
    if (firstError !== undefined) throw firstError;
    const doneTasks = tasks.filter((t) => states.get(t.id) === "done").map((t) => t.id);
    const failedTasks = tasks.filter((t) => states.get(t.id) !== "done").map((t) => t.id);
    const diff = await this.deps.workspace.sessionDiff(this.options.sessionId).catch(() => "");
    const result: BlockResult = {
      status: failedTasks.length ? "failed" : "succeeded",
      outputs: {
        passed: failedTasks.length === 0,
        done_tasks: doneTasks,
        failed_tasks: failedTasks,
        results: Object.fromEntries(tasks.map((t) => [t.id, states.get(t.id)])),
        diff,
      },
      ...(failedTasks.length ? { error: `Tasks not finished: ${failedTasks.join(", ")}` } : {}),
    };
    this.emit({
      type: "step.finished",
      key,
      block: block.id,
      status: result.status,
      outputs: summarizeOutputs(result.outputs),
      durationMs: this.deps.clock.now() - startedAt,
    });
    return result;
  }

  private async runTask(run: TaskRun, block: ForeachBlock, frame: Frame, key: string, children: Frame[]): Promise<"done" | "failed"> {
    this.runningTasks.set(run.id, run);
    try {
      for (;;) {
        const taskKey = `${key}/${run.id}@${run.attempt}`;
        this.spec.state.set(run.id, "running");
        let outcome: "done" | "failed" | "restart";
        try {
          outcome = await this.runTaskAttempt(run, block, frame, taskKey, children);
        } catch (e) {
          if (e instanceof TaskRestart && e.taskId === run.id) outcome = "restart";
          else if (isControl(e) || this.abort.signal.aborted) throw e;
          else outcome = run.requested ? "failed" : this.failTask(run, (e as Error).message ?? String(e));
        }
        const requested = run.requested;
        if (requested === "cancel") return this.failTask(run, "Cancelled by the user");
        if (requested === "skip") {
          this.spec.state.set(run.id, "done");
          this.emit({ type: "warning", task: run.id, message: `${run.id} skipped by the user; nothing was merged` });
          this.emit({ type: "task.finished", task: run.id });
          return "done";
        }
        if (requested === "retry" || requested === "retry-model" || outcome === "restart") {
          const latest = this.spec.task(run.id) ?? run.spec;
          delete run.requested;
          Object.assign(run, newTaskRun(latest), {
            attempt: run.attempt + 1,
            notes: run.notes,
            modelOffset: run.modelOffset + (requested === "retry-model" ? 1 : 0),
          });
          continue;
        }
        return outcome;
      }
    } finally {
      this.runningTasks.delete(run.id);
    }
  }

  private async runTaskAttempt(run: TaskRun, block: ForeachBlock, frame: Frame, taskKey: string, children: Frame[]): Promise<"done" | "failed" | "restart"> {
    const worktree = await this.deps.workspace.createTaskWorktree(this.options.sessionId, run.id, run.attempt);
    run.worktree = worktree.path;
    this.emit({ type: "task.started", task: run.id, goal: run.spec.goal, kind: run.spec.kind, worktree: worktree.path });
    const setup = this.options.config.worktree?.setup;
    if (worktree.created && setup) {
      const outcome = await this.exec(renderTemplate(setup, this.templateVars(frame)), worktree.path, "setup", { signal: this.signalFor(run) });
      if (!outcome.passed) return this.failTask(run, `Worktree setup failed: ${tailLines(outcome.output, 10)}`);
    }
    const taskFrame = frame.child(taskKey, worktree.path, run);
    children.push(taskFrame);
    run.cursor = await this.workerCursor(run, taskKey, block);
    for (let i = 0; i < run.modelOffset; i++) run.cursor.advance("loop_exhausted");
    const body = await this.runSteps(block.body, taskFrame);
    if (run.requested) return "failed";
    if (body.status === "failed") return this.failTask(run, body.error ?? "A step failed");
    const merged = await this.mergeTask(run, taskKey);
    if (merged !== "done") return merged;
    this.spec.state.set(run.id, "done");
    await this.deps.workspace.removeTaskWorktree(worktree.path).catch(() => undefined);
    return "done";
  }

  private failTask(run: TaskRun, reason: string): "failed" {
    this.spec.state.set(run.id, "failed");
    this.emit({ type: "task.failed", task: run.id, reason });
    return "failed";
  }

  private async mergeTask(run: TaskRun, taskKey: string): Promise<"done" | "failed" | "restart"> {
    const key = `${taskKey}/merge`;
    const recorded = this.deps.journal.get(key);
    if (recorded) {
      this.emit({ type: "task.finished", task: run.id, ...(recorded.outputs.commit ? { commit: String(recorded.outputs.commit) } : {}) });
      return "done";
    }
    const result = await this.deps.workspace.commitAndMerge(
      this.options.sessionId,
      run.worktree!,
      run.id,
      run.spec.edit,
      `harness(${run.id}): ${run.spec.goal}`,
    );
    if (result.ok) {
      this.deps.journal.put(key, { status: "succeeded", outputs: result.commit ? { commit: result.commit } : {} });
      this.emit({ type: "task.finished", task: run.id, ...(result.commit ? { commit: result.commit } : {}) });
      return "done";
    }
    const resolution = await this.raiseEscalation(
      {
        type: "spec_conflict",
        summary: `Merging ${run.id} into the session branch conflicts in ${result.conflicts.join(", ")}. No model resolves conflicts on its own.`,
        evidence: result.conflicts.map((file) => ({ file })),
        blocks: [],
        options_seen: [],
      },
      run,
      "harness",
      "merge_conflict",
    );
    const action = await this.applyResolution(resolution, run);
    return action === "restart" ? "restart" : this.failTask(run, "Merge conflict");
  }

  private async workerCursor(run: TaskRun, taskKey: string, block: ForeachBlock): Promise<EngineCursor> {
    const estimate = await this.estimateTokens(run.spec, run.worktree!);
    const request: RouteRequest = {
      role: "worker",
      kind: run.spec.kind,
      est_tokens: estimate,
      files: run.spec.edit.length,
      paths: [...run.spec.edit, ...run.spec.read],
      needs_tools: run.spec.needs_tools ?? true,
      accepts_diff_mode: this.workerAgent(block)?.diff_mode === true,
      ...(run.spec.max_cost !== undefined ? { max_cost: run.spec.max_cost } : {}),
    };
    run.request = request;
    const decision = this.recordedDecision(`chain:${taskKey}`, () => this.deps.router.route(request));
    const cursor = new EngineCursor(this.deps, "worker", decision, request, taskKey, run.id);
    this.announceDecision(decision, taskKey, "worker", run.id);
    return cursor;
  }

  /** The chain is journaled so a resumed session keeps the same models. */
  private recordedDecision(key: string, make: () => RouteDecision): RouteDecision {
    const recorded = this.deps.journal.getValue<{ refs: string[]; chosen: string | undefined }>(key);
    const decision = make();
    if (recorded) {
      const chain = recorded.refs
        .map((ref) => decision.chain.find((l) => l.ref === ref) ?? this.linkFor(ref))
        .filter((l): l is ChainLink => !!l);
      const chosenIndex = chain.findIndex((l) => l.ref === recorded.chosen);
      if (chain.length) {
        return { ...decision, chain, chosenIndex, ...(chosenIndex >= 0 ? { chosen: chain[chosenIndex]! } : {}) };
      }
    } else {
      this.deps.journal.putValue(key, { refs: decision.chain.map((l) => l.ref), chosen: decision.chosen?.ref });
    }
    return decision;
  }

  private linkFor(ref: string): ChainLink | undefined {
    const model = this.deps.router.catalog.favorites.find((m) => m.ref === ref);
    return model ? { ref, model, source: "fallback" } : undefined;
  }

  announceDecision(decision: RouteDecision, key: string, role: string, task?: string): void {
    this.emit({
      type: "router.decision",
      key,
      role,
      model: decision.chosen?.ref ?? "",
      modelLabel: decision.chosen?.model.label ?? "no model available",
      rule: decision.rule,
      reason: decision.reason,
      chainIndex: decision.chosenIndex,
      chain: decision.chain.map((l) => l.ref),
      warnings: decision.warnings,
      skipped: decision.skipped,
      ...(task ? { task } : {}),
    });
  }

  private workerAgent(block: ForeachBlock): AgentDefinition | undefined {
    let found: AgentDefinition | undefined;
    walkBlocks(block.body, ({ block: inner }) => {
      if (found || inner.type !== "agent") return;
      const agent = this.options.agents.get(inner.agent);
      if (agent?.role === "worker") found = agent;
    });
    return found ?? this.options.agents.get("worker");
  }

  private async estimateTokens(task: TaskSpec, cwd: string): Promise<number> {
    let tokens = approximateTokens(JSON.stringify(task)) + 600;
    for (const file of [...task.edit, ...task.read]) {
      if (/[*?{[]/.test(file)) continue;
      const content = await this.deps.files.read(this.deps.files.join(cwd, file)).catch(() => undefined);
      tokens += content ? approximateTokens(content) : 0;
    }
    return tokens;
  }

  private implicitTaskRun(): TaskRun {
    if (!this.implicitTask) {
      this.implicitTask = {
        ...newTaskRun({
          id: "main",
          goal: this.options.message,
          kind: "feature",
          edit: ["**"],
          read: [],
          acceptance_criteria: [{ id: "AC1", text: "The user's request is fulfilled", verify: "review" }],
          test_plan: [],
          acceptance: [],
          depends_on: [],
          notes: [],
        }),
        implicit: true,
      };
      this.implicitTask.worktree = this.session?.path;
    }
    return this.implicitTask;
  }

  // ---------------------------------------------------------------- agents

  private agent(name: string): AgentDefinition {
    const agent = this.options.agents.get(name);
    if (!agent) throw new Error(`No agent named "${name}"`);
    return agent;
  }

  private async runAgentBlock(block: AgentBlock, frame: Frame, key: string, attempt: Attempt): Promise<BlockResult> {
    const agent = this.agent(block.agent);
    const role = agent.role;
    const task = role === "principal" ? frame.task : frame.task ?? this.implicitTaskRun();
    const mode: AgentMode =
      role === "principal" ? (block.output === "spec" ? "spec" : "verify") : role === "worker" ? "work" : role === "qa" ? "qa" : "review";

    const inputs = (Array.isArray(block.input) ? block.input : block.input ? [block.input] : []).map((name) => ({
      name,
      value: this.resolve(frame, name.split(".")),
    }));
    const feedback = (block.feedback ?? []).map((name) => ({ name, value: this.feedbackValue(frame, name) }));
    const loop = frame.nearestLoop();
    const iteration = mode === "spec" ? (loop?.iteration ?? 1) + (this.userFeedback.length ? 1 : 0) : loop?.iteration;

    let context = "";
    if (this.options.history) context += section("Conversation so far", this.options.history);
    if (mode === "spec") {
      context += section("Current spec", renderSpec(this.spec.current));
      context += section("Task status", this.spec.current ? this.spec.current.tasks.map((t) => `- ${t.id}: ${this.spec.state.get(t.id) ?? "pending"}`).join("\n") : undefined);
      context += section("Feedback from the previous delivery", renderNamed([...this.previousDeliveryFeedback(frame), ...this.userFeedback.map((value, i) => ({ name: `note ${i + 1}`, value }))]));
    }
    if (task && mode !== "spec") context += section("Task", renderTask(task.spec));
    context += section("Inputs", renderNamed(inputs));
    context += section("Feedback to address", renderNamed([...feedback, ...(task?.notes ?? []).map((value, i) => ({ name: `note ${i + 1}`, value }))]));
    if (mode !== "spec" && this.userFeedback.length && !task) {
      context += section("User feedback", this.userFeedback.join("\n"));
    }
    context += section("Decisions so far", renderDecisions(this.escalations.decisions));

    const editScope = role === "worker" ? (task?.spec.edit ?? []) : role === "qa" && task ? testFilesOf(task.spec) : [];
    const cursor = this.cursorFor(block, agent, key, task);
    const result = await this.callAgent({
      key,
      agent,
      mode,
      task,
      cwd: frame.cwd,
      editScope,
      instructions: modeInstructions(mode, { message: this.options.message, ...(task ? { task: task.spec } : {}), ...(iteration ? { iteration } : {}) }),
      blockInstructions: block.instructions,
      context,
      cursor,
      frame,
      attempt,
      ...(task && role !== "principal" ? { diffModeFiles: [...task.spec.edit.filter((f) => !/[*?]/.test(f)), ...task.spec.read] } : {}),
    });

    const base = { text: result.text, model: result.model, tokens: result.usage.input + result.usage.output };
    const effects: StepEffects = { ...(cursor instanceof EngineCursor ? { chainIndex: cursor.index } : {}), usage: result.usageEffects };
    if (result.status === "aborted") {
      throw new TaskRestart(task?.id ?? "main", result.error ?? "aborted");
    }
    if (result.status === "failed") {
      if (result.chainExhausted && task && !task.implicit) {
        const action = await this.autoEscalate("chain_exhausted", task, {
          type: "decision_gap",
          summary: `${block.id} could not run on any model of the chain: ${result.error ?? "unknown error"}`,
          evidence: [],
          blocks: [],
          options_seen: [],
        });
        if (action === "restart") throw new TaskRestart(task.id, "chain exhausted");
      }
      return {
        status: "failed",
        fatal: !result.soft,
        outputs: { ...base, error: result.error },
        error: result.error ?? "The agent failed",
        effects,
        tokens: base.tokens,
        ...(result.model ? { model: result.model } : {}),
      };
    }

    let outputs: Record<string, unknown> = { ...base };
    switch (mode) {
      case "spec": {
        if (result.submission?.tool === "answer") {
          const answer = String((result.submission.value as { text: string }).text);
          this.deps.journal.put(key, { status: "succeeded", outputs: { answer }, effects: { answer } });
          throw new FlowAnswered(answer);
        }
        if (!result.submission) {
          if (result.text.trim()) {
            this.deps.journal.put(key, { status: "succeeded", outputs: { answer: result.text }, effects: { answer: result.text } });
            throw new FlowAnswered(result.text);
          }
          return { status: "failed", fatal: true, outputs, error: "The principal submitted no spec", effects };
        }
        const submission = SpecSubmission.parse(result.submission.value);
        const change = this.spec.publish(submission);
        this.emitSpec(change.version, change.pending, change.reopened, change.version === 1 ? "initial spec" : "delta");
        effects.spec = submission;
        outputs = { ...outputs, ...this.specOutputs() };
        break;
      }
      case "verify": {
        const verdict = VerdictSubmission.parse(result.submission?.value ?? { approved: false, notes: "No verdict submitted" });
        if (!verdict.approved && verdict.reopen.length) {
          for (const item of verdict.reopen) {
            if (this.spec.task(item.task)) {
              const change = this.spec.annotate([item.task], `Principal review: ${item.note}`);
              if (change) this.emitSpec(change.version, change.pending, change.reopened, `rejected ${item.task}`);
            }
          }
        }
        outputs = {
          ...outputs,
          approved: verdict.approved,
          notes: verdict.notes,
          rejected_tasks: verdict.reopen.map((r) => r.task),
          delta: verdict.reopen,
        };
        break;
      }
      case "work": {
        const diff = await this.deps.workspace.diff(frame.cwd, task?.implicit ? undefined : task?.spec.edit).catch(() => "");
        outputs = {
          ...outputs,
          diff,
          files_changed: result.filesChanged,
          notes: (result.submission?.value as { notes?: string } | undefined)?.notes ?? result.text,
        };
        break;
      }
      case "qa": {
        const qa = QaSubmission.safeParse(result.submission?.value);
        const value = qa.success ? qa.data : { results: [], missing: ["QA did not submit a report"], added_tests: [] };
        const failedAcs = value.results.filter((r) => !r.passed).map((r) => r.ac);
        const missing = [
          ...value.results.filter((r) => !r.passed).map((r) => `${r.ac}: ${r.evidence || "not met"}`),
          ...value.missing,
        ];
        if (task && value.added_tests.length) {
          this.addTests(task, value.added_tests);
          effects.testPlanAdditions = value.added_tests;
        }
        if (task) await this.checkPingPong(task, failedAcs, frame);
        if (task) task.lastQaPassed = new Set(value.results.filter((r) => r.passed).map((r) => r.ac));
        outputs = {
          ...outputs,
          passed: missing.length === 0,
          missing,
          results: value.results,
          added_tests: value.added_tests,
        };
        break;
      }
      case "review": {
        const findings = FindingsSubmission.safeParse(result.submission?.value);
        const list = findings.success ? findings.data.findings : [];
        outputs = { ...outputs, findings: list, passed: list.length === 0 };
        break;
      }
      default:
        break;
    }
    return {
      status: "succeeded",
      outputs,
      effects,
      tokens: base.tokens,
      ...(result.model ? { model: result.model } : {}),
    };
  }

  private previousDeliveryFeedback(frame: Frame): { name: string; value: unknown }[] {
    const items: { name: string; value: unknown }[] = [];
    for (const [id, outputs] of frame.outputs) {
      if (outputs.approved === false) items.push({ name: `${id} verdict`, value: { notes: outputs.notes, reopen: outputs.delta } });
      if (outputs.passed === false && outputs.output !== undefined) {
        items.push({ name: `${id} failures`, value: (outputs.failures as unknown[] | undefined)?.length ? outputs.failures : outputs.output });
      }
      if (Array.isArray(outputs.failed_tasks) && outputs.failed_tasks.length) {
        items.push({ name: `${id} unfinished tasks`, value: outputs.failed_tasks });
      }
    }
    return items;
  }

  /** `x.failures` falls back to the output tail when the command has no parser. */
  private feedbackValue(frame: Frame, name: string): unknown {
    const path = name.split(".");
    const value = this.resolve(frame, path);
    if (path.length === 2 && path[1] === "failures" && (!Array.isArray(value) || value.length === 0)) {
      const outputs = this.resolve(frame, [path[0]!]) as Record<string, unknown> | undefined;
      if (outputs?.passed === false && typeof outputs.output === "string") return outputs.output;
    }
    return value;
  }

  private addTests(task: TaskRun, tests: TaskSpec["test_plan"]): void {
    const additions = tests.map((t) => ({ ...t, added_by: "qa" as const }));
    task.spec = { ...task.spec, test_plan: [...task.spec.test_plan, ...additions] };
    const current = this.spec.current;
    const inSpec = current?.tasks.find((t) => t.id === task.id);
    if (inSpec) inSpec.test_plan = [...inSpec.test_plan, ...additions];
  }

  /** The same criterion failing in two QA rounds while the worker undoes its own lines. */
  private async checkPingPong(task: TaskRun, failedAcs: string[], frame: Frame): Promise<void> {
    const diff = task.worktree ? await this.deps.workspace.diff(task.worktree, task.spec.edit).catch(() => "") : "";
    const added = new Set(parseUnifiedDiff(diff).flatMap((f) => f.hunks.flatMap((h) => h.lines.filter((l) => l.type === "add").map((l) => `${f.path}:${l.text.trim()}`))));
    const previous = task.qaRounds.at(-1);
    task.qaRounds.push({ failed: failedAcs, added });
    if (!previous || !this.escalations.isAutoTriggerEnabled("qa_ping_pong")) return;
    const repeated = failedAcs.filter((ac) => previous.failed.includes(ac));
    const undone = [...previous.added].filter((line) => !added.has(line) && line.split(":").slice(1).join(":").length > 0);
    if (repeated.length && undone.length) {
      const action = await this.autoEscalate("qa_ping_pong", task, {
        type: "decision_gap",
        summary: `${repeated.join(", ")} failed in two QA rounds in a row with opposite fixes. The criterion is probably ambiguous.`,
        evidence: undone.slice(0, 5).map((line) => ({ quote: line })),
        blocks: repeated,
        options_seen: [],
      });
      if (action === "fail") throw new Error("QA and worker disagree on the same criterion");
    }
    void frame;
  }

  private cursorFor(block: AgentBlock | ReviewBlock, agent: AgentDefinition, key: string, task: TaskRun | undefined): ModelCursor {
    const role = AGENT_ROLE_TO_ROUTER_ROLE[agent.role];
    const pinTarget = block.model ?? (agent.tier && agent.tier !== "auto" ? agent.tier : undefined);
    if (agent.role === "worker" && task?.cursor && !pinTarget) return task.cursor;
    if (agent.role === "principal" && !pinTarget && this.principalCursor) return this.principalCursor;

    const request: RouteRequest = {
      role,
      ...(task && agent.role !== "principal" ? { kind: task.spec.kind } : {}),
      est_tokens: task ? (task.request?.est_tokens ?? 8000) : 8000,
      files: task?.spec.edit.length ?? 0,
      paths: task ? [...task.spec.edit, ...task.spec.read] : [],
      needs_tools: agent.diff_mode !== true,
      accepts_diff_mode: agent.diff_mode === true,
      ...(task?.cursor && (agent.role === "qa" || agent.role === "bugbot") && task.cursor.current()
        ? { avoid: [task.cursor.current()!.model.baseRef] }
        : {}),
    };
    if (agent.role === "worker" && task && !task.request) task.request = request;
    const pinned = pinTarget
      ? { use: pinTarget, fallback: block.fallback ?? [], ...(block.type === "agent" && block.stay_local ? { stay_local: true } : {}) }
      : undefined;
    const decision = this.recordedDecision(`chain:${key}`, () => this.deps.router.route(request, pinned ? { pinned } : {}));
    this.announceDecision(decision, key, agent.role, task && !task.implicit ? task.id : undefined);
    const cursor = new EngineCursor(this.deps, agent.role, decision, request, key, task?.id);
    if (agent.role === "worker" && task && !pinTarget) task.cursor = cursor;
    if (agent.role === "principal") this.principalCursor = cursor;
    return cursor;
  }

  private async callAgent(params: {
    key: string;
    agent: AgentDefinition;
    mode: AgentMode;
    task: TaskRun | undefined;
    cwd: string;
    editScope: string[];
    instructions: string;
    blockInstructions?: string | undefined;
    context: string;
    cursor: ModelCursor;
    frame: Frame;
    /** Set for block attempts: retries start a fresh conversation and a timeout aborts them. */
    attempt?: Attempt;
    diffModeFiles?: string[];
    submit?: SubmitTool[];
  }): Promise<AgentRunResult & { usageEffects: { ref: string; tokens: number; costUsd: number }[] }> {
    await this.pauseGate.wait();
    await this.checkSessionTime(params.cursor);
    const usageEffects: { ref: string; tokens: number; costUsd: number }[] = [];
    const loops = params.frame.loops();
    const base = params.cursor;
    const cursor: ModelCursor = {
      role: base.role,
      current: () => base.current(),
      advance: (cause) => base.advance(cause),
      rewind: () => base.rewind(),
      acquireSlot: (signal) => base.acquireSlot(signal),
      reportFailure: (failure) => base.reportFailure(failure),
      nextRetryAt: () => base.nextRetryAt(),
      recordUsage: (usage) => {
        const tokens = usage.input + usage.output;
        for (const loop of loops) loop.tokens += tokens;
        const link = base.current();
        if (link) usageEffects.push({ ref: link.ref, tokens, costUsd: usageCost(link.model, usage) ?? 0 });
        return base.recordUsage(usage);
      },
      ...(base.reportRateLimits ? { reportRateLimits: (snapshot: RateLimitSnapshot) => base.reportRateLimits!(snapshot) } : {}),
    };
    const submit = params.submit ?? SUBMIT_TOOLS[params.mode].map((tool) =>
      tool.name === "submit_spec"
        ? {
            ...tool,
            validate: (value: unknown) => {
              const parsed = SpecSubmission.safeParse(value);
              if (!parsed.success) return [parsed.error.message];
              const done = new Set([...this.spec.state].filter(([, s]) => s === "done").map(([id]) => id));
              return validateSpecSubmission(parsed.data, done).map(formatIssue);
            },
          }
        : tool,
    );
    const taskId = params.task && !params.task.implicit ? params.task.id : undefined;
    const signal = params.attempt?.signal ?? this.signalFor(params.task);
    return {
      ...(await this.deps.runner.run({
        key: params.attempt?.index ? `${params.key}#retry${params.attempt.index}` : params.key,
        agent: params.agent,
        mode: params.mode,
        ...(params.task ? { task: params.task.spec } : {}),
        cwd: params.cwd,
        editScope: params.editScope,
        instructions: params.instructions,
        ...(params.blockInstructions ? { blockInstructions: params.blockInstructions } : {}),
        context: params.context,
        ...(params.diffModeFiles ? { diffModeFiles: params.diffModeFiles } : {}),
        submit,
        requireSubmit: params.mode !== "work" && params.mode !== "fix",
        models: cursor,
        maxTurns: params.agent.max_turns ?? this.limits.max_agent_turns,
        signal,
        onEscalation: (request) => this.agentEscalation(request, params.task, params.agent.role),
        runCommand: async (command) => {
          const outcome = await this.exec(command, params.cwd, "agent", { signal });
          return { ok: outcome.passed, output: tailLines(outcome.output, this.limits.output_tail_lines) };
        },
        onText: (delta) => {
          if (taskId || params.mode === "spec") this.emit({ type: "task.delta", task: taskId ?? "principal", key: params.key, text: delta });
        },
        onTool: (tool, summary, ok) => this.emit({ type: "agent.tool", key: params.key, tool, summary, ok, ...(taskId ? { task: taskId } : {}) }),
      })),
      usageEffects,
    };
  }

  private async agentEscalation(request: EscalationRequest, task: TaskRun | undefined, raisedBy: string): Promise<EscalationReply> {
    const resolution = await this.raiseEscalation(request, task, raisedBy);
    if (resolution.kind === "rejected") return { kind: "continue", message: `The principal replied: ${resolution.reply}` };
    await this.recordDecision(resolution.decision);
    if (task && !task.implicit && this.spec.task(task.id)) {
      const change = this.spec.annotate([task.id], `Decision ${resolution.decision.id}: ${resolution.decision.answer}`);
      if (change) this.emitSpec(change.version, change.pending, change.reopened, `decision ${resolution.decision.id}`);
      return { kind: "abort", reason: `decision ${resolution.decision.id}` };
    }
    this.userFeedback.push(`Decision ${resolution.decision.id}: ${resolution.decision.answer}`);
    return { kind: "continue", message: `Decision ${resolution.decision.id}: ${resolution.decision.answer}. Continue with it.` };
  }

  private async triage(escalation: Escalation, signal?: AbortSignal): Promise<TriageOutcome> {
    const principal = [...this.options.agents.values()].find((a) => a.role === "principal");
    if (!principal) {
      return { outcome: "ask_human", question: escalation.summary, options: fallbackOptions(escalation) };
    }
    const key = `triage/${escalation.id}`;
    const task = escalation.task ? this.spec.task(escalation.task) : undefined;
    let context = section("Escalation", renderValue(escalation));
    if (task) context += section("Task", renderTask(task));
    context += section("Current spec", renderSpec(this.spec.current));
    context += section("Decisions so far", renderDecisions(this.escalations.decisions));
    const cursor =
      this.principalCursor ??
      this.cursorFor({ id: "triage", type: "review", agent: principal.name }, principal, key, undefined);
    const result = await this.callAgent({
      key,
      agent: { ...principal, tools: principal.tools.filter((t) => t !== "delegate") },
      mode: "triage",
      task: undefined,
      cwd: this.session?.path ?? ".",
      editScope: [],
      instructions: modeInstructions("triage", {}),
      context,
      cursor,
      frame: new Frame(undefined, key, this.session?.path ?? "."),
    });
    void signal;
    const outcome = result.submission?.value as TriageOutcome | undefined;
    if (result.status !== "completed" || !outcome) {
      return { outcome: "ask_human", question: escalation.summary, options: fallbackOptions(escalation) };
    }
    return outcome;
  }

  private async checkSessionTime(cursor: ModelCursor): Promise<void> {
    const elapsedMinutes = (this.deps.clock.now() - this.timeBaseline) / 60_000;
    if (elapsedMinutes < this.limits.session.max_minutes) return;
    if (this.limits.session.on_time_exhausted === "ask_user") {
      this.emit({ type: "session.paused", reason: "Session time ran out" });
      const answer = await this.deps.human.ask(
        {
          id: `time-${Math.floor(elapsedMinutes)}`,
          question: `The session has run for ${Math.round(elapsedMinutes)} minutes, its limit. Continue for another ${this.limits.session.max_minutes} minutes?`,
          options: [{ label: "Continue", recommended: true }, { label: "Stop the session" }],
          blocks: [],
          batched: false,
        },
        this.abort.signal,
      );
      if (!answer.toLowerCase().startsWith("continue")) this.cancel("Session time ran out");
      this.timeBaseline = this.deps.clock.now();
      return;
    }
    if (cursor instanceof EngineCursor && !cursor.timeFallbackApplied) {
      cursor.timeFallbackApplied = true;
      cursor.advance("budget");
    }
  }

  // ---------------------------------------------------------------- commands

  private async exec(
    command: string,
    cwd: string,
    source: CommandSource,
    options: { timeoutMs?: number; env?: Record<string, string>; signal?: AbortSignal } = {},
  ): Promise<{ passed: boolean; exitCode: number | null; output: string; durationMs: number; denied?: boolean; timedOut?: boolean }> {
    await this.pauseGate.wait();
    const decision = await this.deps.gate.authorize({ command, cwd, source, fromProject: source !== "flow" });
    if (!decision.allowed) {
      return { passed: false, exitCode: null, output: decision.reason, durationMs: 0, denied: true };
    }
    const result = await this.deps.commands.run({
      command,
      cwd,
      timeoutMs: options.timeoutMs ?? parseDuration(this.limits.command_timeout_default),
      ...(options.env ? { env: options.env } : {}),
      signal: options.signal ?? this.abort.signal,
    });
    return {
      passed: result.exitCode === 0 && !result.timedOut,
      exitCode: result.exitCode,
      output: result.timedOut ? `${result.output}\n[timed out]` : result.output,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
    };
  }

  private async runCommandBlock(block: CommandBlock, frame: Frame, key: string): Promise<BlockResult> {
    const vars = this.templateVars(frame);
    let commands: string[];
    let cwd: string;
    try {
      commands = [renderTemplate(block.run, vars)];
      cwd = block.cwd ? renderTemplate(block.cwd, vars) : frame.cwd;
    } catch (e) {
      if (e instanceof TemplateError) return { status: "failed", fatal: true, outputs: {}, error: e.message };
      throw e;
    }
    if (block.also_run) {
      const extra = this.resolve(frame, block.also_run.split("."));
      for (const item of Array.isArray(extra) ? extra : extra ? [extra] : []) commands.push(renderTemplate(String(item), vars));
    }
    const parse = parseSpecOf(block.parse);
    const reportPath = parse.kind === "junit" || (parse.kind === "json" && parse.file) ? this.deps.files.join(cwd, (parse as { file: string }).file) : undefined;
    const successCodes = block.success_codes ?? [0];
    const timeoutMs = block.timeout ? parseDuration(block.timeout) : parseDuration(this.limits.command_timeout_default);
    const tail = block.tail_lines ?? this.limits.output_tail_lines;

    let passed = true;
    let exitCode: number | null = 0;
    let output = "";
    let failures: Failure[] = [];
    let durationMs = 0;
    for (const command of commands) {
      if (reportPath) await this.deps.files.remove(reportPath).catch(() => undefined);
      const outcome = await this.exec(command, cwd, commands.indexOf(command) === 0 ? "flow" : "spec", {
        timeoutMs,
        signal: this.signalFor(frame.task),
        ...(block.env ? { env: block.env } : {}),
      });
      durationMs += outcome.durationMs;
      const ok = !outcome.denied && !outcome.timedOut && outcome.exitCode !== null && successCodes.includes(outcome.exitCode);
      output += `${commands.length > 1 ? `$ ${command}\n` : ""}${outcome.output}\n`;
      let parsed: Failure[] = [];
      if (!ok) {
        if (parse.kind === "junit" && reportPath) parsed = parseJunit((await this.deps.files.read(reportPath)) ?? "");
        else if (parse.kind === "json") {
          const text = reportPath ? await this.deps.files.read(reportPath) : outcome.output;
          parsed = parseJsonFailures(text ?? "");
        } else if (parse.kind === "regex") parsed = parseRegexFailures(outcome.output, parse.pattern);
      }
      failures = [...failures, ...parsed];
      this.emit({
        type: "command.finished",
        key,
        command,
        exitCode: outcome.exitCode,
        passed: ok,
        failures: parsed.length,
        durationMs: outcome.durationMs,
      });
      if (!ok) {
        passed = false;
        exitCode = outcome.exitCode;
        break;
      }
    }
    const trimmed = tailLines(output, tail);
    return {
      status: passed ? "succeeded" : "failed",
      outputs: {
        passed,
        exit_code: exitCode,
        failures,
        output: trimmed,
        signature: failureSignature(failures, trimmed, passed),
        duration_ms: durationMs,
      },
      ...(passed ? {} : { error: `${commands[0]} failed` }),
    };
  }

  private async runScript(block: ScriptBlock, frame: Frame, key: string): Promise<BlockResult> {
    const vars = this.templateVars(frame);
    const cwd = block.cwd ? renderTemplate(block.cwd, vars) : frame.cwd;
    const outcome = await this.exec(renderTemplate(block.run, vars), cwd, "flow", block.timeout ? { timeoutMs: parseDuration(block.timeout) } : {});
    void key;
    if (!outcome.passed) return { status: "failed", outputs: { passed: false, output: tailLines(outcome.output, 30) }, error: "Script failed" };
    const jsonStart = outcome.output.indexOf("{");
    try {
      const outputs = JSON.parse(outcome.output.slice(jsonStart)) as Record<string, unknown>;
      return { status: "succeeded", outputs };
    } catch {
      return { status: "failed", outputs: { passed: false, output: tailLines(outcome.output, 30) }, error: "Script did not print a JSON object" };
    }
  }

  private async runSubflow(block: SubflowBlock, frame: Frame, key: string): Promise<BlockResult> {
    if (!this.deps.loadSubflow) return { status: "failed", fatal: true, outputs: {}, error: "Subflows are not available" };
    const flow = await this.deps.loadSubflow(block.flow);
    this.emit({ type: "step.started", key, block: block.id, blockType: "subflow" });
    const startedAt = this.deps.clock.now();
    const child = frame.child(key);
    for (const [name, expr] of Object.entries(block.inputs ?? {})) child.setOutputs(name, { value: this.evalValue(frame, expr) });
    const body = await this.runSteps(flow.steps, child);
    const outputs = { passed: body.status === "succeeded", outputs: Object.fromEntries(child.outputs) };
    const result: BlockResult = {
      status: body.status,
      outputs,
      ...(body.fatal ? { fatal: true } : {}),
      ...(body.error ? { error: body.error } : {}),
    };
    this.emit({ type: "step.finished", key, block: block.id, status: result.status, outputs: { passed: outputs.passed }, durationMs: this.deps.clock.now() - startedAt });
    return result;
  }

  private async runCondition(block: ConditionBlock, frame: Frame): Promise<BlockResult> {
    const value = this.evalValue(frame, block.expr);
    return { status: "succeeded", outputs: { value: truthy(value) } };
  }

  private async runApproval(block: ApprovalBlock, frame: Frame, key: string): Promise<BlockResult> {
    const mode = this.options.approval ?? block.mode ?? this.options.config.defaults?.approval ?? "auto";
    if (mode === "auto") return { status: "succeeded", outputs: { approved: true } };
    this.emit({ type: "approval.requested", key });
    const diff = await this.deps.workspace.sessionDiff(this.options.sessionId).catch(() => "");
    const answer = await this.deps.human.review(
      { key, summary: this.spec.current?.summary ?? this.options.message, diff },
      this.abort.signal,
    );
    this.emit({ type: "approval.resolved", key, approved: answer.approved, ...(answer.note ? { note: answer.note } : {}) });
    void frame;
    if (answer.approved) return { status: "succeeded", outputs: { approved: true } };
    if ((block.on_reject ?? "feedback_to_workers") === "feedback_to_workers") {
      const note = answer.note ?? "Rejected without a note";
      this.deps.journal.put(key, { status: "failed", outputs: { approved: false, note }, effects: { rejection: note } });
      throw new ApprovalRejected(note);
    }
    return { status: "failed", fatal: true, outputs: { approved: false, note: answer.note ?? "" }, error: "Rejected in review" };
  }

  // ---------------------------------------------------------------- review (bugbot)

  private async runReview(block: ReviewBlock, frame: Frame, key: string, attempt: Attempt): Promise<BlockResult> {
    const agent = this.agent(block.agent);
    const task = frame.task;
    const scope = block.scope ?? (task ? "task.diff" : "session.diff");
    const diff =
      scope === "task.diff" && task?.worktree
        ? await this.deps.workspace.diff(task.worktree, task.spec.edit)
        : scope === "working_tree"
          ? await this.deps.workspace.workingTreeDiff()
          : await this.deps.workspace.sessionDiff(this.options.sessionId);
    const round = (task?.reviewRounds.length ?? 0) + 1;
    if (!diff.trim()) {
      return { status: "succeeded", outputs: { passed: true, needs_qa: false, routed_findings: [], report_only: [], findings: [], round } };
    }
    let context = "";
    if (task) context += section("Task", renderTask(task.spec));
    context += section("Diff to review", "```diff\n" + diff + "\n```");
    context += section("Decisions so far", renderDecisions(this.escalations.decisions));
    const cursor = this.cursorFor(block, agent, key, task);
    const result = await this.callAgent({
      key,
      agent,
      mode: "review",
      task,
      cwd: frame.cwd,
      editScope: [],
      instructions: modeInstructions("review", {}),
      blockInstructions: block.instructions,
      context,
      cursor,
      frame,
      attempt,
    });
    const tokens = result.usage.input + result.usage.output;
    if (result.status === "aborted") throw new TaskRestart(task?.id ?? "main", result.error ?? "aborted");
    if (result.status !== "completed") {
      return { status: "failed", fatal: true, outputs: {}, error: result.error ?? "Review failed", tokens };
    }
    const parsed = FindingsSubmission.safeParse(result.submission?.value);
    const raw = parsed.success ? parsed.data.findings : [];
    const findings = await applyDetectors(raw, this.deps.detectors ?? [bugbotClaimDetector]);
    const table = block.routing === "report_only" || !task ? "report_only" : (this.options.config.findings_routing ?? []);
    let routed = findings.map((f) => routeFinding(f, table));

    const announce = (r: RoutedFinding, status: "pending" | "fixed" | "failed" | "reported") =>
      this.emit({
        type: "finding.routed",
        key,
        finding: r.finding.id,
        severity: r.finding.severity,
        category: r.finding.category,
        route: r.route,
        rule: r.rule,
        message: r.finding.message,
        status,
        ...(task ? { task: task.id } : {}),
        ...(r.promotedFrom ? { promotedFrom: r.promotedFrom, promotionReason: r.promotionReason } : {}),
      });
    routed.forEach((r) => announce(r, r.route === "report_only" ? "reported" : "pending"));

    if (task) {
      routed = await this.fixMechanically(routed, task, frame, key, announce);
      await this.checkReviewerConflict(task, routed);
    }

    const reportOnly = routed.filter((r) => r.route === "report_only").map((r) => r.finding);
    this.reportOnly.push(...reportOnly);
    const toWorker = routed.filter((r) => r.route === "worker_then_qa");
    const actionable = routed.filter((r) => r.route !== "report_only");
    return {
      status: "succeeded",
      outputs: {
        passed: actionable.length === 0,
        needs_qa: toWorker.length > 0,
        routed_findings: toWorker.map((r) => ({ ...r.finding, route: r.route, ...(r.promotionReason ? { promoted: r.promotionReason } : {}) })),
        report_only: reportOnly,
        findings,
        round,
      },
      tokens,
      ...(result.model ? { model: result.model } : {}),
    };
  }

  /**
   * Order within one bugbot round: command fixes, then one worker pass for the
   * worker_then_command findings (when no finding needs QA), then verification and the
   * safeguard. Anything that fails the safeguard is promoted to worker_then_qa.
   */
  private async fixMechanically(
    routed: RoutedFinding[],
    task: TaskRun,
    frame: Frame,
    key: string,
    announce: (r: RoutedFinding, status: "pending" | "fixed" | "failed" | "reported") => void,
  ): Promise<RoutedFinding[]> {
    const margin = this.options.config.safeguard?.line_margin ?? 3;
    const cwd = task.worktree!;
    const result = [...routed];
    const promoteAt = (index: number, reason: string) => {
      result[index] = promote(result[index]!, reason);
      announce(result[index]!, "pending");
    };

    for (let i = 0; i < result.length; i++) {
      const item = result[i]!;
      if (item.route !== "command_fix") continue;
      const vars = this.templateVars(frame, { finding: { ...item.finding, files: [item.finding.file] } });
      const checkpoint = await this.deps.workspace.checkpoint(cwd);
      const fix = item.fix ? await this.exec(renderTemplate(item.fix, vars), cwd, "finding") : { passed: false, output: "no fix command" };
      if (!fix.passed) {
        promoteAt(i, `fix command failed: ${tailLines(fix.output, 5)}`);
        continue;
      }
      const verify = item.verify ? await this.exec(renderTemplate(item.verify, vars), cwd, "finding") : { passed: true, output: "" };
      const violations = checkFixScope(await this.deps.workspace.diffSince(cwd, checkpoint), [item.finding], margin);
      if (!verify.passed) promoteAt(i, `verify failed: ${tailLines(verify.output, 5)}`);
      else if (violations.length) promoteAt(i, `fix touched ${describeViolations(violations)}`);
      else announce(item, "fixed");
    }

    const workerItems = result.map((r, i) => ({ r, i })).filter(({ r }) => r.route === "worker_then_command");
    const needsQa = result.some((r) => r.route === "worker_then_qa");
    if (workerItems.length && !needsQa) {
      const worker = [...this.options.agents.values()].find((a) => a.role === "worker");
      if (!worker || !task.cursor) {
        workerItems.forEach(({ i }) => promoteAt(i, "no worker available for the fix"));
        return result;
      }
      const checkpoint = await this.deps.workspace.checkpoint(cwd);
      const fixKey = `${key}/fix`;
      const recorded = this.deps.journal.get(fixKey);
      if (!recorded) {
        const fixRun = await this.callAgent({
          key: fixKey,
          agent: worker,
          mode: "fix",
          task,
          cwd,
          editScope: task.spec.edit,
          instructions: modeInstructions("fix", { task: task.spec }),
          context: section("Task", renderTask(task.spec)) + section("Findings to fix", renderValue(workerItems.map(({ r }) => r.finding))),
          cursor: task.cursor,
          frame,
        });
        if (fixRun.status === "aborted") throw new TaskRestart(task.id, fixRun.error ?? "aborted");
        this.deps.journal.put(fixKey, { status: fixRun.status === "completed" ? "succeeded" : "failed", outputs: {} });
        if (fixRun.status !== "completed") {
          workerItems.forEach(({ i }) => promoteAt(i, `worker fix failed: ${fixRun.error ?? ""}`));
          return result;
        }
      }
      const fixDiff = await this.deps.workspace.diffSince(cwd, checkpoint);
      const violations = checkFixScope(fixDiff, workerItems.map(({ r }) => r.finding), margin);
      const verifyCommands = [...new Set(workerItems.map(({ r }) => r.verify).filter((v): v is string => !!v))];
      const failedVerify: string[] = [];
      for (const command of verifyCommands) {
        const vars = this.templateVars(frame, { finding: { files: [...new Set(workerItems.map(({ r }) => r.finding.file))] } });
        const outcome = await this.exec(renderTemplate(command, vars), cwd, "finding");
        if (!outcome.passed) failedVerify.push(command);
      }
      const acTests = await this.runAcceptanceTests(task, frame);
      for (const { r, i } of workerItems) {
        if (failedVerify.length) promoteAt(i, `verify failed: ${failedVerify.join(", ")}`);
        else if (violations.some((v) => v.file === r.finding.file) || violations.some((v) => !workerItems.some(({ r: w }) => w.finding.file === v.file))) {
          promoteAt(i, `fix went beyond the finding: ${describeViolations(violations)}`);
        } else if (!acTests.passed) promoteAt(i, "acceptance tests failed after the fix");
        else announce(r, "fixed");
      }
    }
    return result;
  }

  /** Second half of the safeguard: the criteria's tests (per test_plan) must still pass. */
  private async runAcceptanceTests(task: TaskRun, frame: Frame): Promise<{ passed: boolean }> {
    const commands = [...task.spec.acceptance];
    const testCommand = this.flowTestCommand();
    if (testCommand) commands.unshift(testCommand);
    for (const command of commands) {
      const outcome = await this.exec(renderTemplate(command, this.templateVars(frame)), task.worktree!, "spec");
      if (!outcome.passed) return { passed: false };
    }
    return { passed: true };
  }

  private flowTestCommand(): string | undefined {
    let found: string | undefined;
    walkBlocks(this.options.flow.steps, ({ block }) => {
      if (!found && block.type === "command" && block.also_run === "task.acceptance") found = block.run;
    });
    return found ?? (this.options.config.commands?.test ? "{{commands.test}}" : undefined);
  }

  /** QA approved a criterion and the bugbot keeps asking to change it: they contradict each other. */
  private async checkReviewerConflict(task: TaskRun, routed: RoutedFinding[]): Promise<void> {
    const keys = new Set(
      routed
        .filter((r) => r.route === "worker_then_qa")
        .flatMap((r) => r.finding.affects_ac.filter((ac) => task.lastQaPassed.has(ac)).map((ac) => `${r.finding.file}|${ac}`)),
    );
    const previous = task.reviewRounds.at(-1);
    task.reviewRounds.push(keys);
    if (!previous || !this.escalations.isAutoTriggerEnabled("reviewer_conflict")) return;
    const repeated = [...keys].filter((k) => previous.has(k));
    if (!repeated.length) return;
    const acs = [...new Set(repeated.map((k) => k.split("|")[1]!))];
    const action = await this.autoEscalate("reviewer_conflict", task, {
      type: "decision_gap",
      summary: `QA approved ${acs.join(", ")}, but the bugbot asked twice to change the same behavior. They contradict each other.`,
      evidence: repeated.map((k) => ({ file: k.split("|")[0]! })),
      blocks: acs,
      options_seen: ["Keep QA's reading of the criterion", "Apply the bugbot's change"],
    });
    if (action === "fail") throw new Error("QA and the bugbot contradict each other");
  }
}

/** Model chain position of one role, with fallback on errors, loop limits and budgets. */
export class EngineCursor implements ModelCursor {
  index: number;
  timeFallbackApplied = false;

  constructor(
    private readonly deps: Pick<EngineDeps, "router" | "events">,
    readonly role: string,
    readonly decision: RouteDecision,
    readonly request: RouteRequest,
    readonly key: string,
    readonly task?: string,
  ) {
    this.index = decision.chosenIndex;
  }

  current(): ChainLink | undefined {
    return this.index >= 0 ? this.decision.chain[this.index] : undefined;
  }

  advance(cause: AdvanceCause): ChainLink | undefined {
    const from = this.current();
    const next = this.index >= 0 ? this.deps.router.advance(this.decision, this.index, cause, this.request) : undefined;
    this.index = next ?? -1;
    const to = this.current();
    this.deps.events.emit({
      type: "router.switch",
      key: this.key,
      from: from?.ref ?? "",
      cause,
      ...(to ? { to: to.ref } : {}),
      ...(this.task ? { task: this.task } : {}),
    });
    return to;
  }

  rewind(): ChainLink | undefined {
    const first = this.deps.router.advance(this.decision, -1, "loop_exhausted", this.request);
    if (first !== undefined) this.index = first;
    return first !== undefined ? this.current() : undefined;
  }

  async acquireSlot(signal?: AbortSignal): Promise<() => void> {
    const link = this.current();
    if (!link) return () => undefined;
    if (this.deps.router.slotBusy(link.model.provider)) {
      this.deps.events.emit({ type: "provider.slot_wait", key: this.key, provider: link.model.provider });
    }
    return this.deps.router.acquireSlot(link.model.provider, signal);
  }

  reportFailure(failure: { kind: ErrorKind; message: string; retryAfterMs?: number }): void {
    const link = this.current();
    if (!link) return;
    const { router } = this.deps;
    switch (failure.kind) {
      case "rate_limit":
        router.markRateLimited(link.model.provider, failure.retryAfterMs);
        break;
      case "unavailable":
        router.markOffline(link.model.provider);
        break;
      case "not_found":
        router.markModelMissing(link.model.baseRef);
        break;
      case "auth": {
        const key = profileKey(link.model);
        router.markCredentialProblem(key, "authentication failed");
        this.deps.events.emit({
          type: "warning",
          key: this.key,
          ...(this.task ? { task: this.task } : {}),
          message: `${key} rejected its API key (${failure.message}); check the key in the configuration`,
        });
        break;
      }
      default:
        break;
    }
  }

  reportRateLimits(snapshot: RateLimitSnapshot): void {
    const link = this.current();
    if (!link) return;
    this.deps.events.emit({
      type: "provider.limits",
      provider: link.model.provider,
      ...(link.model.profile ? { profile: link.model.profile } : {}),
      ...snapshot,
    });
  }

  nextRetryAt(): number | undefined {
    const times = this.decision.chain
      .map((l) => this.deps.router.health[l.model.provider])
      .filter((h) => h?.status === "rate_limited")
      .map((h) => h!.untilMs ?? 0);
    return times.length ? Math.min(...times) : undefined;
  }

  recordUsage(usage: { input: number; output: number; cached?: number }): boolean {
    const link = this.current();
    if (!link) return false;
    const model: CatalogModel = link.model;
    const tokens = usage.input + usage.output;
    const cost = usageCost(model, usage);
    this.deps.events.emit({
      type: "usage",
      key: this.key,
      role: this.role,
      model: link.ref,
      provider: model.provider,
      input: usage.input,
      output: usage.output,
      ...(cost !== undefined ? { costUsd: cost } : {}),
      ...(model.profile ? { profile: model.profile } : {}),
      ...(usage.cached ? { cached: usage.cached } : {}),
    });
    return this.deps.router.recordUsage(model, tokens, cost ?? 0);
  }
}

function newTaskRun(spec: TaskSpec): TaskRun {
  return {
    id: spec.id,
    spec,
    attempt: 0,
    notes: [],
    qaRounds: [],
    reviewRounds: [],
    lastQaPassed: new Set(),
    control: new AbortController(),
    modelOffset: 0,
  };
}

function fallbackOptions(escalation: Escalation) {
  const seen = escalation.options_seen.slice(0, 3).map((label) => ({ label }));
  return seen.length >= 2 ? seen : [...seen, { label: "Continue as written" }, { label: "Stop this task" }].slice(0, 4);
}

/** Large outputs (diffs, specs) are kept in the journal but trimmed in events. */
function summarizeOutputs(outputs: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(outputs)) {
    if (typeof value === "string" && value.length > 4000) result[key] = `${value.slice(0, 4000)}…`;
    else if (key === "spec" || key === "pending_tasks" || key === "tasks") result[key] = Array.isArray(value) ? value.length : value ? "…" : value;
    else result[key] = value;
  }
  return result;
}
