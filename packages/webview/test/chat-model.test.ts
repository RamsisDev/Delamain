import { describe, expect, it } from "vitest";
import { reduceEvents, type HarnessEvent, type HarnessEventBody } from "@delamain/core";
import {
  applyEventBatch,
  archiveOf,
  blockIdOfRow,
  blockStatuses,
  principalOptions,
  pushArchive,
} from "../src/chat/chat-model";

function events(bodies: HarnessEventBody[], session = "s1"): HarnessEvent[] {
  return bodies.map((body, i) => ({ ...body, seq: i + 1, ts: 1000 + i * 10, session }) as HarnessEvent);
}

const log = events([
  { type: "session.started", message: "add retries", flow: "default", approval: "auto" },
  { type: "step.started", key: "delivery-loop#1", block: "delivery-loop", blockType: "loop" },
  { type: "step.started", key: "delivery-loop#1/spec", block: "spec", blockType: "agent" },
  { type: "step.finished", key: "delivery-loop#1/spec", block: "spec", status: "succeeded", outputs: {}, durationMs: 12 },
  { type: "task.started", task: "t1", goal: "rename", kind: "rename" },
  { type: "step.started", key: "delivery-loop#1/build/t1/test-loop#1/tests", block: "tests", blockType: "command", task: "t1" },
  { type: "step.finished", key: "delivery-loop#1/build/t1/test-loop#1/tests", block: "tests", status: "failed", outputs: {}, durationMs: 5 },
  { type: "step.started", key: "delivery-loop#1/build/t1/test-loop#2/tests", block: "tests", blockType: "command", task: "t1" },
  { type: "step.finished", key: "delivery-loop#1/build/t1/test-loop#2/tests", block: "tests", status: "succeeded", outputs: {}, durationMs: 5 },
  { type: "task.started", task: "t2", goal: "tests", kind: "tests" },
  { type: "step.started", key: "delivery-loop#1/build/t2/test-loop#1/tests", block: "tests", blockType: "command", task: "t2" },
  { type: "message.assistant", text: "Working on it" },
]);

describe("chat model", () => {
  it("appends batches, drops duplicates and replaces on reset", () => {
    const first = applyEventBatch([], log.slice(0, 3));
    const second = applyEventBatch(first, log.slice(2, 6));
    expect(second).toHaveLength(6);
    expect(applyEventBatch(second, log.slice(0, 1), true)).toHaveLength(1);
  });

  it("maps step rows to block ids without iteration markers", () => {
    const view = reduceEvents(log);
    const rows = view.rows.flatMap(function flat(r): typeof view.rows {
      return [r, ...r.children.flatMap(flat)];
    });
    expect(rows.map(blockIdOfRow).filter(Boolean)).toContain("tests");
    expect(blockIdOfRow({ id: "task:t1", label: "t1", kind: "task", status: "running", tokens: 0, children: [] })).toBeUndefined();
  });

  it("colors each block by its latest run per task and the most urgent status across tasks", () => {
    const view = reduceEvents(log);
    const statuses = blockStatuses(view.rows);
    expect(statuses.spec).toBe("succeeded");
    expect(statuses["delivery-loop"]).toBe("running");
    expect(statuses.tests).toBe("running");
    const t1Only = blockStatuses(reduceEvents(log.slice(0, 9)).rows);
    expect(t1Only.tests).toBe("succeeded");
  });

  it("archives finished turns once per session", () => {
    const view = reduceEvents(log);
    const turn = archiveOf(view);
    expect(turn).toMatchObject({ session: "s1", message: "add retries", answer: "Working on it" });
    const history = pushArchive(pushArchive([], turn), turn);
    expect(history).toHaveLength(1);
  });

  it("lists orchestrator favorites as principal overrides", () => {
    const options = principalOptions([
      { ref: "anthropic/claude", label: "Claude", roles: ["orchestrator"] },
      { ref: "openrouter/deepseek", roles: ["worker"] },
      { ref: "openai/gpt", roles: ["orchestrator-fallback", "qa"] },
    ]);
    expect(options.map((o) => o.value)).toEqual(["anthropic/claude", "openai/gpt"]);
  });
});
