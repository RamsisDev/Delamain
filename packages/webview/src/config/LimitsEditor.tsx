import { DEFAULT_LIMITS } from "@delamain/core";
import { LayerBadge } from "../components/badges";
import { Field, NumberInput, Select, TextInput } from "../components/controls";
import { getIn, setInDraft } from "../util/deep";
import { useConfig } from "./ConfigContext";

interface NumberSpec {
  path: string[];
  label: string;
  min: number;
  step?: number | "any";
  hint?: string;
}

const NUMBERS: NumberSpec[] = [
  { path: ["max_loop_iterations"], label: "Max loop iterations", min: 1, hint: "A loop asking for more is rejected on save." },
  { path: ["max_nested_loops"], label: "Max nested loops", min: 1 },
  { path: ["worst_case_warning"], label: "Worst-case warning", min: 1, hint: "Warn when worker runs per task exceed this." },
  { path: ["max_escalations_per_task"], label: "Max escalations per task", min: 0 },
  { path: ["max_human_questions_per_session"], label: "Max human questions per session", min: 0 },
  { path: ["max_agent_turns"], label: "Max agent turns", min: 1, hint: "Tool-calling turns per agent run." },
  { path: ["output_tail_lines"], label: "Output tail lines", min: 1 },
  { path: ["session", "max_minutes"], label: "Session max minutes", min: 0, step: "any" },
  { path: ["session", "per_profile", "max_tokens"], label: "Per profile: max tokens", min: 1, hint: "Budget of each credential profile per session." },
  { path: ["session", "per_profile", "max_cost_usd"], label: "Per profile: max cost (USD)", min: 0, step: "any" },
];

/** Global caps (`limits`); part of the configuration working copy, saved with the config. */
export function LimitsEditor() {
  const cfg = useConfig();
  const limits = cfg.merged.limits ?? {};
  const field = (path: string[]) => {
    const full = ["limits", ...path];
    return {
      full,
      value: getIn(limits, path),
      fallback: getIn(DEFAULT_LIMITS, path),
      badge: <LayerBadge layer={cfg.owner(full)} />,
      disabled: !cfg.editable(full),
      issues: cfg.issuesAt(full),
      set: (value: unknown) => cfg.edit((d) => setInDraft(d, full, value)),
    };
  };
  const timeout = field(["command_timeout_default"]);
  const onTime = field(["session", "on_time_exhausted"]);

  return (
    <div className="card">
      <div className="section-title">Limits</div>
      <p className="muted">No flow can exceed these caps. An empty field falls back to the layer below.</p>
      <div className="form-grid">
        {NUMBERS.map((spec) => {
          const f = field(spec.path);
          return (
            <Field key={spec.path.join(".")} label={spec.label} hint={spec.hint} badge={f.badge} issues={f.issues}>
              <NumberInput
                value={f.value as number | undefined}
                min={spec.min}
                step={spec.step}
                placeholder={f.fallback === undefined ? undefined : String(f.fallback)}
                disabled={f.disabled}
                onChange={f.set}
              />
            </Field>
          );
        })}
        <Field label="Command timeout default" hint="e.g. 300s, 10m" badge={timeout.badge} issues={timeout.issues}>
          <TextInput
            value={timeout.value === undefined ? "" : String(timeout.value)}
            placeholder={String(timeout.fallback)}
            disabled={timeout.disabled}
            onChange={(text) => timeout.set(text === "" ? undefined : /^\d+(\.\d+)?$/.test(text) ? Number(text) : text)}
          />
        </Field>
        <Field label="When session time runs out" badge={onTime.badge} issues={onTime.issues}>
          <Select
            value={onTime.value as "fallback" | "ask_user" | undefined}
            empty="fallback (default)"
            disabled={onTime.disabled}
            options={[
              { value: "fallback", label: "fallback — next link of the chain" },
              { value: "ask_user", label: "ask_user — pause and ask" },
            ]}
            onChange={onTime.set}
          />
        </Field>
      </div>
    </div>
  );
}
