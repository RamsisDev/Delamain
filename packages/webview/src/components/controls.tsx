import { useEffect, useId, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import type { Issue } from "@delamain/core";
import { parseNumber, splitList } from "../util/format";

export function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(" ");
}

type ButtonVariant = "primary" | "secondary" | "danger" | "link";

export function Button({
  variant = "secondary",
  small,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; small?: boolean }) {
  return <button type="button" className={cx("btn", `btn-${variant}`, small && "btn-small", className)} {...props} />;
}

export function FieldIssues({ issues }: { issues: readonly Issue[] }) {
  if (!issues.length) return null;
  return (
    <ul className="field-issues">
      {issues.map((issue, i) => (
        <li key={i} className={`issue-${issue.severity}`}>
          {issue.severity === "error" ? "✗" : "⚠"} {issue.message}
        </li>
      ))}
    </ul>
  );
}

export function Field({
  label,
  hint,
  issues = [],
  badge,
  wide,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  issues?: readonly Issue[];
  badge?: ReactNode;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={cx("field", wide && "field-wide", issues.some((i) => i.severity === "error") && "field-invalid")}>
      <div className="field-label">
        <span>{label}</span>
        {badge}
      </div>
      {children}
      {hint ? <div className="field-hint">{hint}</div> : null}
      <FieldIssues issues={issues} />
    </div>
  );
}

interface InputBase {
  disabled?: boolean;
  placeholder?: string;
  title?: string;
  className?: string;
}

export function TextInput({
  value,
  onChange,
  type = "text",
  list,
  ...rest
}: InputBase & { value: string | undefined; onChange: (value: string) => void; type?: "text" | "password"; list?: string }) {
  return (
    <input
      className={cx("input", rest.className)}
      type={type}
      value={value ?? ""}
      list={list}
      disabled={rest.disabled}
      placeholder={rest.placeholder}
      title={rest.title}
      spellCheck={false}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/** Text that maps to an optional string: an empty field means the key is removed. */
export function OptionalText(props: InputBase & { value: string | undefined; onChange: (value: string | undefined) => void; list?: string }) {
  const { onChange, ...rest } = props;
  return <TextInput {...rest} onChange={(v) => onChange(v === "" ? undefined : v)} />;
}

export function TextArea({
  value,
  onChange,
  rows = 3,
  ...rest
}: InputBase & { value: string | undefined; onChange: (value: string) => void; rows?: number }) {
  return (
    <textarea
      className={cx("input", "textarea", rest.className)}
      rows={rows}
      value={value ?? ""}
      disabled={rest.disabled}
      placeholder={rest.placeholder}
      spellCheck={false}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export function NumberInput({
  value,
  onChange,
  min,
  step,
  ...rest
}: InputBase & { value: number | undefined; onChange: (value: number | undefined) => void; min?: number; step?: number | "any" }) {
  return (
    <input
      className={cx("input", "input-number", rest.className)}
      type="number"
      value={value ?? ""}
      min={min}
      step={step}
      disabled={rest.disabled}
      placeholder={rest.placeholder}
      title={rest.title}
      onChange={(e) => onChange(parseNumber(e.target.value))}
    />
  );
}

export type Option<T extends string = string> = { value: T; label: string; disabled?: boolean };

export function toOptions<T extends string>(values: readonly T[]): Option<T>[] {
  return values.map((value) => ({ value, label: value }));
}

export function Select<T extends string>({
  value,
  options,
  onChange,
  empty,
  ...rest
}: InputBase & { value: T | undefined; options: readonly Option<T>[]; onChange: (value: T | undefined) => void; empty?: string }) {
  const known = value === undefined || options.some((o) => o.value === value);
  return (
    <select
      className={cx("input", "select", rest.className)}
      value={value ?? ""}
      disabled={rest.disabled}
      title={rest.title}
      onChange={(e) => onChange(e.target.value === "" ? undefined : (e.target.value as T))}
    >
      {empty !== undefined || value === undefined ? <option value="">{empty ?? ""}</option> : null}
      {!known ? <option value={value}>{value}</option> : null}
      {options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
  disabled,
  title,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  disabled?: boolean;
  title?: string;
}) {
  const id = useId();
  return (
    <span className="checkbox" title={title}>
      <input id={id} type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <label htmlFor={id}>{label}</label>
    </span>
  );
}

/** Optional boolean: unset / yes / no. */
export function TriState({
  value,
  onChange,
  unsetLabel = "any",
  disabled,
}: {
  value: boolean | undefined;
  onChange: (value: boolean | undefined) => void;
  unsetLabel?: string;
  disabled?: boolean;
}) {
  return (
    <Select<"yes" | "no">
      value={value === undefined ? undefined : value ? "yes" : "no"}
      empty={unsetLabel}
      options={[
        { value: "yes", label: "yes" },
        { value: "no", label: "no" },
      ]}
      disabled={disabled}
      onChange={(v) => onChange(v === undefined ? undefined : v === "yes")}
    />
  );
}

export function Chips({
  options,
  values,
  onChange,
  disabled,
}: {
  options: readonly string[];
  values: readonly string[];
  onChange: (values: string[]) => void;
  disabled?: boolean;
}) {
  return (
    <div className="chips">
      {options.map((option) => {
        const on = values.includes(option);
        return (
          <button
            key={option}
            type="button"
            className={cx("chip", on && "chip-on")}
            disabled={disabled}
            aria-pressed={on}
            onClick={() => onChange(on ? values.filter((v) => v !== option) : [...values, option])}
          >
            {option}
          </button>
        );
      })}
    </div>
  );
}

/** A comma or newline separated list; keeps the raw text while typing. */
export function ListInput({
  value,
  onChange,
  multiline,
  ...rest
}: InputBase & { value: readonly string[] | undefined; onChange: (value: string[]) => void; multiline?: boolean }) {
  const joined = (value ?? []).join(multiline ? "\n" : ", ");
  const [text, setText] = useState(joined);
  useEffect(() => {
    // Resync only when the value changed from outside; otherwise keep what the user is typing.
    if (splitList(text).join("\u0000") !== (value ?? []).join("\u0000")) setText(joined);
  }, [joined]);
  const change = (next: string) => {
    setText(next);
    onChange(splitList(next));
  };
  return multiline ? (
    <TextArea {...rest} value={text} onChange={change} rows={3} />
  ) : (
    <TextInput {...rest} value={text} onChange={change} />
  );
}

export function Collapsible({
  title,
  defaultOpen = false,
  children,
  className,
}: {
  title: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <details className={cx("collapsible", className)} open={defaultOpen}>
      <summary>{title}</summary>
      <div className="collapsible-body">{children}</div>
    </details>
  );
}
