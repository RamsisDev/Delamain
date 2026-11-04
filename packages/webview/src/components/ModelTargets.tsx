import { FAVORITE_ROLES, type FavoriteModel } from "@delamain/core";
import { Button, Select, type Option } from "./controls";

/** Favorites plus `role:<role>` targets, the values a router rule or an agent pin can use. */
export function targetOptions(models: readonly FavoriteModel[] | undefined): Option[] {
  return [
    ...(models ?? []).map((m) => ({ value: m.ref, label: m.label ? `★ ${m.label} — ${m.ref}` : `★ ${m.ref}` })),
    ...FAVORITE_ROLES.map((role) => ({ value: `role:${role}`, label: `role:${role}` })),
  ];
}

export function TargetPicker({
  value,
  options,
  onChange,
  empty,
  disabled,
}: {
  value: string | undefined;
  options: readonly Option[];
  onChange: (value: string | undefined) => void;
  empty?: string;
  disabled?: boolean;
}) {
  return <Select value={value} options={options} onChange={onChange} disabled={disabled} {...(empty !== undefined ? { empty } : {})} />;
}

/** Ordered list of targets (a fallback chain). */
export function TargetList({
  values,
  options,
  onChange,
  disabled,
}: {
  values: readonly string[];
  options: readonly Option[];
  onChange: (values: string[]) => void;
  disabled?: boolean;
}) {
  const set = (index: number, value: string | undefined) => {
    const next = [...values];
    if (value === undefined) next.splice(index, 1);
    else next[index] = value;
    onChange(next);
  };
  const swap = (a: number, b: number) => {
    const next = [...values];
    [next[a], next[b]] = [next[b]!, next[a]!];
    onChange(next);
  };
  return (
    <div className="target-list">
      {values.map((value, index) => (
        <div className="target-row" key={index}>
          <span className="target-index">{index + 1}.</span>
          <TargetPicker value={value} options={options} onChange={(v) => set(index, v)} disabled={disabled} />
          <Button small variant="link" disabled={disabled || index === 0} onClick={() => swap(index, index - 1)} title="Move up">
            ↑
          </Button>
          <Button small variant="link" disabled={disabled || index === values.length - 1} onClick={() => swap(index, index + 1)} title="Move down">
            ↓
          </Button>
          <Button small variant="link" disabled={disabled} onClick={() => set(index, undefined)} title="Remove">
            ✕
          </Button>
        </div>
      ))}
      <Button small disabled={disabled || !options.length} onClick={() => onChange([...values, options[0]!.value])}>
        + Add backup model
      </Button>
    </div>
  );
}
