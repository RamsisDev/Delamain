import { useState, type DragEvent } from "react";

const MIME = "application/x-harness-reorder";

/**
 * HTML5 drag-and-drop reordering for a list of cards: the handle starts the drag (so text in the
 * card's inputs stays selectable) and the whole card is the drop target.
 */
export function useReorder(onMove: (from: number, to: number) => void) {
  const [dragging, setDragging] = useState<number>();
  const [over, setOver] = useState<number>();

  const reset = () => {
    setDragging(undefined);
    setOver(undefined);
  };

  const handle = (index: number, enabled: boolean) => ({
    draggable: enabled,
    onDragStart: (event: DragEvent<HTMLElement>) => {
      event.dataTransfer.setData(MIME, String(index));
      event.dataTransfer.effectAllowed = "move";
      const card = event.currentTarget.closest(".card");
      if (card) event.dataTransfer.setDragImage(card, 16, 16);
      setDragging(index);
    },
    onDragEnd: reset,
  });

  const target = (index: number) => ({
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (dragging === undefined) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      if (over !== index) setOver(index);
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      if (dragging !== undefined && dragging !== index) onMove(dragging, index);
      reset();
    },
  });

  const stateClass = (index: number) =>
    dragging === index ? "dragging" : over === index && dragging !== undefined ? (dragging > index ? "drop-before" : "drop-after") : undefined;

  return { handle, target, stateClass };
}
