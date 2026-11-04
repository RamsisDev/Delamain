import { execFile } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import * as vscode from "vscode";
import { copyPreset } from "@delamain/adapters";
import { buildCatalog, dryRun, harnessLibrary, type ConfigFile, type DryRunReport } from "@delamain/core";
import type { Destination, HarnessService } from "./harness-service.ts";
import type { Secrets } from "./secrets.ts";
import type { SessionManager } from "./session-manager.ts";
import type { WebviewHub } from "./webviews.ts";

export interface CommandDeps {
  harness: HarnessService;
  sessions: SessionManager;
  hub: WebviewHub;
  secrets: Secrets;
}

async function pickDestination(harness: HarnessService, placeHolder: string): Promise<Destination | undefined> {
  const items: (vscode.QuickPickItem & { value: Destination })[] = [];
  if (harness.projectDir) items.push({ label: "Project", description: harness.projectDir, detail: "Shared with the repository through git", value: "project" });
  items.push({ label: "Global", description: harness.globalDir, detail: "All of your projects", value: "global" });
  if (items.length === 1) return items[0]!.value;
  return (await vscode.window.showQuickPick(items, { placeHolder }))?.value;
}

async function pickProvider(harness: HarnessService, placeHolder: string): Promise<string | undefined> {
  const providers = harness.resolved.config.providers ?? [];
  if (!providers.length) {
    void vscode.window.showInformationMessage("Harness: no providers configured yet. Add one in Harness: Open Configuration.");
    return undefined;
  }
  return (await vscode.window.showQuickPick(providers.map((p) => ({ label: p.id, description: `${p.type}${p.local ? " · local" : ""}` })), { placeHolder }))?.label;
}

export function renderDryRun(report: DryRunReport): string {
  const lines = [`# Dry run — ${report.flow}`, "", `Worst case: **${report.worstCase.perModel}** worker runs per task per model${report.worstCase.total ? ` (${report.worstCase.total} across the chain)` : ""}.`, ""];
  for (const step of report.steps) {
    const indent = "  ".repeat(step.depth);
    const model = step.model ? ` → **${step.model}** _(${step.rule})_` : "";
    lines.push(`${indent}- \`${step.type}\` **${step.label}** ${step.detail ? `— ${step.detail}` : ""}${model}`);
    for (const warning of step.warnings ?? []) lines.push(`${indent}  - ⚠ ${warning}`);
  }
  if (report.issues.length) {
    lines.push("", "## Issues", "");
    for (const issue of report.issues) lines.push(`- ${issue.severity}: ${issue.message} (${issue.path.join(".")})`);
  }
  return lines.join("\n");
}

export function computeDryRun(harness: HarnessService, flowName: string, principal?: string): DryRunReport | undefined {
  const entry = harness.resolved.flows.get(flowName);
  if (!entry) return undefined;
  const catalog = buildCatalog(harness.resolved.config, harness.discoveredModels());
  return dryRun(entry.flow, harness.resolved.config, harness.resolved.agents, catalog, {
    library: harnessLibrary(harness.resolved),
    ...(principal ? { principal } : {}),
  });
}

function run(command: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) =>
    execFile(command, args, { cwd }, (error, _stdout, stderr) => (error ? reject(new Error(stderr || error.message)) : resolve())),
  );
}

async function copyTree(from: string, to: string, overwrite: boolean): Promise<string[]> {
  const copied: string[] = [];
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const source = join(dir, entry.name);
      if (entry.isDirectory()) await walk(source);
      else if (entry.isFile()) {
        const target = join(to, relative(from, source));
        if (existsSync(target) && !overwrite) continue;
        await mkdir(dirname(target), { recursive: true });
        await copyFile(source, target);
        copied.push(target);
      }
    }
  };
  await walk(from);
  return copied;
}

