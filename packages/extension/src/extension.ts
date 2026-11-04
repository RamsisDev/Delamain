import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as vscode from "vscode";
import { ConfigFile, parseYaml, stringifyYaml, validateWith, type ToExtension } from "@delamain/core";
import { computeDryRun, registerCommands } from "./commands.ts";
import { HarnessDiagnostics } from "./diagnostics.ts";
import { HarnessService, type Destination } from "./harness-service.ts";
import { ChatHuman } from "./human.ts";
import { Log } from "./log.ts";
import { Secrets } from "./secrets.ts";
import { SessionManager } from "./session-manager.ts";
import { HarnessStatusBar } from "./status-bar.ts";
import { WebviewHub } from "./webviews.ts";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const log = new Log();
  const secrets = new Secrets(context.secrets);
  const harness = new HarnessService(secrets, log, context.globalState);
  const hub = new WebviewHub(context.extensionUri);
  const human = new ChatHuman(hub);
  const sessions = new SessionManager(context, harness, hub, human, log);
  context.subscriptions.push(log, harness, hub, sessions);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider("harness.chat", hub, { webviewOptions: { retainContextWhenHidden: true } }));

  await harness.reload().catch((e) => log.error("Could not load the configuration", e));
  harness.watch();
  const diagnostics = new HarnessDiagnostics(harness);
  context.subscriptions.push(diagnostics, new HarnessStatusBar(sessions, human));
  void diagnostics.refreshAll();

  harness.onDidChange(() => hub.postAll({ type: "harness", snapshot: harness.snapshot() }));
  context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(() => hub.postAll({ type: "harness", snapshot: harness.snapshot() })));

  hub.onReady(async (view) => {
    hub[view === "chat" ? "postChat" : "postConfig"]({ type: "init", view, settings: sessions.conversation.settings });
    hub[view === "chat" ? "postChat" : "postConfig"]({ type: "harness", snapshot: harness.snapshot() });
    if (view === "chat") await sessions.replayTo();
  });
  hub.onMessage((message, view) => handleMessage(message, view, { harness, hub, human, sessions, secrets }));
  registerCommands(context, { harness, sessions, hub, secrets });

  if (harness.resolved.config.discovery?.enabled !== false) void harness.discover().catch((e) => log.warn(`Local discovery failed: ${(e as Error).message}`));

  const resumable = await sessions.resumable().catch(() => []);
  if (resumable.length) {
    void vscode.window
      .showInformationMessage(`Harness: an unfinished session can be resumed ("${resumable[0]!.message.slice(0, 60)}").`, "Resume", "Later")
      .then(async (choice) => {
        if (choice !== "Resume") return;
        await hub.revealChat();
        await sessions.resume(resumable[0]!.id).catch((e: Error) => vscode.window.showErrorMessage(`Harness: ${e.message}`));
      });
  }
}

export function deactivate(): void {}

interface Context {
  harness: HarnessService;
  hub: WebviewHub;
  human: ChatHuman;
  sessions: SessionManager;
  secrets: Secrets;
}

