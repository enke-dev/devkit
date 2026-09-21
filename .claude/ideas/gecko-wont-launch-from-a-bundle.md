# Gecko will not launch when DevKit is started like an app

## What happens

Double-click `DevKit.app` and the Gecko pane fails while the other two render:

```
browserType.launch: Failed to launch the browser process.
[err] *** You are running in headless mode.
[err] Could not find profile folder.
<process did exit: exitCode=1, signal=null>
```

Start the same bundle from a terminal and Gecko comes up. Granting Full Disk Access and launching
from Finder also works. Nothing else differs — same binary, same engine cache, same environment.

## Cause

macOS **App Data** protection. Firefox reads `~/Library/Application Support/Firefox/profiles.ini`
during startup — it does this even when Playwright hands it `-profile`, and even for a persistent
context. That directory belongs to `org.mozilla.firefox`, so reading it from another app is gated.
The kernel says so outright:

```
kernel (Sandbox) sandboxd rejected approval request from firefox for
  AppProtection (/Users/davidenke/Library/Application Support/Firefox/profiles.ini): denied
```

and `tccd` shows the two services it tried, in order:

```
Handling access request to kTCCServiceSystemPolicyAllFiles … Denied (Service Policy)
    fine_grained_object_identifier="org.mozilla.firefox"
checking kTCCServiceSystemPolicyAppDataDetailed for "org.mozilla.firefox", user interaction allowed
Handling access request to kTCCServiceSystemPolicyAppDataDetailed … Denied (None)
```

Full Disk Access is only consulted because it is a **superset** — it is checked first and, when
held, ends the question. The permission actually at stake is the much narrower
`kTCCServiceSystemPolicyAppDataDetailed`, the macOS 14+ "allow access to data from other apps".

This is why it needs no grant from a shell: under a terminal, the same run makes **no AppProtection
request at all** — the responsible process already holds a grant that short-circuits the check.

**It only bites where real Firefox is installed.** The protection maps
`~/Library/Application Support/Firefox` to an installed `org.mozilla.firefox`. This machine has
`/Applications/Firefox.app`. A machine without it should be unaffected — untested, and the cheapest
thing to confirm next, because it decides whether this is everyone's bug or one setup's.

## Measured

Counting Firefox processes 22 seconds after launch, same `DevKit.app`, same cache:

| How it was started             | Firefox processes |
| ------------------------------ | ----------------- |
| `open -n DevKit.app` (launchd) | 0                 |
| child of a shell               | 1                 |

Granting Full Disk Access and launching from Finder: Gecko 1, Chromium 4, WebKit 5. All three.

Chromium and WebKit are unaffected — they read nothing belonging to another app.

## The sandbox_extension line is a red herring

An earlier version of this file blamed:

```
sandbox_extension_issue_file_to_process failed for …/plugin-container.app: 1 (Operation not permitted)
```

It appears in the **succeeding** shell run too — exit 0, page rendered. It is printed and survived.
The only message that separates failure from success is `Could not find profile folder`.

## Ruled out

Workarounds that do not help, all tested against the launchd repro:

- **`HOME` pointed at a private directory.** Firefox resolves its app-data root through
  `NSSearchPathForDirectoriesInDomains`, which reads the password database, not `$HOME`. The denial
  still names the real path.
- **`XRE_PROFILE_PATH` / `XRE_PROFILE_LOCAL_PATH`.** `profiles.ini` is read regardless.
- **`launchPersistentContext` with a directory we own.** Same.
- **`MOZ_LAUNCHER_PROCESS=0`**, **`MOZ_DISABLE_CONTENT_SANDBOX=1`.** No effect.
- **Developer Tools**, granted to DevKit instead of Full Disk Access. Still fails (tested on the real
  app, not the harness).
- **App Management.** Not it — no `kTCCServiceSystemPolicyAppBundles` row is ever requested.
- **Profile location.** Outside `/var/folders`, in a space-free home path: same failure. (An early
  test here was confounded — the path held a space, which truncates Firefox's `-profile` argument on
  its own.)
- **The environment.** Under launchd and under a shell, `HOME`, `TMPDIR` and `USER` are identical,
  the binary is readable and `TMPDIR` writable. Only `PWD` differs. The repro is faithful.
- **The engine cache path**, **quarantine** (only `com.apple.provenance`), **the app's entitlements**
  (ad-hoc, none, no hardened runtime), **Firefox's own signature** (re-signing changed nothing), and
  **a stale download** (fails with engines installed long beforehand).

## Caveat on the harness

`launchctl submit` runs jobs in a **Background** session, and tccd says so:

```
Background Session: service kTCCServiceSystemPolicyAllFiles … validRequester: 1
… Denied (Service Policy)
```

A Background session cannot prompt, so it is denied outright. A Finder launch runs in **Aqua**,
where `user interaction allowed` means macOS *can* put up the "access data from other apps" dialog.
So the harness may be forcing a denial the real app would instead be asked about. Where the two
disagree, the real app is the evidence.

## What follows

- **App Data can be prompted for; Full Disk Access cannot.** There is no macOS API to request FDA —
  it is settings-only by design. The community plugin `ayangweb/tauri-plugin-macos-permissions`
  looks like it asks, but its check is a `read_dir` probe on `~/Library/Safari` and its request is
  `open x-apple.systempreferences:…?Privacy_AllFiles`. That deep link is the ceiling for any app.
  Needing App Data rather than FDA is therefore the better outcome: the prompt is automatic, and
  what it asks for is defensible for a tool that drives browsers.
- **Why no prompt appears today** is the open question, and the two candidates are the Aqua/Background
  split above and our ad-hoc signature. TCC keys grants and prompts to code identity; an ad-hoc
  cdhash changes on every build, so an update orphans whatever was granted — which matches DevKit
  not even being listed in Full Disk Access after a prod update. **Signing with a Developer ID** is
  what makes a grant survive an update, and plausibly what makes the prompt appear at all.
- **Say so on first run.** A pane that failed this way should detect it and explain it, rather than
  printing `Could not find profile folder`, which tells nobody anything. The detection is cheap and
  specific: Gecko alone failed, with that message.
