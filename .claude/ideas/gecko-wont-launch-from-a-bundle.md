# Gecko will not launch when DevKit is started like an app — it needs Full Disk Access

## What happens

Double-click `DevKit.app` and the Gecko pane fails while the other two render. The pane shows:

```
browserType.launch: Failed to launch the browser process.
[err] sandbox_extension_issue_file_to_process failed for
      …/ms-playwright/firefox-1543/firefox/Nightly.app: 1 (Operation not permitted)
[err] Could not find profile folder.
<process did exit: exitCode=1, signal=null>
```

Start the same bundle from a terminal and Gecko comes up. Nothing else differs — same binary, same
engine cache, same environment variables.

## Measured

Counting Firefox processes 22 seconds after launch, same `DevKit.app`, same cache:

| How it was started              | Firefox processes |
| ------------------------------- | ----------------- |
| `open -n DevKit.app` (launchd)  | 0                 |
| child of a shell                | 1                 |

It is not the app. The bundled Node running a four-line Playwright script fails the same way when
`launchctl submit` starts it, and succeeds when the shell does:

```js
const { firefox } = require('playwright');
await firefox.launch({ headless: true });   // EPERM under launchd, fine under a shell
```

So: **Playwright's Firefox cannot launch from a process whose ancestry is launchd**, on this machine.
Chromium and WebKit are unaffected — they do not ask for a sandbox extension for their own bundle.

## Ruled out

- **The engine cache path.** Fails from `~/Library/Caches/ms-playwright` and from a temp directory
  alike; succeeds from both under a shell.
- **Quarantine.** No `com.apple.quarantine` on the Firefox bundle, only `com.apple.provenance`.
- **The app's entitlements.** `DevKit.app` is ad-hoc signed with no entitlements and no hardened
  runtime, so nothing is inherited that could deny this.
- **Firefox's own signature.** `codesign --verify` did report it broken — "code has no resources but
  signature indicates they must be present" — but re-signing it ad-hoc changed nothing.
- **`MOZ_DISABLE_CONTENT_SANDBOX=1`** passed through to the browser. No effect.
- **A stale or half-written download.** Fails with engines installed long beforehand.

## Cause: TCC

It was the permissions after all. A process started from a terminal inherits that terminal's grants;
an app launched by launchd is its own responsible process and has none of them. Firefox asks for
something the others do not, and is refused.

Granting `DevKit.app` **Full Disk Access** and launching it again:

| Engine   | Processes after 25s |
| -------- | ------------------- |
| Gecko    | 1                   |
| Chromium | 4                   |
| WebKit   | 5                   |

All three, started the way anyone would start it.

## What is left

- **Nobody should have to do this.** A tool that renders three engines is not obviously a tool that
  needs the whole disk, and "grant Full Disk Access before it works" is a poor first launch. Worth
  finding out whether something narrower is enough — Developer Tools is the next candidate, and can
  be tested by removing the Full Disk Access grant and adding that one instead.
- **The grant is tied to the signature.** Ad-hoc signatures change with every build, so a grant made
  for today's build may not carry to tomorrow's. Signing with a stable Developer ID is what makes a
  grant stick, and is worth doing before anyone else installs this.
- **Say so on first run.** Until the above is settled, a pane that failed this way should say what
  to do rather than showing the browser's own sandbox error. Right now it prints the raw failure,
  which explains nothing to anyone who has not read this file.
