# DevKit internals

How the parts fit, and why they are the way they are. Most of this is measured rather than assumed;
where a number appears, it came from running the thing.

## How it works

```
┌─────────────────────────────────────────────┐
│ Tauri window (HTML/CSS/TS)                  │
│  address bar · three panes                  │
└───────────────┬─────────────────────────────┘
                │ Tauri IPC: invoke + events
┌───────────────┴─────────────────────────────┐
│ Rust backend                                │
│  spawns and supervises the sidecar          │
│  relays newline-JSON in both directions     │
└───────────────┬─────────────────────────────┘
                │ stdin / stdout
┌───────────────┴─────────────────────────────┐
│ Node sidecar (Playwright)                   │
│  chromium · firefox · webkit                │
│  one ephemeral context + page per engine    │
└─────────────────────────────────────────────┘
```

The Rust layer deliberately knows almost nothing about the protocol: it owns the sidecar's lifetime
and pipes, and forwards payloads verbatim. The message shapes live in one place,
[`packages/protocol/src/index.ts`](packages/protocol/src/index.ts), with the handful of names Rust
needs mirrored in [`src-tauri/src/protocol.rs`](src-tauri/src/protocol.rs).

## Decisions worth knowing

**All three engines go through Playwright, including WebKit.** The app's own chrome is a WebView —
WebKit on macOS, WebView2 on Windows, WebKitGTK on Linux. Rendering the WebKit pane in "the
platform's webview" would mean the pane shows a different engine depending on the host OS, which is
the opposite of what this tool is for. Playwright's bundled WebKit is the same build everywhere.

**Nothing captures real browser windows.** No screen recording, no Accessibility-driven window
positioning, no compositing of live windows. Every pane is a headless browser whose frames are
streamed as images. That sidesteps TCC permission grants that invalidate on each rebuild, z-order
fights, and crashes from resizing real windows out from under their owners.

**Playwright manages its own browser binaries.** Stock Firefox has no usable CDP: pointing
`--remote-debugging-port` at a system Firefox yields a vestigial scaffold with no working
`/json/version` and no WebSocket upgrade. Playwright's Firefox is a patched Mozilla build speaking
the private Juggler protocol, which is why it works at all — so it must be Playwright's own binary,
never a system install.

**Every pane is anonymous.** Each engine gets `browser.newContext()` with no persistent profile.
Playwright keeps that state in memory and discards it on close, so no cookies, cache or history
survive a session.

**Navigation and input are both lockstep.** The address bar drives all three panes to the same URL,
and clicking, scrolling or typing in any pane is mirrored to all three — the point of the tool is
watching three engines react to the same thing. Frames render 1:1 at the engine's viewport size, so
a click lands on the pixel you aimed at. The protocol still addresses panes individually, so driving
one pane alone is a frontend change.

Keyboard goes to the pane under the pointer — there is nothing to click first and no focus ring,
because "the pane you are pointing at" and "the pane you are driving" are the same thing. The app's
own shortcuts are taken before a pane sees them:

|                       | macOS                | Windows and Linux     |
| --------------------- | -------------------- | --------------------- |
| Focus the address bar | `Cmd`+`L`            | `Ctrl`+`L`, `Alt`+`D` |
| Reload                | `Cmd`+`R`            | `Ctrl`+`R`, `F5`      |
| Back                  | `Cmd`+`←`, `Cmd`+`[` | `Alt`+`←`             |
| Forward               | `Cmd`+`→`, `Cmd`+`]` | `Alt`+`→`             |

Holding **Alt** drives one pane alone: input goes only to the pane under the pointer, the stand-in
cursors disappear from the others, and their headers dim while the frames stay exactly as the engines
drew them. It is held rather than toggled, so there is no mode to forget you are in — useful for
dismissing a cookie banner or filling a form without three engines racing through it.

Alt is free for that because no modifier is forwarded to the engines: the protocol's input events
carry a button and a position, so no page has ever seen `altKey` from DevKit. If that changes, this
claim on Alt has to be revisited. On Linux, note that many window managers take Alt-drag for
themselves.

The platforms differ in more than the modifier, which is why
[`shortcuts.utils.ts`](packages/app/src/utils/shortcuts.utils.ts) binds per platform rather than
accepting either modifier everywhere. `Ctrl`+`←` on Windows moves the caret by word, so taking it
would steal a key the page should get; and `Meta` there is the Super key, so answering to it means
answering to the desktop's own shortcuts.

