import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Flow } from "@delamain/core";
import type { Log } from "../src/log.ts";
import type { Secrets } from "../src/secrets.ts";

interface FakeWatcher {
  base: string;
  disposed: boolean;
}

const env = vi.hoisted(() => ({
  globalDir: "",
  workspace: undefined as string | undefined,
  watchers: [] as FakeWatcher[],
  onConfiguration: undefined as ((e: { affectsConfiguration(section: string): boolean }) => void) | undefined,
}));

vi.mock("vscode", () => {
  class EventEmitter {
    private readonly listeners: (() => void)[] = [];
    readonly event = (listener: () => void) => {
      this.listeners.push(listener);
      return { dispose() {} };
    };
    fire() {
      for (const listener of this.listeners) listener();
    }
    dispose() {}
  }
  return {
    EventEmitter,
    Uri: { file: (fsPath: string) => ({ fsPath }) },
    RelativePattern: class {
      constructor(
        readonly base: { fsPath?: string; uri?: { fsPath: string } },
        readonly pattern: string,
      ) {}
    },
    workspace: {
      getConfiguration: () => ({ get: () => env.globalDir }),
      get workspaceFolders() {
        return env.workspace ? [{ uri: { fsPath: env.workspace } }] : undefined;
      },
      isTrusted: true,
      createFileSystemWatcher: (pattern: { base: { fsPath?: string; uri?: { fsPath: string } } }) => {
        const watcher = { base: pattern.base.fsPath ?? pattern.base.uri!.fsPath, disposed: false };
        env.watchers.push(watcher);
        const listen = () => ({ dispose() {} });
        return { onDidChange: listen, onDidCreate: listen, onDidDelete: listen, dispose: () => (watcher.disposed = true) };
      },
      onDidChangeConfiguration: (listener: NonNullable<typeof env.onConfiguration>) => {
        env.onConfiguration = listener;
        return { dispose() {} };
      },
    },
  };
});

const { HarnessService } = await import("../src/harness-service.ts");

const secrets = { onDidChange: () => ({ dispose() {} }), has: async () => false, get: async () => undefined } as unknown as Secrets;
const log = { info() {}, warn() {}, error() {} } as unknown as Log;

const flowYaml = (name: string, run = "make build") => `schema_version: 1\nname: ${name}\nsteps:\n  - id: build\n    type: command\n    run: ${run}\n`;
const flow = (name: string, run: string): Flow => ({ schema_version: 1, name, steps: [{ id: "build", type: "command", run }] }) as Flow;

let root: string;
let service: InstanceType<typeof HarnessService>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "harness-service-"));
  env.globalDir = join(root, "global");
  env.workspace = undefined;
  await mkdir(join(env.globalDir, "workflows"), { recursive: true });
  service = new HarnessService(secrets, log);
});

afterEach(async () => {
  service.dispose();
  await rm(root, { recursive: true, force: true });
});

const workflows = () => readdir(join(env.globalDir, "workflows"));

describe("HarnessService flows", () => {
  it("edits a hand-written flow in its own file instead of creating a second one", async () => {
    await writeFile(join(env.globalDir, "workflows", "release.yml"), flowYaml("Release Flow"));
    await service.reload();
    const saved = await service.saveFlow("global", "Release Flow", flow("Release Flow", "make release"));
    expect(saved.ok).toBe(true);
    expect(await workflows()).toEqual(["release.yml"]);
    const step = service.resolved.flows.get("Release Flow")!.flow.steps[0] as { run: string };
    expect(step.run).toBe("make release");
  });

  it("renames from the real file and refuses a name the layer already has", async () => {
    await writeFile(join(env.globalDir, "workflows", "release.yml"), flowYaml("Release Flow"));
    await writeFile(join(env.globalDir, "workflows", "hotfix.yml"), flowYaml("hotfix"));
    await service.reload();

    const taken = await service.saveFlow("global", "hotfix", flow("hotfix", "make release"), "Release Flow");
    expect(taken.ok).toBe(false);
    expect(taken.issues[0]!.message).toContain('already has a flow named "hotfix"');

    expect((await service.saveFlow("global", "Ship", flow("Ship", "make ship"), "Release Flow")).ok).toBe(true);
    expect((await workflows()).sort()).toEqual(["hotfix.yml", "ship.yml"]);
    expect(service.resolved.flows.has("Release Flow")).toBe(false);
  });

  it("reuses flows marked reusable, but refuses unmarked ones and circles", async () => {
    await writeFile(join(env.globalDir, "workflows", "ping.yml"), "schema_version: 1\nname: ping\nreusable: true\nsteps:\n  - { id: run, type: subflow, flow: pong }\n");
    await service.reload();
    expect(service.snapshot().subflows.map((s) => s.ref)).toEqual(["flows/verify.yml"]);

    const pong = (target: string) => ({ schema_version: 1, name: "pong", reusable: true, steps: [{ id: "run", type: "subflow", flow: target }] }) as Flow;
    const circle = await service.saveFlow("global", "pong", pong("ping"));
    expect(circle.ok).toBe(false);
    expect(circle.issues.map((i) => i.message)).toContain("Flows reuse each other in a circle and would never finish: pong → ping → pong");

    const unmarked = await service.saveFlow("global", "pong", pong("single-agent"));
    expect(unmarked.issues.map((i) => i.message)).toContain('"single-agent" is not marked as reusable');

    expect((await service.saveFlow("global", "pong", pong("flows/verify.yml"))).ok).toBe(true);
    expect(service.resolved.flows.has("ping")).toBe(true);
  });

  it("deletes a flow that only exists as invalid", async () => {
    const cycle = "schema_version: 1\nname: broken\nsteps:\n  - { id: a, type: command, run: echo a, after: [b] }\n  - { id: b, type: command, run: echo b, after: [a] }\n";
    await writeFile(join(env.globalDir, "workflows", "broken.yml"), cycle);
    await service.reload();
    expect(service.resolved.invalidFlows.has("broken")).toBe(true);

    await service.deleteFlow("global", "broken");
    expect(await workflows()).toEqual([]);
    expect(service.resolved.invalidFlows.has("broken")).toBe(false);
  });
});

