import { describe, expect, it } from "vitest";
import {
  EngineCursor,
  MemoryJournal,
  RouterService,
  ToolLoopRunner,
  buildCatalog,
  resolveLimits,
  type AgentRunInput,
  type ChatEvent,
  type ChatRequest,
  type HarnessConfig,
  type HarnessEventBody,
  type ModelCursor,
  type ProviderAdapter,
  type RouteRequest,
  type ToolHost,
} from "../src/index.ts";

type Script = (request: ChatRequest) => ChatEvent[];

class FakeAdapter implements ProviderAdapter {
  readonly type = "openai-compatible" as const;
  readonly requests: ChatRequest[] = [];
  constructor(
    readonly id: string,
    private readonly script: Script,
  ) {}
  async listModels() {
    return [];
  }
  async healthCheck() {
    return { status: "online" as const };
  }
  async *stream(request: ChatRequest): AsyncIterable<ChatEvent> {
    this.requests.push(request);
    await new Promise((resolve) => setTimeout(resolve, 2));
    yield* this.script(request);
  }
}

const answer: Script = () => [{ type: "text", delta: "done" }, { type: "done" }];
const fail = (kind: "auth" | "not_found" | "unavailable"): Script => () => [{ type: "error", kind, message: kind }];

const host: ToolHost = { readFile: async () => undefined, writeFile: async () => undefined, listFiles: async () => [], search: async () => [] };
const request: RouteRequest = { role: "worker", est_tokens: 1000, files: 1, paths: [], needs_tools: true };

const cloud: HarnessConfig = {
  providers: [
    { id: "anthropic", type: "anthropic", profiles: [{ label: "Personal", secret: "a.p" }, { label: "Work", secret: "a.w" }] },
    { id: "openrouter", type: "openrouter", profiles: [{ label: "Personal", secret: "or.p" }] },
  ],
  models: [
    { ref: "anthropic/claude", roles: ["worker"], max_output_tokens: 1234 },
    { ref: "anthropic/claude@Work", roles: ["worker"] },
    { ref: "openrouter/anthropic/claude", roles: ["worker"] },
  ],
  router: { default: { use: "role:worker", fallback: ["openrouter/anthropic/claude"] } },
};

function setup(config: HarnessConfig, adapters: Record<string, FakeAdapter>) {
  const clock = { t: 1_000_000, now: () => clock.t, sleep: async () => undefined };
  const router = new RouterService(config, buildCatalog(config), resolveLimits(undefined), {}, clock);
  const events: HarnessEventBody[] = [];
  const runner = new ToolLoopRunner({ get: async (provider, profile) => adapters[`${provider}@${profile ?? ""}`] }, host, new MemoryJournal(), clock);
  const cursor = (key: string) => new EngineCursor({ router, events: { emit: (e) => void events.push(e) } }, "worker", router.route(request), request, key);
  return { clock, router, events, runner, cursor };
}

function input(models: ModelCursor, key: string): AgentRunInput {
  return {
    key,
    agent: { name: "worker", role: "worker", tools: ["read"], edit_scope: "none", prompt: "You work." },
    mode: "work",
    cwd: "/repo",
    editScope: [],
    instructions: key,
    context: "",
    submit: [],
    requireSubmit: false,
    models,
    maxTurns: 5,
    signal: new AbortController().signal,
    onEscalation: async () => ({ kind: "continue", message: "" }),
    runCommand: async () => ({ ok: true, output: "" }),
    onText: () => undefined,
    onTool: () => undefined,
  };
}

describe("tool loop runner on provider failures", () => {
  it("a rejected key moves to the same model on another profile and tells the user", async () => {
    const personal = new FakeAdapter("anthropic", fail("auth"));
    const work = new FakeAdapter("anthropic", answer);
    const { runner, router, events, cursor } = setup(cloud, { "anthropic@Personal": personal, "anthropic@Work": work });
    const result = await runner.run(input(cursor("k"), "k"));
    expect(result).toMatchObject({ status: "completed", model: "anthropic/claude@Work" });
    expect(router.credentialProblems.get("anthropic@Personal")).toBe("authentication failed");
    expect(events.some((e) => e.type === "warning" && e.message.includes("anthropic@Personal rejected its API key"))).toBe(true);
    expect(personal.requests[0]?.maxOutputTokens).toBe(1234);
  });

  it("a 404 skips that model under every profile but keeps the provider", async () => {
    const { runner, router, cursor } = setup(cloud, {
      "anthropic@Personal": new FakeAdapter("anthropic", fail("not_found")),
      "anthropic@Work": new FakeAdapter("anthropic", answer),
      "openrouter@Personal": new FakeAdapter("openrouter", answer),
    });
    const result = await runner.run(input(cursor("k"), "k"));
    expect(result.model).toBe("openrouter/anthropic/claude");
    expect(router.missingModels.has("anthropic/claude")).toBe(true);
    expect(router.health.anthropic).toBeUndefined();
  });

  it("an outage takes the provider out only until its cooldown ends", async () => {
    const { runner, router, clock, cursor } = setup(cloud, {
      "anthropic@Personal": new FakeAdapter("anthropic", fail("unavailable")),
      "openrouter@Personal": new FakeAdapter("openrouter", answer),
    });
    expect((await runner.run(input(cursor("k"), "k"))).model).toBe("openrouter/anthropic/claude");
    expect(router.route(request).chosen?.ref).toBe("openrouter/anthropic/claude");
    clock.t += 61_000;
    expect(router.route(request).chosen?.ref).toBe("anthropic/claude");
  });

  it("keeps a local server's only slot for a whole conversation", async () => {
    const local: HarnessConfig = {
      providers: [{ id: "jan", type: "openai-compatible", base_url: "http://localhost:1337/v1", local: true }],
      models: [{ ref: "jan/qwen", roles: ["worker"], tool_calling: true }],
      router: { default: { use: "role:worker", fallback: ["jan/qwen"] } },
    };
    const order: string[] = [];
    const jan = new FakeAdapter("jan", (req) => {
      const conversation = String(req.messages[0]!.content);
      const first = req.messages.at(-1)?.role === "user";
      order.push(`${conversation}:${first ? 1 : 2}`);
      return first ? [{ type: "tool_call", id: `${conversation}-1`, name: "list_files", args: {} }, { type: "done" }] : answer(req);
    });
    const { runner, cursor } = setup(local, { "jan@": jan });
    await Promise.all([runner.run(input(cursor("a"), "a")), runner.run(input(cursor("b"), "b"))]);
    expect(order).toEqual(["a:1", "a:2", "b:1", "b:2"]);
  });
});
