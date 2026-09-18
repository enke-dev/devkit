# Persisting history

## What exists

The last visited URL is remembered in the webview's local storage and restored on launch, so
closing and reopening resumes the same page. That is the whole of it.

## What does not

**Back and forward are per-session.** Each pane's history lives in its Playwright page and dies with
the browser, so the toolbar's back button cannot reach anything from a previous run. Restoring the
URL gives a pane one entry, not a history.

**There is no visited-URL list** — no suggestions in the address bar, no way to see where you have
been.

## If it is worth doing

The URL list is easy: keep an array in local storage alongside the last URL and offer it from the
address bar.

Restoring actual back/forward is not, and is worth being honest about. A pane's history would have
to be replayed into the engine at startup — navigating each entry in turn so the engine builds its
own stack — which means either visiting every page again (slow, and it re-runs whatever those pages
do) or accepting that the entries exist but their content does not. Neither is obviously right for a
tool whose panes are meant to be disposable.

Note that this cuts against [the ephemeral-context decision](../../README.md): contexts are created
with no persistent storage precisely so nothing survives a session. Persisting history is a
deliberate exception for convenience — persisting cookies or cache would not be.
