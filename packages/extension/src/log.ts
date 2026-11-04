import * as vscode from "vscode";

export class Log implements vscode.Disposable {
  private readonly channel = vscode.window.createOutputChannel("Harness", { log: true });

  info(message: string): void {
    this.channel.info(message);
  }

  warn(message: string): void {
    this.channel.warn(message);
  }

  error(message: string, error?: unknown): void {
    this.channel.error(error instanceof Error ? `${message}: ${error.stack ?? error.message}` : message);
  }

  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
  }
}
