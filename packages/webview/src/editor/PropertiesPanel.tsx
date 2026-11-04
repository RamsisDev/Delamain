import { useState, type ReactNode } from "react";
import {
  ON_EXHAUSTED,
  parseDuration,
  type AgentBlock,
  type Block,
  type FinishAction,
  type Flow,
  type FlowLibrary,
  type FlowValidationContext,
  type Issue,
  type ReviewBlock,
} from "@delamain/core";
import {
  Button,
  Checkbox,
  Field,
  FieldIssues,
  ListInput,
  NumberInput,
  OptionalText,
  Select,
  TextArea,
  TextInput,
  toOptions,
  type Option,
} from "../components/controls";
import { TargetList, TargetPicker } from "../components/ModelTargets";
import { formatDuration } from "../util/format";
import { issuesAt, issuesUnder } from "../util/issues";
import { BLOCK_META } from "./block-defaults";
import { currentDependencies, pathOfBlock, siblingsOf, withField, type GraphEdge } from "./flow-graph";
import type { CanvasNode } from "./nodes";

/** A flow a subflow block may point at; orchestrations only count once marked `reusable`. */
export interface KnownFlow {
  /** What the block writes in `flow`: an orchestration name, or flows/<file>.yml. */
  ref: string;
  label: string;
  flow: Flow;
  invalid?: boolean;
}

export interface EditorContext {
  agents: string[];
  flows: string[];
  targets: Option[];
  known: KnownFlow[];
  /** Set by the block editor from `known`. */
  library?: FlowLibrary;
  /** Providers and favorites, to check stay_local blocks. */
  config?: FlowValidationContext["config"];
}

const BASIC_WHEN = ["success", "failure", "always"] as const;
const REUSABLE_LIST = "reusable-flows";

/** success (default) / failure / always / expression. Choosing success removes the key. */
export function WhenPicker({ value, onChange }: { value: string | undefined; onChange: (value: string | undefined) => void }) {
  const basic = value === undefined || (BASIC_WHEN as readonly string[]).includes(value);
  const [typingExpression, setTypingExpression] = useState(!basic);
  const mode = !basic || typingExpression ? "expression" : (value ?? "success");
  return (
    <div className="when-picker">
      <Select<string>
        value={mode}
        options={[
          { value: "success", label: "on success (default)" },
          { value: "failure", label: "on failure" },
          { value: "always", label: "always" },
          { value: "expression", label: "when expression…" },
        ]}
        onChange={(next) => {
          setTypingExpression(next === "expression");
          if (next === "expression") return;
          onChange(next === "success" || next === undefined ? (value === "success" ? value : undefined) : next);
        }}
      />
      {mode === "expression" ? (
        <TextInput
          value={basic ? "" : value}
          placeholder="e.g. bugbot.needs_qa"
          onChange={(text) => onChange(text.trim() === "" ? undefined : text)}
        />
      ) : null}
    </div>
  );
}

function durationValue(text: string): string | number | undefined {
  if (text.trim() === "") return undefined;
  return /^\d+(\.\d+)?$/.test(text.trim()) ? Number(text) : text;
}