export function registerCommands(context: vscode.ExtensionContext, deps: CommandDeps): void {
  const { harness, sessions, hub, secrets } = deps;
  const register = (id: string, handler: (...args: unknown[]) => unknown) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: unknown[]) => {
        try {
          await handler(...args);
        } catch (e) {
          void vscode.window.showErrorMessage(`Harness: ${(e as Error).message}`);
        }
      }),
    );

  register("harness.openChat", () => hub.revealChat());
  register("harness.openConfig", () => hub.openConfig());
  register("harness.newChat", () => sessions.newChat());
  register("harness.cancel", () => sessions.cancel());
  register("harness.showMetrics", () => sessions.showMetrics());

  register("harness.customize", async () => {
    const destination = await pickDestination(harness, "Where should the preset be copied?");
    if (!destination) return;
    const dir = harness.dirOf(destination)!;
    const written = await copyPreset(dir);
    await harness.reload();
    void vscode.window.showInformationMessage(
      written.length ? `Harness: copied ${written.length} preset file(s) to ${dir}. Existing files were kept.` : `Harness: ${dir} already has every preset file.`,
    );
    await vscode.window.showTextDocument(vscode.Uri.file(join(dir, "config.yml")));
  });

  register("harness.dryRun", async () => {
    const flows = [...harness.resolved.flows.keys()];
    const flow = await vscode.window.showQuickPick(flows, { placeHolder: "Orchestration to dry-run" });
    if (!flow) return;
    const report = computeDryRun(harness, flow, sessions.conversation.settings.principal);
    if (!report) return;
    hub.postConfig({ type: "dryrun", report });
    const document = await vscode.workspace.openTextDocument({ content: renderDryRun(report), language: "markdown" });
    await vscode.window.showTextDocument(document, { preview: true });
  });

  register("harness.findLocalServers", async () => {
    const found = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Harness: looking for local servers…" }, () => harness.discover());
    const configured = new Set((harness.resolved.config.providers ?? []).map((p) => p.base_url?.replace(/\/$/, "")));
    const fresh = found.filter((s) => !configured.has(s.base_url.replace(/\/$/, "")));
    if (!found.length) {
      void vscode.window.showInformationMessage("Harness: no local servers answered (Jan, Ollama, LM Studio, llama.cpp, vLLM).");
      return;
    }
    if (!fresh.length) {
      void vscode.window.showInformationMessage(`Harness: found ${found.map((s) => s.label).join(", ")}; all are already configured.`);
      return;
    }
    const picks = await vscode.window.showQuickPick(
      fresh.map((s) => ({ label: s.label, description: s.base_url, detail: `${s.models.length} model(s): ${s.models.slice(0, 5).map((m) => m.id).join(", ")}`, picked: true, server: s })),
      { canPickMany: true, placeHolder: "Add these servers as providers" },
    );
    if (!picks?.length) return;
    const destination = await pickDestination(harness, "Save the providers to…");
    if (!destination) return;
    const layer: Partial<ConfigFile> = structuredClone(harness.layerConfig(destination) ?? {});
    layer.providers = [
      ...(layer.providers ?? []),
      ...picks.map((p) => ({ id: p.server.id, type: "openai-compatible" as const, label: p.server.label, base_url: p.server.base_url, local: true, max_concurrent: 1 })),
    ];
    const saved = await harness.saveConfig(destination, layer);
    if (!saved.ok) throw new Error(saved.issues.map((i) => i.message).join("; "));
    void vscode.window.showInformationMessage(`Harness: added ${picks.map((p) => p.label).join(", ")}.`);
  });

  register("harness.testConnection", async () => {
    const provider = await pickProvider(harness, "Provider to test");
    if (!provider) return;
    const health = await harness.testConnection(provider);
    if (health.status === "online") void vscode.window.showInformationMessage(`Harness: ${provider} is online${health.models !== undefined ? ` (${health.models} models)` : ""}.`);
    else void vscode.window.showErrorMessage(`Harness: ${provider} — ${health.status}: ${"message" in health ? health.message : ""}`);
  });

  register("harness.setApiKey", async () => {
    const providerId = await pickProvider(harness, "Provider");
    if (!providerId) return;
    const provider = harness.resolved.config.providers?.find((p) => p.id === providerId);
    const profiles = provider?.profiles ?? [];
    if (!profiles.length) {
      void vscode.window.showInformationMessage(`Harness: ${providerId} has no credential profiles. Add one in the configuration screen.`);
      return;
    }
    const profile = profiles.length === 1 ? profiles[0] : (await vscode.window.showQuickPick(profiles.map((p) => ({ label: p.label, description: p.secret, profile: p })), { placeHolder: "Profile" }))?.profile;
    if (!profile) return;
    const value = await vscode.window.showInputBox({ prompt: `API key for ${providerId} (${profile.label})`, password: true, ignoreFocusOut: true });
    if (!value) return;
    await secrets.set(profile.secret, value);
    harness.registry.invalidate();
    void vscode.window.showInformationMessage(`Harness: key stored in SecretStorage as "${profile.secret}".`);
  });

  register("harness.resume", async () => {
    const resumable = await sessions.resumable();
    if (!resumable.length) {
      void vscode.window.showInformationMessage("Harness: no unfinished sessions.");
      return;
    }
    const pick = await vscode.window.showQuickPick(
      resumable.map((s) => ({ label: s.message.slice(0, 80), description: `${s.flow} · ${new Date(s.startedAt).toLocaleString()}`, id: s.id })),
      { placeHolder: "Session to resume" },
    );
    if (!pick) return;
    await hub.revealChat();
    await sessions.resume(pick.id);
  });

  register("harness.installPreset", async () => {
    const url = await vscode.window.showInputBox({ prompt: "Git URL of the preset repository", placeHolder: "https://github.com/someone/harness-presets.git", ignoreFocusOut: true });
    if (!url) return;
    const destination = await pickDestination(harness, "Install the preset into…");
    if (!destination) return;
    const target = harness.dirOf(destination)!;
    const temp = mkdtempSync(join(tmpdir(), "harness-preset-"));
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Harness: cloning ${url}…` }, () => run("git", ["clone", "--depth", "1", url, temp]));
      const source = existsSync(join(temp, ".harness")) ? join(temp, ".harness") : temp;
      await rm(join(source, ".git"), { recursive: true, force: true });
      const overwrite = (await vscode.window.showQuickPick(["Keep my existing files", "Overwrite existing files"], { placeHolder: "When a file already exists…" })) === "Overwrite existing files";
      const copied = await copyTree(source, target, overwrite);
      await harness.reload();
      void vscode.window.showInformationMessage(`Harness: installed ${copied.length} file(s) into ${target}.`);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
}
