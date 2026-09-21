# DevKit as an agent's cross-engine answer

DevKit is a window a person looks at. The thing it is actually good at — asking three engines one
question and showing where they disagree — is not a picture, and there is no reason it has to stay
behind a webview.

An agent writing CSS has the same question a person does: *does this hold up in Gecko and WebKit, or
only in the one I am looking at?* Today it cannot ask anything. Playwright's own MCP server can drive
a browser, but one browser per session, with the orchestration of three left to the agent — which is
the part an agent does worst.

So the question is not whether to open DevKit up, but what exactly is worth handing out.

## What this is not

Not a remote control. A surface that re-exposes `navigate`, `input` and a screenshot is
[playwright-mcp](https://github.com/microsoft/playwright-mcp) with fewer features and a Tauri
dependency, and there is no reason to write it.

Everything below exists because of one claim: **the answer is the diff, not the three readings.**
Handing back three DOM dumps and letting the model reconcile them spends the tokens that were the
saving, and reconciling three near-identical trees is exactly the work a model gets subtly wrong. If
a tool cannot say *what differs* in its own words, it does not belong here.

## What is worth exposing

Four things in the protocol are differentiated. Everything else is either UI plumbing or something
Playwright already does better on its own.

**A point is the only cross-engine identity there is.** `inspect`
([`packages/protocol/src/index.ts`](../../packages/protocol/src/index.ts), the `inspect` command)
takes viewport pixels, not a selector, and every pane shares one viewport. This matters more for an
agent than for a person: a selector is written against one engine's understanding of the document,
which is the very thing under test. Three engines resolving different elements at one point is a
finding that cannot be phrased any other way.

**Lockstep is already built.** One session is one URL, one viewport, one `colorScheme`, three
engines. An agent asked to reproduce that with three Playwright sessions has to keep them in step by
hand on every navigation, resize and scheme change, and will drift.

**Three console streams, one vocabulary.** `console-message` classifies twice — `level` for how bad,
`kind` for what shape — and carries `at` plus per-engine `seq` so three streams sort into one list. A
warning only Gecko prints is high-signal and free; nothing has to be asked for it.

**Settled device-resolution stills.** The `sharp` frame is taken after the pane settles, at device
resolution, rather than being a live screencast frame. That is the only capture here worth diffing.

Deliberately not exposed: `input` mirroring, `cursor`, `detach`, `dom-watch`/`dom-mutated`, and the
frame channel itself. All of them exist to make a live picture feel alive, which is a thing no agent
is doing. `probe` and `install` stay internal behind a single "engines are ready" step.

## Diff geometry, not pixels

The obvious first move — screenshot three engines, count differing pixels — is the one to avoid.
Font rasterisation, subpixel antialiasing and scrollbar metrics differ between engines on every page
ever written, so a pixel diff reports a difference on all of them. A signal that always fires is not
a signal, and an agent handed one will either chase noise or learn to ignore the tool.

What is meaningful is what `InspectedElement` already carries: boxes. *Gecko gives this element 340px
where the others give 328* is a sentence someone can act on; *2.1% of pixels differ* is not. So
geometry is the primary comparison and pixels are secondary evidence — rendered for a human to look
at, never the thing a tool reports a verdict on.

This needs a tolerance, and the tolerance is the open question. Engines round subpixel layout
differently, so an epsilon of zero reports every page and an epsilon too generous hides the 1px
border that started the investigation. Best guess is a fraction of a CSS pixel with a separate,
larger allowance for text metrics, but it has to be measured against real pages before it is chosen.

## Step 1 — a comparison CLI

The sidecar is already a headless NDJSON server over stdin/stdout, and the `verify:*` scripts are
already hosts in their own right — which is what `DEFAULT_SESSION` exists for. There is no server to
write, only a command that speaks what those scripts already speak.

```
devkit compare <url> [--viewport WxH] [--scheme light|dark] --json
devkit compare <url> --point X,Y --json
devkit compare <url> --console --json
devkit compare <url> --query <text> --json
```

Each prints one JSON object: per-engine browser version and title, then the differences, then — for
the render case — paths to the three stills on disk. An agent can run this today over Bash with no
MCP at all, and so can CI.

Start with `--point` and the plain render. They are the smallest pair that tests the claim: if a
point-identity diff does not read as obviously useful in a real investigation, nothing built on top
of it will either.

## Step 2 — a skill

A page telling an agent when to reach for the CLI and how to read what it prints. Costs nothing while
idle, works for agents that have no MCP support, and needs no process to be running.

This is where the judgement lives — that a difference in `display` between engines matters and a 1px
scroll offset usually does not — and prose is a better home for that than a tool description.

## Step 3 — MCP, only if the loop is too slow

Three cold browser launches per call is seconds and several hundred megabytes. Fine for a one-shot
check, wrong for an investigation that asks twelve questions about one page.

The fix is a warm session, and the protocol already has the shape for it: sessions are keyed and the
sidecar holds up to `MAX_SESSIONS` of them, so an agent's session coexists with whatever windows are
open. An MCP server is then a thin thing that holds one session open across calls and closes it on
idle.

Worth writing only once the CLI has proved the answers are good and the launch cost is what hurts. In
CI, a plain Playwright test file beats both of these and should.

## Security

`evaluate` takes an arbitrary expression and runs it in the page. That is correct for a local
inspector and is arbitrary code execution the moment anything but the local user can reach it.

- Bind to loopback only. Never `0.0.0.0`, not even behind a flag.
- Require a token generated per run, passed by the caller; an unauthenticated local port is reachable
  by any process on the machine, including a page's own fetch.
- Keep `compare_eval` behind an explicit opt-in rather than on by default, so the dangerous verb is a
  decision rather than an inheritance.
- Treat the URL as untrusted input throughout: the agent supplies it, and `file://` reaches the whole
  disk.

## Open questions

- The geometry tolerance, above. Needs numbers from real pages.
- Whether a diff should report engine-versus-engine or majority-versus-outlier. Two-against-one is
  the common case and reads better, but three-way disagreement is real and must not be flattened.
- What `--console` waits for. There is no moment a page is done logging, so it needs a settle
  definition, and the sidecar's existing settle is about frames rather than messages.
- Whether the CLI should reuse a running DevKit's sidecar or always start its own. Own process is
  simpler and cannot disturb a window somebody is using.
