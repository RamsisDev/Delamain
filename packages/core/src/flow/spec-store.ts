import { Spec, TaskSpec, type SpecSubmission } from "../schema/spec.ts";
import { deepEqual } from "../util/hash.ts";
import { error, type Issue } from "../util/issues.ts";

export type TaskState = "pending" | "running" | "done" | "failed";

export interface SpecChange {
  version: number;
  pending: string[];
  reopened: string[];
  removed: string[];
}

/** Every principal decision or rejection produces a new spec version. */
export class SpecStore {
  readonly versions: Spec[] = [];
  readonly state = new Map<string, TaskState>();

  get current(): Spec | undefined {
    return this.versions.at(-1);
  }

  get version(): number {
    return this.current?.spec_version ?? 0;
  }

  task(id: string): TaskSpec | undefined {
    return this.current?.tasks.find((t) => t.id === id);
  }

  pendingTasks(): TaskSpec[] {
    return (this.current?.tasks ?? []).filter((t) => this.state.get(t.id) !== "done");
  }

  publish(submission: SpecSubmission): SpecChange {
    const previous = this.current;
    const version = this.version + 1;
    const spec: Spec = { spec_version: version, tasks: submission.tasks, ...(submission.summary ? { summary: submission.summary } : {}) };
    const reopened: string[] = [];
    const pending: string[] = [];
    for (const task of spec.tasks) {
      const before = previous?.tasks.find((t) => t.id === task.id);
      const changed = !before || !deepEqual(before, task);
      const reopen = submission.reopen.includes(task.id);
      if (changed || reopen || this.state.get(task.id) !== "done") {
        if (this.state.get(task.id) === "done") reopened.push(task.id);
        this.state.set(task.id, "pending");
        pending.push(task.id);
      }
    }
    const removed = (previous?.tasks ?? []).filter((t) => !spec.tasks.some((n) => n.id === t.id)).map((t) => t.id);
    for (const id of removed) this.state.delete(id);
    this.versions.push(spec);
    return { version, pending, reopened, removed };
  }

  /** Adds a note to tasks and publishes the result as a new version. */
  annotate(taskIds: readonly string[], note: string): SpecChange | undefined {
    const current = this.current;
    if (!current) return undefined;
    const tasks = current.tasks.map((t) => (taskIds.includes(t.id) ? { ...t, notes: [...t.notes, note] } : t));
    return this.publish({ tasks, reopen: [...taskIds], ...(current.summary ? { summary: current.summary } : {}) });
  }

  restore(spec: Spec, states: Record<string, TaskState>): void {
    this.versions.push(spec);
    for (const [id, state] of Object.entries(states)) this.state.set(id, state);
  }
}

/** Structural checks on a submitted spec: unique ids, known dependencies, no cycles, plan coverage. */
export function validateSpecSubmission(submission: SpecSubmission, knownDone: ReadonlySet<string> = new Set()): Issue[] {
  const issues: Issue[] = [];
  const ids = new Set<string>();
  submission.tasks.forEach((task, index) => {
    if (ids.has(task.id)) issues.push(error(["tasks", index, "id"], `Duplicate task id "${task.id}"`));
    ids.add(task.id);
    const acIds = new Set<string>();
    task.acceptance_criteria.forEach((ac, i) => {
      if (acIds.has(ac.id)) issues.push(error(["tasks", index, "acceptance_criteria", i, "id"], `Duplicate criterion "${ac.id}"`));
      acIds.add(ac.id);
    });
    task.test_plan.forEach((entry, i) => {
      for (const ac of entry.covers) {
        if (!acIds.has(ac)) issues.push(error(["tasks", index, "test_plan", i, "covers"], `Unknown criterion "${ac}"`));
      }
    });
  });
  submission.tasks.forEach((task, index) => {
    task.depends_on.forEach((dep, i) => {
      if (!ids.has(dep) && !knownDone.has(dep)) {
        issues.push(error(["tasks", index, "depends_on", i], `Unknown task "${dep}"`));
      }
    });
  });
  const byId = new Map(submission.tasks.map((t) => [t.id, t]));
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (id: string): boolean => {
    if (done.has(id)) return false;
    if (visiting.has(id)) return true;
    visiting.add(id);
    for (const dep of byId.get(id)?.depends_on ?? []) if (byId.has(dep) && visit(dep)) return true;
    visiting.delete(id);
    done.add(id);
    return false;
  };
  for (const task of submission.tasks) {
    if (visit(task.id)) {
      issues.push(error(["tasks"], `Dependency cycle involving "${task.id}"`));
      break;
    }
  }
  const files = new Map<string, string>();
  for (const task of submission.tasks) {
    for (const file of task.edit) {
      const other = files.get(file);
      if (other && !dependsTransitively(byId, task.id, other) && !dependsTransitively(byId, other, task.id)) {
        issues.push(
          error(["tasks"], `Tasks "${other}" and "${task.id}" both edit ${file}; one must depend on the other`),
        );
      }
      files.set(file, task.id);
    }
  }
  return issues;
}

function dependsTransitively(byId: Map<string, TaskSpec>, from: string, target: string, seen = new Set<string>()): boolean {
  if (seen.has(from)) return false;
  seen.add(from);
  const task = byId.get(from);
  if (!task) return false;
  return task.depends_on.some((dep) => dep === target || dependsTransitively(byId, dep, target, seen));
}

export { Spec, TaskSpec };
