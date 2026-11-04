import type { ToExtension, ToWebview } from "@delamain/core";

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

function createApi(): VsCodeApi {
  if (typeof acquireVsCodeApi === "function") return acquireVsCodeApi();
  // Outside VS Code (a plain browser while developing) messages are only logged.
  let state: unknown;
  return {
    postMessage: (message) => console.info("[harness → extension]", message),
    getState: () => state,
    setState: (next) => {
      state = next;
    },
  };
}

// acquireVsCodeApi may only be called once per webview.
let api: VsCodeApi | undefined;

function vscode(): VsCodeApi {
  api ??= createApi();
  return api;
}

export function post(message: ToExtension): void {
  vscode().postMessage(message);
}

function stateObject(): Record<string, unknown> {
  const state = vscode().getState();
  return state && typeof state === "object" ? (state as Record<string, unknown>) : {};
}

export function getState<T>(key: string): T | undefined {
  return stateObject()[key] as T | undefined;
}

export function setState(key: string, value: unknown): void {
  vscode().setState({ ...stateObject(), [key]: value });
}

export function onHostMessage(handler: (message: ToWebview) => void): () => void {
  const listener = (event: MessageEvent) => {
    const data: unknown = event.data;
    if (data && typeof data === "object" && typeof (data as { type?: unknown }).type === "string") {
      handler(data as ToWebview);
    }
  };
  window.addEventListener("message", listener);
  return () => window.removeEventListener("message", listener);
}
