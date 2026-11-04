import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import { registerCommands, type CommandDeps } from "../src/commands.ts";

const ui = vi.hoisted(() => ({
  handlers: new Map<string, () => Promise<void>>(),
  showInputBox: vi.fn(), showQuickPick: vi.fn(),
  showInformationMessage: vi.fn(), showErrorMessage: vi.fn(),
}));
vi.mock("vscode", () => ({
  commands: { registerCommand: (id: string, handler: () => Promise<void>) => { ui.handlers.set(id, handler); return { dispose() {} }; } },
  ProgressLocation: { Notification: 15 },
  window: { ...ui, withProgress: async (_options: unknown, run: () => Promise<void>) => run() },
}));

let root: string;
let source: string;
let target: string;
let reload: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.clearAllMocks();
  root = await mkdtemp(join(tmpdir(), "delamain-preset-qa-"));
  source = join(root, "source");
  target = join(root, "project", ".harness");
  await mkdir(join(source, ".harness", "workflows"), { recursive: true });
  await mkdir(target, { recursive: true });
  await writeFile(join(source, ".harness", "config.yml"), "schema_version: 1\ncommands:\n  test: node --test\n");
  await writeFile(join(source, ".harness", "workflows", "imported.yml"), "schema_version: 1\nname: imported\nsteps: []\n");
  await writeFile(join(target, "config.yml"), "# My existing configuration\nschema_version: 1\n");
  for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=QA", "-c", "user.email=qa@localhost", "commit", "-qm", "fixture"]]) {
    execFileSync("git", args, { cwd: source, stdio: "pipe", windowsHide: true });
  }
  reload = vi.fn().mockResolvedValue(undefined);
  registerCommands({ subscriptions: [] } as unknown as vscode.ExtensionContext, {
    harness: { projectDir: target, globalDir: join(root, "global"), dirOf: () => target, reload },
  } as unknown as CommandDeps);
  ui.showInputBox.mockResolvedValue(pathToFileURL(source).href);
  ui.showQuickPick.mockReset().mockResolvedValueOnce({ value: "project" });
});

afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("installing presets from a real Git repository (VS Code dialogs simulated)", () => {
  it("cancelling the conflict choice does not install files or reload configuration", async () => {
    ui.showQuickPick.mockResolvedValueOnce(undefined);
    await ui.handlers.get("harness.installPreset")!();
    expect(existsSync(join(target, "workflows"))).toBe(false);
    expect(await readFile(join(target, "config.yml"), "utf8")).toContain("My existing configuration");
    expect(reload).not.toHaveBeenCalled();
    expect(ui.showInformationMessage).not.toHaveBeenCalled();
    expect(ui.showErrorMessage).not.toHaveBeenCalled();
  });

  it("keeps existing files while installing new nested files", async () => {
    ui.showQuickPick.mockResolvedValueOnce("Keep my existing files");
    await ui.handlers.get("harness.installPreset")!();
    expect(await readFile(join(target, "config.yml"), "utf8")).toContain("My existing configuration");
    expect(await readFile(join(target, "workflows", "imported.yml"), "utf8")).toContain("name: imported");
    expect(existsSync(join(target, ".git"))).toBe(false);
    expect(reload).toHaveBeenCalledOnce();
    expect(ui.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining("installed 1 file(s)"));
    expect(ui.showErrorMessage).not.toHaveBeenCalled();
  });

  it("overwrites only when that option is selected", async () => {
    ui.showQuickPick.mockResolvedValueOnce("Overwrite existing files");
    await ui.handlers.get("harness.installPreset")!();
    expect(await readFile(join(target, "config.yml"), "utf8")).toContain("test: node --test");
    expect(ui.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining("installed 2 file(s)"));
    expect(ui.showErrorMessage).not.toHaveBeenCalled();
  });
});
