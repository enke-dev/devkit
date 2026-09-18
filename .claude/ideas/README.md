# Ideas

Deferred work, one file per item. Each says what the current behaviour is, why it was left alone,
and what picking it up would involve — so none of it needs re-deriving from scratch.

Nothing here is a commitment. An idea that turns out not to be worth it should be deleted with a
sentence saying why, not left rotting. So should one that gets done: what was measured on the way
belongs in [`docs/internals.md`](../../docs/internals.md), which is where it will be read.

## Interaction

- [cursor-reflects-engine-state.md](cursor-reflects-engine-state.md) — the stand-in cursor shows
  where *you* are, not where each engine's pointer actually is
- [pointer-capture-on-drag.md](pointer-capture-on-drag.md) — dragging out of a pane strands the
  engines with a mouse button held down
- [per-engine-cursor-shape.md](per-engine-cursor-shape.md) — draw the cursor shape each engine
  computed, as a cross-browser signal in its own right
- [single-pane-input.md](single-pane-input.md) — drive one pane instead of all three
- [sidecar-side-input-pacing.md](sidecar-side-input-pacing.md) — the sidecar trusts the client not
  to flood it

## Rendering

- [gecko-device-scale.md](gecko-device-scale.md) — Gecko drops its `deviceScaleFactor` and takes the
  panes out of agreement, which stops clicks landing; it recovers itself now, and the trigger is
  still unknown
- [gecko-torn-animation-frames.md](gecko-torn-animation-frames.md) — Gecko's live frames arrive
  half-composited while a page animates, which is the flicker; measured against the other two, and
  nothing reachable from here can fix it

## Packaging

- [gecko-wont-launch-from-a-bundle.md](gecko-wont-launch-from-a-bundle.md) — Playwright's Firefox
  needs Full Disk Access when the app is double-clicked; what is left is whether something narrower
  will do, and saying so rather than showing a sandbox error
- [cross-platform-builds.md](cross-platform-builds.md) — Windows and Linux have never been run
- [code-signing.md](code-signing.md) — macOS builds are unsigned and un-notarised, which also means
  every rebuild is a new identity to whatever was granted permission
- [dmg-bundling.md](dmg-bundling.md) — the DMG step needs Finder automation permission

## Sessions

- [session-history.md](session-history.md) — the last URL is restored, but back/forward still dies
  with the session

## Inspection

- [devtools-for-every-engine.md](devtools-for-every-engine.md) — real developer tools can only be
  attached to one of the three engines; a comparison inspector is the version worth building
