import { useEffect, useMemo, useState } from "react";
import { resolveLimits, type Flow } from "@delamain/core";
import { LayerBadge, Pill } from "../components/badges";
import { Button } from "../components/controls";
import { targetOptions } from "../components/ModelTargets";
import { BlockEditor, type FlowDraftSource } from "../editor/BlockEditor";
import type { EditorContext } from "../editor/PropertiesPanel";
import { post } from "../vscode";
import { useConfig } from "./ConfigContext";
import { DryRunView } from "./DryRunView";
import { LimitsEditor } from "./LimitsEditor";

function uniqueName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

export function OrchestrationsTab() {
  const cfg = useConfig();
  const flows = cfg.snapshot.flows;
  const names = useMemo(() => new Set(flows.map((f) => f.name)), [flows]);
  const [editing, setEditing] = useState<FlowDraftSource>();
  const [editorKey, setEditorKey] = useState(0);
  const [pendingSave, setPendingSave] = useState<{ flow: Flow; at: number }>();
  const [hiddenReport, setHiddenReport] = useState<unknown>();

  useEffect(() => {
    if (!pendingSave || !cfg.saved || cfg.saved.at < pendingSave.at) return;
    if (cfg.saved.ok) {
      const saved = pendingSave.flow;
      setEditing((source) => source && { ...source, name: saved.name, flow: saved, layer: cfg.destination, isNew: false });
    }
    setPendingSave(undefined);
  }, [cfg.saved, pendingSave, cfg.destination]);

  const open = (source: FlowDraftSource) => {
    setEditing(source);
    setEditorKey((k) => k + 1);
  };

  const subflows = cfg.snapshot.subflows;
  const context: EditorContext = useMemo(
    () => ({
      agents: cfg.snapshot.agents.map((a) => a.name),
      flows: flows.map((f) => f.name),
      targets: targetOptions(cfg.merged.models),
      known: [
        ...flows.map((f) => ({ ref: f.name, label: `${f.name} (orchestration)`, flow: f.flow, ...(f.invalid ? { invalid: true } : {}) })),
        ...subflows.map((s) => ({ ref: s.ref, label: `${s.name} (flows/)`, flow: s.flow })),
      ],
      config: { providers: cfg.merged.providers, models: cfg.merged.models },
    }),
    [cfg.snapshot.agents, flows, subflows, cfg.merged.models, cfg.merged.providers],
  );
  const limits = useMemo(() => resolveLimits(cfg.merged.limits), [cfg.merged.limits]);
  const defaultFlow = cfg.merged.defaults?.flow;

  return (
    <div className="tab-content">
      <h2>Orchestrations</h2>
      {!cfg.snapshot.trusted ? (
        <p className="issue-warning">Untrusted workspace: commands, scripts and subflows from .harness/ will not run.</p>
      ) : null}
      <div className="table-scroll" role="region" aria-label="Orchestrations" tabIndex={0}>
        <table className="table flows-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Layer</th>
              <th>File</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {flows.map((entry) => (
              <tr key={`${entry.layer}:${entry.name}`} className={editing?.name === entry.name && !editing.isNew ? "row-selected" : undefined}>
                <td>
                  <strong>{entry.name}</strong> {entry.name === defaultFlow ? <Pill>default</Pill> : null}
                  {entry.flow.reusable ? <Pill title="Other flows can run it with a Subflow block">reusable</Pill> : null}
                  {entry.invalid ? (
                    <Pill tone="error" title="This flow has errors: fix it to run it">
                      invalid
                    </Pill>
                  ) : null}
                  {entry.flow.description ? <div className="muted">{entry.flow.description}</div> : null}
                </td>
                <td>
                  <LayerBadge layer={entry.layer} />
                </td>
                <td className="muted path-cell" title={entry.path}>
                  {entry.path}
                </td>
                <td className="actions-cell">
                  <Button small variant="primary" onClick={() => open({ name: entry.name, layer: entry.layer, path: entry.path, flow: entry.flow })}>
                    Edit
                  </Button>
                  <Button
                    small
                    onClick={() => {
                      const name = uniqueName(`${entry.name}-copy`, names);
                      open({ name, layer: cfg.destination, flow: { ...entry.flow, name }, isNew: true });
                    }}
                  >
                    Duplicate
                  </Button>
                  <Button small onClick={() => post({ type: "dryrun", flow: entry.name })}>
                    Dry run
                  </Button>
                  {entry.layer === cfg.destination ? (
                    <Button small variant="danger" onClick={() => post({ type: "flow.delete", destination: cfg.destination, name: entry.name })}>
                      Delete
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Button
        onClick={() => {
          const name = uniqueName("new-flow", names);
          open({
            name,
            layer: cfg.destination,
            isNew: true,
            flow: { schema_version: 1, name, steps: [{ id: "work", type: "agent", agent: "worker" }] },
          });
        }}
      >
        + New orchestration
      </Button>

      {cfg.dryrun && cfg.dryrun !== hiddenReport ? <DryRunView report={cfg.dryrun} onClose={() => setHiddenReport(cfg.dryrun)} /> : null}

      {editing ? (
        <BlockEditor
          key={editorKey}
          source={editing}
          destination={cfg.destination}
          limits={limits}
          context={context}
          onClose={() => setEditing(undefined)}
          onSave={(flow, previousName) => {
            setPendingSave({ flow, at: Date.now() });
            post({ type: "flow.save", destination: cfg.destination, name: flow.name, flow, ...(previousName ? { previousName } : {}) });
          }}
        />
      ) : null}

      <LimitsEditor />
    </div>
  );
}
