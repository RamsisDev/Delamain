import type { ReactNode } from "react";
import { cx } from "./controls";

export interface TabSpec<T extends string> {
  id: T;
  label: string;
  badge?: ReactNode;
}

export function Tabs<T extends string>({ tabs, active, onChange }: { tabs: readonly TabSpec<T>[]; active: T; onChange: (id: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={tab.id === active}
          className={cx("tab", tab.id === active && "tab-active")}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
          {tab.badge}
        </button>
      ))}
    </div>
  );
}
