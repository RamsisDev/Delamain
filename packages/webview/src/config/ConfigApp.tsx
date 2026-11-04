import { useCallback, useMemo, useRef, useState } from "react";
import type { DryRunReport, HarnessSnapshot, Health, Issue, ModelInfo, ToWebview } from "@delamain/core";
import { Pill } from "../components/badges";
import { Button, Collapsible, cx } from "../components/controls";
import { Tabs } from "../components/Tabs";
import { useHostConnection, useLatest, usePersistentState } from "../hooks";
import { clone, deepEqual } from "../util/deep";
import { formatIssuePath } from "../util/issues";
import { post } from "../vscode";
import { ConfigContext, createConfigModel, type ProbeResult, type SavedResult } from "./ConfigContext";
import { baselineOf, editKeyedEntry, isDirty, type Destination, type WorkingConfig } from "./layers";
import { ModelsTab } from "./ModelsTab";
import { OrchestrationsTab } from "./OrchestrationsTab";
import { ProvidersTab } from "./ProvidersTab";
import { RouterTab } from "./RouterTab";

type TabId = "providers" | "models" | "router" | "orchestrations";

function resolveDestination(wanted: Destination, snapshot: HarnessSnapshot | undefined): Destination {
  return wanted === "project" && snapshot && !snapshot.hasProject ? "global" : wanted;
}

function IssueSummary({ issues, title }: { issues: readonly Issue[]; title: string }) {
  if (!issues.length) return null;
  return (
    <Collapsible title={title} className="problems">
      <ul className="plain-list">
        {issues.map((issue, i) => (
          <li key={i} className={`issue-${issue.severity}`}>
            {issue.severity === "error" ? "✗" : "⚠"} {issue.file ? <span className="muted">{issue.file}: </span> : null}
            <code>{formatIssuePath(issue.path) || "(root)"}</code> {issue.message}
          </li>
        ))}
      </ul>
    </Collapsible>
  );
}

