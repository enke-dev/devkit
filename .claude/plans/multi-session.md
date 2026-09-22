# Multi-session DevKit

One DevKit window is one comparison: three engines, one URL, one trail. Looking at a second page
today means giving up the first. The way out is not a tab strip — it is that nothing in the app can
currently say *which* comparison it is talking about.

So this is one refactor and then a choice of window management on top of it.

## What multi-tab actually costs

The tab strip is the small part. macOS groups windows into tabs itself, given a tabbing identifier,
and that grouping changes nothing about how the app is built: a tab *is* a window, with its own
webview, its own frontend instance, its own set of panes. On Windows and Linux there is no native
equivalent at all, so the same windows simply stay windows until somebody backfills a strip.

What stands in the way is that the protocol, the sidecar and the backend are all written for exactly
one of everything:

- `panes` in [`packages/sidecar/src/index.ts`](../../packages/sidecar/src/index.ts) is a
  `Map<Engine, Pane>` — engine is the whole key, so a second window's Chromium and the first's are
  the same entry
- commands name an engine and nothing else, and events come back the same way
- the backend re-emits every sidecar event with `app.emit`, which reaches *every* webview
- frames are stored per engine and served as `devkit-frame://<engine>/<seq>`
- `localStorage` is shared by origin, so two windows would share one back/forward trail

None of that is about tabs. All of it has to be true before a second window can exist at all, which
is why it comes first and why it is worth doing on its own.

## Step 1 — the session dimension — **done**

The whole of this step lands while the app still opens exactly one window. Nothing about it is
visible; what it buys is that every message in the system says who it belongs to.

### The session id is the window label

Tauri already hands out a stable label per window — `webview.label()` in Rust,
`getCurrentWindow().label` in the frontend. Using it as the session id means no allocation
handshake, no registry to keep in step with reality, and replies that can be routed with
`emit_to(label, …)` without a lookup. The first window keeps the configured `main`; later ones are
`s1`, `s2`, … , which stay safe in a frame URL's path.

### Protocol

[`packages/protocol/src/index.ts`](../../packages/protocol/src/index.ts):

- `SessionId`, and a `session` field on the request envelope beside the `id` the bridge already adds.
  One field on the envelope rather than a field on each of the `Command` union's variants.
- Events are stamped with their session by the sidecar. Four stay deliberately unstamped because
  they describe the process rather than a comparison — `hello`, `browsers`, `install-progress`,
  `log` — and so does the separate `SidecarStatus` channel, which is the process by definition.
- `close-session` joins the commands. `suspend-session` is declared with it and left unimplemented
  until step 3, so the shape is settled while it is cheap to change.
- The frame header keeps its 16 bytes: byte 15, which the table at the bottom of the file records as
  unused, becomes the session slot.
- Frame URLs become `devkit-frame://<session>/<engine>/<seq>`. `FRAME_LATEST` is unaffected.

A byte for the slot rather than the label itself because the header is fixed-width and read on every
frame; 255 concurrent comparisons is not a limit anybody will meet.

### Sidecar

`sessions: Map<SessionId, Session>` in [`session.ts`](../../packages/sidecar/src/session.ts), where a
session holds what was global: its panes, its viewport and scheme, its cursor sample, its slot. The
`frame-channel.ts` counters are keyed by pane — slot and engine — for the same reason. `start`
creates a session on demand and `close-session` closes its panes and drops it.

`Pane` gains its session and slot and nothing else; it already knew nothing about its siblings, which
is why this was a key change and not a rewrite. The two emit doors (`emit` for the process,
`emitFor` for a session) make forgetting to say which session a compile error rather than an event
that quietly lands in every window.

**Not keyed by session:** `detached.ts`. A headed window is handed to the user outright, and its own
comment already says a second click adds a tab rather than a second window — which is the right
behaviour whichever comparison asked for it.

### Backend

A `label ↔ slot` table, assigned when a label is first seen. `sidecar_send` learns which webview
invoked it, stamps the session and injects the slot; the relay still parses only enough to route.
[`frame_channel.rs`](../../src-tauri/src/frame_channel.rs) reads the slot back out of the header,
stores the frame under its session and emits to that window alone.
[`frames.rs`](../../src-tauri/src/frames.rs) is keyed by session and engine, and its responder takes
the extra path segment. A window that is destroyed takes its session's panes and frames with it.

### Frontend

The bridge sends nothing new — the backend stamps the session — but ignores anything coming back for
somebody else: the routing already prevents it, and a frontend that silently renders another window's
frames is not a failure anybody would notice, only one they could not explain. Pane frame URLs gain the segment. The inspector window becomes
`inspector:<session>` with its events named to match, and closes with its parent.

