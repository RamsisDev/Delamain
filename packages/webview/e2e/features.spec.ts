import { test, expect } from "@playwright/test";
import { field, fitsViewport, host, messages, openView, snapshot } from "./harness";

for (const width of [320, 640, 1280]) {
  for (const light of [false, true]) {
    test(`configuration tabs fit ${width}px in ${light ? "light" : "dark"} theme`, async ({ page }) => {
      const errors = await openView(page, "config", { width, light });
      for (const tab of ["Providers", "Models", "Router", "Orchestrations"]) {
        await page.getByRole("tab", { name: tab, exact: true }).click();
        await expect(page.getByRole("heading", { name: tab, exact: true })).toBeVisible();
        await fitsViewport(page);
      }
      expect(errors).toEqual([]);
    });
  }
}

test("providers: add, validate, save, health, secret and remove", async ({ page }) => {
  await openView(page);
  const add = page.locator(".add-card");
  await add.locator("select").selectOption("cli");
  await expect(add.getByRole("button", { name: "Add provider" })).toBeDisabled();
  await add.locator('input[placeholder="cli"]').fill("codex");
  await add.locator('input[placeholder="codex exec"]').fill("codex exec -");
  await add.getByRole("button", { name: "Add provider" }).click();
  const card = page.locator(".card").filter({ has: page.locator(".card-header strong").getByText("codex", { exact: true }) });
  await expect(card).toBeVisible();
  await card.locator("select").selectOption("stdin");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const saved = (await messages(page, "config.save"))[0];
  expect(saved.config.providers.find((p: any) => p.id === "codex")).toMatchObject({ command: "codex exec -", prompt_input: "stdin" });
  await host(page, { type: "saved", ok: true, issues: [], path: "config.yml" });
  await expect(page.locator(".banner-ok")).toContainText("Saved");
  await card.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(card).toHaveCount(0);
  await page.getByRole("button", { name: "Test connection" }).first().click();
  expect((await messages(page, "provider.test"))[0].provider).toBe("anthropic");
  await host(page, { type: "health", provider: "anthropic", health: { status: "offline", message: "Connection failed: " + "x".repeat(400) } });
  await fitsViewport(page);
  await page.locator('input[type="password"]').fill("qa-dummy-key");
  await page.getByRole("button", { name: "Store", exact: true }).click();
  expect((await messages(page, "secret.set"))[0]).toMatchObject({ secret: "anthropic.personal", value: "qa-dummy-key" });
  await expect(page.locator('input[type="password"]')).toHaveValue("");
});

test("models: catalog search and favorites", async ({ page }) => {
  await openView(page);
  await page.getByRole("tab", { name: "Models", exact: true }).click();
  await page.getByPlaceholder("Search models…").fill("Qwen 3");
  await expect(page.locator(".model-row")).toHaveCount(1);
  await page.getByRole("button", { name: "Add to favorites" }).click();
  await expect(page.locator(".model-row.favorite")).toHaveCount(1);
  await page.getByRole("button", { name: "Remove from favorites" }).click();
  await expect(page.locator(".model-row.favorite")).toHaveCount(0);
  await page.getByPlaceholder("Search models…").fill("nothing-matches");
  await expect(page.getByText("No models match.", { exact: false })).toBeVisible();
});

test("router: conditions, simulator and rule removal", async ({ page }) => {
  await openView(page, "config", { width: 420 });
  await page.getByRole("tab", { name: "Router", exact: true }).click();
  const simulator = page.locator(".simulator");
  await field(simulator, "Kind").locator("select").selectOption("docstring");
  await field(simulator, "Estimated tokens").locator("input").fill("1000");
  await expect(simulator.locator(".decision-summary")).toContainText("Docs");
  await expect(simulator.locator(".decision-summary")).toContainText("openrouter/deepseek/deepseek-chat");
  const before = await page.locator(".rule-card").count();
  await page.getByRole("button", { name: "+ Add rule", exact: true }).click();
  await expect(page.locator(".rule-card")).toHaveCount(before + 1);
  await page.locator(".rule-card").filter({ has: page.locator('input[value="New rule"]') }).getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page.locator(".rule-card")).toHaveCount(before);
  await fitsViewport(page);
});

