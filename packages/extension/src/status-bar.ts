import * as vscode from "vscode";
import type { ChatHuman } from "./human.ts";
import type { SessionManager } from "./session-manager.ts";

function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

/** Active orchestration, pending decisions and the session's token usage. */
export class HarnessStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly sessions: SessionManager,
    private readonly human: ChatHuman,
  ) {
    this.item.command = "harness.openChat";
    this.disposables.push(sessions.onDidChange(() => this.update()), human.onDidChange(() => this.update()));
    this.update();
    this.item.show();
  }

  update(): void {
    const status = this.sessions.status();
    const decisions = this.human.pendingDecisions.length;
    const parts = [`$(${status.running ? "sync~spin" : "hubot"}) ${status.flow}`];
    if (decisions) parts.push(`$(question) ${decisions}`);
    if (status.tokens) parts.push(`${formatTokens(status.tokens)} tok`);
    this.item.text = parts.join(" · ");
    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(`**Harness** — orchestration \`${status.flow}\`${status.running ? " (running)" : ""}\n\n`);
    if (decisions) {
      tooltip.appendMarkdown(`Pending decisions:\n\n${this.human.pendingDecisions.map((q) => `- ${q.question}`).join("\n")}\n\n`);
    }
    if (status.tokens) {
      const cost = `$${status.costUsd.toFixed(4)}${status.costUnknown ? " plus models without pricing" : ""}`;
      tooltip.appendMarkdown(`Session usage: ${status.tokens} tokens, ${cost}`);
    }
    this.item.tooltip = tooltip;
    this.item.backgroundColor = decisions ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.item.dispose();
  }
}
