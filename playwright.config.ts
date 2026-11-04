import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "packages/webview/e2e",
  fullyParallel: true,
  workers: 2,
  use: { browserName: "chromium", screenshot: "only-on-failure", trace: "retain-on-failure" },
  reporter: [["list"], ["html", { open: "never" }]],
});
