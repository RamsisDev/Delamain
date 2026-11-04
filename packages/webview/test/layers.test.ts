import { describe, expect, it } from "vitest";
import type { Issue, RouterRule } from "@delamain/core";
import {
  canEditFrom,
  editKeyedEntry,
  effectiveConfig,
  isDirty,
  layerToMergedPath,
  ownerOf,
  removeKeyedEntry,
  reorderNamed,
  validateWorking,
  type WorkingConfig,
} from "../src/config/layers";
import { issuesAt, issuesUnder } from "../src/util/issues";
import { setInDraft } from "../src/util/deep";
import { preset, snapshotWith } from "./fixtures";

const globalLayer: WorkingConfig = {
  schema_version: 1,
  providers: [{ id: "anthropic", type: "anthropic", profiles: [{ label: "Personal", secret: "anthropic.personal" }] }],
  models: [{ ref: "anthropic/claude", roles: ["orchestrator"] }],
  router: {
    rules: [{ name: "Docs", when: { kind: "docstring" }, use: "role:worker", fallback: ["anthropic/claude"] }],
  },
};

describe("issuesAt / issuesUnder", () => {
  const issues: Issue[] = [
    { severity: "error", path: ["router", "rules", 0, "fallback"], message: "needs a backup" },
    { severity: "warning", path: ["router", "rules", 0, "use"], message: "not a favorite" },
    { severity: "error", path: ["router", "rules", 1, "name"], message: "duplicate" },
  ];

  it("matches a field exactly, comparing indexes as strings", () => {
    expect(issuesAt(issues, ["router", "rules", 0, "fallback"]).map((i) => i.message)).toEqual(["needs a backup"]);
    expect(issuesAt(issues, ["router", "rules", "0", "use"])).toHaveLength(1);
    expect(issuesAt(issues, ["router", "rules", 0])).toEqual([]);
  });

  it("collects everything below a card", () => {
    expect(issuesUnder(issues, ["router", "rules", 0])).toHaveLength(2);
    expect(issuesUnder(issues, ["router"])).toHaveLength(3);
  });
});

describe("configuration layers", () => {
  const snapshot = snapshotWith(globalLayer);

  it("reports which layer each merged entry comes from", () => {
    const merged = effectiveConfig(snapshot, "global", globalLayer);
    const names = merged.config.router?.rules?.map((r) => r.name);
    expect(names?.[0]).toBe("Docs");
    expect(ownerOf(merged.origins, ["router", "rules", 0])).toBe("global");
    expect(ownerOf(merged.origins, ["router", "rules", 1, "use"])).toBe("preset");
    expect(ownerOf(merged.origins, ["limits", "max_loop_iterations"])).toBe("preset");
    expect(ownerOf(merged.origins, ["worktree", "setup"])).toBeUndefined();
    expect(canEditFrom("preset", "global")).toBe(true);
    expect(canEditFrom("project", "global")).toBe(false);
  });

  it("maps destination-layer paths to merged paths", () => {
    const project: WorkingConfig = {
      schema_version: 1,
      router: { rules: [{ name: "Secrets", when: { paths: ["src/secrets/**"] }, use: "role:short-tasks", fallback: [] }] },
    };
    const merged = effectiveConfig(snapshotWith(globalLayer, project), "project", project);
    expect(layerToMergedPath(merged.origins, "project", ["router", "rules", 0, "fallback"])).toEqual(["router", "rules", 0, "fallback"]);
    expect(layerToMergedPath(merged.origins, "global", ["router", "rules", 0, "use"])).toEqual(["router", "rules", 1, "use"]);
    expect(layerToMergedPath(merged.origins, "global", ["providers", 0, "type"])).toEqual(["providers", 0, "type"]);
  });

  it("copies an inherited entry into the destination when it is edited", () => {
    const draft = structuredClone(globalLayer);
    const merged = effectiveConfig(snapshot, "global", draft).config;
    const inherited = merged.router!.rules!.find((r) => r.name === "Tests and refactors")!;
    editKeyedEntry<RouterRule>(draft, ["router", "rules"], "name", inherited, (rule) => {
      rule.enabled = false;
    });
    expect(draft.router?.rules?.map((r) => r.name)).toEqual(["Docs", "Tests and refactors"]);
    expect(draft.router?.rules?.[1]?.enabled).toBe(false);
    expect(preset.router?.rules?.[1]?.enabled).toBeUndefined();

    editKeyedEntry<RouterRule>(draft, ["router", "rules"], "name", draft.router!.rules![0]!, (rule) => {
      rule.name = "Docstrings";
    });
    expect(draft.router?.rules?.map((r) => r.name)).toEqual(["Docstrings", "Tests and refactors"]);
    removeKeyedEntry(draft, ["router", "rules"], "name", "Docstrings");
    expect(draft.router?.rules?.map((r) => r.name)).toEqual(["Tests and refactors"]);
    expect(isDirty(snapshot, "global", draft)).toBe(true);
    expect(isDirty(snapshot, "global", structuredClone(globalLayer))).toBe(false);
  });

  it("reorders the destination's rules and copies a moved inherited rule", () => {
    const merged = effectiveConfig(snapshot, "global", globalLayer).config.router!.rules!;
    expect(merged.map((r) => r.name)).toEqual(["Docs", "Short tasks to short-task models", "Tests and refactors"]);
    const moved = reorderNamed(merged, globalLayer.router!.rules!, 2, 0);
    expect(moved.map((r) => r.name)).toEqual(["Tests and refactors", "Docs"]);
    expect(reorderNamed(merged, globalLayer.router!.rules!, 0, 0)).toEqual(globalLayer.router!.rules);
  });

  it("clears fields without leaving empty objects", () => {
    const draft: Record<string, unknown> = { limits: { session: { max_minutes: 30 } } };
    setInDraft(draft, ["limits", "session", "max_minutes"], undefined);
    expect(draft).toEqual({});
    setInDraft(draft, ["limits", "worst_case_warning"], 12);
    expect(draft).toEqual({ limits: { worst_case_warning: 12 } });
  });

  it("validates the working copy and only blocks on errors it introduced", () => {
    const ok = validateWorking(snapshot, "global", globalLayer, effectiveConfig(snapshot, "global", globalLayer));
    expect(ok.blocking).toEqual([]);

    const broken: WorkingConfig = structuredClone(globalLayer);
    broken.router!.rules![0]!.fallback = [];
    broken.providers!.push({ id: "local", type: "openai-compatible" });
    const result = validateWorking(snapshot, "global", broken, effectiveConfig(snapshot, "global", broken));
    const paths = result.blocking.map((i) => i.path.join("."));
    expect(paths).toContain("router.rules.0.fallback");
    expect(paths).toContain("providers.1.base_url");
  });
});
