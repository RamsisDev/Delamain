import { BLOCK_TYPES, type BlockType } from "@delamain/core";
import { cx } from "../components/controls";
import { BLOCK_META } from "./block-defaults";
import { BLOCK_DRAG_TYPE } from "./FlowCanvas";

/** Block types to drag onto the canvas (or into a container); a click adds to the selection's container. */
export function Palette({ onAdd }: { onAdd: (type: BlockType) => void }) {
  return (
    <div className="palette">
      <div className="palette-title">Blocks</div>
      {BLOCK_TYPES.map((type) => {
        const meta = BLOCK_META[type];
        return (
          <button
            key={type}
            type="button"
            draggable
            className={cx("palette-item", `family-${meta.family}`)}
            title={`${meta.hint}. Drag onto the canvas or into a loop / for each.`}
            onDragStart={(event) => {
              event.dataTransfer.setData(BLOCK_DRAG_TYPE, type);
              event.dataTransfer.effectAllowed = "copy";
            }}
            onClick={() => onAdd(type)}
          >
            <span className="flow-node-icon">{meta.icon}</span>
            {meta.label}
          </button>
        );
      })}
      <div className="palette-legend">
        <span className="legend family-ai">AI step</span>
        <span className="legend family-deterministic">Deterministic</span>
        <span className="legend family-control">Control</span>
        <span className="legend family-container">Container</span>
      </div>
    </div>
  );
}
