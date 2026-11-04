import type { EventSink } from "../events/types.ts";
import type {
  Decision,
  Escalation,
  EscalationRequest,
  HumanOption,
  TriageOutcome,
} from "../schema/escalation.ts";
import type { EscalationPolicy } from "../schema/flow.ts";
import type { ResolvedLimits } from "../schema/limits.ts";

export interface HumanQuestion {
  id: string;
  escalation?: string;
  question: string;
  options: HumanOption[];
  blocks: string[];
  /** Over the session's question cap: shown in one collected list, not notified alone. */
  batched: boolean;
}

export interface HumanReview {
  key: string;
  summary: string;
  diff: string;
}

export interface CommandConfirmation {
  command: string;
  cwd: string;
  reason: "new" | "destructive";
  source: string;
}

export interface HumanPort {
  ask(question: HumanQuestion, signal?: AbortSignal): Promise<string>;
  review(request: HumanReview, signal?: AbortSignal): Promise<{ approved: boolean; note?: string }>;
  confirmCommand(request: CommandConfirmation): Promise<"allow" | "allow_always" | "deny">;
}

export type EscalationResolution =
  | { kind: "rejected"; reply: string }
  | { kind: "decided"; decision: Decision };

export interface TriageInput {
  escalation: Escalation;
  decisions: readonly Decision[];
}

export interface EscalationManagerDeps {
  events: EventSink;
  human: HumanPort;
  limits: ResolvedLimits;
  policy: EscalationPolicy;
  /** Runs the principal in triage mode. */
  triage(input: TriageInput, signal?: AbortSignal): Promise<TriageOutcome>;
  now(): number;
  /** Replayed answers when resuming a session, keyed by escalation id. */
  recorded?: (id: string) => EscalationResolution | undefined;
  record?: (id: string, resolution: EscalationResolution) => void;
}

/**
 * The loop breaker. The principal triages every escalation first; only real decisions reach the
 * human, and only the affected task waits for them.
 */
export class EscalationManager {
  readonly decisions: Decision[] = [];
  private readonly perTask = new Map<string, number>();
  private readonly raisedPerScope = new Map<string, number>();
  private questionsAsked = 0;
  private decisionSequence = 0;
  readonly pending = new Map<string, Escalation>();

  constructor(private readonly deps: EscalationManagerDeps) {}

  get maxPerTask(): number {
    return this.deps.policy.max_per_task ?? this.deps.limits.max_escalations_per_task;
  }

  isAutoTriggerEnabled(trigger: string): boolean {
    const triggers = this.deps.policy.auto_triggers;
    return triggers === undefined || (triggers as string[]).includes(trigger);
  }

  addDecisions(decisions: readonly Decision[]): void {
    for (const decision of decisions) {
      if (!this.decisions.some((d) => d.id === decision.id)) this.decisions.push(decision);
      const n = Number(/^D(\d+)$/.exec(decision.id)?.[1] ?? 0);
      this.decisionSequence = Math.max(this.decisionSequence, n);
    }
  }

  async raise(
    request: EscalationRequest,
    origin: { task?: string; raisedBy: string; automatic?: string; specVersion?: number },
    signal?: AbortSignal,
  ): Promise<EscalationResolution> {
    const scope = origin.task ?? "session";
    const raised = (this.raisedPerScope.get(scope) ?? 0) + 1;
    this.raisedPerScope.set(scope, raised);
    const id = `${scope}-E${raised}`;
    const escalation: Escalation = {
      ...request,
      id,
      raised_by: origin.raisedBy,
      created_at: this.deps.now(),
      ...(origin.task ? { task: origin.task } : {}),
      ...(origin.automatic ? { automatic: origin.automatic } : {}),
    };
    const count = (this.perTask.get(scope) ?? 0) + 1;
    this.perTask.set(scope, count);
    const replayed = this.deps.recorded?.(id);
    if (replayed) {
      if (replayed.kind === "decided") {
        this.addDecisions([replayed.decision]);
        if (replayed.decision.decided_by === "human") this.questionsAsked++;
      }
      return replayed;
    }
    this.deps.events.emit({ type: "escalation.raised", escalation });
    this.pending.set(id, escalation);
    try {
      const resolution = await this.resolve(escalation, count, origin.specVersion, signal);
      this.deps.record?.(id, resolution);
      return resolution;
    } finally {
      this.pending.delete(id);
    }
  }

