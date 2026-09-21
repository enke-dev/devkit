/**
 * Dragging a divider.
 *
 * Pointer capture rather than window listeners: the pointer leaves the divider
 * within the first few pixels of any drag, and it must keep being followed
 * once it has — over the panes, over the toolbar, outside the window. Capture
 * is also what makes the release arrive wherever it happens, so a drag cannot
 * be left running by letting go somewhere unexpected.
 */
export interface DragHandlers {
  /** Called for every movement, with the distance from where the drag began. */
  move: (deltaX: number, deltaY: number) => void;
  /** Called once, wherever the pointer was released. */
  end: () => void;
}

export function startDrag(event: PointerEvent, handlers: DragHandlers): void {
  const divider = event.currentTarget;
  if (!(divider instanceof HTMLElement)) {
    return;
  }
  // Otherwise the drag also selects text in the app's own chrome, and the
  // pane surfaces treat it as input.
  event.preventDefault();

  const startX = event.clientX;
  const startY = event.clientY;
  divider.setPointerCapture(event.pointerId);

  const move = (moved: PointerEvent) =>
    handlers.move(moved.clientX - startX, moved.clientY - startY);

  const finish = () => {
    divider.removeEventListener('pointermove', move);
    divider.releasePointerCapture(event.pointerId);
    handlers.end();
  };

  divider.addEventListener('pointermove', move);
  divider.addEventListener('pointerup', finish, { once: true });
  divider.addEventListener('pointercancel', finish, { once: true });
}

/** Keep a size inside its bounds, whichever way it was dragged. */
export function clamp(value: number, least: number, most: number): number {
  return Math.min(Math.max(value, least), Math.max(least, most));
}
