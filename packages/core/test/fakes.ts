import {
  CommandGate,
  FlowEngine,
  MemoryJournal,
  RouterService,
  buildCatalog,
  loadHarness,
  mergeSources,
  presetSources,
  resolveLimits,
  type AgentRunInput,
  type AgentRunResult,
  type AgentRunner,
  type Clock,
  type CommandRunner,
  type EngineOptions,
  type FileAccess,
  type HarnessEvent,
  type HarnessEventBody,
  type HumanPort,
  type Journal,
  type Workspace,
} from "../src/index.ts";

export const TEST_CONFIG = `schema_version: 1
commands:
  test: make test
  typecheck: make typecheck
providers:
  - { id: anthropic, type: anthropic, profiles: [{ label: Personal, secret: a }] }
  - { id: openrouter, type: openrouter, profiles: [{ label: Personal, secret: o }] }
models:
  - { ref: anthropic/claude, label: Claude, roles: [orchestrator] }
  - { ref: openrouter/anthropic/claude, label: Claude OR, roles: [orchestrator-fallback] }
  - { ref: openrouter/deepseek, label: DeepSeek, roles: [worker] }
  - { ref: openrouter/gpt, label: GPT, roles: [qa, reviewer] }
findings_routing:
  - name: Auto-fixable format
    when: { category: [format], autofix: true }
    route: command_fix
    fix: "make fmt FILES='{{finding.files}}'"
    verify: "make lint"
  - default:
      route: worker_then_qa
`;

export function testHarness(extraConfig = "") {
  const sources = mergeSources(presetSources(), {
    configs: [{ layer: "project", path: "/repo/.harness/config.yml", text: TEST_CONFIG + extraConfig }],
    agents: [],
    workflows: [],
    subflows: [],
    decisions: [],
  });
  return loadHarness(sources);
}

export type Script = (input: AgentRunInput, call: number) => Partial<AgentRunResult> | Promise<Partial<AgentRunResult>>;

export class ScriptedRunner implements AgentRunner {
  readonly calls: AgentRunInput[] = [];
  constructor(private readonly script: Script) {}
  async run(input: AgentRunInput): Promise<AgentRunResult> {
    this.calls.push(input);
    const link = input.models.current();
    input.models.recordUsage({ input: 100, output: 50 });
    const partial = await this.script(input, this.calls.length);
    return {
      status: "completed",
      text: "",
      usage: { input: 100, output: 50, cached: 0 },
      filesChanged: [],
      ...(link ? { model: link.ref } : {}),
      ...partial,
    };
  }
}

export class FakeWorkspace implements Workspace {
  readonly merged: string[] = [];
  readonly removed: string[] = [];
  diffs = new Map<string, string>();
  fixDiff = "--- a/src/t1.ts\n+++ b/src/t1.ts\n@@ -5,1 +5,1 @@\n-x\n+y\n";
  async startSession(id: string) {
    return { path: "/session", branch: `harness/${id}`, baseCommit: "base" };
  }
  async createTaskWorktree(_s: string, task: string, attempt: number) {
    return { path: `/wt/${task}-${attempt}`, branch: `harness/s/${task}`, created: true };
  }
  async diff(path: string) {
    return this.diffs.get(path) ?? `--- a/src/file.ts\n+++ b/src/file.ts\n@@ -1,1 +1,1 @@\n-old ${path}\n+new ${path}\n`;
  }
  async changedFiles() {
    return ["src/file.ts"];
  }
  async checkpoint() {
    return "cp";
  }
  async diffSince() {
    return this.fixDiff;
  }
  async restoreOthers() {}
  async commitAndMerge(_s: string, _p: string, task: string) {
    this.merged.push(task);
    return { ok: true as const, commit: `c-${task}` };
  }
  async removeTaskWorktree(path: string) {
    this.removed.push(path);
  }
  async sessionDiff() {
    return `--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-a\n+b\n`;
  }
  async workingTreeDiff() {
    return this.sessionDiff();
  }
}

