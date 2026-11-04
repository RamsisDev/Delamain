import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import type { CommandConfirmation, HumanPort, HumanQuestion, HumanReview } from "@delamain/core";
import type { WebviewHub } from "./webviews.ts";

type CommandAnswer = "allow" | "allow_always" | "deny";

/**
 * The human side of the harness: decision cards, the review card and command confirmations
 * are answered in the chat. VS Code notifications point to them when the chat is not visible.
 */
export class ChatHuman implements HumanPort {
  private readonly questions = new Map<string, { question: HumanQuestion; resolve: (answer: string) => void }>();
  private pendingReview: ((answer: { approved: boolean; note?: string }) => void) | undefined;
  private readonly commands = new Map<string, (answer: CommandAnswer) => void>();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly hub: WebviewHub) {}

  get pendingDecisions(): HumanQuestion[] {
    return [...this.questions.values()].map((q) => q.question);
  }

  ask(question: HumanQuestion, signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      this.questions.set(question.id, { question, resolve });
      this.changed.fire();
      signal?.addEventListener(
        "abort",
        () => {
          this.questions.delete(question.id);
          this.changed.fire();
          reject(signal.reason);
        },
        { once: true },
      );
      if (!question.batched) {
        void vscode.window
          .showInformationMessage(`Harness: decision needed — ${question.question}`, "Open chat")
          .then((choice) => choice && this.hub.revealChat());
      }
    });
  }

  answer(id: string, answer: string): void {
    const pending = this.questions.get(id);
    if (!pending) return;
    this.questions.delete(id);
    this.changed.fire();
    pending.resolve(answer);
  }

  review(_request: HumanReview, signal?: AbortSignal): Promise<{ approved: boolean; note?: string }> {
    return new Promise((resolve, reject) => {
      this.pendingReview = resolve;
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      void vscode.window.showInformationMessage("Harness: the result is ready for your review.", "Open chat").then((c) => c && this.hub.revealChat());
    });
  }

  answerReview(approved: boolean, note?: string): void {
    const resolve = this.pendingReview;
    this.pendingReview = undefined;
    resolve?.({ approved, ...(note ? { note } : {}) });
  }

  confirmCommand(request: CommandConfirmation): Promise<CommandAnswer> {
    const id = randomUUID();
    return new Promise((resolve) => {
      let settled = false;
      const settle = (answer: CommandAnswer) => {
        if (settled) return;
        settled = true;
        this.commands.delete(id);
        this.hub.postChat({ type: "command.resolved", id });
        resolve(answer);
      };
      this.commands.set(id, settle);
      this.hub.postChat({ type: "command.confirm", id, command: request.command, cwd: request.cwd, reason: request.reason });
      if (!this.hub.chatVisible) {
        const label = request.reason === "destructive" ? "Destructive command" : "New command";
        const options = request.reason === "destructive" ? ["Allow once", "Deny"] : ["Allow once", "Always allow", "Deny"];
        void vscode.window
          .showWarningMessage(`Harness — ${label}: ${request.command}`, { modal: request.reason === "destructive" }, ...options)
          .then((choice) => settle(choice === "Always allow" ? "allow_always" : choice === "Allow once" ? "allow" : "deny"));
      }
    });
  }

  answerCommand(id: string, answer: CommandAnswer): void {
    this.commands.get(id)?.(answer);
  }

  rejectAll(): void {
    for (const settle of this.commands.values()) settle("deny");
  }
}

/** Remembers approved commands per workspace; a modified command is a new one. */
export class WorkspaceAllowlist {
  constructor(private readonly state: vscode.Memento) {}

  async has(command: string): Promise<boolean> {
    return this.state.get<string[]>("harness.allowlist", []).includes(command);
  }

  async add(command: string): Promise<void> {
    const list = this.state.get<string[]>("harness.allowlist", []);
    if (!list.includes(command)) await this.state.update("harness.allowlist", [...list, command]);
  }
}
