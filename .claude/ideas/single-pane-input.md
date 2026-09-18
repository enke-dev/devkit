# Single-pane input

## Current behaviour

Input mirrors to all three panes. `forwardInput` in
[`packages/app/src/main.ts`](../../packages/app/src/main.ts) sends `engine: 'all'`, and the sidecar
fans it out.

This matches the lockstep navigation decision and is the right default: the point of the tool is
watching three engines react to the same thing.

## Why it is already cheap to change

The protocol never assumed mirroring. `{ type: 'input', engine: Engine | 'all', event }` addresses a
single engine just as well, and the sidecar's `input` case already handles both — it only expands
`'all'` into the full pane list. **Driving one pane is a frontend change alone.** No protocol
version bump, no sidecar work.

## Sketch

A modifier held while interacting (alt, say) sends `engine: view.engine` instead of `'all'`, with
the pane border indicating that it is being driven solo. A sticky per-pane toggle would also work
but is more state to keep straight and more UI to explain.

Worth pairing with a way to resynchronise afterwards, since panes that have diverged stay diverged
until the next shared navigation.

## Open question

Whether divergent panes should be visually marked. The same question was raised for per-pane
navigation and deliberately not answered — lockstep-only was chosen specifically to avoid it. If
single-pane input lands, that question comes back.