function recordToText(record: Record<string, string> | undefined): string {
  return Object.entries(record ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

function textToRecord(text: string): Record<string, string> | undefined {
  const entries = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const at = line.indexOf("=");
      return at < 0 ? [line, ""] : [line.slice(0, at).trim(), line.slice(at + 1).trim()];
    });
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function FinishActions({
  actions,
  onChange,
  issues,
}: {
  actions: FinishAction[] | undefined;
  onChange: (actions: FinishAction[] | undefined) => void;
  issues: (index: number) => Issue[];
}) {
  const list = actions ?? [];
  const set = (index: number, action: FinishAction | undefined) => {
    const next = [...list];
    if (action) next[index] = action;
    else next.splice(index, 1);
    onChange(next.length ? next : undefined);
  };
  return (
    <div className="finish-actions">
      {list.map((action, index) => {
        const kind = action.run_flow !== undefined ? "run_flow" : "run";
        return (
          <div className="finish-action" key={index}>
            <WhenPicker value={action.when} onChange={(when) => set(index, withAction(action, "when", when))} />
            <Select<"run" | "run_flow">
              value={kind}
              options={[
                { value: "run", label: "run command" },
                { value: "run_flow", label: "run subflow" },
              ]}
              onChange={(next) => {
                const target = action.run ?? action.run_flow ?? "";
                const { run: _run, run_flow: _flow, ...rest } = action;
                set(index, next === "run_flow" ? { ...rest, run_flow: target } : { ...rest, run: target });
              }}
            />
            <TextInput
              value={kind === "run" ? action.run : action.run_flow}
              placeholder={kind === "run" ? "git diff --stat" : "flows/verify.yml"}
              {...(kind === "run_flow" ? { list: REUSABLE_LIST } : {})}
              onChange={(text) => set(index, withAction(action, kind, text))}
            />
            <Button small variant="link" onClick={() => set(index, undefined)} title="Remove action">
              ✕
            </Button>
            <FieldIssues issues={issues(index)} />
          </div>
        );
      })}
      <Button small onClick={() => onChange([...list, { when: "always", run: "" }])}>
        + Completion action
      </Button>
    </div>
  );
}

function withAction(action: FinishAction, key: keyof FinishAction, value: string | undefined): FinishAction {
  const next: Record<string, unknown> = { ...action };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next as FinishAction;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="props-section">
      <h4>{title}</h4>
      {children}
    </section>
  );
}

export function EdgeProperties({
  edge,
  nodes,
  onWhen,
  onJoin,
  onDisconnect,
}: {
  edge: GraphEdge;
  nodes: CanvasNode[];
  onWhen: (when: string | undefined) => void;
  onJoin: (join: "all" | "any" | undefined) => void;
  onDisconnect: () => void;
}) {
  const source = nodes.find((n) => n.id === edge.source)?.data.block;
  const target = nodes.find((n) => n.id === edge.target)?.data.block;
  if (!source || !target) return null;
  return (
    <div className="props">
      <h3>
        Connection {source.id} → {target.id}
      </h3>
      {edge.data?.implicit ? (
        <p className="muted">Implicit: {target.id} has no `after`, so it waits for the previous block.</p>
      ) : null}
      <Field label={`Runs ${target.id}`} hint={`The condition belongs to ${target.id} and applies to all its incoming connections.`}>
        <WhenPicker key={target.id} value={target.when} onChange={onWhen} />
      </Field>
      <Field label="Join" hint="all waits for every dependency; any starts after the first one finishes.">
        <Select value={target.join} empty="all (default)" options={toOptions(["all", "any"] as const)} onChange={onJoin} />
      </Field>
      <Button variant="danger" small onClick={onDisconnect}>
        Remove connection
      </Button>
    </div>
  );
}

/** A titled group of a block's settings. `keys` are the block fields it edits, for error badges. */
export interface SettingsSection {
  id: string;
  title: string;
  keys: readonly string[] | "rest";
  content: ReactNode;
  errors: number;
}

export interface BlockSettingsProps {
  node: CanvasNode;
  nodes: CanvasNode[];
  flow: Flow;
  issues: Issue[];
  context: EditorContext;
  onChange: (block: Block) => void;
  onRename: (id: string) => void;
  onDependencies: (after: string[] | undefined) => void;
}

/** "Up to 3 attempts, waiting 10s, then 20s" for an agent or review block. */
export function retrySummary(block: AgentBlock | ReviewBlock): string {
  const retries = block.retries ?? 0;
  if (!retries) return "Runs once: a failure fails the block.";
  let delay: number | undefined;
  try {
    delay = block.retry_delay === undefined ? undefined : parseDuration(block.retry_delay);
  } catch {
    delay = undefined;
  }
  const waits = Array.from({ length: retries }, (_, i) => (delay ? formatDuration(delay * (block.retry_backoff ?? 1) ** i) : undefined));
  const timing = waits[0] ? `, waiting ${waits.join(", then ")}` : ", right away";
  return `Up to ${retries + 1} attempts${timing}.`;
}

