# Code signing and notarisation

## State

macOS builds are unsigned and un-notarised.

Locally built apps run fine. A build transferred to another machine — downloaded, AirDropped,
copied from a share — gets quarantined by Gatekeeper and refuses to open without the user right
clicking through the warning.

## It is also what makes permissions stick

Gatekeeper was the reason to look at this; TCC is the reason it cannot stay undone. macOS keys every
privacy grant to code identity, and an ad-hoc signature gets a new cdhash on every build — so an
update orphans whatever was granted, and the app disappears from the Settings list rather than
staying there switched off. That is exactly what happens to the Gecko pane after a prod update:
see `gecko-wont-launch-from-a-bundle.md`.

Worth testing at the same time, because it is the better outcome and currently unexplained: the
permission actually at stake there is App Data, which macOS *can* prompt for. No prompt appears
today, and a stable identity is one of the two candidate reasons.

## Why it has not been done

It needs an Apple Developer account, a Developer ID certificate, and an app-specific password or API
key for notarisation. None of that was in scope while the app had not yet been shown to work.

## What it involves

Tauri supports this through configuration and environment: signing identity in the bundle config,
`APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` (or an API key) for notarisation, which runs as part
of `tauri build`.

One thing specific to this app: the **sidecar binary is a copy of Node**, sitting in
`Contents/MacOS/` next to the app executable. It carries its own signature from wherever it came
from. Signing the bundle has to cover it correctly, and a hardened-runtime build may need
entitlements for it to execute at all. Expect this to be the part that misbehaves — a stock Tauri
app has no second executable to worry about.

Windows signing is a separate exercise and has not been looked at.
