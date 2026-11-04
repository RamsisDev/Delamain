import {
  FINDING_CATEGORIES,
  FINDING_ROUTES,
  FINDING_SEVERITIES,
  isFindingsDefault,
  type FindingsDefault,
  type FindingsRule,
  type FindingsWhen,
} from "@delamain/core";
import { LayerBadge } from "../components/badges";
import { Button, Checkbox, Chips, Field, FieldIssues, ListInput, OptionalText, Select, TextInput, TriState, cx, toOptions } from "../components/controls";
import { useReorder } from "../components/reorder";
import { useConfig } from "./ConfigContext";
import { editKeyedEntry, keepFindingsDefaultLast, removeKeyedEntry, reorderNamed, type WorkingConfig } from "./layers";

function oneOrMany<T extends string>(values: T[]): T | T[] | undefined {
  if (values.length === 0) return undefined;
  return values.length === 1 ? values[0] : values;
}

function asList<T extends string>(value: T | readonly T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? [...value] : [value as T];
}

type AffectsMode = "unset" | "none" | "any" | "list";

function FindingsRuleCard({
  rule,
  index,
  reorder,
  position,
}: {
  rule: FindingsRule;
  index: number;
  reorder: ReturnType<typeof useReorder>;
  position: number;
}) {
  const cfg = useConfig();
  const path = ["findings_routing", index];
  const owner = cfg.owner(path);
  const editable = cfg.editable(path);
  const owned = owner === cfg.destination;
  const disabled = !editable;
  const at = (...rest: (string | number)[]) => cfg.issuesAt([...path, ...rest]);
  const update = (mutate: (r: FindingsRule) => void) =>
    cfg.edit((d) => {
      editKeyedEntry(d, ["findings_routing"], "name", rule, mutate);
      keepFindingsDefaultLast(d);
    });
  const set = (key: keyof FindingsRule, value: unknown) =>
    update((r) => {
      const record = r as Record<string, unknown>;
      if (value === undefined) delete record[key];
      else record[key] = value;
    });
  const setWhen = (key: keyof FindingsWhen, value: unknown) =>
    update((r) => {
      const when = r.when as Record<string, unknown>;
      if (value === undefined) delete when[key];
      else when[key] = value;
    });
  const affects = rule.when.affects_ac;
  const mode: AffectsMode = affects === undefined ? "unset" : affects === "none" || affects === "any" ? affects : "list";

  return (
    <div className={cx("card", "rule-card", reorder.stateClass(position))} {...reorder.target(position)}>
      <div className="card-header">
        <span className={cx("drag-handle", disabled && "disabled")} title="Drag to reorder" {...reorder.handle(position, editable)}>
          ⋮⋮
        </span>
        <span className="rule-index">{position + 1}</span>
        <TextInput value={rule.name} disabled={!owned} onChange={(name) => set("name", name)} />
        <Checkbox label="Enabled" checked={rule.enabled !== false} disabled={disabled} onChange={(on) => set("enabled", on ? undefined : false)} />
        <LayerBadge layer={owner} />
        <span className="spacer" />
        {owned ? (
          <Button
            small
            variant="danger"
            onClick={() => cfg.edit((d) => removeKeyedEntry(d, ["findings_routing"], "name", rule.name))}
          >
            Remove
          </Button>
        ) : null}
      </div>
      <FieldIssues issues={[...at(), ...at("name"), ...at("when")]} />
      <div className="form-grid">
        <Field label="Category" wide issues={at("when", "category")}>
          <Chips options={FINDING_CATEGORIES} values={asList(rule.when.category)} disabled={disabled} onChange={(v) => setWhen("category", oneOrMany(v))} />
        </Field>
        <Field label="Severity" issues={at("when", "severity")}>
          <Chips options={FINDING_SEVERITIES} values={asList(rule.when.severity)} disabled={disabled} onChange={(v) => setWhen("severity", oneOrMany(v))} />
        </Field>
        <Field label="Autofix" issues={at("when", "autofix")}>
          <TriState value={rule.when.autofix} disabled={disabled} onChange={(v) => setWhen("autofix", v)} />
        </Field>
        <Field label="Behavior change" issues={at("when", "behavior_change")}>
          <TriState value={rule.when.behavior_change} disabled={disabled} onChange={(v) => setWhen("behavior_change", v)} />
        </Field>
        <Field label="Affects ACs" issues={cfg.issuesUnder([...path, "when", "affects_ac"])}>
          <div className="inline">
            <Select<AffectsMode>
              value={mode}
              disabled={disabled}
              options={[
                { value: "unset", label: "any value" },
                { value: "none", label: "none" },
                { value: "any", label: "at least one" },
                { value: "list", label: "one of…" },
              ]}
              onChange={(m) => setWhen("affects_ac", m === "unset" || m === undefined ? undefined : m === "list" ? (Array.isArray(affects) ? affects : ["AC1"]) : m)}
            />
            {mode === "list" ? (
              <ListInput value={affects as string[]} disabled={disabled} placeholder="AC1, AC2" onChange={(v) => setWhen("affects_ac", v)} />
            ) : null}
          </div>
        </Field>
        <Field label="Files" hint="Globs matched against the finding's file." issues={cfg.issuesUnder([...path, "when", "files"])}>
          <ListInput value={rule.when.files} disabled={disabled} placeholder="src/**" onChange={(v) => setWhen("files", v.length ? v : undefined)} />
        </Field>
        <Field label="Route" issues={at("route")}>
          <Select value={rule.route} options={toOptions(FINDING_ROUTES)} disabled={disabled} onChange={(v) => v && set("route", v)} />
        </Field>
        <Field label="Fix command" issues={at("fix")}>
          <OptionalText value={rule.fix} disabled={disabled} placeholder="make fmt FILES='{{finding.files}}'" onChange={(v) => set("fix", v)} />
        </Field>
        <Field label="Verify command" issues={at("verify")}>
          <OptionalText value={rule.verify} disabled={disabled} placeholder="make lint FILES='{{finding.files}}'" onChange={(v) => set("verify", v)} />
        </Field>
      </div>
    </div>
  );
}

