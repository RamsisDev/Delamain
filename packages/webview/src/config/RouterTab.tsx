import { DEFAULT_THRESHOLDS, type RouterDefault, type RouterRule, type SizeThreshold } from "@delamain/core";
import { LayerBadge } from "../components/badges";
import { Button, Checkbox, Field, FieldIssues, NumberInput, OptionalText, TextInput, cx } from "../components/controls";
import { TargetList, TargetPicker, targetOptions } from "../components/ModelTargets";
import { useReorder } from "../components/reorder";
import { setInDraft } from "../util/deep";
import { useConfig } from "./ConfigContext";
import { FindingsRouting } from "./FindingsRouting";
import { editKeyedEntry, removeKeyedEntry, reorderNamed } from "./layers";
import { RuleConditions } from "./RuleConditions";
import { Simulator } from "./Simulator";

function Thresholds() {
  const cfg = useConfig();
  const thresholds = cfg.merged.router?.thresholds;
  const sizes = ["short", "medium"] as const;
  const setThreshold = (size: (typeof sizes)[number], field: keyof SizeThreshold, value: number | undefined) =>
    cfg.edit((d) => {
      const current = { ...(thresholds?.[size] ?? DEFAULT_THRESHOLDS[size]) } as Partial<SizeThreshold>;
      if (value === undefined) delete current[field];
      else current[field] = value;
      setInDraft(d, ["router", "thresholds", size], current);
    });
  const margin = ["router", "context_margin_tokens"];
  return (
    <div className="card">
      <div className="section-title">Size thresholds</div>
      <p className="muted">A task is short or medium when both its tokens and files fit; anything bigger is large.</p>
      <div className="form-grid">
        {sizes.flatMap((size) =>
          (["max_tokens", "max_files"] as const).map((field) => {
            const path = ["router", "thresholds", size, field];
            return (
              <Field key={`${size}-${field}`} label={`${size} · ${field}`} badge={<LayerBadge layer={cfg.owner(path)} />} issues={cfg.issuesAt(path)}>
                <NumberInput
                  value={thresholds?.[size]?.[field] ?? DEFAULT_THRESHOLDS[size][field]}
                  min={1}
                  disabled={!cfg.editable(path)}
                  onChange={(v) => setThreshold(size, field, v)}
                />
              </Field>
            );
          }),
        )}
        <Field label="Context margin (tokens)" hint="Free tokens a model needs on top of the estimate. Default 2000." badge={<LayerBadge layer={cfg.owner(margin)} />} issues={cfg.issuesAt(margin)}>
          <NumberInput
            value={cfg.merged.router?.context_margin_tokens}
            min={0}
            placeholder="2000"
            disabled={!cfg.editable(margin)}
            onChange={(v) => cfg.edit((d) => setInDraft(d, margin, v))}
          />
        </Field>
      </div>
    </div>
  );
}

