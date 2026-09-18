# Gecko drops its device scale — recoverable, cause unknown

## What happens

A Gecko pane starts rendering at half the resolution of the other two and stays there. The page
reports `devicePixelRatio` 1 although the context was made with `deviceScaleFactor: 2`, so even a
full screenshot comes back at CSS resolution.

In the app it reads as the Gecko pane being *zoomed*, alternating between a soft stream and a
sharper settled capture, because the two arrive at different scales.

It has never been pinned to a trigger. It does not reproduce across fresh contexts, resizes,
repeated navigations or screencast restarts, but it happens while the app is being used.

## Measured

From a running session, with the sidecar's own warning:

```
firefox sharp capture came back 2008x334, expected 4016 wide
        (pane viewport 2008x334 @2x; page reports 2008x334 dpr=1)
```

The pane and the page agree on the CSS size and disagree on the scale. Chromium produced a
different fault in the same session, which is *not* this one and is filed separately below:

```
chromium sharp capture came back 1256x2432, expected 3776 wide
        (pane viewport 1888x386 @2x; page reports 1888x386 dpr=2)
```

Correct dpr, capture at the *previous* viewport — a resize race, not a lost scale.

## Why it matters beyond softness

The panes stop sharing a viewport, and the app sends one pointer coordinate to all three. A click
mapped against a pane rendering at a different scale lands somewhere else in the page, so **links
stop responding in every pane**, not just Gecko's. That symptom is what the fault looks like from
the outside; the softness is easy to miss.

## What is done

`#checkCaptureSize` notices a settled capture that is not the size it should be, asks the page what
it believes rather than trusting our record, and repairs it when they disagree. The repair is a
viewport nudge — one pixel away and back — because Playwright ignores a resize to the size it
already believes it has.

When the nudge does not take, the pane now relaunches and returns to where it was. The scale is
fixed when the context is made, so a new context is the only way back. It takes one failed nudge
first, so a single odd capture does not cost a relaunch, and the existing 5s floor still bounds how
often a repair is attempted.

## What was in the way

The repair reported its own verdict at `info`, and the frontend kept only `warn` and `error`. So the
mismatch warning appeared in the terminal while "restored", "still 1" and "repair failed" never did
— the one mechanism built to fix this bug could not be observed at all. Every level reaches the
terminal in development now.

## Ruled out

Each of these was measured against a bare Playwright Firefox at
`deviceScaleFactor: 2`, watching `devicePixelRatio` after every step. All left it
at 2.

- **Replayed input, including a double-tap.** `dblclick`, two rapid clicks,
  `ctrl` + wheel, `Control+Minus` and `Meta+Minus`. Page zoom would have been a
  tidy explanation — Firefox folds zoom into `devicePixelRatio`, so 50% zoom on a
  2x display reads as 1 — but nothing the app can send produces it.
- **Resize churn.** Forty rounds of resize, stop the screencast, start it again,
  the shape changing every time. This is what dragging a window edge does to a
  pane, and it was the strongest suspect since the fault shows up while resizing.

## What is left

- **The trigger.** Still unknown. The next session with the scale dropping will now print whether
  the nudge worked, which is the first real evidence either way.
- **The nudge may be pointless.** If the logs show it never restores anything, drop it and relaunch
  straight away — it costs a reflow per attempt for nothing.
- **Relaunching loses the page.** Scroll position and any state go with it. Acceptable for a pane
  that is otherwise useless, but it is a real cost and a reason not to relaunch eagerly.
- ~~**The Chromium race above**~~ — **resolved**. A screenshot is taken against whatever viewport the
  page had when it started, so one that lands after a resize describes a shape the pane has already
  left. Reproduced on all three engines by starting a capture and resizing underneath it: each
  returned the previous viewport. Such a capture is now discarded and another scheduled, rather than
  sent as a frame that cannot fit and so blanks the pane.

## Do not repeat these

Two false leads cost most of a session:

- **A profiler attached to the webview inflates what it measures.** A Web Inspector timeline put
  frame fetches at 47.6ms mean and the IPC handover at 40.7ms, which made the transport look like
  the bottleneck. Measured from inside the app with nothing attached, both are ~1ms. The recording
  was capturing 577 screenshots of its own — 13/s — and that is what it was timing.
- **"It degrades over time" was not a leak.** Across 44s: script time fell (196.9ms → 157.2ms),
  layout records fell (1000 → 635), CPU fell (52.6% → 48.1%), GC ran 80 times for 44ms total. The
  listeners do not stack — `#attached` is a `WeakSet`, the observers are one per pane. What degrades
  is a pane that has lost its scale and never recovers, which is a step change wearing the costume
  of a slow decline.

The numbers to reach for are already in the once-a-second `[ui]` line: `fetch=` and `ipc=` as
p50/p95, `blank=` as a count and the last wait, and `awaitingAck=` when anything is outstanding.
