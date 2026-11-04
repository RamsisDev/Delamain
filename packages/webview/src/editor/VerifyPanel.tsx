import type { FlowCheck, Issue } from "@delamain/core";
import { Button, cx } from "../components/controls";
import { formatIssuePath } from "../util/issues";
import type { Advice, Fix } from "./fixes";
import type { CheckResult, CheckStatus } from "./verify";

const ICONS: Record<CheckStatus, string> = { pass: "✓", warning: "⚠", error: "✗" };

/**
 * The flow's checks as a checklist with every problem listed under its check, explained, and
 * fixable in one click where there is an obvious fix. Selecting a check highlights it on the canvas.
 */
export function VerifyPanel({
  checks,
  focus,
  onFocus,
  advise,
  onSelect,
  onFix,
}: {
  checks: readonly CheckResult[];
  focus: FlowCheck | undefined;
  onFocus: (check: FlowCheck | undefined) => void;
  advise: (issue: Issue) => Advice;
  onSelect: (blockId: string) => void;
  onFix: (fix: Fix) => void;
}) {
  const failing = checks.filter((c) => c.status === "error").length;
  const warned = checks.filter((c) => c.status === "warning").length;
  return (
    <div className="verify-panel">
      <div className="verify-header">
        <strong>Verify</strong>
        {failing ? (
          <span className="issue-error">
            {failing} of {checks.length} checks fail
          </span>
        ) : (
          <span className="verify-ok">All checks pass{warned ? ` (${warned} with warnings)` : ""}</span>
        )}
        {focus ? (
          <button type="button" className="btn-link" onClick={() => onFocus(undefined)}>
            Clear highlight
          </button>
        ) : null}
      </div>
      <ul className="verify-list">
        {checks.map((check) => (
          <li key={check.id}>
            <button
              type="button"
              className={cx("verify-check", `verify-${check.status}`, focus === check.id && "active")}
              aria-pressed={focus === check.id}
              title={check.nodes.length || check.edges.length ? "Highlight on the canvas" : "Nothing to highlight"}
              onClick={() => onFocus(focus === check.id ? undefined : check.id)}
            >
              <span className="verify-icon">{ICONS[check.status]}</span>
              <span className="verify-label">{check.label}</span>
              {check.detail ? <span className="verify-detail">{check.detail}</span> : null}
            </button>
            {check.issues.length ? (
              <ul className="verify-issues">
                {check.issues.map((issue, i) => {
                  const advice = advise(issue);
                  return (
                    <li key={i} className={`verify-issue issue-${issue.severity}`}>
                      <div>
                        {issue.severity === "error" ? "✗" : "⚠"}{" "}
                        {advice.blockId ? (
                          <button
                            type="button"
                            className="btn-link link-inline"
                            title="Select the block"
                            onClick={() => {
                              onSelect(advice.blockId!);
                              onFocus(check.id);
                            }}
                          >
                            {advice.blockId}
                          </button>
                        ) : (
                          <span className="muted">{formatIssuePath(issue.path) || "flow"}</span>
                        )}
                        : {issue.message}
                      </div>
                      {advice.hint ? <div className="verify-hint">{advice.hint}</div> : null}
                      {advice.fixes.length ? (
                        <div className="verify-fixes">
                          {advice.fixes.map((fix) => (
                            <Button key={fix.label} small onClick={() => onFix(fix)}>
                              {fix.label}
                            </Button>
                          ))}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
