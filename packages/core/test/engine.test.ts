import { describe, expect, it } from "vitest";
import { Flow, MemoryJournal, parseYaml, reduceEvents, computeMetrics, systemPromptFor, tokenSplit, walkBlocks } from "../src/index.ts";
import { FakeCommands, FakeHuman, ScriptedRunner, makeEngine, task, testHarness, type Script } from "./fakes.ts";

const approve = { tool: "submit_verdict", value: { approved: true, notes: "", reopen: [] } };

/** The happy path of the default flow with one realistic bump per loop. */
const defaultScript: Script = (input) => {
  if (input.mode === "spec") {
    return { submission: { tool: "submit_spec", value: { tasks: [task("t1"), task("t2", { depends_on: ["t1"] })], reopen: [] } } };
  }
  if (input.mode === "verify") return { submission: approve };
  if (input.mode === "work" || input.mode === "fix") return { submission: { tool: "finish", value: { notes: "done" } } };
  if (input.mode === "qa") {
    const id = input.task!.id;
    const round = qaRounds.get(id) ?? 0;
    qaRounds.set(id, round + 1);
    const passed = !(id === "t1" && round === 0);
    return { submission: { tool: "submit_qa", value: { results: [{ ac: "AC1", passed, evidence: passed ? "test passes" : "404 retried" }], missing: [], added_tests: [] } } };
  }
  if (input.mode === "review") {
    const id = input.task!.id;
    const round = reviewRounds.get(id) ?? 0;
    reviewRounds.set(id, round + 1);
    const findings =
      id === "t1" && round === 0
        ? [{ id: "F1", severity: "low", category: "format", file: "src/t1.ts", line: 5, message: "formatting", affects_ac: [], behavior_change: false, autofix: true }]
        : [];
    return { submission: { tool: "submit_findings", value: { findings } } };
  }
  return {};
};
const qaRounds = new Map<string, number>();
const reviewRounds = new Map<string, number>();

describe("default flow end to end", () => {
  it("runs spec, tasks through tests/QA/bugbot, final checks and verification", async () => {
    qaRounds.clear();
    reviewRounds.clear();
    const runner = new ScriptedRunner(defaultScript);
    const commands = new FakeCommands((command, cwd, count) => (command === "make test" && cwd === "/wt/t1-0" && count === 1 ? 1 : 0));
    const { engine, events, workspace } = makeEngine({ runner, commands });
    const result = await engine.run();

    expect(result.status).toBe("succeeded");
    expect(workspace.merged).toEqual(["t1", "t2"]);
    expect(workspace.removed).toEqual(["/wt/t1-0", "/wt/t2-0"]);

    const modes = runner.calls.map((c) => `${c.mode}${c.task ? `:${c.task.id}` : ""}`);
    // t1: tests fail once (2 worker runs), QA rejects once (another worker run), bugbot fixes a format finding mechanically.
    expect(modes.filter((m) => m === "work:t1")).toHaveLength(3);
    expect(modes.filter((m) => m === "qa:t1")).toHaveLength(2);
    expect(modes.filter((m) => m === "review:t1")).toHaveLength(2);
    expect(modes.filter((m) => m === "work:t2")).toHaveLength(1);
    expect(modes[0]).toBe("spec");
    expect(modes.at(-1)).toBe("verify");

    // The worker's second attempt gets the failing tests as feedback; the third gets QA's missing criterion.
    const t1Work = runner.calls.filter((c) => c.mode === "work" && c.task?.id === "t1");
    expect(t1Work[1]!.context).toContain("FAIL make test");
    expect(t1Work[2]!.context).toContain("AC1: 404 retried");

    // The format finding was fixed by a command, without a QA round.
    const routed = events.filter((e) => e.type === "finding.routed");
    expect(routed.map((e) => (e as { status?: string }).status)).toEqual(["pending", "fixed"]);
    expect(commands.runs.some((r) => r.command === "make fmt FILES='src/t1.ts'")).toBe(true);

    // Tasks share no files but t2 depends on t1, so t2 waited.
    expect(events.some((e) => e.type === "task.waiting" && e.task === "t2")).toBe(true);
    // QA and the bugbot use a different model than the worker.
    const decisions = events.filter((e) => e.type === "router.decision");
    expect(decisions.find((d) => d.role === "worker")?.model).toBe("openrouter/deepseek");
    expect(decisions.find((d) => d.role === "qa")?.model).toBe("openrouter/gpt");

    const view = reduceEvents(events);
    expect(view.status).toBe("succeeded");
    expect(view.rows.some((r) => r.id === "task:t1" && r.status === "succeeded")).toBe(true);
    const metrics = computeMetrics(events);
    expect(metrics.byRole.worker!.calls).toBe(4);
    expect(metrics.findings.qaRoundsAvoided).toBe(1);
    expect(tokenSplit(metrics).principal).toBeGreaterThan(0);
  });

  it("answers directly when the principal does not start the orchestration", async () => {
    const runner = new ScriptedRunner(() => ({ submission: { tool: "answer", value: { text: "It lives in src/http.ts" } } }));
    const { engine } = makeEngine({ runner });
    const result = await engine.run();
    expect(result).toMatchObject({ status: "answered", answer: "It lives in src/http.ts" });
    expect(runner.calls).toHaveLength(1);
  });

  it("records the rate-limit headers an agent reports, per profile", async () => {
    const runner = new ScriptedRunner((input) => {
      input.models.reportRateLimits?.({ requestsRemaining: 7, tokensRemaining: 900 });
      return { submission: { tool: "answer", value: { text: "ok" } } };
    });
    const { engine, events } = makeEngine({ runner });
    await engine.run();
    const limits = events.find((e) => e.type === "provider.limits");
    expect(limits).toMatchObject({ requestsRemaining: 7, tokensRemaining: 900 });
    const metrics = computeMetrics(events);
    expect(Object.values(metrics.rateLimits)).toEqual([expect.objectContaining({ requestsRemaining: 7, tokensRemaining: 900 })]);
  });
});

