import { randomBytes } from "node:crypto";
import { join } from "node:path";
import * as vscode from "vscode";
import {
  GitWorkspace,
  NodeCommandRunner,
  NodeToolHost,
  SessionStore,
  appendDecision,
  listSessions,
  nodeFileAccess,
  toSummary,
  type SessionMeta,
} from "@delamain/adapters";
import {
  CommandGate,
  FlowEngine,
  RouterService,
  ToolLoopRunner,
  buildCatalog,
  computeMetrics,
  harnessLibrary,
  resolveLimits,
  systemClock,
  type ChatSettings,
  type HarnessEvent,
  type HarnessEventBody,
  type SessionResult,
  type SessionSummary,
  type TaskAction,
} from "@delamain/core";
import type { HarnessService } from "./harness-service.ts";
import { WorkspaceAllowlist, type ChatHuman } from "./human.ts";
import type { Log } from "./log.ts";
import type { WebviewHub } from "./webviews.ts";

interface Turn {
  message: string;
  outcome: string;
  session: string;
}

interface Conversation {
  settings: ChatSettings;
  turns: Turn[];
}

interface Running {
  engine: FlowEngine;
  router: RouterService;
  /** The harness's `secretsVersion` when credential problems were last copied to the router. */
  secretsVersion: number;
  store: SessionStore;
  meta: SessionMeta;
  workspace: GitWorkspace;
  events: HarnessEvent[];
}

export interface SessionStatus {
  running: boolean;
  flow: string;
  tokens: number;
  costUsd: number;
  /** Some usage came from models without pricing, so `costUsd` is a lower bound. */
  costUnknown: boolean;
}

