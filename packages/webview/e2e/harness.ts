import { readFileSync } from "node:fs";
import { expect, type Page } from "@playwright/test";
import type { HarnessSnapshot, ToWebview } from "@delamain/core";
import { globalLayer, snapshotWith } from "../test/fixtures";

const bundle = readFileSync(new URL("../../extension/media/webview/main.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../../extension/media/webview/main.css", import.meta.url), "utf8");

export const snapshot = () => snapshotWith(globalLayer, {});

export async function host(page: Page, message: ToWebview) {
  await page.evaluate(message => window.dispatchEvent(new MessageEvent("message", { data: message })), message);
}

export async function messages(page: Page, type: string) {
  return page.evaluate(type => (window as any).qaMessages.filter((m: any) => m.type === type), type);
}

export function field(page: Page | import("@playwright/test").Locator, label: string) {
  return page.locator(`.field:has(> .field-label > span:text-is(${JSON.stringify(label)}))`).first();
}

export async function openView(page: Page, view = "config", options: { width?: number; height?: number; light?: boolean; snapshot?: HarnessSnapshot } = {}) {
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.setViewportSize({ width: options.width ?? 1280, height: options.height ?? 850 });
  const state = options.snapshot ?? snapshot();
  await page.addInitScript(({ state }) => {
    let saved: unknown;
    (window as any).qaMessages = [];
    (window as any).acquireVsCodeApi = () => ({
      getState: () => saved,
      setState: (value: unknown) => { saved = value; },
      postMessage: (message: any) => {
        (window as any).qaMessages.push(message);
        if (message.type === "ready") {
          queueMicrotask(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "harness", snapshot: state } })));
        }
      },
    });
  }, { state });
  const fg = options.light ? "#333333" : "#cccccc";
  const bg = options.light ? "#ffffff" : "#1f1f1f";
  const surface = options.light ? "#f3f3f3" : "#252526";
  const theme = `:root {
    --vscode-foreground:${fg}; --vscode-editor-background:${bg}; --vscode-sideBar-background:${surface};
    --vscode-editorWidget-background:${surface}; --vscode-input-background:${options.light ? "#ffffff" : "#313131"};
    --vscode-input-foreground:${fg}; --vscode-input-border:#808080; --vscode-dropdown-background:${surface};
    --vscode-button-background:#0078d4; --vscode-button-foreground:#ffffff;
    --vscode-button-secondaryBackground:${options.light ? "#dddddd" : "#3b3b3b"}; --vscode-button-secondaryForeground:${fg};
    --vscode-focusBorder:#0078d4; --vscode-descriptionForeground:${options.light ? "#616161" : "#9d9d9d"};
    --vscode-panel-border:#80808066; --vscode-errorForeground:${options.light ? "#a1260d" : "#f48771"};
    --vscode-textLink-foreground:${options.light ? "#006ab1" : "#4daafc"}; --vscode-badge-background:#555555; --vscode-badge-foreground:#ffffff;
  }`;
  await page.route("http://harness.test/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/main.js") return route.fulfill({ contentType: "text/javascript", body: bundle });
    if (path === "/main.css") return route.fulfill({ contentType: "text/css", body: css });
    return route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/main.css"><style>${theme}</style></head><body><div id="root" data-view="${view}"></div><script type="module" src="/main.js"></script></body></html>` });
  });
  await page.goto("http://harness.test/");
  await expect(page.locator(`.${view}-app`)).toBeVisible();
  return errors;
}

export async function fitsViewport(page: Page) {
  const size = await page.evaluate(() => ({ width: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
  expect(size.content, "Page must not overflow horizontally").toBeLessThanOrEqual(size.width + 1);
}