describe("block instructions", () => {
  it("reach the agent of that block only, in its system prompt", async () => {
    qaRounds.clear();
    reviewRounds.clear();
    const flow = structuredClone(testHarness().flows.get("default")!.flow);
    walkBlocks(flow.steps, ({ block }) => {
      if (block.id === "code" && block.type === "agent") block.instructions = "Reuse the helpers in src/api/http.ts.";
    });
    const runner = new ScriptedRunner(defaultScript);
    const { engine } = makeEngine({ runner, options: { flow } });
    await engine.run();

    const work = runner.calls.filter((c) => c.mode === "work");
    expect(work.length).toBeGreaterThan(0);
    expect(work.every((c) => c.blockInstructions === "Reuse the helpers in src/api/http.ts.")).toBe(true);
    expect(runner.calls.filter((c) => c.mode !== "work").every((c) => c.blockInstructions === undefined)).toBe(true);

    const system = systemPromptFor(work[0]!);
    expect(system.indexOf(work[0]!.agent.prompt)).toBe(0);
    expect(system).toContain("# Instructions for this step\nReuse the helpers in src/api/http.ts.\n\n# Working rules");
    expect(systemPromptFor({ ...work[0]!, blockInstructions: "  " })).not.toContain("Instructions for this step");
  });
});

describe("retry policy", () => {
  const single = (extra: string) =>
    Flow.parse(parseYaml(`schema_version: 1\nname: single\nsteps:\n  - { id: code, type: agent, agent: worker${extra} }\n`).value) as Flow;
  const finish = { submission: { tool: "finish", value: { notes: "done" } } };

  it("retries a failed agent block with a growing wait and a fresh conversation", async () => {
    const runner = new ScriptedRunner((_input, call) => (call < 3 ? { status: "failed", error: `bad answer ${call}` } : finish));
    const { engine, events } = makeEngine({ runner, options: { flow: single(", retries: 2, retry_delay: 1s, retry_backoff: 2") } });
    const result = await engine.run();

    expect(result.status).toBe("succeeded");
    expect(runner.calls.map((c) => c.key)).toEqual(["code", "code#retry1", "code#retry2"]);
    const retrying = events.filter((e) => e.type === "step.retrying");
    expect(retrying.map((e) => [e.attempt, e.maxAttempts, e.delayMs, e.error])).toEqual([
      [2, 3, 1000, "bad answer 1"],
      [3, 3, 2000, "bad answer 2"],
    ]);
    expect(events.flatMap((e) => (e.type === "step.finished" && e.block === "code" ? [e.status] : []))).toEqual(["succeeded"]);
  });

  it("does not retry without a policy, and stops when the retries run out", async () => {
    const failing = () => new ScriptedRunner(() => ({ status: "failed", error: "bad answer" }));
    const none = failing();
    await makeEngine({ runner: none, options: { flow: single("") } }).engine.run();
    expect(none.calls).toHaveLength(1);

    const twice = failing();
    const { engine, events } = makeEngine({ runner: twice, options: { flow: single(", retries: 1") } });
    expect((await engine.run()).status).toBe("failed");
    expect(twice.calls).toHaveLength(2);
    expect(events.filter((e) => e.type === "step.retrying")).toHaveLength(1);
  });

  it("aborts a timed-out attempt before the retry starts", async () => {
    const runner = new ScriptedRunner(async (input, call) => {
      if (call > 1) return finish;
      await new Promise((resolve) => input.signal.addEventListener("abort", resolve, { once: true }));
      return { status: "failed", error: "Cancelled" };
    });
    const { engine, events } = makeEngine({ runner, options: { flow: single(", retries: 1, timeout: 50ms") } });
    expect((await engine.run()).status).toBe("succeeded");
    expect(runner.calls[0]!.signal.aborted).toBe(true);
    expect(events.find((e) => e.type === "step.retrying")).toMatchObject({ error: "Timed out after 50ms", attempt: 2 });
  });
});