  private async resolve(
    escalation: Escalation,
    count: number,
    specVersion: number | undefined,
    signal?: AbortSignal,
  ): Promise<EscalationResolution> {
    if (count > this.maxPerTask) {
      this.deps.events.emit({
        type: "escalation.triaged",
        id: escalation.id,
        outcome: "ask_human",
        detail: `Task reached ${this.maxPerTask} escalations; it goes to the human`,
      });
      return this.askHuman(escalation, {
        question: escalation.summary,
        options: [
          ...escalation.options_seen.slice(0, 3).map((label) => ({ label })),
          { label: "Stop this task" },
        ].slice(0, 4),
      }, specVersion, signal);
    }

    const outcome = await this.deps.triage({ escalation, decisions: this.decisions }, signal);
    this.deps.events.emit({
      type: "escalation.triaged",
      id: escalation.id,
      outcome: outcome.outcome,
      detail:
        outcome.outcome === "resolved"
          ? outcome.answer
          : outcome.outcome === "rejected"
            ? outcome.reply
            : outcome.question,
    });
    if (outcome.outcome === "rejected") {
      this.deps.events.emit({ type: "escalation.resolved", id: escalation.id, answer: outcome.reply, decidedBy: "principal" });
      return { kind: "rejected", reply: outcome.reply };
    }
    if (outcome.outcome === "resolved") {
      const decision = this.newDecision(escalation, `${outcome.answer} (source: ${outcome.citation})`, "principal", specVersion);
      this.deps.events.emit({ type: "escalation.resolved", id: escalation.id, answer: decision.answer, decidedBy: "principal", decision: decision.id });
      return { kind: "decided", decision };
    }
    return this.askHuman(escalation, outcome, specVersion, signal);
  }

  private async askHuman(
    escalation: Escalation,
    ask: { question: string; options: HumanOption[] },
    specVersion: number | undefined,
    signal?: AbortSignal,
  ): Promise<EscalationResolution> {
    const batched = this.questionsAsked >= this.deps.limits.max_human_questions_per_session;
    this.questionsAsked++;
    const question: HumanQuestion = {
      id: `Q-${escalation.id}`,
      escalation: escalation.id,
      question: ask.question,
      options: ask.options,
      blocks: [...(escalation.task ? [escalation.task] : []), ...escalation.blocks],
      batched,
    };
    this.deps.events.emit({
      type: "question.asked",
      id: question.id,
      escalation: escalation.id,
      question: question.question,
      options: question.options,
      blocks: question.blocks,
      batched,
    });
    const answer = await this.deps.human.ask(question, signal);
    this.deps.events.emit({ type: "question.answered", id: question.id, answer });
    const decision = this.newDecision(escalation, answer, "human", specVersion, ask.question);
    this.deps.events.emit({ type: "escalation.resolved", id: escalation.id, answer, decidedBy: "human", decision: decision.id });
    return { kind: "decided", decision };
  }

  private newDecision(
    escalation: Escalation,
    answer: string,
    decidedBy: "human" | "principal",
    specVersion: number | undefined,
    question = escalation.summary,
  ): Decision {
    const decision: Decision = {
      id: `D${++this.decisionSequence}`,
      question,
      answer,
      decided_by: decidedBy,
      affects: escalation.blocks,
      ...(specVersion !== undefined ? { spec_version: specVersion + 1 } : {}),
      ...(escalation.task ? { task: escalation.task } : {}),
      date: new Date(this.deps.now()).toISOString(),
    };
    this.decisions.push(decision);
    return decision;
  }
}
