import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadHarness, mergeSources, presetSources } from "@delamain/core";
import { SessionStore, appendDecision, copyPreset, listSessions, readClosedEvents, readLayer, writeYaml } from "../src/index.ts";

describe("session store", () => {
  it("persists steps, values, conversations and events, and reloads them to resume", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-store-"));
    const store = new SessionStore(root, "s1");
    store.writeMeta({ id: "s1", message: "m", flow: "default", startedAt: 1, status: "running", settings: { flow: "default", approval: "auto" } });
    store.put("a/b", { status: "succeeded", outputs: { passed: true } });
    store.putValue("chain:a", { refs: ["x/y"], chosen: "x/y" });
    store.saveConversation("a/b", [{ role: "user", content: "hi" }]);
    store.appendEvent({ type: "warning", message: "one" });
    store.appendEvent({ type: "warning", message: "two" });

    const reopened = new SessionStore(root, "s1");
    expect(reopened.get("a/b")).toEqual({ status: "succeeded", outputs: { passed: true } });
    expect(reopened.getValue("chain:a")).toEqual({ refs: ["x/y"], chosen: "x/y" });
    expect(reopened.conversation("a/b")).toEqual([{ role: "user", content: "hi" }]);
    expect(reopened.appendEvent({ type: "warning", message: "three" }).seq).toBe(3);
    expect((await listSessions(root)).map((s) => s.id)).toEqual(["s1"]);

    await reopened.close();
    expect(existsSync(join(reopened.dir, "journal.jsonl"))).toBe(false);
    expect((await readClosedEvents(root, "s1")).map((e) => (e as { message: string }).message)).toEqual(["one", "two", "three"]);
  });
});

describe("layers", () => {
  it("Customize copies the preset without overwriting edits, and the copy loads cleanly", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "harness-layer-")), ".harness");
    const first = await copyPreset(dir);
    expect(first.some((p) => p.endsWith("workflows/default.yml"))).toBe(true);
    expect(first.some((p) => p.endsWith("decisions/_REFERENCE.md"))).toBe(true);
    writeFileSync(join(dir, "config.yml"), "schema_version: 1\n# mine\n");
    expect(await copyPreset(dir)).toEqual([]);
    expect(readFileSync(join(dir, "config.yml"), "utf8")).toContain("# mine");

    const project = await readLayer(dir, "project");
    expect(project.workflows.length).toBe(4);
    const harness = loadHarness(mergeSources(presetSources(), project));
    expect(harness.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(harness.flows.get("default")?.layer).toBe("project");
  });

  it("appends decisions to a schema-valid file per session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-decisions-"));
    const decision = { id: "D1", question: "Retry 409?", answer: "Yes, 3 times", decided_by: "human" as const, affects: ["AC2"] };
    await appendDecision(dir, "s1", decision);
    await appendDecision(dir, "s1", { ...decision, id: "D2", answer: "Supersedes D1: no" });
    const layer = await readLayer(dir, "project");
    const harness = loadHarness(mergeSources(presetSources(), layer));
    expect(harness.decisions.map((d) => d.id)).toEqual(["D1", "D2"]);
  });

  it("writes YAML keeping the comments of untouched parts", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "harness-yaml-")), "config.yml");
    writeFileSync(path, "schema_version: 1\n# keep me\nlimits:\n  max_loop_iterations: 4 # cap\n");
    await writeYaml(path, { schema_version: 1, limits: { max_loop_iterations: 4, max_nested_loops: 3 } });
    const text = readFileSync(path, "utf8");
    expect(text).toContain("# keep me");
    expect(text).toContain("# cap");
    expect(text).toContain("max_nested_loops: 3");
  });
});