function DefaultEntry({ entry, index }: { entry: FindingsDefault | undefined; index: number }) {
  const cfg = useConfig();
  const path = ["findings_routing", index];
  const owner = entry ? cfg.owner(path) : undefined;
  const disabled = !cfg.editable(path);
  const current = entry?.default ?? { route: "worker_then_qa" as const };
  const set = (key: keyof FindingsDefault["default"], value: unknown) =>
    cfg.edit((d: WorkingConfig) => {
      const list = (d.findings_routing ??= []);
      let target = list.find(isFindingsDefault);
      if (!target) {
        target = { default: structuredClone(current) };
        list.push(target);
      }
      const record = target.default as Record<string, unknown>;
      if (value === undefined) delete record[key];
      else record[key] = value;
      keepFindingsDefaultLast(d);
    });
  return (
    <div className="card default-card">
      <div className="card-header">
        <strong>Default</strong>
        <span className="muted">every finding no rule matched</span>
        <LayerBadge layer={owner} />
      </div>
      <FieldIssues issues={cfg.issuesAt(path)} />
      <div className="form-grid">
        <Field label="Route" issues={cfg.issuesAt([...path, "default", "route"])}>
          <Select value={current.route} options={toOptions(FINDING_ROUTES)} disabled={disabled} onChange={(v) => v && set("route", v)} />
        </Field>
        <Field label="Fix command" issues={cfg.issuesAt([...path, "default", "fix"])}>
          <OptionalText value={current.fix} disabled={disabled} onChange={(v) => set("fix", v)} />
        </Field>
        <Field label="Verify command" issues={cfg.issuesAt([...path, "default", "verify"])}>
          <OptionalText value={current.verify} disabled={disabled} onChange={(v) => set("verify", v)} />
        </Field>
      </div>
    </div>
  );
}

/** The bugbot's findings routing table: ordered rules, first match wins, then the default. */
export function FindingsRouting() {
  const cfg = useConfig();
  const routing = cfg.merged.findings_routing ?? [];
  const rules = routing.flatMap((entry, index) => (isFindingsDefault(entry) ? [] : [{ rule: entry, index }]));
  const defaultIndex = routing.findIndex(isFindingsDefault);
  const defaultEntry = defaultIndex >= 0 ? (routing[defaultIndex] as FindingsDefault) : undefined;

  const reorder = useReorder((from, to) =>
    cfg.edit((d) => {
      const layer = d.findings_routing ?? [];
      const layerRules = layer.filter((e): e is FindingsRule => !isFindingsDefault(e));
      const ordered = reorderNamed(
        rules.map((r) => r.rule),
        layerRules,
        from,
        to,
      );
      d.findings_routing = [...ordered, ...layer.filter(isFindingsDefault)];
    }),
  );

  const addRule = () =>
    cfg.edit((d) => {
      const names = new Set(rules.map((r) => r.rule.name));
      let name = "New finding rule";
      for (let n = 2; names.has(name); n++) name = `New finding rule ${n}`;
      (d.findings_routing ??= []).push({ name, when: { severity: "low" }, route: "report_only" });
      keepFindingsDefaultLast(d);
    });

  return (
    <section>
      <h3>Bugbot findings routing</h3>
      <p className="muted">The bugbot classifies; the first matching rule picks the route. Drag to reorder.</p>
      <FieldIssues issues={cfg.issuesAt(["findings_routing"])} />
      {rules.map(({ rule, index }, position) => (
        <FindingsRuleCard key={position} rule={rule} index={index} position={position} reorder={reorder} />
      ))}
      <Button onClick={addRule}>+ Add finding rule</Button>
      <DefaultEntry entry={defaultEntry} index={defaultIndex >= 0 ? defaultIndex : routing.length} />
    </section>
  );
}
