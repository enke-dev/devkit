# DMG bundling

## What happens

`bun run build` builds `DevKit.app` successfully and then fails on the DMG:

```
failed to bundle project: error running bundle_dmg.sh
```

`bun run tauri build --bundles app` skips the step and completes.

## Cause

`bundle_dmg.sh` drives Finder through AppleScript to lay out the disk image window. Without
automation permission — a headless session, an agent-run shell, CI — the AppleScript fails and takes
the bundle step with it.

It may well work from an ordinary interactive terminal that has been granted Finder automation. It
has not been confirmed either way, only observed failing in an agent-run shell.

## Options, if it turns out to matter

- Confirm whether it works interactively before treating it as a problem at all. That is one build.
- Restrict `bundle.targets` to `app` and produce the DMG separately, so a layout script cannot fail
  the whole build.
- Build DMGs in CI with a tool that does not need Finder (`create-dmg` and similar can run without
  AppleScript layout).

Low priority while the app is unsigned anyway: a DMG of an unsigned app is quarantined on arrival,
so it does not yet solve distribution. See [code-signing.md](code-signing.md).
