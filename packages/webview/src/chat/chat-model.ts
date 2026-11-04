import type { FavoriteModel, HarnessEvent, SessionView, StepStatus, TreeRow } from "@delamain/core";

/** A finished conversation turn kept in the chat after the host resets the event log. */
export interface ArchivedTurn {
  session: string;
  message: string;
  answer?: string;
  summary?: string;
  status: SessionView["status"];
  tokens: number;
  costUsd: number;
}

/** Appends a batch of events, or replaces the log on reset. Duplicates (same session and seq) are dropped. */
export function applyEventBatch(current: readonly HarnessEvent[], incoming: readonly HarnessEvent[], reset = false): HarnessEvent[] {
  const base = reset ? [] : [...current];
  const seen = new Set(base.map((e) => `${e.session}:${e.seq}`));
  for (const event of incoming) {
    const key = `${event.session}:${event.seq}`;
    if (seen.has(key)) continue;
    seen.add(key);
    base.push(event);
  }
  return base;
}

export function archiveOf(view: SessionView): ArchivedTurn | undefined {
  if (!view.session || view.message === undefined) return undefined;
  return {
    session: view.session,
    message: view.message,
    ...(view.answer !== undefined ? { answer: view.answer } : {}),
    ...(view.summary !== undefined ? { summary: view.summary } : {}),
    status: view.status,
    tokens: view.tokens,
    costUsd: view.costUsd,
  };
}

/** Adds the turn unless that session is already in the history. */
export function pushArchive(history: readonly ArchivedTurn[], turn: ArchivedTurn | undefined): ArchivedTurn[] {
  if (!turn || history.some((t) => t.session === turn.session)) return [...history];
  return [...history, turn];
}

/** Block id of a step row: the last segment of its step key without iteration markers. */
export function blockIdOfRow(row: TreeRow): string | undefined {
  if (row.kind !== "step" && row.kind !== "attempt") return undefined;
  if (row.block) return row.block;
  const last = row.id.split("/").pop() ?? row.id;
  return last.replace(/#\d+/g, "").replace(/@\d+/g, "") || undefined;
}

const PRIORITY: StepStatus[] = ["running", "paused", "waiting", "failed", "cancelled", "succeeded", "skipped"];

/**
 * Live status per block id for the graph view. Within one task the latest run of a block wins
 * (later loop iterations replace earlier ones); across tasks the most urgent status wins.
 */
export function blockStatuses(rows: readonly TreeRow[]): Record<string, StepStatus> {
  const latest = new Map<string, { block: string; status: StepStatus; at: number; order: number }>();
  let order = 0;
  const visit = (list: readonly TreeRow[]) => {
    for (const row of list) {
      const block = blockIdOfRow(row);
      if (block) {
        const key = `${row.task ?? ""}|${block}`;
        const at = row.startedAt ?? 0;
        const previous = latest.get(key);
        const current = { block, status: row.status, at, order: order++ };
        if (!previous || at > previous.at || (at === previous.at && current.order > previous.order)) latest.set(key, current);
      }
      visit(row.children);
    }
  };
  visit(rows);
  const out: Record<string, StepStatus> = {};
  for (const { block, status } of latest.values()) {
    const previous = out[block];
    if (!previous || PRIORITY.indexOf(status) < PRIORITY.indexOf(previous)) out[block] = status;
  }
  return out;
}

export interface PrincipalOption {
  value: string;
  label: string;
}

/** Favorites that can act as the principal for one conversation. */
export function principalOptions(models: readonly FavoriteModel[] | undefined): PrincipalOption[] {
  return (models ?? [])
    .filter((m) => m.roles?.some((r) => r === "orchestrator" || r === "orchestrator-fallback"))
    .map((m) => ({ value: m.ref, label: m.label ? `${m.label} (${m.ref})` : m.ref }));
}

/** User messages typed during a run, which the reducer does not keep. */
export function userMessagesOf(events: readonly HarnessEvent[]): string[] {
  const out: string[] = [];
  for (const event of events) if (event.type === "message.user") out.push(event.text);
  return out;
}
