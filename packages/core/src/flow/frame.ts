import type { RouteRequest } from "../router/route.ts";
import type { TaskSpec } from "../schema/spec.ts";
import type { ModelCursor } from "./ports.ts";

export interface LoopState {
  id: string;
  iteration: number;
  tokens: number;
  startedAt: number;
}

export interface TaskRun {
  id: string;
  spec: TaskSpec;
  attempt: number;
  worktree?: string;
  cursor?: ModelCursor;
  request?: RouteRequest;
  /** Replies and notes attached while the task runs (rejected escalations, user feedback). */
  notes: string[];
  /** Per QA round: unmet criteria ids, and lines the worker had added at that point. */
  qaRounds: { failed: string[]; added: Set<string> }[];
  /** Per review round: "file|AC" keys of findings sent back to the worker. */
  reviewRounds: Set<string>[];
  lastQaPassed: Set<string>;
  implicit?: boolean;
  /** Aborts only this task's agents and commands (per-task cancel, retry, skip). */
  control: AbortController;
  requested?: TaskAction;
  /** How many links to skip when the task restarts ("retry with another model"). */
  modelOffset: number;
}

export type TaskAction = "cancel" | "retry" | "retry-model" | "skip";

/**
 * Scope of one body execution. Outputs are looked up from the innermost frame outwards, so
 * inner loops see the latest values of outer blocks (e.g. bugbot.routed_findings).
 */
export class Frame {
  readonly outputs = new Map<string, Record<string, unknown>>();
  /** Latest outputs of every block at any depth inside this task, for outside aggregation. */
  readonly flat = new Map<string, Record<string, unknown>>();
  readonly foreachChildren = new Map<string, Frame[]>();
  loop?: LoopState;

  constructor(
    readonly parent: Frame | undefined,
    public key: string,
    readonly cwd: string,
    readonly task?: TaskRun,
  ) {}

  child(key: string, cwd = this.cwd, task = this.task): Frame {
    return new Frame(this, key, cwd, task);
  }

  setOutputs(id: string, outputs: Record<string, unknown>): void {
    this.outputs.set(id, outputs);
    for (let f: Frame | undefined = this; f; f = f.parent) {
      if (f.task && (!f.parent || f.parent.task !== f.task)) {
        f.flat.set(id, outputs);
        break;
      }
    }
  }

  lookup(id: string): Record<string, unknown> | undefined {
    for (let f: Frame | undefined = this; f; f = f.parent) {
      const found = f.outputs.get(id);
      if (found) return found;
    }
    return undefined;
  }

  /** Outputs of a block that ran once per task inside a foreach below this scope. */
  aggregate(id: string): Record<string, unknown>[] {
    const values: Record<string, unknown>[] = [];
    for (let f: Frame | undefined = this; f; f = f.parent) {
      for (const children of f.foreachChildren.values()) {
        for (const child of children) {
          const found = child.flat.get(id);
          if (found) values.push(found);
        }
      }
      if (values.length) break;
    }
    return values;
  }

  nearestLoop(): LoopState | undefined {
    for (let f: Frame | undefined = this; f; f = f.parent) if (f.loop) return f.loop;
    return undefined;
  }

  loops(): LoopState[] {
    const result: LoopState[] = [];
    for (let f: Frame | undefined = this; f; f = f.parent) if (f.loop) result.push(f.loop);
    return result;
  }
}

/** Combines per-task values: lists are concatenated, booleans must all hold. */
export function combine(values: unknown[]): unknown {
  if (values.length === 0) return undefined;
  if (values.every(Array.isArray)) return (values as unknown[][]).flat();
  if (values.every((v) => typeof v === "boolean")) return values.every(Boolean);
  if (values.every((v) => typeof v === "string")) return (values as string[]).join("\n");
  return values;
}
