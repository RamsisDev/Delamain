import { readFile } from "node:fs/promises";
import * as vscode from "vscode";
import {
  locate,
  offsetToPosition,
  parseAgentFile,
  parseYaml,
  validateSingleFile,
  yamlErrorRanges,
  type Issue,
  type LayerName,
  type SchemaKind,
} from "@delamain/core";
import type { HarnessService } from "./harness-service.ts";

type FileKind = SchemaKind | "agent-md";

/** Kind of a file from its path relative to a layer folder (~/.harness or <repo>/.harness). */
export function kindOf(path: string, layerDirs: readonly (string | undefined)[]): FileKind | undefined {
  const normalized = path.replace(/\\/g, "/");
  const dir = layerDirs.find((d) => d && normalized.startsWith(`${d.replace(/\\/g, "/")}/`));
  if (!dir) return undefined;
  const rest = normalized.slice(dir.replace(/\\/g, "/").length + 1);
  if (/^config\.ya?ml$/.test(rest)) return "config";
  if (/^(workflows|flows)\/[^/]+\.ya?ml$/.test(rest)) return "flow";
  if (/^decisions\/[^/]+\.ya?ml$/.test(rest)) return "decisions";
  if (/^agents\/[^/]+\.md$/.test(rest)) return "agent-md";
  return undefined;
}

function toRange(text: string, start: number, end: number): vscode.Range {
  const a = offsetToPosition(text, start);
  const b = offsetToPosition(text, Math.max(end, start + 1));
  return new vscode.Range(a.line, a.character, b.line, b.character);
}

function toDiagnostics(kind: FileKind, text: string, issues: readonly Issue[]): vscode.Diagnostic[] {
  let yamlText = text;
  let offset = 0;
  if (kind === "agent-md") {
    const agent = parseAgentFile(text);
    yamlText = agent.frontmatterText;
    offset = agent.frontmatterOffset;
  }
  const parsed = parseYaml(yamlText);
  const syntax = yamlErrorRanges(parsed.doc).map(({ range, message }) => {
    const diagnostic = new vscode.Diagnostic(toRange(text, range.start + offset, range.end + offset), message, vscode.DiagnosticSeverity.Error);
    diagnostic.source = "harness";
    return diagnostic;
  });
  if (syntax.length) return syntax;
  return issues.map((issue) => {
    const range = locate(parsed.doc, issue.path) ?? { start: 0, end: 1 };
    const diagnostic = new vscode.Diagnostic(
      toRange(text, range.start + offset, range.end + offset),
      issue.message,
      issue.severity === "error" ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning,
    );
    diagnostic.source = "harness";
    return diagnostic;
  });
}

/** Errors next to the field that causes them, for every YAML and agent file of the harness. */
export class HarnessDiagnostics implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection("harness");
  private readonly disposables: vscode.Disposable[] = [];
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly harness: HarnessService) {
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((d) => this.validateDocument(d)),
      vscode.workspace.onDidChangeTextDocument((e) => this.debounce(e.document)),
      vscode.workspace.onDidCloseTextDocument((d) => {
        if (this.kind(d.uri.fsPath)) void this.refreshFile(d.uri.fsPath);
      }),
      harness.onDidChange(() => void this.refreshAll()),
    );
  }

  private kind(path: string): FileKind | undefined {
    return kindOf(path, [this.harness.globalDir, this.harness.projectDir]);
  }

  private layerOf(path: string): LayerName {
    return path.startsWith(this.harness.globalDir) ? "global" : "project";
  }

  private debounce(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    const timer = this.timers.get(key);
    if (timer) clearTimeout(timer);
    this.timers.set(key, setTimeout(() => this.validateDocument(document), 250));
  }

  validateDocument(document: vscode.TextDocument): void {
    const path = document.uri.fsPath;
    const kind = this.kind(path);
    if (!kind) return;
    const text = document.getText();
    const issues = validateSingleFile(kind, { layer: this.layerOf(path), path, text }, this.harness.resolved);
    this.collection.set(document.uri, toDiagnostics(kind, text, issues));
  }

  private async refreshFile(path: string): Promise<void> {
    const kind = this.kind(path);
    if (!kind) return;
    const text = await readFile(path, "utf8").catch(() => undefined);
    if (text === undefined) {
      this.collection.delete(vscode.Uri.file(path));
      return;
    }
    const issues = this.harness.resolved.issues.filter((i) => i.file === path);
    this.collection.set(vscode.Uri.file(path), toDiagnostics(kind, text, issues));
  }

  async refreshAll(): Promise<void> {
    const files = new Set(this.harness.resolved.issues.map((i) => i.file).filter((f): f is string => !!f && !f.startsWith("preset:")));
    this.collection.forEach((uri) => {
      if (!files.has(uri.fsPath)) this.collection.delete(uri);
    });
    for (const file of files) await this.refreshFile(file);
    for (const document of vscode.workspace.textDocuments) this.validateDocument(document);
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    for (const d of this.disposables) d.dispose();
    this.collection.dispose();
  }
}
