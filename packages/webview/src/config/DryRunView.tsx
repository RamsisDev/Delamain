import type { DryRunReport } from "@delamain/core";
import { FieldIssues } from "../components/controls";
import { BLOCK_META } from "../editor/block-defaults";

export function DryRunView({ report, onClose }: { report: DryRunReport; onClose: () => void }) {
  const { worstCase } = report;
  return (
    <div className="card dryrun">
      <div className="card-header">
        <strong>Dry run: {report.flow}</strong>
        <span className="muted">no tokens spent</span>
        <span className="spacer" />
        <button type="button" className="btn btn-link btn-small" onClick={onClose}>
          Close
        </button>
      </div>
      <ul className="dryrun-steps">
        {report.steps.map((step, i) => (
          <li key={i} style={{ paddingLeft: step.depth * 18 }}>
            <span className={`flow-node-icon family-${BLOCK_META[step.type].family}`}>{BLOCK_META[step.type].icon}</span>{" "}
            <strong>{step.label}</strong> <span className="muted">{step.type}</span>
            {step.detail ? <span className="muted"> · {step.detail}</span> : null}
            {step.model ? (
              <span>
                {" "}
                → <strong>{step.model}</strong>
                {step.rule ? <span className="muted"> (rule: {step.rule})</span> : null}
              </span>
            ) : null}
            {step.chain?.length ? <div className="muted dryrun-chain">chain: {step.chain.join(" → ")}</div> : null}
            {step.warnings?.map((w, j) => (
              <div key={j} className="issue-warning">
                ⚠ {w}
              </div>
            ))}
          </li>
        ))}
      </ul>
      <p>
        Worst case: <strong>{worstCase.perModel}</strong> worker runs per task per model
        {worstCase.total !== undefined ? (
          <>
            , <strong>{worstCase.total}</strong> across the model chain
          </>
        ) : null}
        {worstCase.loops.length ? <span className="muted"> ({worstCase.loops.map((l) => `${l.id} ${l.max}`).join(" × ")})</span> : null}
      </p>
      <FieldIssues issues={report.issues} />
    </div>
  );
}