describe("escalations", () => {
  it("pauses only the affected task, asks the human and restarts it with the decision", async () => {
    let escalated = false;
    const runner = new ScriptedRunner(async (input) => {
      if (input.mode === "spec") return { submission: { tool: "submit_spec", value: { tasks: [task("t1"), task("t2")], reopen: [] } } };
      if (input.mode === "triage") {
        return {
          submission: {
            tool: "submit_triage",
            value: { outcome: "ask_human", question: "Retry 409?", options: [{ label: "Retry 409 as transient", recommended: true }, { label: "Fail on 409" }] },
          },
        };
      }
      if (input.mode === "work" && input.task?.id === "t2" && !escalated) {
        escalated = true;
        const reply = await input.onEscalation({ type: "decision_gap", summary: "AC1 says no retry on 4xx but 409 is transient", evidence: [], blocks: ["AC1"], options_seen: [] });
        if (reply.kind === "abort") return { status: "aborted", error: reply.reason };
      }
      if (input.mode === "verify") return { submission: approve };
      if (input.mode === "qa") return { submission: { tool: "submit_qa", value: { results: [{ ac: "AC1", passed: true, evidence: "ok" }] } } };
      if (input.mode === "review") return { submission: { tool: "submit_findings", value: { findings: [] } } };
      return { submission: { tool: "finish", value: { notes: "" } } };
    });
    const human = new FakeHuman((_q, options) => options[0]!);
    const { engine, events, workspace } = makeEngine({ runner, human });
    const result = await engine.run();
    expect(result.status).toBe("succeeded");
    expect(human.questions).toEqual(["Retry 409?"]);
    expect(workspace.merged.sort()).toEqual(["t1", "t2"]);
    // t2 restarted with a new attempt and the decision in its notes.
    const restarted = runner.calls.filter((c) => c.mode === "work" && c.task?.id === "t2").at(-1)!;
    expect(restarted.key).toContain("t2@1");
    expect(restarted.task!.notes.join()).toContain("Decision D1: Retry 409 as transient");
    expect(engine.spec.version).toBe(2);
    expect(events.some((e) => e.type === "escalation.resolved" && e.decidedBy === "human")).toBe(true);
    expect(engine.escalations.decisions[0]).toMatchObject({ id: "D1", decided_by: "human", affects: ["AC1"] });
  });

  it("escalates automatically when a loop makes no progress", async () => {
    const runner = new ScriptedRunner((input) => {
      if (input.mode === "spec") return { submission: { tool: "submit_spec", value: { tasks: [task("t1")], reopen: [] } } };
      if (input.mode === "triage") return { submission: { tool: "submit_triage", value: { outcome: "ask_human", question: "Stuck", options: [{ label: "Stop this task" }, { label: "Keep trying" }] } } };
      if (input.mode === "verify") return { submission: { tool: "submit_verdict", value: { approved: false, notes: "t1 missing", reopen: [] } } };
      return { submission: { tool: "finish", value: { notes: "" } } };
    });
    const commands = new FakeCommands((command) => (command === "make test" ? 1 : 0));
    const human = new FakeHuman((_q, options) => (options.includes("Stop this task") ? "Stop this task" : options[1] ?? options[0]!));
    const { engine, events } = makeEngine({ runner, commands, human });
    const result = await engine.run();
    expect(result.status).toBe("failed");
    const raised = events.filter((e) => e.type === "escalation.raised");
    expect(raised[0]).toMatchObject({ escalation: { automatic: "no_progress", task: "t1" } });
    // Two identical failures in a row stop the test loop after two worker runs, not three.
    expect(runner.calls.filter((c) => c.mode === "work" && c.key.includes("delivery-loop#1/build/t1@0")).length).toBe(2);
  });
});