Stored state splits along what it describes:

- per session: `devkit.session`, the back/forward trail, which *is* the comparison
- shared: `devkit.history` (the address bar's memory, shared exactly as a browser's is),
  `devkit.split`, `devkit.inspectorDock`, `devkit.inspectorSize`, `devkit.treeSize` — layout
  preferences, which nobody wants to set twice

### Verification

Three of the `verify:*` drivers in [`packages/sidecar/scripts`](../../packages/sidecar/scripts) speak
the protocol directly; they say nothing about sessions and land in `DEFAULT_SESSION`, which is the
case worth keeping working. One is added: two sessions in one sidecar, navigated apart, asserting
that neither frames nor events cross.

### Order

Green at every commit, which matters because the sidecar's globals are threaded through its entry
point:

1. protocol, with `session` optional and defaulting to `'default'`
2. sidecar, keyed by session, defaulting the same way — the app is untouched and still works
3. backend: slot table, routing, frame paths
4. frontend: stamping, URLs, storage split, inspector labels
5. `session` becomes required and the default is deleted, verify scripts alongside

**Step 5 was not taken, on purpose.** `session` stays optional *on the request envelope* and the
default stays: the frontend builds a `Command` and never sets it — the backend does, which is the
point — so requiring it would be a rule that only the direct drivers could break. The `verify:*`
scripts that speak the protocol are those drivers, and they carry on unstamped, which is now what
`DEFAULT_SESSION` is for and is checked by `verify:settle` still passing untouched.

On the event side it *is* required: `emitFor` is the only way a session-scoped event can be sent, so
`Emission` states that every one of them says which session.

### Where it landed

- protocol: `SessionId`, `SessionSlot`, `DEFAULT_SESSION`, the `GLOBAL_EVENTS` split, `close-session`
  and a declared-only `suspend-session`, header byte 15, session-first frame URLs
- sidecar: [`session.ts`](../../packages/sidecar/src/session.ts), two emit doors, per-pane frame keys
- backend: [`sessions.rs`](../../src-tauri/src/sessions.rs), stamping in `sidecar_send`, `emit_to`
  routing in [`sidecar.rs`](../../src-tauri/src/sidecar.rs) and
  [`frame_channel.rs`](../../src-tauri/src/frame_channel.rs), session-keyed
  [`frames.rs`](../../src-tauri/src/frames.rs), teardown on `WindowEvent::Destroyed`
- frontend: [`session-id.utils.ts`](../../packages/app/src/utils/session-id.utils.ts), session in the
  frame URL, the trail keyed per session, the inspector window and its two channels named per session
- [`verify-sessions.ts`](../../packages/sidecar/scripts/verify-sessions.ts): two sessions in one
  sidecar, navigated apart, nothing crossing — and it passes, as does `verify:settle`

## Step 2 — window management — **done**

Only now does a second window exist, and the platforms diverge.

**macOS** gets real tabs. `tabbingIdentifier` is supported the whole way down — tao exposes
`with_tabbing_identifier`, tauri wraps it on the window builder, and it is in both the config schema
and the JS `WindowOptions`. Three things are not handled for us:

- an identifier alone does not group anything. There is no `setTabbingMode` or `addTabbedWindow:`
  anywhere in tao, so the default `NSWindowTabbingMode.automatic` applies and defers to the user's
  "Prefer tabs" setting — which by default means full screen only. Forcing it needs
  `setTabbingMode(.preferred)` through objc2, which is already a dependency for the cursors, and
  `addTabbedWindow:ordered:` to put the new window in the group it was opened from. Both are in
  [`windows.rs`](../../src-tauri/src/windows.rs).
- the tab bar's `+` button only appears when `newWindowForTab:` is answered, which means adding a
  method to a class tao registered. **Not done**, and not for want of trying: the attempt and the
  AppKit assertion it ends in are written up in
  [`tab-bar-plus-button.md`](../ideas/tab-bar-plus-button.md).
- tabbing is switched off outright for transparent or undecorated windows, so this rules out a
  custom title bar for as long as native tabs are wanted.

A tab is a title and nothing else, which is why the window is now named after the page it shows
([`window-title.utils.ts`](../../packages/app/src/utils/window-title.utils.ts)) — `document.title`
never reached the native window, which nobody could tell while there was one of them.

What comes free once they are grouped: the tab overview, ⌘⇧[ and ⌘⇧], dragging a tab out into its
own window, and Merge All Windows.