function newSessionId(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${stamp}-${randomBytes(2).toString("hex")}`;
}

/** Runs one orchestration session at a time per workspace, and resumes interrupted ones. */
export class SessionManager implements vscode.Disposable {
  private running: Running | undefined;
  private last: { meta: SessionMeta; result: SessionResult; workspace: GitWorkspace; events: HarnessEvent[] } | undefined;
  private pendingEvents: HarnessEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private closing = false;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly harnessListener: vscode.Disposable;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly harness: HarnessService,
    private readonly hub: WebviewHub,
    private readonly human: ChatHuman,
    private readonly log: Log,
  ) {
    this.harnessListener = harness.onDidChange(() => {
      if (this.running?.router) this.syncRouter(this.running, false);
    });
  }

  /**
   * Copies what the harness knows about providers into the session's router. Discovery keeps
   * refreshing local servers during a session, so their health follows it; cloud health only
   * comes from connection tests and is taken once, at the start. A key stored mid-session makes
   * its profile usable again.
   */
  private syncRouter(running: Running, initial: boolean): void {
    const { router } = running;
    router.unavailableModels.clear();
    for (const ref of this.harness.unavailableModels) router.unavailableModels.add(ref);
    const local = new Set((this.harness.resolved.config.providers ?? []).filter((p) => p.local).map((p) => p.id));
    const now = Date.now();
    for (const [provider, health] of Object.entries(this.harness.health)) {
      if (!initial && !local.has(provider)) continue;
      if (health.status === "offline") router.markOffline(provider);
      else if (health.status === "rate_limited" && health.untilMs > now) router.markRateLimited(provider, health.untilMs - now);
      else if (health.status === "online" && router.health[provider]?.status === "offline") router.markOnline(provider);
    }
    if (running.secretsVersion !== this.harness.secretsVersion) {
      router.credentialProblems.clear();
      running.secretsVersion = this.harness.secretsVersion;
    }
    for (const [key, reason] of this.harness.credentialProblems()) router.markCredentialProblem(key, reason);
  }

  private get storage(): string {
    return (this.context.storageUri ?? this.context.globalStorageUri).fsPath;
  }

  get conversation(): Conversation {
    const fallback: Conversation = {
      settings: { flow: this.harness.resolved.config.defaults?.flow ?? "default", approval: this.harness.resolved.config.defaults?.approval ?? "auto" },
      turns: [],
    };
    return this.context.workspaceState.get<Conversation>("harness.conversation", fallback);
  }

  private async saveConversation(conversation: Conversation): Promise<void> {
    await this.context.workspaceState.update("harness.conversation", conversation);
  }

  async updateSettings(settings: ChatSettings): Promise<void> {
    await this.saveConversation({ ...this.conversation, settings });
    this.changed.fire();
  }

  async newChat(): Promise<void> {
    if (this.running) throw new Error("Stop the running session first.");
    await this.saveConversation({ settings: this.conversation.settings, turns: [] });
    this.last = undefined;
    this.hub.postChat({ type: "chat.reset" });
    this.hub.postChat({ type: "events", events: [], reset: true });
  }

  status(): SessionStatus {
    const events = this.running?.events ?? this.last?.events ?? [];
    let tokens = 0;
    let costUsd = 0;
    let costUnknown = false;
    for (const e of events) {
      if (e.type === "usage") {
        tokens += e.input + e.output;
        costUsd += e.costUsd ?? 0;
        if (e.costUsd === undefined) costUnknown = true;
      }
    }
    return { running: this.running !== undefined, flow: this.running?.meta.flow ?? this.conversation.settings.flow, tokens, costUsd, costUnknown };
  }

  /** What a webview that just loaded needs to show the current state. */
  async replayTo(): Promise<void> {
    const current = this.running ?? this.last;
    if (current) this.hub.postChat({ type: "events", events: current.events, reset: true });
    if (this.last && !this.running) this.postResult(this.last.result, this.last.workspace, this.last.meta);
    this.hub.postChat({ type: "status", running: this.running !== undefined });
    this.hub.postChat({ type: "sessions", resumable: await this.resumable() });
  }

  async resumable(): Promise<SessionSummary[]> {
    const sessions = await listSessions(this.storage);
    return sessions.filter((s) => s.status === "running" && s.id !== this.running?.meta.id).map(toSummary);
  }

  async start(message: string, settings: ChatSettings): Promise<void> {
    if (this.running) {
      await this.running.engine.userMessage(message);
      return;
    }
    await this.updateSettings(settings);
    const meta: SessionMeta = {
      id: newSessionId(),
      message,
      flow: settings.flow,
      startedAt: Date.now(),
      status: "running",
      settings,
    };
    await this.run(meta, false);
  }

  async resume(id: string): Promise<void> {
    if (this.running) throw new Error("A session is already running.");
    const store = new SessionStore(this.storage, id);
    const meta = store.readMeta();
    if (!meta) throw new Error(`Session ${id} cannot be resumed: its metadata is missing.`);
    await this.run(meta, true, store);
  }

  async discard(id: string): Promise<void> {
    const store = new SessionStore(this.storage, id);
    const meta = store.readMeta();
    if (meta) store.writeMeta({ ...meta, status: "cancelled" });
    await store.close();
    const root = this.harness.workspaceRoot;
    if (root) await new GitWorkspace(root, this.storage).cleanupSession(id).catch(() => undefined);
    this.hub.postChat({ type: "sessions", resumable: await this.resumable() });
  }

  cancel(): void {
    this.running?.engine.cancel();
    this.human.rejectAll();
  }

  taskAction(task: string, action: TaskAction): void {
    if (!this.running?.engine.taskAction(task, action)) {
      void vscode.window.showWarningMessage(`Harness: task ${task} is not running.`);
    }
  }

  private async run(meta: SessionMeta, resuming: boolean, existing?: SessionStore): Promise<void> {
    const root = this.harness.workspaceRoot;
    if (!root) throw new Error("Open a folder: the harness works on a git repository.");
    const workspace = new GitWorkspace(root, this.storage);
    if (!(await workspace.isRepository())) throw new Error("The harness needs a git repository with at least one commit.");
    await this.harness.reload();
    const resolved = this.harness.resolved;
    const flowEntry = resolved.flows.get(meta.flow);
    if (!flowEntry) throw new Error(`No orchestration named "${meta.flow}". Check the configuration for errors.`);
    const errors = resolved.issues.filter((i) => i.severity === "error" && !i.file?.includes("workflows"));
    if (errors.length) {
      this.log.show();
      throw new Error(`The configuration has ${errors.length} error(s); fix them first (see the Harness output).`);
    }

    const config = resolved.config;
    const limits = resolveLimits(config.limits);
    const catalog = buildCatalog(config, this.harness.discoveredModels());
    const router = new RouterService(config, catalog, limits, meta.settings.principal ? { principal: meta.settings.principal } : {});

    const store = existing ?? new SessionStore(this.storage, meta.id);
    store.writeMeta(meta);
    const priorEvents = resuming ? store.readEvents() : [];
    const running: Running = { engine: undefined as unknown as FlowEngine, router, secretsVersion: this.harness.secretsVersion, store, meta, workspace, events: priorEvents };
    this.syncRouter(running, true);
    this.running = running;
    this.last = undefined;
    this.hub.postChat({ type: "events", events: priorEvents, reset: true });
    this.hub.postChat({ type: "status", running: true });
    this.changed.fire();
    const allowlist = new WorkspaceAllowlist(this.context.workspaceState);
    const gate = new CommandGate({
      trusted: vscode.workspace.isTrusted,
      destructivePatterns: config.security?.destructive_patterns ?? [],
      allowlist,
      approver: { confirm: (request) => this.human.confirmCommand({ command: request.command, cwd: request.cwd, reason: request.reason, source: request.source }) },
    });
    const history = this.conversation.turns
      .slice(-6)
      .map((t) => `User: ${t.message}\nOutcome: ${t.outcome}`)
      .join("\n\n");
    const persistTo = flowEntry.flow.policy?.escalation?.persist_decisions ?? "project";
    const engine = new FlowEngine(
      {
        sessionId: meta.id,
        message: meta.message,
        flow: flowEntry.flow,
        config,
        agents: resolved.agents,
        approval: meta.settings.approval,
        ...(meta.settings.principal ? { principal: meta.settings.principal } : {}),
        decisions: resolved.decisions,
        ...(history ? { history } : {}),
      },
      {
        router,
        runner: new ToolLoopRunner(this.harness.registry, new NodeToolHost(), store, systemClock),
        commands: new NodeCommandRunner(),
        files: nodeFileAccess,
        workspace,
        human: this.human,
        gate,
        journal: store,
        events: { emit: (event) => this.onEvent(running, event) },
        clock: systemClock,
        loadSubflow: async (ref) => {
          const flow = harnessLibrary(resolved).resolve(ref);
          if (flow) return flow;
          if (resolved.flows.has(ref)) throw new Error(`"${ref}" is not marked as reusable`);
          throw new Error(resolved.invalidFlows.has(ref) ? `The flow "${ref}" has errors; fix it before reusing it` : `No flow named ${ref}`);
        },
        persistDecision: async (decision, scope) => {
          const dir = scope === "global" ? this.harness.globalDir : (this.harness.projectDir ?? this.harness.globalDir);
          await appendDecision(dir, meta.id, decision);
        },
      },
    );
    running.engine = engine;
    if (resuming) this.onEvent(running, { type: "session.resumed" });

    let result: SessionResult;
    try {
      result = await engine.run();
    } catch (e) {
      this.log.error("Session crashed", e);
      result = { status: "failed", summary: (e as Error).message, reportOnly: [] };
    }
    this.flush();
    await this.finish(running, result);
  }

  private onEvent(running: Running, body: HarnessEventBody): void {
    const event = running.store.appendEvent(body);
    running.events.push(event);
    this.pendingEvents.push(event);
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 60);
    if (event.type === "usage" || event.type === "question.asked" || event.type === "session.finished") this.changed.fire();
  }

  private flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (!this.pendingEvents.length) return;
    this.hub.postChat({ type: "events", events: this.pendingEvents });
    this.pendingEvents = [];
  }

  private async finish(running: Running, result: SessionResult): Promise<void> {
    const { store, meta, workspace } = running;
    if (this.closing) return;
    const status = result.status;
    try {
      if (status === "succeeded" || status === "failed") await workspace.finalizeSession(meta.id, `harness: ${meta.message.slice(0, 60)}`);
    } catch (e) {
      this.log.error("Could not commit the session's leftover changes", e);
    }
    const finalMeta: SessionMeta = { ...meta, status, ...(result.branch ? { branch: result.branch } : {}) };
    store.writeMeta(finalMeta);
    const localProviders = new Set((this.harness.resolved.config.providers ?? []).filter((p) => p.local).map((p) => p.id));
    store.writeMetrics(computeMetrics(running.events, localProviders));
    await store.close();
    const conversation = this.conversation;
    await this.saveConversation({
      ...conversation,
      turns: [...conversation.turns, { message: meta.message, outcome: (result.answer ?? result.summary).slice(0, 600), session: meta.id }],
    });
    this.running = undefined;
    this.last = { meta: finalMeta, result, workspace, events: running.events };
    this.hub.postChat({ type: "status", running: false });
    this.postResult(result, workspace, finalMeta);
    this.changed.fire();
  }

  private postResult(result: SessionResult, workspace: GitWorkspace, meta: SessionMeta): void {
    if (result.status === "answered") return;
    void workspace.sessionFiles(meta.id).then((files) => {
      this.hub.postChat({
        type: "result",
        status: result.status,
        summary: result.summary,
        ...(result.branch ? { branch: result.branch } : {}),
        files,
        canCommit: files.length > 0 && result.status !== "cancelled",
      });
    });
  }

  async commitResult(): Promise<void> {
    const last = this.last;
    if (!last) return;
    const outcome = await last.workspace.commitToCurrentBranch(last.meta.id, `harness: ${last.meta.message.slice(0, 72)}`);
    if (outcome.ok) {
      await last.workspace.cleanupSession(last.meta.id, true).catch(() => undefined);
      void vscode.window.showInformationMessage(`Harness: ${outcome.message}`);
    } else {
      void vscode.window.showErrorMessage(`Harness: ${outcome.message}`);
    }
  }

  async keepResult(): Promise<void> {
    const last = this.last;
    if (!last) return;
    await last.workspace.cleanupSession(last.meta.id, false).catch(() => undefined);
    void vscode.window.showInformationMessage(`Harness: the result stays on branch ${last.workspace.sessionBranch(last.meta.id)}.`);
  }

  async showDiff(): Promise<void> {
    const current = this.last ?? this.running;
    if (!current) return;
    const diff = await current.workspace.sessionDiff(current.meta.id).catch((e: Error) => `Could not compute the diff: ${e.message}`);
    const document = await vscode.workspace.openTextDocument({ content: diff || "No changes.", language: "diff" });
    await vscode.window.showTextDocument(document, { preview: true });
  }

  /** Detail of one step: router decision, outputs, command output and the agent's conversation. */
  async openStep(key: string): Promise<void> {
    const current = this.running ?? this.last;
    if (!current) return;
    const events = current.events;
    const store = this.running?.store ?? new SessionStore(this.storage, current.meta.id);
    const lines = [`# Step \`${key}\``, ""];
    for (const e of events) {
      if (e.type === "router.decision" && e.key === key) {
        lines.push(`**Model:** ${e.modelLabel} (\`${e.model}\`) — ${e.reason}`, "", `Chain: ${e.chain.map((c) => `\`${c}\``).join(" → ")}`, "");
        for (const s of e.skipped) lines.push(`- skipped \`${s.ref}\`: ${s.reason}`);
        for (const w of e.warnings) lines.push(`- ⚠ ${w}`);
        lines.push("");
      }
      if (e.type === "router.switch" && e.key === key) lines.push(`- switched from \`${e.from}\` to \`${e.to ?? "nothing"}\` (${e.cause})`);
      if (e.type === "command.finished" && e.key === key) lines.push(`- \`${e.command}\` → ${e.passed ? "passed" : `exit ${e.exitCode}`} in ${e.durationMs} ms`);
    }
    const finished = [...events].reverse().find((e) => e.type === "step.finished" && e.key === key);
    const outputs = store.get(key)?.outputs ?? (finished?.type === "step.finished" ? finished.outputs : undefined);
    if (outputs) {
      const { diff, output, ...rest } = outputs as Record<string, unknown>;
      lines.push("", "## Outputs", "", "```json", JSON.stringify(rest, null, 2), "```");
      if (typeof output === "string" && output) lines.push("", "## Command output (tail)", "", "```", output, "```");
      if (typeof diff === "string" && diff) lines.push("", "## Diff", "", "```diff", diff, "```");
    }
    const conversation = store.conversation(key);
    if (conversation?.length) {
      lines.push("", "## Conversation", "");
      for (const message of conversation) {
        if (message.role === "tool") lines.push(`**tool \`${message.name}\`**${message.isError ? " (error)" : ""}`, "", "```", message.content.slice(0, 4000), "```", "");
        else {
          lines.push(`**${message.role}**`, "", message.content || "_(no text)_", "");
          if (message.role === "assistant") for (const call of message.toolCalls ?? []) lines.push(`→ \`${call.name}\` ${JSON.stringify(call.args).slice(0, 400)}`, "");
        }
      }
    } else if (!this.running) {
      lines.push("", "_The agent conversation is only kept while a session can be resumed._");
    }
    const document = await vscode.workspace.openTextDocument({ content: lines.join("\n"), language: "markdown" });
    await vscode.window.showTextDocument(document, { preview: true });
  }

  async showMetrics(): Promise<void> {
    const events = this.running?.events ?? this.last?.events;
    if (!events?.length) {
      void vscode.window.showInformationMessage("Harness: no session yet.");
      return;
    }
    const localProviders = new Set((this.harness.resolved.config.providers ?? []).filter((p) => p.local).map((p) => p.id));
    const metrics = computeMetrics(events, localProviders);
    const rows = (title: string, data: Record<string, { tokens: number; costUsd: number; calls: number }>) =>
      [`### ${title}`, "", "| | tokens | cost | calls |", "|---|---:|---:|---:|", ...Object.entries(data).map(([k, v]) => `| ${k} | ${v.tokens} | $${v.costUsd.toFixed(4)} | ${v.calls} |`), ""].join("\n");
    const content = [
      `# Harness usage — session ${metrics.session}`,
      "",
      rows("By role", metrics.byRole),
      rows("By model", metrics.byModel),
      rows("By credential profile", metrics.byProfile),
      "### Rate limits (last reading per profile)",
      "",
      ...(Object.keys(metrics.rateLimits).length
        ? [
            "| | requests left | tokens left | resets |",
            "|---|---:|---:|---|",
            ...Object.entries(metrics.rateLimits).map(
              ([k, v]) => `| ${k} | ${v.requestsRemaining ?? "–"} | ${v.tokensRemaining ?? "–"} | ${v.resetAt ? new Date(v.resetAt).toLocaleTimeString() : "–"} |`,
            ),
          ]
        : ["_No provider reported rate-limit headers._"]),
      "",
      "### Findings",
      "",
      `Routes: ${JSON.stringify(metrics.findings.byRoute)} · promoted: ${metrics.findings.promoted} · QA rounds avoided: ${metrics.findings.qaRoundsAvoided}`,
      "",
      `### Escalations: ${metrics.escalations.total}`,
      "",
      JSON.stringify(metrics.escalations.byRaiser),
    ].join("\n");
    const document = await vscode.workspace.openTextDocument({ content, language: "markdown" });
    await vscode.window.showTextDocument(document, { preview: true });
  }

  sessionsDir(): string {
    return join(this.storage, "sessions");
  }

  /** Closing VS Code interrupts the session but keeps it resumable. */
  dispose(): void {
    this.closing = true;
    this.running?.engine.cancel("VS Code is closing");
    this.harnessListener.dispose();
    this.changed.dispose();
  }
}