export function ConfigApp() {
  const [snapshot, setSnapshot] = useState<HarnessSnapshot>();
  const [wantedDestination, setWantedDestination] = usePersistentState<Destination>("destination", "global");
  const [working, setWorking] = useState<WorkingConfig>();
  const [tab, setTab] = usePersistentState<TabId>("tab", "providers");
  const [saved, setSaved] = useState<SavedResult>();
  const [saving, setSaving] = useState(false);
  const [liveHealth, setLiveHealth] = useState<Record<string, Health>>({});
  const [liveCatalogs, setLiveCatalogs] = useState<Record<string, ModelInfo[]>>({});
  const [probes, setProbes] = useState<Record<string, ProbeResult>>({});
  const [dryrun, setDryrun] = useState<DryRunReport>();
  const [changedOnDisk, setChangedOnDisk] = useState(false);

  const destination = resolveDestination(wantedDestination, snapshot);
  // Updated synchronously: two snapshots can arrive before React re-renders.
  const lastSnapshot = useRef<HarnessSnapshot>(undefined);

  const edit = useCallback((mutate: (draft: WorkingConfig) => void) => {
    setWorking((current) => {
      if (!current) return current;
      const draft = clone(current);
      mutate(draft);
      return draft;
    });
  }, []);

  const derived = useMemo(
    () =>
      snapshot && working
        ? createConfigModel(snapshot, destination, working, { health: liveHealth, catalogs: liveCatalogs, probes, dryrun, saved }, edit)
        : undefined,
    [snapshot, destination, working, liveHealth, liveCatalogs, probes, dryrun, saved, edit],
  );
  const latest = useLatest({ working, merged: derived?.model.merged });

  useHostConnection("config", (message: ToWebview) => {
    switch (message.type) {
      case "harness": {
        const previous = lastSnapshot.current;
        const current = latest.current.working;
        const next = message.snapshot;
        lastSnapshot.current = next;
        const dest = resolveDestination(wantedDestination, next);
        const localEdits = previous !== undefined && current !== undefined && isDirty(previous, dest, current);
        setSnapshot(next);
        setLiveHealth({});
        setLiveCatalogs({});
        if (!localEdits || !isDirty(next, dest, current)) {
          setWorking(baselineOf(next, dest));
          setChangedOnDisk(false);
        } else if (!deepEqual(baselineOf(previous, dest), baselineOf(next, dest))) {
          setChangedOnDisk(true);
        }
        break;
      }
      case "health":
        setLiveHealth((h) => ({ ...h, [message.provider]: message.health }));
        break;
      case "catalog":
        setLiveCatalogs((c) => ({ ...c, [message.provider]: message.models }));
        break;
      case "probe": {
        setProbes((p) => ({
          ...p,
          [message.ref]: {
            toolCalling: message.toolCalling,
            ...(message.contextWindow !== undefined ? { contextWindow: message.contextWindow } : {}),
            message:
              message.message ??
              (message.toolCalling === undefined ? "Could not detect tool calling" : `Detected: ${message.toolCalling ? "supports" : "no"} tool calling`),
          },
        }));
        const favorite = latest.current.merged?.models?.find((m) => m.ref === message.ref);
        if (favorite && message.toolCalling !== undefined) {
          const toolCalling = message.toolCalling;
          edit((d) =>
            editKeyedEntry(d, ["models"], "ref", favorite, (f) => {
              f.tool_calling = toolCalling;
            }),
          );
        }
        break;
      }
      case "saved":
        setSaving(false);
        setSaved({ ok: message.ok, issues: message.issues, ...(message.path ? { path: message.path } : {}), at: Date.now() });
        break;
      case "dryrun":
        setDryrun(message.report);
        setTab("orchestrations");
        break;
      default:
        break;
    }
  });

  if (!derived || !snapshot || !working) {
    return <div className="loading">Loading the harness configuration…</div>;
  }
  const { model, validation } = derived;

  const dirty = isDirty(snapshot, destination, working);
  const blocking = validation.blocking;
  const warnings = validation.issues.filter((i) => i.severity === "warning");
  const errorCount = validation.issues.filter((i) => i.severity === "error").length;

  const changeDestination = (next: Destination) => {
    setWantedDestination(next);
    setWorking(baselineOf(snapshot, next));
    setChangedOnDisk(false);
  };

  return (
    <ConfigContext.Provider value={model}>
      <div className="config-app">
        <header className="config-toolbar">
          <div className="destination" role="radiogroup" aria-label="Destination">
            <span className="field-label">Save to</span>
            {(["global", "project"] as const).map((d) => (
              <button
                key={d}
                type="button"
                role="radio"
                aria-checked={destination === d}
                className={cx("segment", destination === d && "segment-on")}
                disabled={(d === "project" && !snapshot.hasProject) || (dirty && destination !== d)}
                title={
                  d === "project" && !snapshot.hasProject
                    ? "Open a folder to use a project configuration"
                    : dirty && destination !== d
                      ? "Save or discard your changes first"
                      : snapshot.layerPaths[d]
                }
                onClick={() => changeDestination(d)}
              >
                {d === "global" ? "Global (all projects)" : "Project (.harness/, shared via git)"}
              </button>
            ))}
          </div>
          <span className="spacer" />
          {dirty ? <Pill tone="warning">unsaved changes</Pill> : null}
          {errorCount ? (
            <Pill tone="error" title={blocking.length ? undefined : "These errors come from other layers and do not block saving"}>
              {errorCount} error{errorCount === 1 ? "" : "s"}
            </Pill>
          ) : null}
          {warnings.length ? <Pill tone="warning">{warnings.length} warning{warnings.length === 1 ? "" : "s"}</Pill> : null}
          <Button
            variant="primary"
            disabled={!dirty || blocking.length > 0 || saving}
            title={!dirty ? "No changes" : blocking.length ? "Fix the errors first" : `Save to ${snapshot.layerPaths[destination] ?? destination}`}
            onClick={() => {
              setSaving(true);
              setSaved(undefined);
              post({ type: "config.save", destination, config: working });
            }}
          >
            {saving ? "Saving…" : "Save"}
          </Button>
          <Button disabled={!dirty} onClick={() => changeDestination(destination)}>
            Discard
          </Button>
          <Button onClick={() => post({ type: "config.open", destination })} title={snapshot.layerPaths[destination]}>
            Open YAML
          </Button>
          <Button onClick={() => post({ type: "config.import" })}>Import</Button>
          <Button onClick={() => post({ type: "config.export" })}>Export</Button>
        </header>

        <div className="banners">
          {!snapshot.trusted ? (
            <div className="banner banner-warning">Untrusted workspace: commands, scripts and subflows from .harness/ will not run.</div>
          ) : null}
          {changedOnDisk ? (
            <div className="banner banner-warning">
              The {destination} configuration changed on disk. Your unsaved edits are kept.{" "}
              <Button small onClick={() => changeDestination(destination)}>
                Discard my edits and reload
              </Button>
            </div>
          ) : null}
          {saved ? (
            saved.ok ? (
              <div className="banner banner-ok">
                ✓ Saved{saved.path ? ` to ${saved.path}` : ""}.{" "}
                <Button small variant="link" onClick={() => setSaved(undefined)}>
                  Dismiss
                </Button>
              </div>
            ) : (
              <div className="banner banner-error">
                ✗ Not saved.
                <ul className="plain-list">
                  {saved.issues.map((issue, i) => (
                    <li key={i} className={`issue-${issue.severity}`}>
                      <code>{formatIssuePath(issue.path) || "(root)"}</code> {issue.message}
                    </li>
                  ))}
                </ul>
                <Button small variant="link" onClick={() => setSaved(undefined)}>
                  Dismiss
                </Button>
              </div>
            )
          ) : null}
          <IssueSummary issues={validation.issues} title={`Validation (${validation.issues.length})`} />
          <IssueSummary issues={snapshot.issues} title={`Problems in configuration files (${snapshot.issues.length})`} />
        </div>

        <Tabs<TabId>
          active={tab}
          onChange={setTab}
          tabs={[
            { id: "providers", label: "Providers", badge: tabBadge(validation.issues, "providers") },
            { id: "models", label: "Models", badge: tabBadge(validation.issues, "models") },
            { id: "router", label: "Router", badge: tabBadge(validation.issues, "router", "findings_routing") },
            { id: "orchestrations", label: "Orchestrations", badge: tabBadge(validation.issues, "limits", "defaults") },
          ]}
        />
        <main className="config-main">
          {tab === "providers" ? <ProvidersTab /> : null}
          {tab === "models" ? <ModelsTab /> : null}
          {tab === "router" ? <RouterTab /> : null}
          {tab === "orchestrations" ? <OrchestrationsTab /> : null}
        </main>
      </div>
    </ConfigContext.Provider>
  );
}

function tabBadge(issues: readonly Issue[], ...sections: string[]) {
  const count = issues.filter((i) => i.severity === "error" && sections.includes(String(i.path[0]))).length;
  return count ? <span className="tab-badge">{count}</span> : null;
}