async function handleMessage(message: ToExtension, view: "chat" | "config", ctx: Context): Promise<void> {
  const { harness, hub, human, sessions, secrets } = ctx;
  const reply = view === "chat" ? hub.postChat.bind(hub) : hub.postConfig.bind(hub);
  switch (message.type) {
    case "ready":
      return;
    case "chat.send":
      await sessions.start(message.text, message.settings);
      return;
    case "chat.cancel":
      sessions.cancel();
      return;
    case "chat.new":
      await sessions.newChat();
      return;
    case "chat.settings":
      await sessions.updateSettings(message.settings);
      return;
    case "question.answer":
      human.answer(message.id, message.answer);
      return;
    case "approval.answer":
      human.answerReview(message.approved, message.note);
      return;
    case "command.answer":
      human.answerCommand(message.id, message.answer);
      return;
    case "session.resume":
      await sessions.resume(message.id);
      return;
    case "session.discard":
      await sessions.discard(message.id);
      return;
    case "result.commit":
      await sessions.commitResult();
      return;
    case "result.keep":
      await sessions.keepResult();
      return;
    case "result.diff":
      await sessions.showDiff();
      return;
    case "task.action":
      sessions.taskAction(message.task, message.action);
      return;
    case "step.open":
      await sessions.openStep(message.key);
      return;
    case "config.save": {
      const result = await harness.saveConfig(message.destination, message.config);
      reply({ type: "saved", ok: result.ok, issues: result.issues, ...(result.path ? { path: result.path } : {}) });
      return;
    }
    case "flow.save": {
      const result = await harness.saveFlow(message.destination, message.name, message.flow, message.previousName);
      reply({ type: "saved", ok: result.ok, issues: result.issues, ...(result.path ? { path: result.path } : {}) });
      return;
    }
    case "flow.delete":
      await harness.deleteFlow(message.destination, message.name);
      return;
    case "provider.test": {
      const health = await harness.testConnection(message.provider);
      hub.postAll({ type: "health", provider: message.provider, health });
      return;
    }
    case "provider.discover":
      await harness.discover();
      return;
    case "provider.catalog": {
      const models = await harness.loadCatalog(message.provider).catch((e: Error) => {
        void vscode.window.showErrorMessage(`Harness: could not load the ${message.provider} catalog: ${e.message}`);
        return [];
      });
      reply({ type: "catalog", provider: message.provider, models });
      return;
    }
    case "provider.probe": {
      const probe = await harness.probe(message.ref);
      reply({ type: "probe", ref: message.ref, toolCalling: probe.toolCalling, message: probe.message, ...(probe.contextWindow ? { contextWindow: probe.contextWindow } : {}) });
      return;
    }
    case "secret.set":
      await secrets.set(message.secret, message.value);
      harness.registry.invalidate();
      return;
    case "secret.delete":
      await secrets.delete(message.secret);
      harness.registry.invalidate();
      return;
    case "config.open":
      await openLayerConfig(harness, message.destination);
      return;
    case "config.import":
      await importConfig(harness);
      return;
    case "config.export":
      await exportConfig(harness);
      return;
    case "dryrun": {
      const report = computeDryRun(harness, message.flow, sessions.conversation.settings.principal);
      if (report) reply({ type: "dryrun", report });
      return;
    }
  }
}

async function openLayerConfig(harness: HarnessService, destination: Destination): Promise<void> {
  const dir = harness.dirOf(destination);
  if (!dir) throw new Error("Open a folder to edit the project configuration.");
  const path = join(dir, "config.yml");
  if (!existsSync(path)) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, stringifyYaml({ schema_version: 1 }, ` Harness ${destination} configuration. Only what differs from the lower layers.`));
  }
  await vscode.window.showTextDocument(vscode.Uri.file(path));
}

async function importConfig(harness: HarnessService): Promise<void> {
  const [file] = (await vscode.window.showOpenDialog({ canSelectMany: false, filters: { YAML: ["yml", "yaml"] }, openLabel: "Import" })) ?? [];
  if (!file) return;
  const parsed = parseYaml(await readFile(file.fsPath, "utf8"));
  const result = validateWith(ConfigFile, parsed.value);
  if (!result.ok) throw new Error(`The file is not a valid harness configuration: ${result.issues[0]?.message ?? ""}`);
  const destination = (await vscode.window.showQuickPick(harness.projectDir ? ["project", "global"] : ["global"], { placeHolder: "Import into…" })) as Destination | undefined;
  if (!destination) return;
  const { schema_version: _version, ...config } = result.value;
  const saved = await harness.saveConfig(destination, config);
  if (!saved.ok) throw new Error(saved.issues.map((i) => i.message).join("; "));
  void vscode.window.showInformationMessage(`Harness: imported into ${saved.path}.`);
}

async function exportConfig(harness: HarnessService): Promise<void> {
  const target = await vscode.window.showSaveDialog({ filters: { YAML: ["yml"] }, saveLabel: "Export", defaultUri: vscode.Uri.file(join(harness.workspaceRoot ?? harness.globalDir, "harness-config.yml")) });
  if (!target) return;
  await writeFile(target.fsPath, stringifyYaml({ schema_version: 1, ...harness.resolved.config }, " Exported harness configuration (merged layers, no secrets)"));
  void vscode.window.showInformationMessage(`Harness: exported to ${target.fsPath}.`);
}