export class FakeCommands implements CommandRunner {
  readonly runs: { command: string; cwd: string }[] = [];
  constructor(private readonly exitCode: (command: string, cwd: string, count: number) => number = () => 0) {}
  async run(input: { command: string; cwd: string }) {
    this.runs.push(input);
    const count = this.runs.filter((r) => r.command === input.command && r.cwd === input.cwd).length;
    const exitCode = this.exitCode(input.command, input.cwd, count);
    return { exitCode, output: exitCode ? `FAIL ${input.command}` : "ok", timedOut: false, durationMs: 5 };
  }
}

export const memoryFiles: FileAccess = {
  read: async () => undefined,
  remove: async () => undefined,
  join: (...parts) => parts.join("/"),
};

export class FakeHuman implements HumanPort {
  readonly questions: string[] = [];
  constructor(private readonly answer: (question: string, options: string[]) => string = (_q, o) => o[0] ?? "") {}
  async ask(question: { question: string; options: { label: string }[] }) {
    this.questions.push(question.question);
    return this.answer(question.question, question.options.map((o) => o.label));
  }
  async review() {
    return { approved: true };
  }
  async confirmCommand(_request?: unknown) {
    return "allow_always" as const;
  }
}

export const fixedClock = (): Clock => {
  let now = 1_000_000;
  return { now: () => (now += 10), sleep: async (ms) => void (now += ms) };
};

export interface EngineSetup {
  runner: ScriptedRunner;
  workspace?: FakeWorkspace;
  commands?: FakeCommands;
  human?: FakeHuman;
  journal?: Journal;
  flow?: string;
  options?: Partial<EngineOptions>;
  extraConfig?: string;
}

export function makeEngine(setup: EngineSetup) {
  const harness = testHarness(setup.extraConfig);
  const errors = harness.issues.filter((i) => i.severity === "error");
  if (errors.length) throw new Error(JSON.stringify(errors));
  const events: HarnessEvent[] = [];
  let seq = 0;
  const clock = fixedClock();
  const sink = { emit: (event: HarnessEventBody) => void events.push({ ...event, seq: ++seq, ts: clock.now(), session: "s1" } as HarnessEvent) };
  const human = setup.human ?? new FakeHuman();
  const workspace = setup.workspace ?? new FakeWorkspace();
  const commands = setup.commands ?? new FakeCommands();
  const journal = setup.journal ?? new MemoryJournal();
  const router = new RouterService(harness.config, buildCatalog(harness.config), resolveLimits(harness.config.limits), {}, clock);
  const allow = new Set<string>();
  const engine = new FlowEngine(
    {
      sessionId: "s1",
      message: "Add retry to fetchOrders",
      flow: harness.flows.get(setup.flow ?? "default")!.flow,
      config: harness.config,
      agents: harness.agents,
      ...setup.options,
    },
    {
      router,
      runner: setup.runner,
      commands,
      files: memoryFiles,
      workspace,
      human,
      gate: new CommandGate({
        trusted: true,
        destructivePatterns: harness.config.security?.destructive_patterns ?? [],
        allowlist: { has: async (c) => allow.has(c), add: async (c) => void allow.add(c) },
        approver: { confirm: (r) => human.confirmCommand(r) },
      }),
      journal,
      events: sink,
      clock,
    },
  );
  return { engine, events, workspace, commands, human, journal, harness };
}

export function task(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    goal: `Goal of ${id}`,
    kind: "tests",
    edit: [`src/${id}.ts`, `src/${id}.test.ts`],
    acceptance_criteria: [{ id: "AC1", text: "works", verify: "test" }],
    test_plan: [{ covers: ["AC1"], test: `${id}.test.ts > works` }],
    acceptance: [`npm test -- ${id}`],
    ...extra,
  };
}