describe("HarnessService configuration", () => {
  it("saves the global layer despite an error that already existed in the project", async () => {
    env.workspace = join(root, "repo");
    await mkdir(join(env.workspace, ".harness"), { recursive: true });
    await writeFile(join(env.workspace, ".harness", "config.yml"), "schema_version: 1\nproviders:\n  - { id: lan, type: openai-compatible }\n");
    await service.reload();

    const global = await service.saveConfig("global", { limits: { worst_case_warning: 40 } });
    expect(global.ok).toBe(true);
    expect(service.resolved.config.limits?.worst_case_warning).toBe(40);

    const project = await service.saveConfig("project", service.layerConfig("project")!);
    expect(project.ok).toBe(false);
    expect(project.issues.map((i) => i.message)).toContain("openai-compatible providers need a base_url");
  });

  it("moves the global watcher when the global directory setting changes", async () => {
    env.watchers = [];
    service.watch();
    const first = env.watchers.find((w) => w.base === env.globalDir)!;
    expect(first).toBeDefined();

    env.globalDir = join(root, "elsewhere");
    env.onConfiguration!({ affectsConfiguration: (section) => section === "harness.globalDirectory" });
    expect(first.disposed).toBe(true);
    expect(env.watchers.some((w) => w.base === env.globalDir && !w.disposed)).toBe(true);
    await service.reload();
  });

  it("lists the profiles the router must skip and restores catalogs saved in an earlier session", async () => {
    const stored = new Map<string, unknown>([["harness.catalogs", { "openrouter|https://openrouter.ai/api/v1": [{ id: "deepseek/deepseek-chat", contextWindow: 64000 }] }]]);
    const cache = { get: <T>(key: string) => stored.get(key) as T | undefined, update: async (key: string, value: unknown) => void stored.set(key, value) };
    const cached = new HarnessService(secrets, log, cache);
    writeFileSync(
      join(env.globalDir, "config.yml"),
      [
        "schema_version: 1",
        "providers:",
        "  - { id: anthropic, type: anthropic }",
        "  - { id: openrouter, type: openrouter, profiles: [{ label: Personal, secret: or.p }] }",
        "  - { id: jan, type: openai-compatible, base_url: 'http://localhost:1337/v1', local: true }",
      ].join("\n"),
    );
    await cached.reload();
    expect([...cached.credentialProblems()]).toEqual([
      ["anthropic", "no credential profile"],
      ["openrouter@Personal", "no API key stored"],
    ]);
    expect(cached.catalogs.openrouter).toEqual([{ id: "deepseek/deepseek-chat", contextWindow: 64000 }]);
    cached.dispose();
  });

  it("a reload requested while another runs reads the files written in between", async () => {
    await service.reload();
    const running = service.reload();
    writeFileSync(join(env.globalDir, "config.yml"), "schema_version: 1\nlimits: { worst_case_warning: 77 }\n");
    await service.reload();
    await running;
    expect(service.resolved.config.limits?.worst_case_warning).toBe(77);
  });
});