function durationText(value: string | number | undefined): string {
  return value === undefined ? "" : String(value);
}

/**
 * Every setting of a block, grouped. The side panel shows the groups one under the other and
 * the ⚙ dialog as tabs, so both always offer the same settings.
 */
export function blockSections(props: BlockSettingsProps, roomy = false): SettingsSection[] {
  const { node, nodes, flow, issues, context, onChange, onRename, onDependencies } = props;
  const block = node.data.block;
  const base = pathOfBlock(flow, block.id) ?? [];
  const at = (...rest: (string | number)[]) => issuesAt(issues, [...base, ...rest]);
  const under = (...rest: (string | number)[]) => issuesUnder(issues, [...base, ...rest]);
  const set = (key: string, value: unknown) => onChange(withField(block, key, value));
  const siblings = siblingsOf(nodes, node.parentId).filter((n) => n.id !== node.id);
  const deps = currentDependencies(nodes, node.id);
  const timeout = (label: string, hint: string) => (
    <Field label={label} hint={hint} issues={at("timeout")}>
      <TextInput value={durationText(block.timeout)} placeholder="e.g. 300s, 10m" onChange={(t) => set("timeout", durationValue(t))} />
    </Field>
  );

  const sections: Omit<SettingsSection, "errors">[] = [];
  if (block.type === "agent" || block.type === "review") {
    sections.push(
      {
        id: "instructions",
        title: "Instructions",
        keys: ["instructions"],
        content: (
          <>
            <p className="muted">
              Added to the prompt of the {block.agent} agent only when this block runs, and kept when the router switches to a backup model.
              Use it for what is specific to this step: conventions to follow, files to read first, things to avoid.
            </p>
            <Field label="Instructions" issues={at("instructions")}>
              <TextArea
                value={block.instructions}
                rows={roomy ? 12 : 4}
                placeholder={"Follow the error handling in src/api/http.ts.\nDo not change the public API of the module."}
                onChange={(v) => set("instructions", v.trim() ? v : undefined)}
              />
            </Field>
          </>
        ),
      },
      {
        id: "model",
        title: "Agent & model",
        keys: ["agent", "model", "fallback", "stay_local"],
        content: (
          <>
            <datalist id="agent-names">
              {context.agents.map((a) => (
                <option key={a} value={a} />
              ))}
            </datalist>
            <Field label="Agent" issues={at("agent")}>
              <TextInput value={block.agent} list="agent-names" onChange={(v) => set("agent", v)} />
            </Field>
            <Field label="Model" hint="auto lets the router pick by rules." issues={at("model")}>
              <TargetPicker value={block.model} options={context.targets} empty="auto (router)" onChange={(v) => set("model", v)} />
            </Field>
            {block.model !== undefined || block.fallback !== undefined ? (
              <Field label="Fallback" issues={under("fallback")}>
                <TargetList values={block.fallback ?? []} options={context.targets} onChange={(v) => set("fallback", v.length ? v : undefined)} />
              </Field>
            ) : null}
            {block.type === "agent" ? (
              <Checkbox label="Stay local" checked={block.stay_local === true} onChange={(on) => set("stay_local", on ? true : undefined)} />
            ) : null}
          </>
        ),
      },
      {
        id: "retries",
        title: "Retries & timeout",
        keys: ["retries", "retry_delay", "retry_backoff", "timeout"],
        content: (
          <>
            <p className="muted">
              When the block fails, run it again. Model errors such as rate limits or outages already move to the next model of the chain and do
              not use a retry.
            </p>
            <Field label="Retries" hint="Extra attempts, 0 to 5." issues={at("retries")}>
              <NumberInput value={block.retries} min={0} onChange={(v) => set("retries", v)} />
            </Field>
            <Field label="Wait before retrying" hint="e.g. 10s. Empty retries right away." issues={at("retry_delay")}>
              <TextInput value={durationText(block.retry_delay)} placeholder="10s" onChange={(t) => set("retry_delay", durationValue(t))} />
            </Field>
            <Field label="Backoff" hint="Multiplies each following wait: 2 doubles it." issues={at("retry_backoff")}>
              <NumberInput value={block.retry_backoff} min={1} step="any" onChange={(v) => set("retry_backoff", v)} />
            </Field>
            {timeout("Timeout per attempt", "A timed-out attempt is stopped before the next one starts.")}
            <p className="retry-summary">{retrySummary(block)}</p>
          </>
        ),
      },
      block.type === "agent"
        ? {
            id: "data",
            title: "Inputs & outputs",
            keys: ["input", "output", "feedback"],
            content: (
              <>
                <Field label="Input" hint="Outputs passed as context, comma separated." issues={under("input")}>
                  <ListInput
                    value={block.input === undefined ? [] : Array.isArray(block.input) ? block.input : [block.input]}
                    onChange={(v) => set("input", v.length === 0 ? undefined : v.length === 1 && !Array.isArray(block.input) ? v[0] : v)}
                  />
                </Field>
                <Field label="Output" issues={at("output")}>
                  <OptionalText value={block.output} placeholder="e.g. spec" onChange={(v) => set("output", v)} />
                </Field>
                <Field label="Feedback" hint="Outputs fed back on the next loop attempt." issues={under("feedback")}>
                  <ListInput value={block.feedback} onChange={(v) => set("feedback", v.length ? v : undefined)} />
                </Field>
              </>
            ),
          }
        : {
            id: "data",
            title: "Review",
            keys: ["scope", "routing"],
            content: (
              <>
                <Field label="Scope" issues={at("scope")}>
                  <Select
                    value={block.scope}
                    empty="(default)"
                    options={toOptions(["task.diff", "session.diff", "working_tree"] as const)}
                    onChange={(v) => set("scope", v)}
                  />
                </Field>
                <Field label="Routing" hint="Findings routing table; empty means findings_routing." issues={at("routing")}>
                  <OptionalText value={block.routing} placeholder="findings_routing" onChange={(v) => set("routing", v)} />
                </Field>
              </>
            ),
          },
    );
  } else {
    const leaf = block.type !== "loop" && block.type !== "foreach" && block.type !== "subflow";
    sections.push({
      id: "type",
      title: BLOCK_META[block.type].label,
      keys: "rest",
      content: (
        <>
          <TypeFields block={block} at={at} set={set} context={context} issues={issues} base={base} />
          {leaf ? timeout("Timeout", "e.g. 300s, 10m.") : null}
        </>
      ),
    });
  }

  sections.push(
    {
      id: "connections",
      title: "Connections",
      keys: ["after", "when", "join"],
      content: (
        <>
          <Field label="Depends on" hint={block.after === undefined ? "Default: the previous block." : undefined} issues={under("after")}>
            <div className="deps">
              {siblings.length === 0 ? <span className="muted">No other blocks at this level.</span> : null}
              {siblings.map((s) => (
                <Checkbox
                  key={s.id}
                  label={s.data.block.id}
                  checked={deps.includes(s.data.block.id)}
                  onChange={(on) => onDependencies(on ? [...deps, s.data.block.id] : deps.filter((d) => d !== s.data.block.id))}
                />
              ))}
              {block.after !== undefined ? (
                <Button small variant="link" onClick={() => onDependencies(undefined)}>
                  Reset to default
                </Button>
              ) : null}
            </div>
          </Field>
          <Field label="Runs" issues={at("when")}>
            <WhenPicker key={block.id} value={block.when} onChange={(v) => set("when", v)} />
          </Field>
          <Field label="Join">
            <Select value={block.join} empty="all (default)" options={toOptions(["all", "any"] as const)} onChange={(v) => set("join", v)} />
          </Field>
        </>
      ),
    },
    {
      id: "appearance",
      title: "Appearance",
      keys: ["id", "label", "ui"],
      content: (
        <>
          <Field label="Id" hint="Conditions read this block's outputs as <id>.<output>." issues={at("id")}>
            <TextInput value={block.id} onChange={onRename} />
          </Field>
          <Field label="Label" hint="Shown on the canvas and in the chat instead of the id.">
            <OptionalText value={block.label} onChange={(v) => set("label", v)} />
          </Field>
        </>
      ),
    },
    {
      id: "finish",
      title: "Completion actions",
      keys: ["on_finish"],
      content: (
        <>
          <datalist id={REUSABLE_LIST}>
            {context.known
              .filter((entry) => entry.flow.name !== flow.name && context.library?.resolve(entry.ref) === entry.flow)
              .map((entry) => (
                <option key={entry.ref} value={entry.ref} label={entry.label} />
              ))}
          </datalist>
          <FinishActions actions={block.on_finish} onChange={(actions) => set("on_finish", actions)} issues={(i) => under("on_finish", i)} />
        </>
      ),
    },
  );

  const covered = new Set(sections.flatMap((s) => (s.keys === "rest" ? [] : s.keys)));
  return sections.map((section) => ({
    ...section,
    errors: issues.filter((issue) => {
      if (issue.severity !== "error" || issue.path.length <= base.length || !base.every((p, i) => String(p) === String(issue.path[i]))) return false;
      const key = String(issue.path[base.length]);
      return section.keys === "rest" ? !covered.has(key) : section.keys.includes(key);
    }).length,
  }));
}

