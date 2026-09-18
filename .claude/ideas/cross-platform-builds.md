# Cross-platform builds

## State

**DevKit has only ever run on macOS (arm64).** Windows and Linux are structurally supported and have
never been executed. No cross-platform build has been produced, so nothing here is known-broken —
it is simply unverified.

## What is already in place

- `prepare-sidecar.ts` takes `DEVKIT_NODE_BINARY` and `DEVKIT_TARGET`, so the staged Node runtime
  and its target-triple filename can both be supplied for another platform.
- `bundle-sidecar.ts` copies dependencies with Node's own `fs.cp` and path handling rather than
  shelling out, so it should work on Windows unchanged.
- The Rust sidecar lookup uses the bare binary name, which Tauri resolves per platform.

## What to expect to go wrong

- **The staged Node binary is never validated against the triple.** Supply a macOS Node with
  `DEVKIT_TARGET=x86_64-pc-windows-msvc` and it will build a bundle that cannot start its sidecar.
  A magic-number check would catch this cheaply.
- **Linux WebView.** The app chrome is WebKitGTK there. Nothing in the frontend should care, but it
  has not been exercised.
- **Playwright's browser cache location** differs per platform. This is Playwright's business, not
  ours, but first-run download is the least-tested path and it is the first thing a new platform
  hits.
- **Windows process termination.** The sidecar is killed on app exit; whether headless browsers are
  reliably reaped on Windows is untested.

## Note

Getting a real Windows or Linux run is worth more than any amount of further reasoning about it.
