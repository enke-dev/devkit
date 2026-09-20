<p align="center">
  <img src="https://raw.githubusercontent.com/enke-dev/devkit/main/assets/icon-macos.png" width="128" alt="DevKit">
</p>

# DevKit

One page, three engines, side by side. DevKit renders the same URL in Chromium, Gecko and WebKit at
once, so you can see where they disagree while you are still writing the code.

Every pane is a real headless browser driven through Playwright — not the platform's webview — so
the comparison means the same thing on every operating system. Navigation and input are mirrored to
all three: type a URL, scroll, click, and watch three engines answer the same event.

<p align="center">
  <picture>
    <source media="(prefers-reduced-motion: reduce)" srcset="https://raw.githubusercontent.com/enke-dev/devkit/main/assets/hello-world.png">
    <img src="https://raw.githubusercontent.com/enke-dev/devkit/main/assets/hello-world.gif" width="960" alt="DevKit rendering the same page in Chromium, Gecko and WebKit">
  </picture>
</p>

## Running it

Needs [Bun](https://bun.sh), [Node](https://nodejs.org) at the version in `.node-version`, and a Rust
toolchain.

```sh
bun install
bun run dev
```

The browser engines are not bundled. They download on first launch into Playwright's shared cache,
which is also where an existing Playwright install already has them.

## Installing it

```sh
bun run build
```

macOS builds are unsigned, so the first launch needs a right-click → Open.

**Gecko needs Full Disk Access** when DevKit is started from the Dock or Finder — without it,
Firefox is refused a permission it needs to start and that pane alone stays empty. System Settings →
Privacy & Security → Full Disk Access → add DevKit. Started from a terminal it inherits the
terminal's permissions and needs nothing. See
[`.claude/ideas/gecko-wont-launch-from-a-bundle.md`](.claude/ideas/gecko-wont-launch-from-a-bundle.md).

## Using it

Keyboard goes to the pane under the pointer — nothing to click first.

|                       | macOS                | Windows and Linux     |
| --------------------- | -------------------- | --------------------- |
| Focus the address bar | `Cmd`+`L`            | `Ctrl`+`L`, `Alt`+`D` |
| Reload                | `Cmd`+`R`            | `Ctrl`+`R`, `F5`      |
| Back                  | `Cmd`+`←`, `Cmd`+`[` | `Alt`+`←`             |
| Forward               | `Cmd`+`→`, `Cmd`+`]` | `Alt`+`→`             |
| Inspector             | `Cmd`+`Shift`+`I`    | `Ctrl`+`Shift`+`I`, `F12` |
| Inspect under pointer | `Cmd`+`Shift`+`C`    | `Ctrl`+`Shift`+`C`    |

Hold `Alt` to drive one pane alone — useful for dismissing a cookie banner without three engines
racing through it.

## Inspecting it

The inspector asks all three engines the same question at once, which is the thing no browser's own
developer tools can do.

**Elements.** Point at any pane and every engine is asked what is under that exact coordinate —
the panes share a viewport, so the point means the same thing in all three. Computed styles line up
in three columns with the rows they disagree about marked, and "only differences" hides the rest.
It descends through open shadow roots and same-origin frames. When two engines resolve *different*
elements at the same point, it says so instead of picking one.

Click to pick: that ends the follow-the-pointer mode and keeps the element selected, and the click
does not reach the page. The highlight then follows its element as you scroll.

**Console.** One stream, not three: every line says which engine printed it, so a warning only
Gecko produced is visible at a glance. Filter by severity, by engine, or by text.

**Evaluate.** One expression, three answers side by side.

The highlight is drawn over the frames and never injected into the page, so nothing you inspect
appears in what the engines render. For breakpoints and the rest, the detach button in a pane's
header opens that page in a real window of the same engine, with its own developer tools.

## More

- [`docs/internals.md`](docs/internals.md) — how capture works, what each engine does differently,
  and the measurements behind every decision
- [`.claude/ideas/`](.claude/ideas/) — deferred work and dead ends, one file each

Windows and Linux are structural so far: never built, never run.