The pane under the pointer also shows the cursor its engine would show. The engine is asked what
`cursor` applies, on a throttle, with a trailing sample so the position the pointer _stops_ on is
always the one reported — without it the link you are hovering is exactly the sample that gets
skipped.

`auto` has to be resolved rather than taken at face value, and neither shortcut works:

- WebKit reports `auto` over links where Chromium and Gecko say `pointer`, so links are detected
  rather than read off.
- Every engine reports `auto` over text while still showing an I-beam. Caret hit-testing is no good
  for this — it snaps to the nearest text and so claims "text" across whole paragraphs of empty
  space, which leaves the cursor stuck. The glyph boxes themselves are measured instead, so the
  cursor changes back on the way out of the words.

The probe rides on the inspector's injected walker rather than shipping its own function body on
every pointer move, which also means it descends: a link inside a shadow root or a same-origin
frame reports `pointer`, where asking the top document alone resolved to the host or the `<iframe>`
and reported an arrow. Covered by `bun run verify:inspect`.

The panes you are _not_ pointing at draw a stand-in cursor at the mirrored position, in the same
shape the pointed-at engine reported — an arrow, a pointing hand or an I-beam, drawn to look like the
system cursors rather than like an app's own iconography, so the three panes stay comparable. It
fills with the accent colour while a button is held, which is the only sign a click happened at all.

They are drawn because headless engines have a pointer position but no cursor, and because frames
lag: a pane repainting at 5fps would otherwise give no sign the input registered. The overlay tracks
at the frontend's own frame rate, which separates "the input landed" from "the engine has repainted".
The pane under the real cursor is left alone rather than being given a second one.

The last URL is remembered, so closing and reopening resumes where you left off.

That cursor is **live by design**: it shows where the pointer is, not what any engine did with the
event. Making it wait for confirmation would put back exactly the lag it exists to hide.

Each pane header names its engine, the build behind it — `Chromium 153.0.8010.12`, `Gecko 155.0`,
`WebKit 26.6` — its current frame rate, and its status. Which build drew a page is the first thing
worth knowing when two panes disagree.

Two pane states look similar but are not the same thing. **Active** — the pane the pointer is in —
tints that pane's header the moment the pointer enters, and is what the stand-in cursors are
mirroring. **Focus** follows a click and shows where keyboard input goes; it stays put when the
pointer moves away, because the keyboard does too.

## Capture: push frames, sharp when settled

Every pane is captured the same way: the engine's own screencast, through Playwright's public
`page.screencast` API. Nothing polls on our side. **There is no polling fallback** — see below.

The engines are not equally generous behind that one API, and the numbers below are measured, not
assumed:

|          | in-page frame rate | screencast delivers  |
| -------- | ------------------ | -------------------- |
| Chromium | 60 Hz              | 60 fps, on composite |
| Gecko    | 120 Hz             | 24 fps, on a timer   |
| WebKit   | 58 Hz              | 21 fps, on a timer   |

