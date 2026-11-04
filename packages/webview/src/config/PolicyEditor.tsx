import { AUTO_TRIGGERS, type EscalationPolicy, type Issue } from "@delamain/core";
import { Button, Checkbox, Field, NumberInput, Select, toOptions } from "../components/controls";
import { withoutUndefined } from "../util/deep";
import { issuesAt } from "../util/issues";

/** Escalation policy of one flow (`policy.escalation`). Unset fields use the engine defaults. */
export function PolicyEditor({
  policy,
  onChange,
  issues,
}: {
  policy: EscalationPolicy | undefined;
  onChange: (policy: EscalationPolicy | undefined) => void;
  issues: Issue[];
}) {
  const current = policy ?? {};
  const set = <K extends keyof EscalationPolicy>(key: K, value: EscalationPolicy[K] | undefined) => {
    const next = withoutUndefined({ ...current, [key]: value });
    onChange(Object.keys(next).length ? next : undefined);
  };
  const at = (key: string) => issuesAt(issues, ["policy", "escalation", key]);
  const triggers = current.auto_triggers;

  return (
    <div className="form-grid">
      <Field label="Triage" hint="The principal always receives escalations first." issues={at("triage")}>
        <Select value={current.triage} empty="principal (default)" options={toOptions(["principal"] as const)} onChange={(v) => set("triage", v)} />
      </Field>
      <Field label="Automatic escalations" hint={triggers === undefined ? "Not set: every trigger is enabled." : undefined} issues={at("auto_triggers")} wide>
        <div className="checkbox-row">
          {AUTO_TRIGGERS.map((trigger) => (
            <Checkbox
              key={trigger}
              label={trigger}
              checked={triggers === undefined || triggers.includes(trigger)}
              onChange={(on) => {
                const base = triggers ?? [...AUTO_TRIGGERS];
                set("auto_triggers", on ? AUTO_TRIGGERS.filter((t) => t === trigger || base.includes(t)) : base.filter((t) => t !== trigger));
              }}
            />
          ))}
          {triggers !== undefined ? (
            <Button small variant="link" onClick={() => set("auto_triggers", undefined)}>
              Reset to all
            </Button>
          ) : null}
        </div>
      </Field>
      <Field label="Max escalations per task" hint="Empty uses limits.max_escalations_per_task." issues={at("max_per_task")}>
        <NumberInput value={current.max_per_task} min={0} onChange={(v) => set("max_per_task", v)} />
      </Field>
      <Field label="Pause" issues={at("pause")}>
        <Select
          value={current.pause}
          empty="affected_only (default)"
          options={[
            { value: "affected_only", label: "affected_only — only the task and its dependents" },
            { value: "all", label: "all — the whole session" },
          ]}
          onChange={(v) => set("pause", v)}
        />
      </Field>
      <Field label="Persist decisions" issues={at("persist_decisions")}>
        <Select
          value={current.persist_decisions}
          empty="project (default)"
          options={[
            { value: "project", label: "project (.harness/decisions)" },
            { value: "global", label: "global" },
            { value: "none", label: "none" },
          ]}
          onChange={(v) => set("persist_decisions", v)}
        />
      </Field>
    </div>
  );
}