**Windows and Linux** get plain windows, which is what their platforms do. A custom strip is a later
decision, and if it is taken, the way that keeps this refactor's shape is several webviews in one
window (`Window::add_child`, behind tauri's `unstable` feature) with a thin chrome webview drawing
the strip — every webview stays single-session, exactly as a window is. Putting several sessions
inside one webview is the other option and is the rewrite this whole plan exists to avoid.

Either way ⌘T and ⌘W have to reach the focused window, and the sidecar may only be killed when the
last window goes.

## Step 3 — paying for it

Three engines per session is three browsers per tab, and four tabs is twelve. Three things keep that
honest — one of which is already in, having fallen out of step 2.

### Share browsers between sessions, one context each — **done**

Today every pane launches its own browser ([`pane.ts`](../../packages/sidecar/src/pane.ts),
`start`), so N sessions are 3N processes. Playwright hosts many `BrowserContext`s per `Browser`, and
a context is exactly what carries the per-session settings already — `#newContext` sets `viewport`,
`deviceScaleFactor` and `colorScheme`, all of which are context properties. So a second window's
Chromium pane wants to be another context in the first window's Chromium, and four tabs becomes
three or four processes instead of twelve. A browser is ~100–200MB; a context is a few.

Pooled by **engine plus launch arguments**, not by engine alone, because of what cannot be shared:

- **Chromium's `--force-device-scale-factor` is a launch argument**, which is the whole reason its
  screencast is not soft on HiDPI. DPR belongs to the process, not the context — `resize` already
  relaunches the pane when the scale changes — so two windows on displays of different scale need
  two Chromiums. Gecko and WebKit pass no launch arguments and can share unconditionally.
- **Crash isolation goes.** One browser per engine means one crash blanks that engine in every
  window at once, and the per-pane heartbeat has to relaunch on behalf of all of them rather than
  for itself. Today a pane dies alone, which is the behaviour the recovery path was written around.
- **A runaway page stalls its neighbours.** Contexts are isolated for storage, not for the engine's
  own scheduling.

[`detached.ts`](../../packages/sidecar/src/detached.ts) already pools the headed browsers this way,
so the shape exists in the repo: a map from key to `Browser`, dropped on `disconnected`, launched on
first use.

Deliberately after step 2 rather than before it. Until a second window can exist there is nothing to
share, and a pool with one member in it is untestable — `verify:sessions` would pass against a pool
that silently never shares anything. It now counts the sidecar's own child processes and fails both
ways: two sessions at one scale that open two browsers, and two at different scales that open one.

Measured in the app: two tabs, six panes, three browser processes where there were six. Killing the
shared Chromium blanked both windows' Chromium panes, as expected, and the relaunch brought them
back as one process.

### Start engines lazily — **done, out of order**

Arrived with the empty new tab rather than here: a comparison with no page launches nothing, and the
first navigation is what brings its engines up. A tab nobody navigates costs nothing, which is what
this item was for.

### Suspend what nobody can see — **done**

`suspend-session` stops the screencast of a window in a background tab and starts it again when the
tab comes back. The pages keep running throughout — still loading, still logging, still where they
were — because what is worthless while a window is hidden is the pictures, not the state.

The signal is `document.visibilityState`, not the window's focus: a window that has lost focus may
still be in plain sight beside the one that took it, and suspending that would be a pane that stops
updating while somebody watches it. Hidden is the webview's own word for occluded — behind another
tab, minimised — which is exactly the case worth stopping for, and it was confirmed to fire on a tab
switch before anything was built on it.

`ensureCapturing` refuses a suspended pane, or the heartbeat would helpfully start the capture again
three seconds later. Coming back asks for a frame outright rather than waiting for one, since a
settled page produces none and the pane would otherwise sit on a picture from before it was hidden.

`verify:sessions` covers it against a page that animates for ever, because suspending a settled pane
looks the same as not suspending it: 0 frames while hidden, 150 from the session beside it, 147 once
it was back.

## Step 4 — restoring what was open — **done**

Tabs that exist only until you quit are tabs nobody arranges. Quitting now writes down every open
comparison and relaunching reopens them in order, under their own labels, each back on its page.

Owned by the backend ([`restore.rs`](../../src-tauri/src/restore.rs)) because the decision needs two
facts that live on opposite sides: the frontend knows the page, and says so on every navigation; the
backend knows whether a window went away because somebody closed it or because the app was quitting.
A closed tab is forgotten as it goes; the survivors are written on `ExitRequested`, while the windows
are still standing.

Measured by hand, since none of it is reachable from the sidecar harness: two tabs on two pages,
quit through the menu, both back as tabs with their pages; then one closed, quit again, and the saved
set held only the one that was left.

What is deliberately not restored: the trail behind each tab, which is still only the first window's
([`session.utils.ts`](../../packages/app/src/utils/session.utils.ts)). A restored comparison opens on
its page with its back arrow empty — the page is the comparison, the trail is how you got there.