Gecko and WebKit are capped inside Playwright's own browser patches — `capability.maxFPS = 25` in
`browser_patches/firefox/juggler/screencast/nsScreencastService.cpp`, and `const int fps = 25` in the
WebKit `InspectorScreencastAgent`. Both are timers rather than repaint hooks, which is also why
Gecko keeps emitting frames for a page where nothing is happening and why WebKit re-encodes identical
pixels to different bytes. Raising either means building and hosting custom browsers, per platform,
on every Playwright upgrade; upstream acknowledges the cap in
[#42752](https://github.com/microsoft/playwright/pull/42752).

### Two kinds of frame

Live frames are requested at **CSS resolution**, because that is the only size all three engines
agree on: Chromium scales to fit the request, while Gecko and WebKit ignore it and push CSS
resolution regardless. Asking for anything else leaves panes rendering at different scales, which
defeats the point of comparing them.

That would leave every pane soft on a HiDPI display, so once a pane stops changing for 400ms it
takes a single `page.screenshot()` at device resolution and sends that instead. The pane header says
`settled` while such a still is on screen and `stream` while live frames are arriving; both are
healthy, so both read green.

The split falls along the cost line as neatly as the fidelity one: the cheap uniform path runs while
the picture is moving too fast to study, and the expensive sharp one exactly when it is not.

### Live frames are only forwarded once repainting is sustained

A hover highlight repaints once; scrolling repaints continuously. Streaming for the former would
drop a sharp pane to CSS resolution to show a change that a sharp capture can show a moment later
and better. So a pane streams only after three repaints inside 250ms; a lone repaint is answered by
re-capturing sharply, after a short delay rather than the full settle time — nothing is settling,
and waiting it out is what made hovering feel laggy.

**Gecko forgets its device scale on navigation.** From its second navigation onward — with or
without a screencast attached — `devicePixelRatio` drops back to 1, so the page genuinely renders at
CSS resolution and even a full screenshot comes back undersized. That pane was sharp on first load
and never again. Playwright exposes no way to re-apply the setting, so DevKit pushes the context's
emulated viewport again after every navigation, through the same patched registry as the screencast.

Four things make this harder than it sounds, all measured:

- **Gecko pushes constantly whether or not anything changed** — 222 byte-identical frames in 10
  seconds on a real page. Comparing buffers drops them all, but only if the comparison happens
  _before_ they are counted as activity.
- **WebKit re-encodes identical pixels to different bytes** — four frames of a static page produced
  three distinct hashes — so no buffer comparison can recognise its idle output.
- **A sharp capture makes the engine repaint, and that repaint comes back as a frame.** Such a frame
  is not shown and does not count as motion, but it still schedules another capture, because it may
  also be a real change the user made at that moment. Dropping it instead — which an earlier version
  did — lost hovers, and left panes sitting on a stale image until something else repainted.
- **That chain has to end by content, not by a timer.** Screenshots are deterministic for unchanged
  content on all three engines, so a capture identical to the last one means nothing really changed
  and the pane is marked settled. Without that, panes re-captured once per second forever, which
  cost ~25% CPU on an idle app.

A pane that cannot stream has to be able to capture. WebKit pushes too few frames to reach the
motion threshold, so a sharp capture is the _only_ way it can show a hover or a blur — and
rate-limiting those rate-limits the pane itself. With a 1500ms floor, only 7 of 24 rapid
hover/blur interactions produced any update at all; at 400ms, all 24 did, and CPU went _down_
because the pane stopped accumulating deferred work. Gecko answers the same interactions by
streaming instead, which is why it looks responsive while producing almost no sharp captures.

Motion is measured over a 250ms window and deliberately does **not** latch. An earlier version kept
a pane "in motion" once it had been, and on a page with anything periodic — an ad, a clock — that
pane never settled and so was never re-captured sharply. That is why Gecko appeared permanently
blurry while the other two looked sharp.

### What this replaced

Polling `page.screenshot()` in a loop, which is what the panes used to do. It was far worse than it
looked, because WebKit repaints the whole page for every screenshot — a 200x200 clip costs the same
as a full viewport.

Measured on en.wikipedia.org/wiki/Berlin, scrolling, three panes at `deviceScaleFactor: 2`:

| Capture            | Engines + sidecar CPU |
| ------------------ | --------------------- |
| screenshot polling | ~330%                 |
| push screencast    | **~55%**              |

Single engine, same page: WebKit went from 9.2fps at 111% CPU to 19.2fps at 30%.

### A dead pane comes back

An engine can die on its own — a crash, a failed relaunch after a DPR change, a
process killed from outside. When it does, the pane reports `closed` and the frontend
relaunches that engine after a short pause.

This matters more than it sounds. `start` used to skip any engine it already had a pane object
for, whether or not that pane still had a browser behind it, so a single death left the column blank
for the rest of the session with no way back short of restarting the app. Panes are now replaced
when their browser has gone, not skipped.

### No fallback, on purpose

If the screencast stops delivering, panes fail loudly rather than silently falling back to something
slower. A fallback path that only runs when something is already broken is a path nobody exercises,
and carrying it would mean maintaining two capture implementations to hide a failure that should be
fixed.

That makes `bun run verify:screencast` worth running after every Playwright upgrade. It reports what
each engine delivers — frame rate and real frame size, read from the JPEG header rather than from
metadata — and checks that a page still renders at device scale after navigating, which Gecko was
once seen stopping doing.

This used to be `verify:patch`, guarding a patched `playwright-core` that exposed the screencast
before it was public API. The patch is gone: `page.screencast` has been public since Playwright 1.59,
and measurement showed the two paths deliver the same frames at the same rate.

`bun run verify:recovery` covers the other invisible failure: a pane that stops. It kills an engine
outright — no clean shutdown, no chance to say goodbye — and requires that the pane reports itself
closed exactly once and comes back when restarted. A pane producing no frames looks exactly like a
page where nothing is happening, so nothing else would notice.

`bun run verify:settle` is the other half, and it tests the thing that actually goes wrong. It drives
the real sidecar — own process, own state machine, own frame channel — through a burst of scrolling
and hovering on a deliberately expensive page, then asserts every pane's _last_ frame is a sharp one.
A pane that ends on a live frame stays soft until something makes the page repaint again, which on a
still page may be never. That is a bug you cannot see in a unit test and can easily miss by eye.

### Frames never become text

A frame at device resolution is a couple of hundred kilobytes, and there are two hops to get it from
an engine to the screen. Neither carries it as base64.

**Sidecar to backend** goes over a loopback socket, not stdout: stdout carries newline-delimited
JSON, so the image would have to be base64 — a third larger, plus a JSON parse of a few hundred
kilobytes per frame at the other end. The socket takes a 16-byte header and the bytes as they are.
The backend offers the port and a token through the sidecar's environment, and a connection that
does not present the token is dropped. See
[`src-tauri/src/frame_channel.rs`](src-tauri/src/frame_channel.rs) and
[`packages/sidecar/src/frame-channel.ts`](packages/sidecar/src/frame-channel.ts).

**Backend to webview** goes over the `devkit-frame` URI scheme. The event says only that a frame
exists; the image element fetches the bytes, so they never become a JavaScript string and decoding
happens off the main thread. Sending frames as base64 inside events here was what collapsed the
pipeline to roughly 8/20/2fps with three panes, backpressure dragging the sidecar's production down
with it. See [`src-tauri/src/frames.rs`](src-tauri/src/frames.rs).

Measured with three panes scrolling at device scale: 48 frames/s carrying 4.4MB/s of JPEG, which as
base64 would have been 5.9MB/s of text to parse.

### All three panes capture at the same resolution

Chromium's screencast captures the surface at the _browser's_ scale factor and ignores the browser
context's `deviceScaleFactor`, so on a HiDPI display its pane arrived at CSS resolution while the
other two arrived at device resolution — one pane upscaled and soft, which is worthless for
comparing rendering. Chromium is therefore launched with `--force-device-scale-factor`, which scales
the surface without touching layout: the page still sees the same CSS viewport as the others.

Because it is a launch argument, a DPR change restarts that pane rather than just its context.

### Measuring it yourself

Diagnostics never use `eprintln!`. It panics when the write fails, and a panic inside a Tauri command
aborts the process — so with stderr going to a terminal that has since gone away, a diagnostic line
becomes a crash. Observed once, as a report whose entire stack was `debug_log` → `__eprint` →
`panic` → `abort`. [`note!`](src-tauri/src/notes.rs) writes and ignores a failed write: losing a line
costs nothing, losing the app loses three browsers and whatever was being compared.

`DEVKIT_DEBUG_FRAMES=1 bun run dev` prints, once a second, how many frames the sidecar produced (and
dropped under backpressure) and how many the frontend received. The two numbers disagreeing is the
signal that the transport, not the engines, is the constraint.

## Introspection: one point, three answers

The panes already share a viewport and already mirror input in viewport pixels, so a pair of
coordinates is the only cross-engine identity an element needs. `document.elementFromPoint(x, y)`
with the same numbers in each engine is the whole addressing scheme: no selector generation, no
node handles, nothing to keep in sync. When the engines resolve different elements at the same
point, that is not a failure to reconcile — it is the most interesting thing the feature can
report, and the panel says so rather than picking one answer to stand for all three.

Everything goes through `page.evaluate`, which means it works identically on all three engines and
adds no dependency. The engines' own developer tools stay behind the existing detach pop-out; this
is the convenience layer, not a replacement, and there are deliberately no breakpoints and no
stepping.

**The walker is injected once per context.** `browserContext.addInitScript` puts it in before any
script of the page's own, in every frame, for every document the context ever loads — so a
navigation does not have to be noticed and re-armed, and the few kilobytes of source are parsed
once rather than on every pointer move. It defines exactly one non-enumerable property on
`globalThis` and nothing else: no listeners, no elements, no styles.

**The highlight is drawn in the app, over the screencast.** An overlay injected into the page would
be captured in the very frames it is meant to annotate, which would make the rendering being
compared a rendering of something else. The pane sends back four rectangles and the app draws them.

**Descent pierces open shadow roots and same-origin frames.** Without it the feature is close to
useless — `elementFromPoint` stops at a shadow host and at an `<iframe>`. Coordinates are
translated down on the way into each frame and the rectangles translated back up on the way out, so
`BoxModel` is always in top-level viewport pixels whatever depth the element was found at. An
untranslated rectangle draws the highlight in the wrong place, and only on the pages that have a
frame, which is exactly the kind of bug that ships.

**WebKit charges for reaching at a cross-origin frame.** Reading `contentDocument` across origins
does not throw — it quietly returns null — but WebKit writes a security error into the *page's* own
console for the attempt. Measured: hovering one cross-origin iframe put "Blocked a frame with
origin … from accessing a frame with origin …" into the page error stream, which the console panel
then shows as though the page had produced it. So the walker judges the origin from the frame's
`src` first and only reaches for the property when the answer is yes. A frame that redirected
cross-origin after loading is still touched once; an advert that was cross-origin from the start,
which is the common case, is not touched at all.

**Computed styles are compared over a curated, normalised set.** A raw `getComputedStyle`
comparison is unreadable: the engines expose different property counts, expand shorthands
differently, and disagree cosmetically about values nobody asked after. `INSPECTED_STYLE_GROUPS` in
the protocol is the list, longhands only, and the walker flattens colours (`rgba(0, 0, 0, 0.5)`
against `rgb(0 0 0 / 0.5)`), fractional lengths and font-family quoting before anything is
compared. What survives that is a real difference. What is deliberately *not* flattened:
`line-height: normal` against a resolved pixel value, and resolved grid tracks — those are
disagreements about the used value, which is the thing being measured.

**Matched rules are best-effort and say so.** They mean walking `document.styleSheets`, and
`.cssRules` throws `SecurityError` for a sheet served from another origin, so a page whose CSS
comes from a CDN has nothing to show. Computed styles are the panel that always works; this one
reports how many sheets it could not open rather than presenting a short list as the whole truth,
because an empty rules panel otherwise reads as "this element is unstyled".

**Console is folded before it is queued.** `page.on('console')` and `page.on('pageerror')` stream
from the moment a pane comes up — a console switched on after the page loaded has already missed
what it was opened for. The control channel queues rather than dropping, so a page logging inside
`requestAnimationFrame` would push sixty events a second per engine through it: identical
consecutive messages are folded into one carrying `repeats`, and past `CONSOLE_RATE_LIMIT` the rest
are counted and reported as `dropped`. The cost is that a message waits up to
`CONSOLE_COALESCE_MS` to find out whether it is about to repeat, which is affordable because
nobody watches a console the way they watch a cursor — and `evaluate` answers on its own path.

Only `message.text()` is read, never `message.args()`: reading the arguments means an evaluation
per handle per message, and the three engines disagree about what a handle to a DOM node or a
cyclic object serialises to — which would turn one console into three for reasons that have nothing
to do with the page.

**Message types are classified twice.** `level` is how bad it is, `kind` is what shape it has, and
both are closed unions so the app can render every engine the same way; `nativeKind` carries the
engine's own word for when one of them later deserves special treatment. Measured vocabularies for
the same page:

| Engine   | `console` types emitted                                                  |
| -------- | ------------------------------------------------------------------------ |
| Chromium | count, debug, endGroup, info, log, startGroup, table, trace, warning     |
| Gecko    | count, debug, endGroup, info, log, startGroup, table, trace, warning     |
| WebKit   | debug, endGroup, info, log, startGroup, table, trace, warning            |

WebKit emits nothing for `console.count`. Anything unlisted maps to `kind: 'other'` and renders as
a plain line rather than being dropped.

**Answers are events, not acks.** `ack` is terminal and carries no payload, so `inspect` and
`evaluate` are answered by one event per pane carrying the command's `id` — the only events besides
`ack` that do. Three panes answer independently and at different speeds, which beats one ack
holding three results and waiting for the slowest; a pane that is not running simply never answers,
so the app counts answers against the panes it asked.

**A selection outlives the point that made it.** Clicking while the picker is on ends the mode and
keeps the element, and the click is swallowed rather than passed to the page — following a link
would take the page out from under the thing just selected. The press and its release are swallowed
together, or three engines are left believing a button is still held.

That selection then has to survive scrolling, and a point cannot express it: the point now holds
whatever scrolled into it, so asking again would be wrong rather than stale. So each walker keeps
the element its last inspection landed on — the only state it has — and re-measures its box and
computed styles, reusing the matched rules, which mean walking every stylesheet and which scrolling
does not change. Nothing identifying the element crosses the wire, so the panes still cannot be
asked about each other's, which is the same restriction that makes a point the identity to begin
with.

**The pane volunteers the move; the frontend does not poll for it.** A highlight drawn over a
screencast is two things taken at two moments, and scrolling is where that shows: the rectangle
comes from a measurement and the content from a frame, and any gap between them is visible as the
highlight sliding against its element. Polling cannot close that gap — it measures somewhere in the
middle of it by construction.

So `applyInput` measures the selection immediately after applying anything that could have moved it
— a wheel, a keystroke, a release — which puts the measurement after the scroll and before the next
capture.

Two things keep that off the hot path, and both were learnt by putting it on there. It is **not
awaited**: the ack for an input is what paces the next one, so anything waited for inside
`applyInput` is added to the latency of every scroll. And it is **skipped entirely unless the pane
has a selection**, which the pane tracks itself rather than asking the page — asking costs exactly
the round trip being avoided. Without those, scrolling in a session where nobody had opened the
inspector paid an evaluate per pane per wheel event, with the ack waiting behind all three; the
panes lagged, and Gecko stopped reaching `stream` at all, because `MOTION_FRAMES` wants three
frames inside 250ms and the throttled wheel could no longer produce them. It arrives as a `selection` event, sent only when the
element actually moved, in the same spirit as `cursor`. Pointer movement is deliberately not in that
list: it moves nothing, and asking three engines about every mouse move is the cost the whole
arrangement exists to avoid.

The `remeasure` command stays as a backstop, trailing 250ms after the input stops, for movement that
arrives without further input — a smooth scroll coasting, a layout settling late.

`remeasure` answers with two different nothings, and the sidecar branches on which: **undefined** is
"this pane has no selection", which is not worth announcing, and **null** is "what was selected has
left the document", which is the highlight's cue to go. Confusing them would announce a vanished
selection on every scroll of every page.

The alternative — injecting the highlight into the page so it is rasterised with the content — was
considered and rejected. The top layer would keep it out of normal layout, and `pointer-events:
none` would keep it out of `elementFromPoint`, but an injected node still changes the document:
every `:last-child`, `:nth-child`, `+` and `~` in the page re-evaluates, which silently alters the
computed styles this feature exists to compare. It would also land in the captured frames, which are
the evidence. Chromium's `Overlay.highlightNode` does exactly the right thing outside the DOM, and
has no counterpart in Gecko or WebKit through Playwright — one pane right and two bare is the
asymmetry the app exists to avoid.

**Identity counts within the tag, not within the children.** The app decides whether one table can
speak for all three panes by deriving an identity per engine from the breadcrumb and comparing
them. Built from raw child indices, that identity moves whenever anything at all is inserted beside
an element — a dev server's overlay, an injected style tag, a node one engine kept and another
folded away — and the panel then reports three engines disagreeing about an element all three had
found. Counting among same-tag siblings, the way `:nth-of-type` does, ignores every insertion that
is not a sibling of the same kind, and a step with an id uses the id instead.

When they really do disagree, the panel shows each engine's whole trail with the first differing
step marked. Showing only the leaf printed the same description three times and called it a
difference, which is an assertion nobody can check.

**The readout waits until it is whole.** Answers arrive one engine at a time, and publishing each
as it landed redrew the table with one column, then two, then three — visible as flicker under a
pointer that had not moved. A sample is held until every running pane has answered, with a 300ms
cap for a pane that never will, and a sample whose signature matches what is already on screen is
dropped rather than rendered. That second guard covers most samples: the pointer moves a few pixels
within one element far more often than it crosses into another.

`bun run verify:inspect` covers the parts that are engine territory rather than ours: shadow and
frame descent, rectangle translation, the cross-origin degradations, the normalisations, the cursor
probe, re-measuring a selection across a scroll, and that the walker adds nothing to the page's own
error console. It serves two origins,
because half of what it tests is what happens across one.

## Running it

Requirements: [Bun](https://bun.sh), [Node.js](https://nodejs.org) (the sidecar runtime), and a Rust
toolchain.

The Node version is pinned in `.node-version`, and it is not advisory: the sidecar _is_ a Node
binary, staged from the build machine into the app bundle. Building through an older Node ships that
older Node to everyone, so `bun run prepare:sidecar` refuses to stage a runtime that disagrees with
the file. With [fnm](https://github.com/Schniz/fnm) or similar, `fnm exec bun run dev` picks it up.

```sh
bun install
bun run dev
```

On first launch DevKit checks which Playwright browsers are present. Missing engines are offered as
a download: a full-screen prompt on a cold start, or an in-pane button that fetches just that one
engine when others are already available. Engines that are installed start immediately rather than
waiting for the rest.

Bun drives package management, scripts and the frontend build. The sidecar runs on **Node**, not
Bun: Playwright does not support Bun as a runtime, and the sidecar is the part that must not be
flaky. `bun run prepare:sidecar` stages the local Node binary as the Tauri sidecar executable
(hardlinked, so it costs no disk space in development).

```sh
bun run typecheck        # all packages
bun run lint             # prettier --check and eslint, all packages
bun run format           # the same two, writing
bun run build:libs       # protocol + sidecar TypeScript
bun run bundle:sidecar   # stage the sidecar as a Tauri resource
bun run sidecar:dev      # rebuild the sidecar on change
```

Linting and formatting come from [`@enke.dev/lint`](https://github.com/enke-dev/lint): each package
carries its own `eslint.config.ts` and `prettier.config.ts`, and the root scripts fan out across
them. The presets differ by target — `node-library` for the protocol and the sidecar, `frontend` for
the app, which adds the HTML and web-component rules.

`bun run dev` runs the first three itself. The staged bundle is not optional even in development:
Tauri resolves the `resources` entry at build time and refuses to build without it.

The dev server runs on port 1430.

## Packaging

```sh
bun run build
```

That compiles the TypeScript, stages the sidecar, stages the Node runtime, and hands off to
`tauri build`.

The installer stays small — roughly the Tauri binary plus a Node runtime plus ~20MB of Playwright —
because browser binaries are **not** bundled. They download on first run into Playwright's shared
cache, which is also where an existing Playwright install already has them.

Two pieces need staging because Bun cannot provide them directly:

- **`scripts/bundle-sidecar.ts`** walks the sidecar's runtime dependency closure and writes a plain
  `node_modules` into `src-tauri/sidecar-bundle`. Bun builds `node_modules` from symlinks into a
  content-addressed store, and those do not survive being copied into an app bundle. The bundle
  directory ships as the `sidecar` resource.
- **`scripts/prepare-sidecar.ts`** stages a Node binary as the Tauri sidecar executable. Playwright
  needs a real Node environment, so the "sidecar binary" is the interpreter and the entry script
  rides along as a resource.

Building for another platform means supplying that platform's Node, since the local one will not
run there:

```sh
DEVKIT_TARGET=x86_64-pc-windows-msvc \
DEVKIT_NODE_BINARY=/path/to/win-x64/node.exe \
  bun run build --target x86_64-pc-windows-msvc
```

Nothing verifies that the binary matches the triple — that is on you.

The `.app` builds cleanly. The DMG step (`bundle_dmg.sh`) drives Finder through AppleScript and
fails without automation permission; `bun run tauri build --bundles app` skips it.

## Layout

| Path                | What it is                                                 |
| ------------------- | ---------------------------------------------------------- |
| `packages/protocol` | Wire protocol types and channel names, shared by both ends |
| `packages/sidecar`  | Node + Playwright: engine lifecycle, capture, downloads    |
| `packages/app`      | Frontend: toolbar, panes, frame rendering                  |
| `src-tauri`         | Rust: window, sidecar supervision, IPC relay               |
| `scripts`           | Build-time helpers                                         |

## Not done yet

- **Windows and Linux have never been run.** Cross-platform is structural so far, not tested, and
  no cross-platform build has been produced.
- **No code signing or notarisation.** macOS builds are unsigned, so the app is quarantined when
  downloaded rather than built locally.

Deferred work lives in [`.claude/ideas/`](.claude/ideas/), one file per item, each recording what
the current behaviour is and what picking it up would involve.