describe("per-task actions and user messages", () => {
  const waitForAbort = (signal: AbortSignal) => new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  const baseScript = (input: Parameters<Script>[0]) => {
    if (input.mode === "spec") return { submission: { tool: "submit_spec", value: { tasks: [task("t1"), task("t2", { depends_on: ["t1"] })], reopen: [] } } };
    if (input.mode === "verify") return { submission: approve };
    if (input.mode === "qa") return { submission: { tool: "submit_qa", value: { results: [{ ac: "AC1", passed: true, evidence: "ok" }] } } };
    if (input.mode === "review") return { submission: { tool: "submit_findings", value: { findings: [] } } };
    return { submission: { tool: "finish", value: { notes: "" } } };
  };

  it("skipping a stuck task lets its dependents continue", async () => {
    let engineRef: ReturnType<typeof makeEngine>["engine"] | undefined;
    const runner = new ScriptedRunner(async (input) => {
      if (input.mode === "work" && input.task?.id === "t1") {
        setTimeout(() => engineRef!.taskAction("t1", "skip"), 5);
        await waitForAbort(input.signal);
        return { status: "failed", error: "Cancelled" };
      }
      return baseScript(input);
    });
    const { engine, workspace, events } = makeEngine({ runner });
    engineRef = engine;
    const result = await engine.run();
    expect(result.status).toBe("succeeded");
    expect(workspace.merged).toEqual(["t2"]);
    expect(events.some((e) => e.type === "warning" && e.message.includes("t1 skipped"))).toBe(true);
  });

  it("a user message that changes requirements restarts only the affected task", async () => {
    let engineRef: ReturnType<typeof makeEngine>["engine"] | undefined;
    let steered = false;
    const runner = new ScriptedRunner(async (input) => {
      if (input.mode === "steer") {
        return { submission: { tool: "submit_steer", value: { action: "continue", reply: "Updating t1", reopen: [{ task: "t1", note: "also handle 404" }] } } };
      }
      if (input.mode === "work" && input.task?.id === "t1" && !steered) {
        steered = true;
        const aborted = waitForAbort(input.signal);
        await engineRef!.userMessage("Please also handle 404");
        await aborted;
        return { status: "failed", error: "Cancelled" };
      }
      return baseScript(input);
    });
    const { engine, workspace, events } = makeEngine({ runner });
    engineRef = engine;
    const result = await engine.run();
    expect(result.status).toBe("succeeded");
    expect(workspace.merged).toEqual(["t1", "t2"]);
    const retried = runner.calls.filter((c) => c.mode === "work" && c.task?.id === "t1").at(-1)!;
    expect(retried.key).toContain("t1@1");
    expect(retried.task!.notes).toContain("User: also handle 404");
    expect(events.some((e) => e.type === "message.assistant" && e.text === "Updating t1")).toBe(true);
  });
});

describe("review mode", () => {
  it("a rejected review sends the note back to the agent and asks again", async () => {
    const runner = new ScriptedRunner(() => ({ submission: { tool: "finish", value: { notes: "done" } } }));
    const human = new FakeHuman();
    let reviews = 0;
    human.review = async () => (++reviews === 1 ? { approved: false, note: "Use the existing logger" } : { approved: true });
    const { engine, events } = makeEngine({ runner, human, flow: "single-agent" });
    const result = await engine.run();
    expect(result.status).toBe("succeeded");
    expect(reviews).toBe(2);
    const solo = runner.calls.filter((c) => c.agent.name === "solo");
    expect(solo).toHaveLength(2);
    expect(solo[1]!.context).toContain("User review: Use the existing logger");
    expect(solo[1]!.key.startsWith("r2/")).toBe(true);
    expect(events.filter((e) => e.type === "approval.resolved").map((e) => e.approved)).toEqual([false, true]);
  });
});

describe("resume", () => {
  it("replays finished steps from the journal without running them again", async () => {
    qaRounds.clear();
    reviewRounds.clear();
    const journal = new MemoryJournal();
    let crash = true;
    let first: ReturnType<typeof makeEngine> | undefined;
    const crashing = new ScriptedRunner((input, call) => {
      if (crash && input.mode === "qa" && input.task?.id === "t2") {
        first!.engine.cancel("VS Code closed");
        throw new Error("VS Code closed");
      }
      return defaultScript(input, call);
    });
    first = makeEngine({ runner: crashing, journal });
    const interrupted = await first.engine.run();
    expect(interrupted.status).toBe("cancelled");
    const firstCalls = crashing.calls.length;

    crash = false;
    const resumed = new ScriptedRunner(defaultScript);
    const second = makeEngine({ runner: resumed, journal });
    const result = await second.engine.run();
    expect(result.status).toBe("succeeded");
    // Only t2's QA onwards runs again; the spec and t1 come from the journal.
    expect(resumed.calls.some((c) => c.mode === "spec")).toBe(false);
    expect(resumed.calls.some((c) => c.task?.id === "t1")).toBe(false);
    expect(resumed.calls.length).toBeLessThan(firstCalls);
    expect(second.workspace.merged).toEqual(["t2"]);
  });
});