function RuleCard({ rule, index, reorder }: { rule: RouterRule; index: number; reorder: ReturnType<typeof useReorder> }) {
  const cfg = useConfig();
  const path = ["router", "rules", index];
  const owner = cfg.owner(path);
  const editable = cfg.editable(path);
  const owned = owner === cfg.destination;
  const disabled = !editable;
  const options = targetOptions(cfg.merged.models);
  const update = (mutate: (r: RouterRule) => void) => cfg.edit((d) => editKeyedEntry(d, ["router", "rules"], "name", rule, mutate));
  const set = (key: keyof RouterRule, value: unknown) =>
    update((r) => {
      const record = r as Record<string, unknown>;
      if (value === undefined) delete record[key];
      else record[key] = value;
    });

  return (
    <div className={cx("card", "rule-card", rule.enabled === false && "rule-disabled", reorder.stateClass(index))} {...reorder.target(index)}>
      <div className="card-header">
        <span className={cx("drag-handle", disabled && "disabled")} title={disabled ? `Defined in ${owner}` : "Drag to reorder"} {...reorder.handle(index, editable)}>
          ⋮⋮
        </span>
        <span className="rule-index">{index + 1}</span>
        <TextInput value={rule.name} disabled={!owned} title={owned ? undefined : "Inherited rules keep their name; edit other fields to override"} onChange={(name) => set("name", name)} />
        <Checkbox label="Enabled" checked={rule.enabled !== false} disabled={disabled} onChange={(on) => set("enabled", on ? undefined : false)} />
        <LayerBadge layer={owner} />
        <span className="spacer" />
        {owned ? (
          <Button small variant="danger" onClick={() => cfg.edit((d) => removeKeyedEntry(d, ["router", "rules"], "name", rule.name))}>
            Remove
          </Button>
        ) : null}
      </div>
      {editable && !owned ? <p className="muted">Inherited from {owner}: editing saves an override in {cfg.destination}.</p> : null}
      <FieldIssues issues={[...cfg.issuesAt(path), ...cfg.issuesAt([...path, "name"]), ...cfg.issuesAt([...path, "when"])]} />
      <Field label="Description">
        <OptionalText value={rule.description} disabled={disabled} onChange={(v) => set("description", v)} />
      </Field>
      <Field label="When">
        <RuleConditions when={rule.when} path={[...path, "when"]} issuesUnder={cfg.issuesUnder} disabled={disabled} onChange={(when) => set("when", when)} />
      </Field>
      <div className="form-grid">
        <Field label="Use" issues={cfg.issuesAt([...path, "use"])}>
          <TargetPicker value={rule.use} options={options} disabled={disabled} onChange={(v) => set("use", v ?? "")} />
        </Field>
        <Field label="Fallback (in order, at least one)" issues={cfg.issuesUnder([...path, "fallback"])}>
          <TargetList values={rule.fallback ?? []} options={options} disabled={disabled} onChange={(v) => set("fallback", v)} />
        </Field>
        <Field label="Stay local" hint="Only local providers; the principal's model is not appended.">
          <Checkbox label="stay_local" checked={rule.stay_local === true} disabled={disabled} onChange={(on) => set("stay_local", on ? true : undefined)} />
        </Field>
      </div>
    </div>
  );
}

function DefaultRoute() {
  const cfg = useConfig();
  const path = ["router", "default"];
  const current: RouterDefault = cfg.merged.router?.default ?? { use: "role:orchestrator", fallback: ["role:orchestrator-fallback"] };
  const options = targetOptions(cfg.merged.models);
  const disabled = !cfg.editable(path);
  const write = (next: RouterDefault) => cfg.edit((d) => setInDraft(d, path, next));
  return (
    <div className="card default-card">
      <div className="card-header">
        <strong>Default route</strong>
        <span className="muted">when no rule matches</span>
        <LayerBadge layer={cfg.owner(path)} />
      </div>
      <FieldIssues issues={[...cfg.issuesAt(["router"]), ...cfg.issuesAt(path)]} />
      <div className="form-grid">
        <Field label="Use" issues={cfg.issuesAt([...path, "use"])}>
          <TargetPicker value={current.use} options={options} disabled={disabled} onChange={(use) => write({ ...current, use: use ?? "" })} />
        </Field>
        <Field label="Fallback" issues={cfg.issuesUnder([...path, "fallback"])}>
          <TargetList values={current.fallback} options={options} disabled={disabled} onChange={(fallback) => write({ ...current, fallback })} />
        </Field>
      </div>
    </div>
  );
}

export function RouterTab() {
  const cfg = useConfig();
  const rules = cfg.merged.router?.rules ?? [];
  const reorder = useReorder((from, to) =>
    cfg.edit((d) => {
      const router = (d.router ??= {});
      router.rules = reorderNamed(rules, router.rules ?? [], from, to);
    }),
  );
  const addRule = () =>
    cfg.edit((d) => {
      const names = new Set(rules.map((r) => r.name));
      let name = "New rule";
      for (let n = 2; names.has(name); n++) name = `New rule ${n}`;
      const router = (d.router ??= {});
      (router.rules ??= []).push({ name, when: { kind: "small-edit" }, use: "role:worker", fallback: ["role:orchestrator-fallback"] });
    });

  return (
    <div className="tab-content">
      <h2>Router</h2>
      <Thresholds />
      <h3>Rules</h3>
      <p className="muted">Ordered: the first matching rule wins. Drag the handle to reorder.</p>
      <FieldIssues issues={cfg.issuesAt(["router", "rules"])} />
      {rules.map((rule, index) => (
        <RuleCard key={index} rule={rule} index={index} reorder={reorder} />
      ))}
      <Button onClick={addRule}>+ Add rule</Button>
      <DefaultRoute />
      <Simulator />
      <FindingsRouting />
    </div>
  );
}
