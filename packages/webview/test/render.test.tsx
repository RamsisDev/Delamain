import { describe, expect, it } from "vitest";
import type { ComponentType } from "react";
import { renderToString } from "react-dom/server";
import { Flow, parseYaml, reduceEvents, resolveLimits, type HarnessEvent, type HarnessEventBody } from "@delamain/core";
import { ConfigContext, createConfigModel } from "../src/config/ConfigContext";
import { ModelsTab } from "../src/config/ModelsTab";
import { OrchestrationsTab } from "../src/config/OrchestrationsTab";
import { ProvidersTab } from "../src/config/ProvidersTab";
import { RouterTab } from "../src/config/RouterTab";
import { ApprovalCard, BatchedDecisions, CommandCard, DecisionCard, ResultCard } from "../src/chat/Cards";
import { TaskTree } from "../src/chat/TaskTree";
import { BlockEditor } from "../src/editor/BlockEditor";
import { BlockSettingsDialog } from "../src/editor/BlockSettingsDialog";
import { flowToGraph } from "../src/editor/flow-graph";
import type { CanvasNode } from "../src/editor/nodes";
import { blockSections, retrySummary } from "../src/editor/PropertiesPanel";
import { globalLayer, presetFlow, snapshotWith } from "./fixtures";

// Server rendering in node: catches runtime errors in the components without a DOM.

function renderTab(Tab: ComponentType, working = structuredClone(globalLayer)) {
  const snapshot = snapshotWith(globalLayer);
  const { model } = createConfigModel(snapshot, "global", working, { health: {}, catalogs: {}, probes: {}, dryrun: undefined, saved: undefined }, () => undefined);
  return renderToString(
    <ConfigContext.Provider value={model}>
      <Tab />
    </ConfigContext.Provider>,
  );
}

describe("configuration tabs render", () => {
  it("providers: cards, profiles, headers and discovered servers", () => {
    const html = renderTab(ProvidersTab);
    expect(html).toContain("Credential profiles");
    expect(html).toContain("X-Title");
    expect(html).toContain("Ollama");
    expect(html).toContain("stored");
  });

  it("models: favorites first, then the catalog", () => {
    const html = renderTab(ModelsTab);
    expect(html.indexOf("Claude")).toBeLessThan(html.indexOf("Qwen 3"));
    expect(html).toContain("★");
    expect(html).toContain("☆");
  });

  it("router: rules with layer badges, simulator and findings routing", () => {
    const html = renderTab(RouterTab);
    expect(html).toContain("Docs");
    expect(html).toContain("Short tasks to short-task models");
    expect(html).toContain("layer-preset");
    expect(html).toContain("layer-global");
    expect(html).toContain("Task simulator");
    expect(html).toContain("Model chain");
    expect(html).toContain("Bugbot findings routing");
  });

  it("router: shows a schema error next to the field", () => {
    const working = structuredClone(globalLayer);
    working.router!.rules![0]!.fallback = [];
    const html = renderTab(RouterTab, working);
    expect(html).toContain("Every rule needs at least one backup model");
  });

  it("orchestrations: flow list and limits", () => {
    const html = renderTab(OrchestrationsTab);
    expect(html).toContain("single-agent");
    expect(html).toContain("Max loop iterations");
  });
});

