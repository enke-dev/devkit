# Pointer capture on drag

## The problem

Press inside a pane, drag out of it, release. The engines never see the `mouseup`, so all three sit
with a mouse button held down until the next press. Any drag that leaves the pane — selecting text
past the edge, dragging a slider, a canvas gesture — ends in this state.

Input listeners are attached per pane surface in
[`packages/app/src/input.ts`](../../packages/app/src/input.ts), and `pointerleave` only clears the
stand-in cursor. Once the pointer is outside, no further events reach that pane's handler.

This is the most defect-shaped item in this directory; it is filed here rather than fixed only
because it has not got in the way yet.

## Sketch

Call `setPointerCapture(event.pointerId)` on the surface in the `pointerdown` handler, and
`releasePointerCapture` on `pointerup`. The surface then keeps receiving moves and the release even
once the pointer is outside it.

Two things that need thought rather than just wiring:

- **Coordinates go out of range.** `toViewportPoint` returns `null` outside the frame, which would
  drop every move during the drag. Captured events should clamp to the viewport instead of being
  discarded — that is what a real browser does when you drag past the window edge.
- **The stand-in cursor.** During a capture the pointer may be well outside the pane. Clamping the
  ghost to the edge is probably right; hiding it mid-drag would look like a glitch.

Also worth a safety net regardless: release any held buttons when a pane's capture ends
unexpectedly, so a lost pointer cannot leave an engine stuck.

## Files

- [`packages/app/src/input.ts`](../../packages/app/src/input.ts)
- [`packages/app/src/pane-view.ts`](../../packages/app/src/pane-view.ts) — `toViewportPoint`