export function BlockProperties({ onDelete, ...props }: BlockSettingsProps & { onDelete: () => void }) {
  const block = props.node.data.block;
  const meta = BLOCK_META[block.type];
  const base = pathOfBlock(props.flow, block.id) ?? [];
  return (
    <div className="props">
      <h3>
        <span className={`flow-node-icon family-${meta.family}`}>{meta.icon}</span> {meta.label}
      </h3>
      <FieldIssues issues={issuesAt(props.issues, base)} />
      {blockSections(props).map((section) => (
        <Section key={section.id} title={section.title}>
          {section.content}
        </Section>
      ))}
      <Button variant="danger" small onClick={onDelete}>
        Delete block{block.type === "loop" || block.type === "foreach" ? " and its contents" : ""}
      </Button>
    </div>
  );
}

function TypeFields({
  block,
  at,
  set,
  context,
  issues,
  base,
}: {
  block: Block;
  at: (...rest: (string | number)[]) => Issue[];
  set: (key: string, value: unknown) => void;
  context: EditorContext;
  issues: Issue[];
  base: (string | number)[];
}) {
  switch (block.type) {
    case "agent":
    case "review":
      return null;
    case "command":
      return (
        <>
          <Field label="Run" issues={at("run")}>
            <TextInput value={block.run} onChange={(v) => set("run", v)} />
          </Field>
          <Field label="Also run" hint="Must pass too, e.g. task.acceptance." issues={at("also_run")}>
            <OptionalText value={block.also_run} onChange={(v) => set("also_run", v)} />
          </Field>
          <Field label="Working directory" issues={at("cwd")}>
            <OptionalText value={block.cwd} placeholder="{{task.worktree}}" onChange={(v) => set("cwd", v)} />
          </Field>
          <Field label="Success codes" issues={issuesUnder(issues, [...base, "success_codes"])}>
            <ListInput
              value={block.success_codes?.map(String)}
              placeholder="0"
              onChange={(v) => {
                const codes = v.map(Number).filter(Number.isInteger);
                set("success_codes", codes.length ? codes : undefined);
              }}
            />
          </Field>
          <Field label="Parse" hint="none, json, json:<file>, junit:<file> or regex:<pattern>" issues={at("parse")}>
            <OptionalText value={block.parse} placeholder="junit:reports/junit.xml" onChange={(v) => set("parse", v)} />
          </Field>
          <Field label="Tail lines" issues={at("tail_lines")}>
            <NumberInput value={block.tail_lines} min={1} onChange={(v) => set("tail_lines", v)} />
          </Field>
        </>
      );
    case "condition":
      return (
        <>
          <Field label="Expression" hint="Its value is exposed as <id>.value." issues={at("expr")}>
            <TextInput value={block.expr} placeholder="tests.passed and not bugbot.needs_qa" onChange={(v) => set("expr", v)} />
          </Field>
        </>
      );
    case "loop": {
      const budget = block.budget ?? {};
      const setBudget = (key: "max_tokens" | "max_minutes", value: number | undefined) => {
        const next: Record<string, number> = { ...budget };
        if (value === undefined) delete next[key];
        else next[key] = value;
        set("budget", Object.keys(next).length ? next : undefined);
      };
      return (
        <>
          <Field label="Max iterations" issues={at("max_iterations")}>
            <NumberInput value={block.max_iterations} min={1} onChange={(v) => set("max_iterations", v)} />
          </Field>
          <Field label="Until" hint="Exit condition, e.g. tests.passed." issues={at("until")}>
            <TextInput value={block.until} onChange={(v) => set("until", v)} />
          </Field>
          <Field label="Reset" issues={at("reset")}>
            <Select
              value={block.reset}
              empty="(default)"
              options={toOptions(["per_parent_iteration", "never"] as const)}
              onChange={(v) => set("reset", v)}
            />
          </Field>
          <Field label="Budget: max tokens" issues={at("budget", "max_tokens")}>
            <NumberInput value={budget.max_tokens} min={1} onChange={(v) => setBudget("max_tokens", v)} />
          </Field>
          <Field label="Budget: max minutes" issues={at("budget", "max_minutes")}>
            <NumberInput value={budget.max_minutes} min={0} step="any" onChange={(v) => setBudget("max_minutes", v)} />
          </Field>
          <Checkbox
            label="Stop if no progress"
            checked={block.stop_if_no_progress === true}
            onChange={(on) => set("stop_if_no_progress", on ? true : undefined)}
          />
          <Field label="On exhausted" issues={at("on_exhausted")}>
            <Select value={block.on_exhausted} empty="escalate_model (default)" options={toOptions(ON_EXHAUSTED)} onChange={(v) => set("on_exhausted", v)} />
          </Field>
        </>
      );
    }
    case "foreach":
      return (
        <>
          <Field label="Over" issues={at("over")}>
            <TextInput value={block.over} onChange={(v) => set("over", v)} />
          </Field>
          <Field label="Max parallel" issues={at("max_parallel")}>
            <NumberInput value={block.max_parallel} min={1} onChange={(v) => set("max_parallel", v)} />
          </Field>
        </>
      );
    case "approval":
      return (
        <>
          <Field label="Mode">
            <Select value={block.mode} empty="auto (default)" options={toOptions(["auto", "review"] as const)} onChange={(v) => set("mode", v)} />
          </Field>
          <Field label="On reject">
            <Select
              value={block.on_reject}
              empty="(default)"
              options={toOptions(["feedback_to_workers", "fail"] as const)}
              onChange={(v) => set("on_reject", v)}
            />
          </Field>
        </>
      );
    case "subflow": {
      const reused = context.library?.resolve(block.flow);
      return (
        <>
          <Field label="Flow" hint="A flow marked Reusable, or one from flows/." issues={at("flow")}>
            <TextInput value={block.flow} list={REUSABLE_LIST} placeholder="flows/verify.yml" onChange={(v) => set("flow", v)} />
          </Field>
          {reused ? (
            <p className="muted">
              Runs {reused.steps.map((s) => s.id).join(" → ") || "nothing"}
              {context.known.some((r) => r.invalid && r.flow === reused) ? " · has errors, fix it before running" : ""}
            </p>
          ) : null}
          <Field label="Inputs" hint="One name=value per line." issues={issuesUnder(issues, [...base, "inputs"])}>
            <TextArea value={recordToText(block.inputs)} onChange={(t) => set("inputs", textToRecord(t))} />
          </Field>
        </>
      );
    }
    case "script":
      return (
        <>
          <Field label="Run" hint="Its stdout must be a JSON object of outputs." issues={at("run")}>
            <TextInput value={block.run} onChange={(v) => set("run", v)} />
          </Field>
          <Field label="Working directory" issues={at("cwd")}>
            <OptionalText value={block.cwd} onChange={(v) => set("cwd", v)} />
          </Field>
        </>
      );
  }
}
