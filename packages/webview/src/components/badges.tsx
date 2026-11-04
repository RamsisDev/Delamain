import type { ReactNode } from "react";
import type { LayerName, StepStatus } from "@delamain/core";
import { cx } from "./controls";

const LAYER_TITLES: Record<LayerName, string> = {
  preset: "Shipped with the extension",
  global: "Global configuration (all projects)",
  project: "Project configuration (.harness/)",
  session: "This conversation",
};

export function LayerBadge({ layer }: { layer: LayerName | undefined }) {
  return (
    <span className={cx("layer-badge", `layer-${layer ?? "default"}`)} title={layer ? LAYER_TITLES[layer] : "Built-in default"}>
      {layer ?? "default"}
    </span>
  );
}

const STATUS_GLYPHS: Record<StepStatus, string> = {
  waiting: "⏸",
  running: "⟳",
  succeeded: "✓",
  failed: "✗",
  skipped: "–",
  paused: "⏸",
  cancelled: "⊘",
};

export function StatusIcon({ status }: { status: StepStatus }) {
  return (
    <span className={cx("status-icon", `status-${status}`)} title={status} aria-label={status}>
      {STATUS_GLYPHS[status]}
    </span>
  );
}

export function Pill({ children, tone, title }: { children: ReactNode; tone?: "warning" | "error" | "ok" | "muted"; title?: string }) {
  return (
    <span className={cx("pill", tone && `pill-${tone}`)} title={title}>
      {children}
    </span>
  );
}
