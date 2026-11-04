import { useMemo } from "react";
import {
  ROUTER_ROLES,
  TASK_KINDS,
  buildCatalog,
  route,
  type DiscoveredModels,
  type RouteDecision,
  type RouteRequest,
} from "@delamain/core";
import { Checkbox, Field, ListInput, NumberInput, Select, toOptions } from "../components/controls";
import { usePersistentState } from "../hooks";
import { useConfig, type ConfigModel } from "./ConfigContext";

function discoveredModels(cfg: ConfigModel): DiscoveredModels[] {
  const out: DiscoveredModels[] = Object.entries(cfg.catalogs).map(([provider, models]) => ({ provider, models }));
  for (const server of cfg.snapshot.discovered) {
    if (!cfg.catalogs[server.id]) out.push({ provider: server.id, models: server.models.map((id) => ({ id })) });
  }
  return out;
}

const SAMPLE: RouteRequest = { role: "worker", kind: "feature", est_tokens: 8000, files: 2, paths: [], needs_tools: true };

/** Routes a sample task locally with core `route()`, using the merged working configuration. */
export function Simulator() {
  const cfg = useConfig();
  const [request, setRequest] = usePersistentState<RouteRequest>("simulator", SAMPLE);
  const set = (patch: Partial<RouteRequest>) => setRequest((r) => ({ ...r, ...patch }));

  const result = useMemo((): { decision: RouteDecision } | { error: string } => {
    try {
      const catalog = buildCatalog(cfg.merged, discoveredModels(cfg));
      return { decision: route(request, cfg.merged, catalog, { now: Date.now(), providers: {} }) };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }, [request, cfg]);

  return (
    <div className="card simulator">
      <div className="section-title">Task simulator</div>
      <div className="form-grid">
        <Field label="Role">
          <Select value={request.role} options={toOptions(ROUTER_ROLES)} onChange={(role) => role && set({ role })} />
        </Field>
        <Field label="Kind">
          <Select
            value={request.kind}
            empty="(none)"
            options={toOptions(TASK_KINDS)}
            onChange={(kind) => setRequest(({ kind: _old, ...rest }) => (kind ? { ...rest, kind } : rest))}
          />
        </Field>
        <Field label="Estimated tokens">
          <NumberInput value={request.est_tokens} min={0} onChange={(v) => set({ est_tokens: v ?? 0 })} />
        </Field>
        <Field label="Files">
          <NumberInput value={request.files} min={0} onChange={(v) => set({ files: v ?? 0 })} />
        </Field>
        <Field label="Paths" hint="Comma separated">
          <ListInput value={request.paths} placeholder="src/api/orders.ts" onChange={(paths) => set({ paths })} />
        </Field>
        <Field label="Max cost (USD)">
          <NumberInput
            value={request.max_cost}
            step="any"
            min={0}
            onChange={(v) => setRequest(({ max_cost: _old, ...rest }) => (v === undefined ? rest : { ...rest, max_cost: v }))}
          />
        </Field>
        <Field label="Tools">
          <Checkbox label="Needs tool calling" checked={request.needs_tools} onChange={(needs_tools) => set({ needs_tools })} />
        </Field>
      </div>
      {"error" in result ? <p className="issue-error">The router failed: {result.error}</p> : <DecisionView decision={result.decision} />}
    </div>
  );
}

function DecisionView({ decision }: { decision: RouteDecision }) {
  const skipped = new Map(decision.skipped.map((s) => [s.ref, s.reason]));
  return (
    <div className="decision">
      <div className="decision-summary">
        <span>
          Size <strong>{decision.size}</strong>
        </span>
        <span>
          Rule <strong>{decision.rule}</strong> <span className="muted">({decision.reason})</span>
        </span>
        <span>
          Chosen{" "}
          {decision.chosen ? (
            <strong className="status-succeeded">
              {decision.chosen.model.label} <code>{decision.chosen.ref}</code>
            </strong>
          ) : (
            <strong className="issue-error">no model available</strong>
          )}
        </span>
        {decision.stayLocal ? <span className="pill">stay local</span> : null}
      </div>
      {decision.evaluations.length ? (
        <table className="table">
          <thead>
            <tr>
              <th>Rule</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {decision.evaluations.map((e, i) => (
              <tr key={i} className={e.matched ? "row-ok" : undefined}>
                <td>{e.rule}</td>
                <td>
                  {e.matched
                    ? "✓ matched"
                    : e.failed === "skipped"
                      ? "– an earlier rule matched"
                      : e.failed === "disabled"
                        ? "– disabled"
                        : `✗ ${e.failed} does not match`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <div className="section-title">Model chain</div>
      <ol className="chain">
        {decision.chain.map((link, i) => (
          <li key={link.ref} className={i === decision.chosenIndex ? "chosen" : skipped.has(link.ref) ? "skipped" : undefined}>
            <strong>{link.model.label}</strong> <code>{link.ref}</code> <span className="muted">from {link.source}</span>
            {i === decision.chosenIndex ? <span className="status-succeeded"> ★ chosen</span> : null}
            {skipped.has(link.ref) ? <span className="issue-warning"> skipped: {skipped.get(link.ref)}</span> : null}
          </li>
        ))}
        {decision.chain.length === 0 ? <li className="muted">Empty chain: no favorite resolves for this rule.</li> : null}
      </ol>
      {decision.warnings.map((w, i) => (
        <div key={i} className="issue-warning">
          ⚠ {w}
        </div>
      ))}
    </div>
  );
}
