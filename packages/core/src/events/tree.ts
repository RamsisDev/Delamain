import type { HumanOption } from "../schema/escalation.ts";
import type { HarnessEvent, StepStatus } from "./types.ts";

export interface TreeRow {
  id: string;
  label: string;
  kind: "step" | "task" | "attempt" | "finding" | "info";
  /** Block id of a step row, for mapping live status onto the flow graph. */
  block?: string;
  status: StepStatus;
  task?: string;
  model?: string;
  rule?: string;
  tokens: number;
  startedAt?: number;
  durationMs?: number;
  detail?: string;
  waitingFor?: string[];
  attempt?: { current: number; max: number };
  budget?: { tokens: number; maxTokens?: number; minutes: number; maxMinutes?: number };
  outputs?: Record<string, unknown>;
  error?: string;
  children: TreeRow[];
}

export interface PendingQuestion {
  id: string;
  question: string;
  options: HumanOption[];
  blocks: string[];
  batched: boolean;
}

export interface SessionView {
  session?: string;
  message?: string;
  flow?: string;
  status: "running" | "succeeded" | "failed" | "cancelled" | "answered" | "paused";
  branch?: string;
  rows: TreeRow[];
  questions: PendingQuestion[];
  approval?: { key: string };
  answer?: string;
  summary?: string;
  tokens: number;
  costUsd: number;
  warnings: string[];
  decisions: { id: string; answer: string; decidedBy: string }[];
  specVersion?: number;
  text: Record<string, string>;
}

export function emptyView(): SessionView {
  return { status: "running", rows: [], questions: [], tokens: 0, costUsd: 0, warnings: [], decisions: [], text: {} };
}

function parentKey(key: string): string | undefined {
  const index = key.lastIndexOf("/");
  return index > 0 ? key.slice(0, index) : undefined;
}