test("configuration preserves unsaved edits when a host snapshot arrives", async ({ page }) => {
  await openView(page);
  await field(page, "Label").locator("input").fill("My unsaved provider");
  const changed = snapshot();
  changed.layers.global!.providers![0]!.label = "Changed on disk";
  await host(page, { type: "harness", snapshot: changed });
  await expect(page.getByText("configuration changed on disk", { exact: false })).toBeVisible();
  await expect(field(page, "Label").locator("input")).toHaveValue("My unsaved provider");
  await page.getByRole("button", { name: "Discard my edits and reload" }).click();
  await expect(field(page, "Label").locator("input")).toHaveValue("Changed on disk");
});

test("flow editor: create, settings, cancel, save and dry run", async ({ page }) => {
  const errors = await openView(page);
  await page.getByRole("tab", { name: "Orchestrations" }).click();
  await page.getByRole("button", { name: "+ New orchestration" }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(1);
  await page.locator(".flow-node-gear").first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("tab", { name: "Appearance" }).click();
  await field(dialog, "Label").locator("input").fill("Temporary change");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator(".flow-node-name")).not.toContainText("Temporary change");
  await page.locator(".block-editor").getByRole("button", { name: /Save/ }).click();
  expect((await messages(page, "flow.save"))[0].flow.steps[0].id).toBe("work");
  await page.getByRole("button", { name: "Dry run", exact: true }).first().click();
  expect((await messages(page, "dryrun"))[0].flow).toBe("default");
  expect(errors).toEqual([]);
});

test("block settings remain visible in a short narrow panel", async ({ page }) => {
  await openView(page, "config", { width: 420, height: 440 });
  await page.getByRole("tab", { name: "Orchestrations" }).click();
  await page.getByRole("button", { name: "+ New orchestration" }).click();
  await page.locator(".flow-node-gear").first().click();
  const dialog = page.getByRole("dialog");
  const box = await dialog.boundingBox();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(440);
  await expect(dialog.getByRole("button", { name: "Done", exact: true })).toBeInViewport();
  await dialog.getByRole("tab", { name: "Completion actions" }).click();
  await fitsViewport(page);
  await dialog.getByRole("button", { name: "Done", exact: true }).focus();
  await page.keyboard.press("Tab");
  expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

for (const width of [320, 640, 960, 1280]) {
  test(`default flow editor fits a ${width}px panel`, async ({ page }) => {
    await openView(page, "config", { width });
    await page.getByRole("tab", { name: "Orchestrations", exact: true }).click();
    await page.locator(".flows-table tbody tr").first().getByRole("button", { name: "Edit", exact: true }).click();
    await expect(page.locator(".react-flow__node").first()).toBeVisible();
    await fitsViewport(page);
  });
}

test("chat: send, cancel, approvals, results and resume", async ({ page }) => {
  const errors = await openView(page, "chat", { width: 320 });
  const input = page.locator(".composer textarea");
  await input.fill("QA request");
  await input.press("Enter");
  expect((await messages(page, "chat.send"))[0].text).toBe("QA request");
  await host(page, { type: "status", running: true });
  await page.getByRole("button", { name: /Stop/ }).click();
  expect(await messages(page, "chat.cancel")).toHaveLength(1);
  await host(page, { type: "command.confirm", id: "cmd", command: "npm test", cwd: "C:/repo", reason: "new" });
  await page.getByRole("button", { name: "Allow once" }).click();
  expect((await messages(page, "command.answer"))[0]).toMatchObject({ id: "cmd", answer: "allow" });
  await host(page, { type: "status", running: false });
  await host(page, { type: "result", status: "succeeded", summary: "QA complete", files: ["a-very-long-file-name/".repeat(20)], canCommit: true });
  await fitsViewport(page);
  await page.getByRole("button", { name: "Keep on session branch" }).click();
  expect(await messages(page, "result.keep")).toHaveLength(1);
  await host(page, { type: "sessions", resumable: [{ id: "qa", message: "Resume QA", flow: "default", startedAt: 1, status: "paused" }] });
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  expect((await messages(page, "session.resume"))[0].id).toBe("qa");
  expect(errors).toEqual([]);
});
