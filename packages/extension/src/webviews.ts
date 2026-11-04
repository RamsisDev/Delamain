import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import type { ToExtension, ToWebview } from "@delamain/core";

type View = "chat" | "config";
export type MessageHandler = (message: ToExtension, view: View) => void | Promise<void>;

export function renderHtml(webview: vscode.Webview, extensionUri: vscode.Uri, view: View): string {
  const media = vscode.Uri.joinPath(extensionUri, "media", "webview");
  if (!existsSync(join(media.fsPath, "main.js"))) {
    return `<!DOCTYPE html><html><body style="font-family: var(--vscode-font-family); padding: 1em">
      The harness UI is not built yet. Run <code>npm run build</code> in the repository and reload the window.</body></html>`;
  }
  const nonce = randomBytes(16).toString("base64");
  const script = webview.asWebviewUri(vscode.Uri.joinPath(media, "main.js"));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(media, "main.css"));
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${style}">
  <title>Harness</title>
</head>
<body>
  <div id="root" data-view="${view}"></div>
  <script type="module" nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}

/** Routes messages between the extension host and the chat view and configuration panel. */
export class WebviewHub implements vscode.WebviewViewProvider, vscode.Disposable {
  private chatView: vscode.WebviewView | undefined;
  private configPanel: vscode.WebviewPanel | undefined;
  private handler: MessageHandler = () => undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly readyListeners: ((view: View) => void)[] = [];

  constructor(private readonly extensionUri: vscode.Uri) {}

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  onReady(listener: (view: View) => void): void {
    this.readyListeners.push(listener);
  }

  private wire(webview: vscode.Webview, view: View): vscode.Disposable {
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    webview.html = renderHtml(webview, this.extensionUri, view);
    return webview.onDidReceiveMessage(async (message: ToExtension) => {
      if (message.type === "ready") for (const listener of this.readyListeners) listener(view);
      try {
        await this.handler(message, view);
      } catch (e) {
        void vscode.window.showErrorMessage(`Harness: ${(e as Error).message}`);
      }
    });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.chatView = view;
    const subscription = this.wire(view.webview, "chat");
    view.onDidDispose(() => {
      subscription.dispose();
      this.chatView = undefined;
    });
  }

  get chatVisible(): boolean {
    return this.chatView?.visible === true;
  }

  async revealChat(): Promise<void> {
    if (this.chatView) this.chatView.show(true);
    else await vscode.commands.executeCommand("harness.chat.focus");
  }

  openConfig(): void {
    if (this.configPanel) {
      this.configPanel.reveal(vscode.ViewColumn.Active);
      return;
    }
    const panel = vscode.window.createWebviewPanel("harness.config", "Harness Configuration", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    });
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, "media", "harness.svg");
    this.configPanel = panel;
    const subscription = this.wire(panel.webview, "config");
    panel.onDidDispose(() => {
      subscription.dispose();
      this.configPanel = undefined;
    });
  }

  postChat(message: ToWebview): void {
    void this.chatView?.webview.postMessage(message);
  }

  postConfig(message: ToWebview): void {
    void this.configPanel?.webview.postMessage(message);
  }

  postAll(message: ToWebview): void {
    this.postChat(message);
    this.postConfig(message);
  }

  dispose(): void {
    this.configPanel?.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