function cleanKey(key: string): string {
  return key.replace(/#\d+/g, "").replace(/@\d+/g, "");
}

/**
 * Folds the event log into the subtask tree shown in the chat. Pure, so the webview can
 * rebuild the same view from a persisted log when a session is reopened.
 */
export function reduceEvents(events: readonly HarnessEvent[], view: SessionView = emptyView()): SessionView {
  const index = new Map<string, TreeRow>();
  const visit = (rows: TreeRow[]) => {
    for (const row of rows) {
      index.set(row.id, row);
      visit(row.children);
    }
  };
  visit(view.rows);

  const taskRows = new Map<string, TreeRow>();
  for (const row of index.values()) if (row.kind === "task" && row.task) taskRows.set(row.task, row);

  const attach = (row: TreeRow, key: string | undefined, task?: string) => {
    let parent: TreeRow | undefined;
    for (let k = key; k; k = parentKey(k)) {
      parent = index.get(k);
      if (parent) break;
    }
    if (!parent && task) parent = taskRows.get(task);
    (parent ? parent.children : view.rows).push(row);
    index.set(row.id, row);
  };

  const upsert = (id: string, make: () => TreeRow, key?: string, task?: string): TreeRow => {
    let row = index.get(id);
    if (!row) {
      row = make();
      attach(row, key ? parentKey(key) : undefined, task);
    }
    return row;
  };

  for (const event of events) {
    switch (event.type) {
      case "session.started":
        view.session = event.session;
        view.message = event.message;
        view.flow = event.flow;
        if (event.branch) view.branch = event.branch;
        view.status = "running";
        break;
      case "session.finished":
        view.status = event.status;
        if (event.summary) view.summary = event.summary;
        break;
      case "session.paused":
        view.status = "paused";
        break;
      case "session.resumed":
        view.status = "running";
        break;
      case "step.waiting": {
        const row = upsert(event.key, () => newRow(event.key, event.label ?? event.block, "step", "waiting", event.task), event.key, event.task);
        row.status = "waiting";
        row.block = event.block;
        row.waitingFor = event.waitingFor;
        if (event.condition) row.detail = `when ${event.condition}`;
        break;
      }
      case "step.started": {
        const row = upsert(event.key, () => newRow(event.key, event.label ?? event.block, "step", "running", event.task), event.key, event.task);
        row.status = "running";
        row.block = event.block;
        row.startedAt = event.ts;
        delete row.waitingFor;
        if (event.maxAttempts) row.attempt = { current: event.attempt ?? 0, max: event.maxAttempts };
        break;
      }
      case "step.finished": {
        const row = upsert(event.key, () => newRow(event.key, event.block, "step", event.status), event.key);
        row.status = event.status;
        row.block = event.block;
        row.durationMs = event.durationMs;
        row.outputs = event.outputs;
        if (event.model) row.model = event.model;
        if (event.tokens) row.tokens = Math.max(row.tokens, event.tokens);
        if (event.error) row.error = event.error;
        delete row.waitingFor;
        break;
      }
      case "step.retrying": {
        const row = index.get(event.key);
        if (row) {
          row.attempt = { current: event.attempt, max: event.maxAttempts };
          row.detail = `retrying after: ${event.error}`;
        }
        break;
      }
      case "loop.iteration": {
        const row = index.get(event.key);
        if (row) {
          row.attempt = { current: event.iteration, max: event.max };
          if (event.budget) row.budget = event.budget;
        }
        break;
      }
      case "task.started": {
        const id = `task:${event.task}`;
        const row = index.get(id) ?? newRow(id, `${event.task} ${event.kind}`, "task", "running", event.task);
        if (!index.has(id)) {
          view.rows.push(row);
          index.set(id, row);
          taskRows.set(event.task, row);
        }
        row.status = "running";
        row.detail = event.goal;
        row.startedAt = event.ts;
        delete row.waitingFor;
        break;
      }
      case "task.waiting": {
        const id = `task:${event.task}`;
        const row = index.get(id) ?? newRow(id, event.task, "task", "waiting", event.task);
        if (!index.has(id)) {
          view.rows.push(row);
          index.set(id, row);
          taskRows.set(event.task, row);
        }
        row.status = "waiting";
        row.waitingFor = event.waitingFor;
        row.detail = event.reason;
        break;
      }
      case "task.finished": {
        const row = index.get(`task:${event.task}`);
        if (row) {
          row.status = "succeeded";
          if (row.startedAt) row.durationMs = event.ts - row.startedAt;
        }
        break;
      }
      case "task.failed": {
        const id = `task:${event.task}`;
        const row = index.get(id) ?? newRow(id, event.task, "task", "failed", event.task);
        if (!index.has(id)) {
          view.rows.push(row);
          index.set(id, row);
        }
        row.status = "failed";
        row.error = event.reason;
        break;
      }
      case "task.delta":
        view.text[event.key] = ((view.text[event.key] ?? "") + event.text).slice(-20_000);
        break;
      case "router.decision": {
        const row = index.get(event.key) ?? (event.task ? index.get(`task:${event.task}`) : undefined);
        if (row) {
          row.model = event.modelLabel;
          row.rule = event.rule;
        }
        for (const warning of event.warnings) view.warnings.push(warning);
        break;
      }
      case "router.switch": {
        const row = index.get(event.key) ?? (event.task ? index.get(`task:${event.task}`) : undefined);
        if (row) row.detail = `switched model (${event.cause})${event.to ? ` → ${event.to}` : ""}`;
        break;
      }
      case "provider.slot_wait": {
        const row = index.get(event.key);
        if (row) row.detail = `waiting for a slot on ${event.provider}`;
        break;
      }
      case "usage": {
        view.tokens += event.input + event.output;
        view.costUsd += event.costUsd ?? 0;
        const row = index.get(event.key);
        if (row) row.tokens += event.input + event.output;
        break;
      }
      case "command.finished": {
        const row = index.get(event.key);
        if (row) row.detail = `${event.command} · ${event.passed ? "passed" : `${event.failures || "exit " + event.exitCode} failures`}`;
        break;
      }
      case "finding.routed": {
        const id = `${event.key}:${event.finding}`;
        const row = upsert(id, () => newRow(id, `${event.finding} ${event.category}`, "finding", "running", event.task), `${event.key}/x`);
        row.label = `${event.finding} ${event.category} ${event.severity} → ${event.route}`;
        row.detail = event.promotionReason ? `${event.message} (promoted: ${event.promotionReason})` : event.message;
        row.rule = event.rule;
        row.status = event.status === "fixed" || event.status === "reported" ? "succeeded" : event.status === "failed" ? "failed" : "running";
        break;
      }
      case "question.asked":
        if (!view.questions.some((q) => q.id === event.id)) {
          view.questions.push({ id: event.id, question: event.question, options: event.options, blocks: event.blocks, batched: event.batched });
        }
        break;
      case "question.answered":
        view.questions = view.questions.filter((q) => q.id !== event.id);
        break;
      case "escalation.resolved":
        if (event.decision) view.decisions.push({ id: event.decision, answer: event.answer, decidedBy: event.decidedBy });
        break;
      case "approval.requested":
        view.approval = { key: event.key };
        break;
      case "approval.resolved":
        delete view.approval;
        break;
      case "spec.published":
        view.specVersion = event.version;
        break;
      case "message.assistant":
        view.answer = event.text;
        break;
      case "warning":
        view.warnings.push(event.message);
        break;
      default:
        break;
    }
  }
  return view;
}

function newRow(id: string, label: string, kind: TreeRow["kind"], status: StepStatus, task?: string): TreeRow {
  return { id, label: label || cleanKey(id), kind, status, tokens: 0, children: [], ...(task ? { task } : {}) };
}
