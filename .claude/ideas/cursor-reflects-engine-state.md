# Cursor reflects engine state

## Current behaviour, and it is deliberate

The stand-in cursor drawn in passive panes is **live**: it follows the user's pointer at the
frontend's own frame rate and says nothing about what any engine did with the event.

That is the point of it. Frames lag — badly on the polled engines, around 5fps — so without the
overlay a pane gives no sign that input registered until it next repaints. Splitting "I did input"
from "I see the response" is the whole value, and tying the cursor back to engine state would
collapse the two again.

**Do not "fix" this by making the cursor wait for confirmation.** It would reintroduce exactly the
lag the overlay exists to hide.

## What is actually missing

The cursor can silently diverge from where an engine's pointer really is. A pane that was
mid-navigation rejects input (`Promise.allSettled` in
[`packages/sidecar/src/index.ts`](../../packages/sidecar/src/index.ts), the `input` case), so its
pointer stays where it was while the overlay carries on. Nothing surfaces that.

Whether this matters in practice is unknown — it has not been observed, only reasoned about. Worth
doing only once someone actually sees a pane behaving as though the cursor were somewhere else.

## Sketch

Cheap version, no extra round trips: the sidecar already knows which panes rejected an input event,
because `allSettled` hands back the rejections. Emit that — a `pane`-scoped event, or a field on an
existing one — and have the frontend grey out that pane's ghost until the next accepted event. The
overlay keeps tracking live; only its styling admits uncertainty.

Expensive version: read each engine's real pointer position back and draw *that*. There is no API
for it, so it would mean a script-side `mousemove` listener per page plus a round trip to read it.
Not worth it for a divergence that may never show up.

## Files

- [`packages/app/src/main.ts`](../../packages/app/src/main.ts) — `paintCursors`
- [`packages/app/src/pane-view.ts`](../../packages/app/src/pane-view.ts) — `showCursor`, `hideCursor`
- [`packages/sidecar/src/index.ts`](../../packages/sidecar/src/index.ts) — the `input` case, which
  already collects the rejections
