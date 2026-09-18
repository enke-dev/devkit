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

## The version worth building instead

A comparison inspector, built on what Playwright exposes *uniformly* across the three:

- `page.on('console')` — console messages
- `page.on('request')`, `'response'`, `'requestfailed'` — what each engine actually fetched
- `page.accessibility.snapshot()` — the accessibility tree
- `getComputedStyle` and box metrics through `page.evaluate` — for the element under the pointer

One query, three answers, side by side: the computed `font-family` for the hovered element in each
engine, or the requests one engine made and another did not. That is the thing real developer tools
cannot do, because each of them only ever shows one browser.

**The plumbing is mostly built.** `readCursor` in the sidecar already runs `elementFromPoint` and
`getComputedStyle` inside the page on every pointer move, throttled, with a trailing sample so the
position the pointer *stops* on is the one reported. An inspector is that same probe returning more
fields.

## Escape hatch for the deep cases

A button that opens the current URL in the user's own browser, where their real developer tools and
extensions already live. No maintenance, and honest about what this tool is and is not.
