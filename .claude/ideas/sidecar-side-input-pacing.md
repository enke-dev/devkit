# Sidecar-side input pacing

## Background

Continuous input (pointer movement, scrolling) is paced in the **frontend**: the next event is sent
only once the previous has been replayed, so at most one is ever in flight. See `attachInput` in
[`packages/app/src/input.ts`](../../packages/app/src/input.ts).

This was a fix, not a precaution. Sending on a fixed schedule let a standing queue form the first
time the engines fell behind, and because send rate then equalled drain rate exactly, it never
drained. Measured over 60s at 60Hz: p50 input latency climbed 22ms -> 234ms and stayed there, with
13 commands permanently queued. With pacing it sits flat at ~16.6ms with one in flight, at the same
throughput.

## The remaining gap

**The sidecar has no defence of its own.** Every command goes through one promise chain in
[`packages/sidecar/src/index.ts`](../../packages/sidecar/src/index.ts), so any client that sends
input faster than the engines replay it rebuilds exactly the same standing queue — and the backlog
also delays navigation and resize, which share that chain.

Today there is one client and it behaves. This only matters if that changes.

## Sketch

Collapse superseded input at the point of dequeue rather than trusting the sender: when the next
queued command is a `mousemove` and further `mousemove`s sit behind it with no discrete event in
between, skip to the last one. Wheel deltas would need summing rather than dropping, since each is a
distinct distance rather than a position.

Worth considering alongside it: run input on a separate chain from navigation and resize, so a busy
pointer cannot delay a URL change. Ordering only needs to hold within each kind.

## Do not

Do not "fix" this by making the frontend send on a timer again, and do not remove the frontend
pacing once the sidecar has its own. Not generating load you cannot absorb is the cheaper half.
