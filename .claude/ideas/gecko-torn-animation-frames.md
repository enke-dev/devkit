# Gecko tears live frames during animation

## What happens

While something on the page animates, a Gecko pane flickers. Individual frames carry a hard edge
with the animation applied on one side of it and not the other — a menu backdrop covering the left
quarter of the frame and nothing else, the top half dimmed while the bottom stays bright. The pane
is not alternating between two pictures; each picture is itself half-finished.

Chromium and WebKit do not do this.

## Measured

A page of one flat colour under a full-viewport veil fading in and out over 600ms, 40 screencast
frames per engine at `deviceScaleFactor: 2`. Every frame should be uniform: the veil covers
everything or nothing. A frame is counted torn when the mean brightness of one band differs from its
neighbour by more than 12 of 255.

| Engine   | Torn frames | Worst band step |
| -------- | ----------- | --------------- |
| Gecko    | 3 / 40      | 62.6            |
| Chromium | 0 / 40      | 7.9             |
| WebKit   | 0 / 40      | 7.3             |

The repro is about ten lines: set a page with a `transition: opacity` veil, start the screencast,
toggle the class a few times, write every frame to disk. No app, no sidecar.

## Why it is not ours

Nothing between the engine and the screen composites anything. The frame arrives torn from
`page.screencast`, is stored as-is and drawn as-is. The same code path shows Chromium and WebKit
without a mark.

It is the same family as the spoiled first row Gecko used to put on live frames, which turned out to
come from asking for an odd viewport width and went away once the shared viewport was floored to an
even number. Gecko's live frames are unreliable in ways its screenshots are not; that one had a size
to avoid, and this one does not.

## What is left

- **Nothing can un-tear a frame** once it arrives. The options are to show it, drop it, or show
  something else.
- **Dropping torn frames** means detecting them, which costs a decode per live frame on the engine
  that already costs the most per frame — and the detection above only works because the test page
  is one flat colour. On a real page a hard edge is usually just the page.
- **Showing a screenshot instead** is clean but expensive, and animation is exactly when a pane
  needs the stream rather than a capture every few hundred milliseconds.
- **Living with it** is what happens today. It is most visible on a large flat animating surface — a
  menu backdrop, a theme switch — and invisible on text that repaints in place.

Worth revisiting only if Playwright's Firefox screencast gains a "wait for a complete composite"
option. The tearing is in the browser build, not in anything reachable from here.
