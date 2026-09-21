# Developer tools for all three engines at once

## The question

Could the app open developer tools for every pane at the same time — and would they have to be
streamed like the frames, or could they be native and merely attached?

## Why it cannot be symmetric

**Chromium — properly, two ways.** DevTools is itself a web application, so it can be pointed at a
page's CDP websocket and run *inside* our own window: not streamed pixels, the real DevTools talking
CDP to the page. Playwright's build supports `--remote-debugging-port` as well as the pipe it uses by
default, and launch arguments are already ours to set. The alternative — a native DevTools window —
needs a headed browser, and a headed browser is a separate OS window that cannot be embedded, which
gives up the single-window design.

**Gecko — awkward.** Firefox's developer tools are not a detachable frontend that can be aimed at a
remote target the way Chrome's are. The route is the remote debugging protocol plus *another*
Firefox's `about:debugging` connected to it: a second native window, not embedded, and unproven
against Playwright's patched Juggler build.

**WebKit — effectively not.** The Inspector protocol exists inside Playwright's build, but no
inspector UI ships that can attach to a headless one, and it is not Safari.

So "all three at once" means one excellent panel, one awkward extra window, and one empty seat —
three different tools with three different capabilities, which is the opposite of what this app is
for.

## The version that got built instead

A comparison inspector, on what Playwright exposes *uniformly* across the three. Elements, console
and evaluation are done and documented in
[`docs/internals.md`](../../docs/internals.md#introspection-one-point-three-answers): one point,
three answers, with the rows the engines disagree about marked.

## What is left of this idea

Two of the four uniform surfaces are still unused:

- **`page.on('request')`, `'response'`, `'requestfailed'`** — what each engine actually fetched.
  The requests one engine made and another did not is a comparison nothing else offers, and it is
  the one most likely to explain a rendering difference that the computed styles do not. Needs
  thought about volume: three engines on a heavy page is thousands of events, and the console
  channel's coalescing does not transfer — requests are not repeats of each other.
- **`page.accessibility.snapshot()`** — the accessibility tree. Uniform across the three and
  genuinely divergent between them, which makes it a good fit. The open question is what to compare
  it *at*. That question is now half-answered: the elements panel is a real tree, with per-pane
  handles for rows and an engine-neutral identity chain for the selection, so an a11y snapshot has
  something to hang off. What is left is whether it compares best as a whole tree beside the DOM
  one or as the node under the selection.


## Escape hatch for the deep cases

Already there: the detach button opens the pane's page in a headed window of the same engine, where
that engine's real developer tools live. No maintenance, and honest about what this tool is and is
not.