describe("editor and chat render", () => {
  it("block editor shows the worst case of the default flow", () => {
    const flow = presetFlow("default");
    const html = renderToString(
      <BlockEditor
        source={{ name: "default", layer: "preset", flow }}
        destination="global"
        limits={resolveLimits(undefined)}
        context={{ agents: ["worker"], flows: ["default"], targets: [], known: [] }}
        onSave={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(html).toContain("worst-case-warning");
    expect(html).toContain(">36<");
    expect(html).toContain("verify-panel");
    expect(html).toContain("All checks pass");
    expect(html).toContain("Cycles only inside a Loop");
  });

  it("the ⚙ dialog holds every setting of a block in tabs", () => {
    const flow = Flow.parse(
      parseYaml(`
schema_version: 1
name: gear
steps:
  - { id: build, type: command, run: make build }
  - { id: code, type: agent, agent: worker, instructions: "Reuse the http helpers.", retries: 2, retry_delay: 10s, retry_backoff: 2, timeout: 5m }
`).value,
    ) as Flow;
    const nodes = flowToGraph(flow).nodes as CanvasNode[];
    const props = (blockId: string) => ({
      node: nodes.find((n) => n.data.block.id === blockId)!,
      nodes,
      flow,
      issues: [{ severity: "error" as const, path: ["steps", 1, "retries"], message: "too many" }],
      context: { agents: ["worker"], flows: [], targets: [], known: [] },
      onChange: () => undefined,
      onRename: () => undefined,
      onDependencies: () => undefined,
    });

    const agent = blockSections(props("code"), true);
    expect(agent.map((s) => s.title)).toEqual([
      "Instructions",
      "Agent & model",
      "Retries & timeout",
      "Inputs & outputs",
      "Connections",
      "Appearance",
      "Completion actions",
    ]);
    expect(agent.find((s) => s.id === "retries")!.errors).toBe(1);
    const dialog = renderToString(
      <BlockSettingsDialog block={props("code").node.data.block} sections={agent} onDone={() => undefined} onCancel={() => undefined} onDelete={() => undefined} />,
    );
    expect(dialog).toContain("Reuse the http helpers.");
    expect(dialog).toContain("tab-badge");
    const retries = renderToString(<>{agent.find((s) => s.id === "retries")!.content}</>).replaceAll("<!-- -->", "");
    expect(retries).toContain("Up to 3 attempts, waiting 10 s, then 20 s.");
    expect(retries).toContain("Timeout per attempt");

    expect(blockSections(props("build")).map((s) => s.title)).toEqual(["Command", "Connections", "Appearance", "Completion actions"]);
    expect(retrySummary({ id: "x", type: "agent", agent: "worker" })).toBe("Runs once: a failure fails the block.");
  });

  it("task tree and cards", () => {
    const bodies: HarnessEventBody[] = [
      { type: "session.started", message: "add retries", flow: "default", approval: "review" },
      { type: "task.started", task: "t1", goal: "rename", kind: "rename" },
      { type: "step.waiting", key: "build/t2/test-loop", block: "test-loop", blockType: "loop", waitingFor: ["t1"], task: "t2" },
      { type: "step.started", key: "build/t1/code", block: "code", blockType: "agent", task: "t1", attempt: 1, maxAttempts: 3 },
      { type: "router.decision", key: "build/t1/code", task: "t1", role: "worker", model: "jan/qwen", modelLabel: "Local Qwen", rule: "Short tasks", reason: "rule", chainIndex: 0, chain: [], warnings: [], skipped: [] },
      { type: "question.asked", id: "q1", question: "Retry 409?", options: [{ label: "Retry", recommended: true, impact: "partner docs" }, { label: "Fail" }], blocks: ["t2"], batched: false },
    ];
    const events = bodies.map((b, i) => ({ ...b, seq: i, ts: i, session: "s" }) as HarnessEvent);
    const view = reduceEvents(events);
    const tree = renderToString(
      <TaskTree rows={view.rows} text={view.text} expanded={new Set(["task:t1"])} onToggle={() => undefined} onAction={() => undefined} onOpen={() => undefined} running />,
    );
    expect(tree).toContain("Local Qwen");
    expect(tree).toContain("Other model");
    expect(tree).toContain("waiting for t1");

    const text = (html: string) => html.replaceAll("<!-- -->", "");
    const cards = text(renderToString(
      <>
        <DecisionCard question={view.questions[0]!} submitted={false} onSubmit={() => undefined} />
        <BatchedDecisions questions={view.questions} submitted={new Set()} onSubmit={() => undefined} />
        <CommandCard confirmation={{ id: "c", command: "rm -rf build", cwd: "/repo", reason: "destructive" }} onAnswer={() => undefined} />
        <ApprovalCard onAnswer={() => undefined} />
        <ResultCard result={{ status: "succeeded", summary: "Done", files: ["a.ts"], canCommit: true }} settled={false} onCommit={() => undefined} onKeep={() => undefined} onDiff={() => undefined} />
      </>,
    ));
    expect(cards).toContain("Decision needed · blocks t2 · everything else continues");
    expect(cards).toContain("1 decision collected");
    expect(cards).toContain("(recommended)");
    expect(cards).not.toContain("Always allow");
    expect(cards).toContain("Commit to my branch");
  });
});
