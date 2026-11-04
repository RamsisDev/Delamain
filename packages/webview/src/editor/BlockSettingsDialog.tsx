import { useEffect, useRef, useState } from "react";
import type { Block } from "@delamain/core";
import { Button } from "../components/controls";
import { Tabs } from "../components/Tabs";
import { BLOCK_META } from "./block-defaults";
import type { SettingsSection } from "./PropertiesPanel";

/**
 * The ⚙ of a block: all its settings as tabs. Edits apply to the draft as you type, Cancel puts
 * the draft back as it was when the dialog opened.
 */
export function BlockSettingsDialog({
  block,
  sections,
  onDone,
  onCancel,
  onDelete,
}: {
  block: Block;
  sections: readonly SettingsSection[];
  onDone: () => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const [tab, setTab] = useState(sections[0]?.id ?? "");
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    return () => previous?.focus();
  }, []);
  const current = sections.find((s) => s.id === tab) ?? sections[0];
  const meta = BLOCK_META[block.type];
  return (
    <div className="dialog-backdrop" onClick={onDone}>
      <div
        className="dialog dialog-settings"
        ref={dialog}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`Settings of ${block.id}`}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onCancel();
          }
          if (event.key === "Tab") {
            const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')].filter(el => el.getClientRects().length);
            const first = controls[0];
            const last = controls.at(-1);
            if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <h3>
          ⚙ <span className={`flow-node-icon family-${meta.family}`}>{meta.icon}</span> {block.label ?? block.id}
          <span className="muted"> · {meta.label} settings</span>
        </h3>
        <Tabs
          tabs={sections.map((s) => ({ id: s.id, label: s.title, badge: s.errors ? <span className="tab-badge">{s.errors}</span> : undefined }))}
          active={current?.id ?? ""}
          onChange={setTab}
        />
        <div className="settings-body props">{current?.content}</div>
        <div className="dialog-actions">
          <Button variant="danger" small onClick={onDelete}>
            Delete block
          </Button>
          <span className="spacer" />
          <Button onClick={onCancel} title="Undo the changes made in this dialog">
            Cancel
          </Button>
          <Button variant="primary" onClick={onDone}>
            Done
          </Button>
        </div>
      </div>
    </div>
  );
}
