import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CommandGate,
  FlowEngine,
  RouterService,
  ToolLoopRunner,
  buildCatalog,
  loadHarness,
  mergeSources,
  presetSources,
  resolveLimits,
  systemClock,
  type ChatEvent,
  type ChatRequest,
  type HarnessEvent,
  type ProviderAdapter,
} from "@delamain/core";
import { GitWorkspace, NodeCommandRunner, NodeToolHost, SessionStore, nodeFileAccess } from "../src/index.ts";
import { tempRepo } from "./helpers.ts";

/** Plays each role by looking at the submit tool it was given; no network involved. */
class ScriptedModel implements ProviderAdapter {
  readonly id = "fake";
  readonly type = "openai-compatible" as const;
  async listModels() {
    return [{ id: "scripted", toolCalling: true }];
  }
  async healthCheck() {
    return { status: "online" as const };
  }
  async *stream(request: ChatRequest): AsyncIterable<ChatEvent> {
    const tools = new Set((request.tools ?? []).map((t) => t.name));
    const last = request.messages.at(-1);
    const call = (name: string, args: unknown, id = name): ChatEvent => ({ type: "tool_call", id, name, args });
    yield { type: "usage", input: 500, output: 100 };
    if (tools.has("submit_spec")) {
      yield call("submit_spec", {
        summary: "Add a sum helper",
        tasks: [
          {
            id: "t1",
            goal: "Add sum(a, b)",
            kind: "small-edit",
            edit: ["src/sum.js", "test/sum.test.js"],
            acceptance_criteria: [{ id: "AC1", text: "sum adds two numbers", verify: "test" }],
            test_plan: [{ covers: ["AC1"], test: "test/sum.test.js > adds" }],
            acceptance: ["node test/sum.test.js"],
          },
        ],
      });
    } else if (tools.has("finish")) {
      if (last?.role === "tool") {
        yield call("finish", { notes: "Implemented sum and its test" });
      } else {
        yield call("write_file", { path: "src/sum.js", content: "exports.sum = (a, b) => a + b;\n" }, "w1");
        yield call("write_file", { path: "test/sum.test.js", content: "const { sum } = require('../src/sum.js');\nif (sum(2, 3) !== 5) { console.error('adds: expected 5'); process.exit(1); }\nconsole.log('ok');\n" }, "w2");
        yield call("write_file", { path: "README.md", content: "outside the edit list" }, "w3");
      }
    } else if (tools.has("submit_qa")) {
      yield call("submit_qa", { results: [{ ac: "AC1", passed: true, evidence: "node test/sum.test.js passes" }] });
    } else if (tools.has("submit_findings")) {
      yield call("submit_findings", { findings: [] });
    } else if (tools.has("submit_verdict")) {
      yield call("submit_verdict", { approved: true, notes: "Looks right" });
    }
    yield { type: "done" };
  }
}

describe("default flow in a real repository", () => {
  it("plans, codes in a worktree, verifies with real commands and leaves the result on the session branch", async () => {
    const repo = tempRepo({ "package.json": '{"name":"demo"}\n', "README.md": "demo\n" });
    const storage = mkdtempSync(join(tmpdir(), "harness-e2e-"));
    const harness = loadHarness(
      mergeSources(presetSources(), {
        configs: [
          {
            layer: "project",
            path: join(repo, ".harness/config.yml"),
            text: `schema_version: 1
commands:
  test: node test/sum.test.js
  typecheck: 'node -e "process.exit(0)"'
providers:
  - { id: fake, type: openai-compatible, base_url: "http://localhost:9/v1", local: true, max_concurrent: 2 }
models:
  - { ref: fake/scripted, label: Scripted, roles: [orchestrator, worker, qa, reviewer], tool_calling: true }
router:
  default: { use: fake/scripted, fallback: [role:worker] }
`,
          },
        ],
        agents: [],
        workflows: [],
        subflows: [],
        decisions: [],
      }),
    );
    expect(harness.issues.filter((i) => i.severity === "error")).toEqual([]);
    const store = new SessionStore(storage, "e2e");
    const events: HarnessEvent[] = [];
    const workspace = new GitWorkspace(repo, storage);
    const runner = new ToolLoopRunner({ get: async () => new ScriptedModel() }, new NodeToolHost(), store, systemClock);
    const allow = new Set<string>();
    const engine = new FlowEngine(
      { sessionId: "e2e", message: "Add a sum helper with a test", flow: harness.flows.get("default")!.flow, config: harness.config, agents: harness.agents },
      {
        router: new RouterService(harness.config, buildCatalog(harness.config), resolveLimits(harness.config.limits), {}),
        runner,
        commands: new NodeCommandRunner(),
        files: nodeFileAccess,
        workspace,
        human: { ask: async () => "", review: async () => ({ approved: true }), confirmCommand: async () => "allow_always" },
        gate: new CommandGate({ trusted: true, destructivePatterns: [], allowlist: { has: async (c) => allow.has(c), add: async (c) => void allow.add(c) }, approver: { confirm: async () => "allow_always" } }),
        journal: store,
        events: { emit: (e) => void events.push(store.appendEvent(e)) },
        clock: systemClock,
      },
    );
    const result = await engine.run();
    expect(result.status, JSON.stringify(events.filter((e) => e.type === "step.finished" && e.status === "failed"))).toBe("succeeded");

    const sessionPath = result.worktree!;
    expect(readFileSync(join(sessionPath, "src/sum.js"), "utf8")).toContain("a + b");
    expect(readFileSync(join(sessionPath, "README.md"), "utf8")).toBe("demo\n");
    expect(existsSync(join(repo, "src/sum.js"))).toBe(false);
    expect(result.diff).toContain("+exports.sum");
    expect(allow.has("node test/sum.test.js")).toBe(true);

    const rejected = events.find((e) => e.type === "agent.tool" && e.summary === "write_file failed");
    expect(rejected).toBeDefined();
    expect(events.some((e) => e.type === "task.finished" && e.task === "t1")).toBe(true);
    expect(store.readEvents().length).toBe(events.length);
    await store.close();
    expect(existsSync(join(store.dir, "events.jsonl.gz"))).toBe(true);
    await workspace.cleanupSession("e2e", true);
  }, 60_000);
});
