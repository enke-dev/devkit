# Per-engine cursor shape

## The idea

Right now every pane draws the same arrow. But the cursor an engine chooses is itself a
cross-browser difference worth seeing: whether a given element yields `cursor: pointer`, where a
text caret appears, how `cursor: grab` is treated. Drawing each pane's *computed* cursor would turn
the overlay from a UI affordance into a comparison signal — "Chromium says pointer here, WebKit
does not".

This is the reason the stand-in cursors are differentiated by weight rather than by shape. Shape is
reserved for meaning "the engine decided this", so it must not be spent on "this pane is passive".

## Why it is not free

There is no push notification for cursor changes. Getting it means asking, per engine:

```js
getComputedStyle(document.elementFromPoint(x, y)).cursor
```

That is a round trip per sample per pane. At pointer-move rates it would swamp the same IPC path
the frames use, and on the polled engines it competes directly with screenshot encoding.

## Sketch

Sample on a throttle — 10Hz is likely plenty, since cursor shape changes at the rate elements
change under the pointer, not at the rate the pointer moves. Send the computed value back as its own
event and map the common keywords (`default`, `pointer`, `text`, `grab`, `not-allowed`, …) to
drawn shapes, falling back to the arrow for anything unrecognised.

Worth measuring the cost on Gecko and WebKit before committing: those panes are already
encode-bound, and this adds work on the same page.

An intermediate version that costs almost nothing: sample only while the pointer is stationary.
Cursor shape matters most when hovering something, which is exactly when moves stop.

## Files

- [`packages/sidecar/src/pane.ts`](../../packages/sidecar/src/pane.ts) — `applyInput`
- [`packages/protocol/src/index.ts`](../../packages/protocol/src/index.ts) — a new event
- [`packages/app/src/pane-view.ts`](../../packages/app/src/pane-view.ts) — the cursor SVG
