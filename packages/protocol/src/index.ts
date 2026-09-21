/**
 * Wire protocol between the Tauri backend (Rust) and the Playwright sidecar (Node).
 *
 * Transport is newline-delimited JSON over the sidecar's stdin/stdout. The Rust
 * side is a dumb relay: it parses just enough to route, and forwards payloads to
 * the frontend over Tauri events. Keep this file in sync with
 * `src-tauri/src/protocol.rs`.
 */

export const ENGINES = ['chromium', 'firefox', 'webkit'] as const;

export type Engine = (typeof ENGINES)[number];

/** Human-facing engine labels. Gecko/WebKit are the engines, Firefox/Safari the browsers. */
export const ENGINE_LABELS: Record<Engine, string> = {
  chromium: 'Chromium',
  firefox: 'Gecko',
  webkit: 'WebKit',
};

/**
 * The scheme a page is told the user prefers.
 *
 * Playwright emulates `prefers-color-scheme` per context and defaults it to
 * light, whatever the host machine is set to — so it is always stated, never
 * inherited.
 */
export type ColorScheme = 'light' | 'dark';

export interface Viewport {
  width: number;
  height: number;
  /** Device pixel ratio the engine renders at. */
  scale: number;
}

// ---------------------------------------------------------------------------
// Host -> sidecar
// ---------------------------------------------------------------------------

export type Command =
  /** Report whether Playwright's browser binaries are present, per engine. */
  | { type: 'probe' }
  /**
   * Download missing browser binaries, streaming `install-progress` events.
   * Omitting `engines` means every missing engine.
   */
  | { type: 'install'; engines?: Engine[] }
  /** Launch the given engines and start capturing. Idempotent per engine. */
  | { type: 'start'; engines: Engine[]; viewport: Viewport; colorScheme: ColorScheme }
  /**
   * Navigate every running pane to the same URL (lockstep navigation).
   *
   * Back and forward are navigations too. The app keeps the trail — it outlives
   * the engines, which have no history of their own after a restart — so it
   * says where to go rather than asking them to step.
   */
  | { type: 'navigate'; url: string }
  | { type: 'reload' }
  /** Resize every pane's viewport. Frames after this arrive at the new size. */
  | { type: 'resize'; viewport: Viewport }
  /**
   * Tell one pane's page which colour scheme the user prefers.
   *
   * Per pane rather than lockstep: seeing one engine's dark rendering beside
   * another's light one is a comparison worth making. Applied in place, so no
   * relaunch and no frame is lost to it.
   */
  | { type: 'color-scheme'; engine: Engine; scheme: ColorScheme }
  /**
   * Open the pane's current page in a headed window of the same engine.
   *
   * The pane itself is untouched: this is a second browser beside it, for the
   * things a streamed picture cannot give — the engine's own developer tools
   * above all. What happens in that window is the user's business; nothing
   * mirrors it back.
   */
  | { type: 'detach'; engine: Engine }
  /**
   * Replay a user input event in one pane, or in all of them at once.
   *
   * Mirroring to `'all'` matches lockstep navigation: one click, three engines
   * reacting side by side. Coordinates are viewport pixels, and since every
   * pane shares one viewport they need no per-engine adjustment.
   */
  | {
      type: 'input';
      engine: Engine | 'all';
      event: InputEvent;
      /**
       * The pane the pointer is actually over. Input is mirrored to every pane,
       * but only this one is asked what cursor it would be showing — three
       * round trips per movement to learn the same answer would be wasteful.
       */
      source?: Engine;
    }
  /**
   * Ask what is at a point, in one pane or in all of them at once.
   *
   * Coordinates are viewport pixels, the same ones `input` uses, and every pane
   * shares one viewport — so a point is the only cross-engine identity an
   * element has here. There is no selector and no node handle: each engine
   * answers for whatever *it* finds under those coordinates, and when they find
   * different things that disagreement is the answer rather than something to
   * reconcile away.
   *
   * Answers come back as `inspected` events, one per pane, each carrying this
   * command's `id`; the `ack` only says the question was asked.
   */
  | { type: 'inspect'; engine: Engine | 'all'; x: number; y: number }
  /**
   * Measure the element each pane last inspected, wherever it is now.
   *
   * Scrolling moves an element without changing which element it is, and the
   * highlight is drawn from rectangles — so it has to be told. Asking by point
   * again would not be stale but wrong: the point now holds whatever scrolled
   * into it.
   *
   * This is the one thing in the protocol that refers to an element without
   * naming it. Each pane holds its own last inspection and answers for that;
   * nothing identifying it crosses the wire, so the panes cannot be asked about
   * each other's, which is the same restriction that makes a point the identity
   * in the first place.
   *
   * Answered by `inspected` events carrying this command's `id`, exactly as
   * `inspect` is. A pane whose element has since left the document answers with
   * a null element.
   *
   * Mostly a fallback now: a pane volunteers a `selection` event whenever
   * something replayed through us moved the element. This is for the movement
   * nothing told us about — a page scrolling itself, a layout settling late.
   */
  | { type: 'remeasure'; engine: Engine | 'all' }
  /**
   * Let go of whatever each pane was holding selected.
   *
   * The counterpart to an inspect, and the protocol has no business without
   * it. A pane that has a selection measures it again after every input that
   * could have moved the page, and volunteers a `selection` event when it did —
   * which is exactly right while somebody is looking at the drawer, and is an
   * evaluation per pane per scroll for a panel that has been shut.
   *
   * Two things stop, and both matter. The page stops being asked, which is the
   * cost; and the pane stops volunteering, which is the ghost — an element
   * selected before the drawer was closed would otherwise be drawn over the
   * pane again the first time the page scrolled after it was reopened.
   *
   * Acked only. There is nothing to answer: it is the absence of a selection,
   * and the highlight it belonged to has already gone.
   */
  | { type: 'deselect'; engine: Engine | 'all' }
  /**
   * The document element of one pane, or of all of them, with a few levels
   * already in hand.
   *
   * The first command in the protocol that hands out *references*. Everything
   * around it identifies an element by the point it was found at, which is what
   * lets three engines be asked one question — but a tree is navigated rather
   * than pointed at, and a row that cannot be asked about again is a row that
   * cannot be opened. So the walker keeps a registry and these commands trade
   * in its keys.
   *
   * A `nodeId` is only ever valid in the pane that issued it and only until
   * that pane navigates: it carries the document's generation, and the walker
   * refuses one from a document it no longer is. Nothing may compare two panes'
   * ids, which is why `DomNode` also carries `step` — the engine-neutral
   * identity that `dom-resolve` trades in.
   *
   * `depth` is how many levels to send unasked, two by default. One level means
   * a round trip per twisty on the way down; the whole tree means megabytes for
   * a page nobody will open a tenth of.
   *
   * Answered by `dom-nodes` events carrying this command's `id`.
   */
  | { type: 'dom-root'; engine: Engine | 'all'; depth?: number }
  /**
   * The children of one node, for the twisty that was just opened.
   *
   * Answered by `dom-nodes` events carrying this command's `id`. A pane whose
   * id has gone stale — the page navigated under it — answers with an empty
   * list and an error, rather than with somebody else's subtree.
   */
  | { type: 'dom-children'; engine: Engine | 'all'; nodeId: string; depth?: number }
  /**
   * Everything the styles panel shows about the element a row stands for, in
   * every pane at once.
   *
   * Addressed by identity rather than by handle, which is what lets one command
   * ask all three. A handle belongs to the pane that minted it, so a
   * handle-addressed describe would be three commands with three ids and three
   * separate collections of answers; `steps` is the engine-neutral chain — tag,
   * position among same-tag siblings, and the boundary each step crossed —
   * which every pane can walk down for itself.
   *
   * A pane that has no such element answers with a null element, which is a
   * finding rather than a failure: it means the engines built different trees,
   * which is the thing this app exists to show.
   *
   * Answered by `inspected` events, exactly as `inspect` is — the same event,
   * because the tree changed how an element is *named*, not what is said about
   * it, and the app collects three answers to one question either way.
   */
  | { type: 'dom-describe'; engine: Engine | 'all'; steps: string[] }
  /**
   * The nodes matching a selector, or holding a piece of text.
   *
   * One engine rather than all three: searching is how somebody gets to a node,
   * and the selection that follows is what the other panes are asked to match.
   * Running it everywhere would produce three result lists nobody asked to
   * reconcile.
   *
   * Answered by `dom-found` events carrying this command's `id`.
   */
  | { type: 'dom-search'; engine: Engine; query: string; limit?: number }
  /**
   * Which subtrees the app is actually showing, so the panes can say when they
   * change.
   *
   * The whole set every time rather than a diff: it is small — what is expanded
   * on screen — and a diff protocol would need the two sides to agree about a
   * history neither keeps. An empty set turns the watch off entirely, which is
   * the state every session that never opens the inspector stays in.
   *
   * Acked only. What it produces afterwards is `dom-mutated`.
   */
  | { type: 'dom-watch'; engine: Engine | 'all'; nodeIds: string[] }
  /**
   * Evaluate an expression in one pane's page, or in all of them at once.
   *
   * The `engine: Engine | 'all'` shape is `input`'s, for the same reason: the
   * case worth having is one expression answered three times side by side.
   * Evaluated as an expression rather than a statement list, and awaited if it
   * produces a thenable. What it produces is *described* rather than returned —
   * see `EvaluatedValue`.
   *
   * Answers come back as `evaluated` events carrying this command's `id`.
   */
  | { type: 'evaluate'; engine: Engine | 'all'; expression: string }
  /** Close all contexts and browsers, then exit. */
  | { type: 'shutdown' };

/** Pane-relative input, in viewport pixels with the pane's top-left as the origin. */
export type InputEvent =
  | { kind: 'mousemove'; x: number; y: number }
  | { kind: 'mousedown'; x: number; y: number; button: 'left' | 'middle' | 'right' }
  | { kind: 'mouseup'; x: number; y: number; button: 'left' | 'middle' | 'right' }
  | { kind: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }
  | { kind: 'keydown'; key: string }
  | { kind: 'keyup'; key: string }
  | { kind: 'text'; text: string };

/** A command with the correlation id the sidecar echoes back in its `ack`. */
export type Request = Command & { id: string };

// ---------------------------------------------------------------------------
// Sidecar -> host
// ---------------------------------------------------------------------------

export type Event =
  /**
   * The sidecar's identity. Confirms the process is alive and speaking.
   *
   * Written once at spawn — before the window exists — and again in answer to
   * `probe`, which is how a frontend that reloaded learns it at all.
   */
  | { type: 'hello'; pid: number; playwrightVersion: string; nodeVersion: string }
  /** Terminal response to a `Request`; `id` correlates. */
  | { type: 'ack'; id: string; ok: true }
  | { type: 'ack'; id: string; ok: false; error: string }
  /** Result of `probe`: which engines already have their binaries downloaded. */
  | { type: 'browsers'; installed: Record<Engine, boolean> }
  /**
   * How a download is going.
   *
   * `percent` is filled in when the line it came from carried one, which is
   * most of them while bytes are moving; `engine` says which download it
   * belongs to, read from the downloader's own announcements rather than
   * assumed from what was asked for.
   */
  | {
      type: 'install-progress';
      engine: Engine | null;
      message: string;
      percent?: number;
      done: boolean;
    }
  /**
   * Lifecycle of a single pane.
   *
   * `version` is the browser build behind the engine, reported once it is up.
   * Which build rendered a page is the first thing worth knowing when two panes
   * disagree, so it is stated rather than left to be guessed from the engine name.
   */
  | { type: 'pane'; engine: Engine; status: PaneStatus; detail?: string; version?: string }
  /** Navigation state, mirrored into the address bar and nav buttons. */
  | { type: 'navigation'; engine: Engine; url: string; title: string; loading: boolean }
  /**
   * A frame is available.
   *
   * Carries no pixels: the sidecar sends those to the backend over the frame
   * channel, and the frontend fetches them over `FRAME_SCHEME`. This event only
   * says that a new one exists and what shape it is.
   */
  | {
      type: 'frame';
      engine: Engine;
      seq: number;
      mime: 'image/jpeg' | 'image/png';
      width: number;
      height: number;
      /**
       * A device-resolution screenshot taken after the pane settled, rather than
       * a live screencast frame. Live frames are CSS resolution — the only size
       * every engine agrees to deliver — so this is what makes a still pane
       * sharp on a HiDPI display.
       */
      sharp?: boolean;
    }
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string }
  /**
   * The CSS cursor the engine would be showing under the pointer.
   *
   * Sent only when it changes. The engine's own answer is what makes a link
   * feel like a link: the pane can show a real pointer cursor rather than
   * guessing from the image.
   */
  | { type: 'cursor'; engine: Engine; css: string }
  /**
   * The selected element has moved, because something was done to the pane that
   * moved it.
   *
   * Volunteered rather than asked for, in the same spirit as `cursor`: the pane
   * knows when it scrolled, and it knows *before the next frame is captured* —
   * which is the only moment at which a rectangle and the picture it annotates
   * agree about where anything is. A frontend polling for this instead measures
   * some time after the scroll and some time before the frame, and the highlight
   * visibly lags its element for the length of that gap.
   *
   * Sent only when the element has actually moved, and only by a pane that has
   * a selection at all. A null element means what was selected has left the
   * document, which is the highlight's cue to go.
   */
  | { type: 'selection'; engine: Engine; element: InspectedElement | null }
  /**
   * What one engine found under an `inspect` point.
   *
   * `id` is the command's, so the panes' answers to one question can be
   * collected; they arrive independently and in no particular order. This is
   * the only event besides `ack` that carries a request id, because it is the
   * only other one that answers a question rather than announcing something.
   *
   * A pane that was not running never answers at all, which is why the app
   * counts answers against the panes it asked rather than waiting for three.
   *
   * `element` is null when the engine found nothing at that point — past the
   * end of a short page, or a pane mid-navigation. That is a finding, not a
   * failure: two panes resolving an element where a third resolves nothing is
   * exactly the kind of difference this exists to show. `error` is the other
   * thing, and means the engine could not be asked at all.
   */
  | {
      type: 'inspected';
      id: string;
      engine: Engine;
      element: InspectedElement | null;
      error?: string;
    }
  /**
   * A slice of one engine's DOM tree, answering a `dom-root` or `dom-children`.
   *
   * `id` is the command's, the way `inspected` carries it and for the same
   * reason: three panes answer one question independently and in no order.
   *
   * `nodes` is the requested level, each node carrying however many of its own
   * levels the command's `depth` asked for. An `error` with an empty list means
   * the pane could not be asked — a stale id, most often, which is what a
   * navigation turns every outstanding id into.
   */
  | { type: 'dom-nodes'; id: string; engine: Engine; nodes: DomNode[]; error?: string }
  /** What a `dom-search` matched, in document order and capped by its limit. */
  | { type: 'dom-found'; id: string; engine: Engine; matches: DomMatch[] }
  /**
   * What changed inside the subtrees this pane was asked to watch.
   *
   * Volunteered rather than answered, so it carries no request id. Coalesced
   * per node before it is sent: a framework re-rendering a list produces
   * hundreds of records describing a handful of nodes, and the app only ever
   * wanted to know which rows to redraw.
   */
  | { type: 'dom-mutated'; engine: Engine; changes: DomChange[] }
  /**
   * Everything this pane said about its tree is void — start again from
   * `dom-root`.
   *
   * Two causes, deliberately not distinguished: the document was replaced, or
   * so much of it changed at once that describing the changes costs more than
   * refetching what is on screen. Either way every `nodeId` the app holds for
   * this engine is now worthless, and the only safe answer is to say so rather
   * than to let stale ids resolve to whatever inherited their numbers.
   */
  | { type: 'dom-invalidated'; engine: Engine }
  /** What one engine made of an `evaluate` expression; `id` correlates. */
  | { type: 'evaluated'; id: string; engine: Engine; result: EvaluatedValue }
  /**
   * A console message from one engine's page.
   *
   * Never asked for: panes stream these from the moment they come up, the way
   * frames do. A message only one engine printed is the whole point, and a
   * console switched on after the page had already loaded has missed it.
   *
   * `at` is the sidecar's clock when the message arrived and `seq` counts per
   * engine. Both are needed to put three streams in one list: `at` orders them
   * against each other, and `seq` breaks the ties a page logging in a loop
   * produces by the dozen.
   *
   * A message is classified twice, because there are two questions about it and
   * one answer cannot serve both. `level` is how bad it is; `kind` is what shape
   * it has — whether it opens a group, clears the console, or is simply a line
   * of text. Both are closed unions, so the app can switch on them exhaustively
   * and render every engine the same way.
   *
   * `nativeKind` is the engine's own word, verbatim. Playwright passes these
   * through and the vocabularies differ, so anything the shared vocabulary has
   * no name for arrives as `kind: 'other'` and can be ignored — while the word
   * that would justify special treatment is still there for whoever comes to
   * add it.
   */
  | {
      type: 'console';
      engine: Engine;
      seq: number;
      at: number;
      level: ConsoleLevel;
      kind: ConsoleKind;
      nativeKind: string;
      text: string;
      location?: SourceLocation;
      /**
       * How many identical messages this one stands for, when more than one.
       *
       * A page logging inside `requestAnimationFrame` produces sixty messages a
       * second per engine, and this channel queues rather than dropping — so
       * coalescing happens before the queue, not in the view. Absent means one.
       */
      repeats?: number;
      /**
       * Messages discarded before this one because the engine exceeded
       * `CONSOLE_RATE_LIMIT`, so a truncated console says so rather than
       * quietly lying about what the page printed.
       */
      dropped?: number;
    }
  /**
   * An uncaught exception or unhandled rejection in one engine's page.
   *
   * Separate from `console` because the engines are separate about it: what
   * reaches `page.on('console')` as an error, what reaches `pageerror`, and
   * whether an unhandled rejection reaches either at all, differ between the
   * three. Keeping them apart lets the app say which channel it came from
   * instead of pretending they are one.
   */
  | {
      type: 'page-error';
      engine: Engine;
      seq: number;
      at: number;
      message: string;
      stack?: string;
      /**
       * Messages the rate limit discarded before this one.
       *
       * The budget is one per engine and covers both channels, so whichever
       * message gets through next is the one that reports what was lost — an
       * error can just as easily be the first thing out the far side of a
       * flood as an ordinary line.
       */
      dropped?: number;
    };

// ---------------------------------------------------------------------------
// Introspection
// ---------------------------------------------------------------------------

/** A rectangle in top-level viewport CSS pixels, with the pane's top-left as the origin. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The four boxes, so the app can draw a real highlight over the screencast.
 *
 * The overlay is drawn in the app and never injected: a highlight inside the
 * page would appear in the captured frames, which would make the page being
 * described a different page from the one being shown. That is also why these
 * are rectangles rather than a node handle — everything the overlay needs
 * travels in the event.
 *
 * Always in **top-level** viewport pixels, whatever depth the element was found
 * at. An element inside an iframe measures itself in that frame's coordinates,
 * so the walker translates back up on the way out; without that the highlight
 * would land somewhere else on exactly the pages where a frame is involved.
 *
 * Only `border` comes straight from the engine (`getBoundingClientRect`); the
 * other three are derived from computed insets, because no engine exposes them
 * outside its own debugging protocol.
 */
export interface BoxModel {
  content: Rect;
  padding: Rect;
  border: Rect;
  margin: Rect;
}

/**
 * One step of the breadcrumb from the inspected element up to the top document.
 *
 * `index` counts among siblings *of the same tag*, the way `:nth-of-type`
 * does, rather than among all of them. It is here because the three panes have
 * to be asked whether they resolved the *same* element before their values can
 * be shown as one table, and tag plus index plus boundary, all the way up, is
 * that question — the app derives an identity from this list and compares the
 * three. Equal identities mean one element described three times; unequal ones
 * mean the engines resolved different elements at that point, which is not an
 * error state but the most interesting thing this feature can report.
 *
 * Counting within the tag is what makes that question answerable on a real
 * page. A raw child index moves whenever anything at all is inserted beside
 * the element — a dev server's overlay, a framework's injected style tag, a
 * node one engine kept and another folded away — and every one of those would
 * have reported three engines disagreeing about an element they had all found.
 */
export interface ElementRef {
  /** Lowercased, as the DOM reports it: `div`, `my-card`. */
  tag: string;
  id?: string;
  classes: string[];
  index: number;
  /**
   * What was crossed to reach this step from the one nearer the element.
   *
   * `shadow` means the nearer step lives in this element's shadow root, `frame`
   * that it lives in this element's document. Absent for an ordinary parent.
   */
  boundary?: 'shadow' | 'frame';
}

/**
 * One CSS rule that applies to the inspected element.
 *
 * Best-effort, and allowed to be missing entirely: matched rules mean walking
 * `document.styleSheets`, and reading `.cssRules` of a sheet served from
 * another origin throws `SecurityError`. A page whose CSS comes from a CDN
 * yields nothing here and must still inspect perfectly — computed styles are
 * the panel that always works, and this is the one that sometimes adds to it.
 *
 * `origin` is the sheet's href, or `<style>` for an inline sheet and
 * `element.style` for the style attribute, which is reported as a rule with an
 * empty selector so it can sit at the top of the same list.
 */
export interface MatchedRule {
  selector: string;
  origin: string;
  /** `@media`, `@supports` and `@layer` conditions wrapping the rule, outermost first. */
  conditions: string[];
  declarations: [property: string, value: string][];
}

/**
 * What one engine says is at the inspected point.
 *
 * Deliberately a description and not a reference. Nothing here can be handed
 * back to an engine to mean "that element again": the next inspect is another
 * point, and the point is the identity.
 */
export interface InspectedElement {
  tag: string;
  id?: string;
  classes: string[];
  /**
   * Position among element siblings in its own root, counted from zero — the
   * same measure `ElementRef` carries, for the same reason.
   *
   * The identity the app compares runs from the document down to the element,
   * and the last step of it is the element itself; without this the comparison
   * would stop at its parent and call two different children a match.
   */
  index: number;
  /** Everything but `id` and `class`, which have their own fields, in document order. */
  attributes: [name: string, value: string][];
  /** Parent upwards to the outermost document element, nearest first. */
  path: ElementRef[];
  /**
   * The document the element actually lives in — the pane's own URL unless a
   * frame was entered.
   */
  documentUrl: string;
  box: BoxModel;
  /**
   * The curated property set, normalised. Always every key of
   * `INSPECTED_PROPERTIES`, so three columns line up row for row without the
   * app reconciling three differently-sized key sets.
   */
  styles: Record<InspectedProperty, string>;
  /** Null when no sheet could be read at all; empty when sheets were read and none matched. */
  rules: MatchedRule[] | null;
  /**
   * Why `rules` is null or short — "3 of 5 stylesheets are cross-origin".
   *
   * Said rather than left blank: an empty rules panel otherwise reads as "this
   * element is unstyled", which is the wrong conclusion to hand somebody.
   */
  rulesNote?: string;
  /**
   * Where the descent had to stop, when it did — a cross-origin frame, or a
   * closed shadow root.
   *
   * Without it the answer is indistinguishable from having genuinely landed on
   * the `<iframe>` element itself, and an engine that pierced one boundary
   * further than another would look like a DOM difference rather than a limit.
   */
  pierceNote?: string;
  /**
   * The walker's handle for this element, when one was minted.
   *
   * Present on anything the tree commands produced, and on a point `inspect`
   * too — picking an element and then finding it in the tree is one gesture,
   * and without this the app would have to search the tree for something it is
   * already holding.
   *
   * Absent rather than null when the pane has no registry yet, which is every
   * pane nobody has opened the Elements tab on.
   */
  nodeId?: string;
  /**
   * The same element's ancestors as handles, outermost first, so the tree can
   * be opened down to it.
   *
   * `path` says the same thing as descriptions; this says it as references.
   * Both, because they answer different questions — one is shown to a person
   * and the other is handed back to the engine.
   */
  ancestors?: string[];
}

/**
 * What kind of node a tree row stands for.
 *
 * Wider than "element" because a DOM view that hides everything else lies about
 * the tree: a page whose layout depends on a stray text node shows nothing to
 * explain itself, and the comment a build tool left behind is often the reason
 * two engines disagree about an `:nth-child`.
 *
 * `shadow-root` and `frame-document` are not really nodes at all — they are the
 * boundaries, given a row each so the tree can show that one was crossed.
 * Chrome's tree does the same, and for the same reason: an element whose
 * children silently come from somewhere else is unreadable.
 */
export type DomNodeKind =
  'element' | 'text' | 'comment' | 'document' | 'doctype' | 'shadow-root' | 'frame-document';

/**
 * One row of the tree.
 *
 * A description *and* a reference, which nothing else in this protocol is. The
 * reference (`nodeId`) belongs to one pane and dies with its document; the
 * identity (`step`) belongs to no pane and is how the three are lined up. Both
 * travel because the app needs both on every row and asking twice would double
 * the traffic of the thing it is trying to keep cheap.
 */
export interface DomNode {
  /** This pane's handle, valid until this pane navigates. */
  nodeId: string;
  kind: DomNodeKind;
  /** `div`, `my-card`, `#text`, `#comment`, `#shadow-root`. */
  name: string;
  id?: string;
  classes: string[];
  /** Everything but `id` and `class`, which have their own fields, in document order. */
  attributes: [name: string, value: string][];
  /** The text of a text or comment node, truncated; absent for elements. */
  value?: string;
  /**
   * How many children this node has, whether or not any were sent.
   *
   * What decides whether a row gets a twisty. Counted rather than inferred from
   * `children`, because a depth-limited answer has children it did not send and
   * a row that refuses to open is worse than one that opens onto nothing.
   */
  childCount: number;
  /** As many levels as the command's `depth` asked for; absent at the cut. */
  children?: DomNode[];
  /**
   * The engine-neutral identity of this step — `#main`, `div[2]`, `shadow>div[0]`.
   *
   * The same vocabulary `ElementRef` produces, so a chain of these is what
   * `dom-resolve` takes and what tells two panes they are looking at one
   * element. Deliberately not the id or the classes: those are what the engines
   * are being compared *on*, and an identity that moved when a class did would
   * call one element two.
   */
  step: string;
  /**
   * Why this subtree stops here, when it does — a closed shadow root, a
   * cross-origin frame.
   *
   * Said rather than left to look like a leaf. An engine that could see one
   * boundary further than another would otherwise read as a DOM difference
   * rather than as the limit it is.
   */
  note?: string;
  /**
   * Which of `::before` and `::after` actually render on this element.
   *
   * Generated content has no node to stand for it, so it is reported on its
   * originating element and drawn as a child row. Decided from the computed
   * `content`, which is the only way to ask from inside the page — and a real
   * source of engine disagreement, which makes it worth the two extra
   * `getComputedStyle` calls a row costs.
   */
  pseudo?: ('before' | 'after')[];
}

/** One `dom-search` hit, with the handles needed to open the tree down to it. */
export interface DomMatch {
  nodeId: string;
  /** Ancestors outermost first, so every twisty on the way can be opened. */
  ancestors: string[];
  /** What the row will say, so a result list can be drawn before it is revealed. */
  label: string;
}

/**
 * One coalesced change inside a watched subtree.
 *
 * Deliberately not a mutation record. A record says what happened; these say
 * what is now true, which is the only thing a redraw needs and the only thing
 * that survives being folded together. Fifty insertions into one list arrive as
 * a single `children` change naming the list.
 */
export type DomChange =
  /** This node's child list is different; refetch it if it is open. */
  | { kind: 'children'; nodeId: string; childCount: number }
  /** This element's attributes are different, in full rather than as a delta. */
  | {
      kind: 'attributes';
      nodeId: string;
      id?: string;
      classes: string[];
      attributes: [name: string, value: string][];
    }
  /** This text or comment node says something else now. */
  | { kind: 'value'; nodeId: string; value: string }
  /** This node has left the document; its row and its subtree go with it. */
  | { kind: 'removed'; nodeId: string };

/**
 * How many levels a tree command sends when it is not told.
 *
 * Two, which is one more than the row that was opened. Opening a twisty is
 * nearly always followed by opening one of the twisties it revealed, and the
 * second level costs a fraction of the round trip that would otherwise fetch
 * it.
 */
export const DOM_TREE_DEPTH = 2;

/**
 * How often a pane with something expanded is asked what changed.
 *
 * Polled rather than pushed, and that is a deliberate trade. Pushing means
 * `exposeBinding`, which puts a second function of ours on the page's global
 * object for the life of the context — and the walker's whole bargain is that
 * it defines one non-enumerable property and nothing else, because the page is
 * somebody else's. A poll costs one evaluation per watching pane per interval
 * and nothing at all when nothing is watched, which is every session that never
 * opens the Elements tab.
 *
 * The number is the same order as the inspector's other samples: slower than a
 * frame, faster than anybody notices a row being stale.
 */
export const DOM_WATCH_POLL_MS = 250;

/**
 * How many coalesced changes are worth describing before it is cheaper to say
 * "start again".
 *
 * A page that replaces its whole body — a route change, a hydration pass —
 * produces changes touching every row at once, and sending them is both slower
 * than a refetch and useless: the app would apply hundreds of edits to arrive
 * at a tree it could have asked for outright.
 */
export const DOM_CHANGE_BURST = 200;

/** Longest text a tree row carries; the rest is an ellipsis. */
export const DOM_VALUE_PREVIEW = 120;

/**
 * What an expression produced, described rather than returned.
 *
 * Returning the value itself would put engine serialisation between the user
 * and their answer: a DOM node, a function or a cyclic object each fail
 * differently in each engine, which is noise rather than a finding. So the
 * page-side helper prints the value and says what kind of thing it was.
 *
 * `json` is filled in only when the value survived a JSON round trip inside the
 * page, which is what lets the app offer an expandable tree for the ordinary
 * case without risking the rest on it.
 */
export type EvaluatedValue =
  | { kind: 'value'; type: string; preview: string; json?: unknown }
  | { kind: 'error'; message: string; stack?: string };

/**
 * How bad a console message is, flattened from each engine's own vocabulary.
 *
 * Severity only, and deliberately the five every engine can be mapped onto: it
 * is what the filter offers and what colours a row, so a sixth value that only
 * one engine ever produces would be a filter that hides two panes' worth of
 * nothing.
 */
export type ConsoleLevel = 'log' | 'debug' | 'info' | 'warn' | 'error';

/**
 * What shape a console message has, which is a different question from how bad
 * it is.
 *
 * A closed union rather than the engine's own word, so the app renders a group
 * or a stack trace the same way whichever pane produced it. Everything the
 * shared vocabulary has no name for is `'other'`, which renders as an ordinary
 * line — the engine's own word travels beside it as `nativeKind` for whoever
 * later decides one of them deserves its own treatment.
 */
export type ConsoleKind =
  /** An ordinary line of text, which is nearly all of them. */
  | 'message'
  /** Opens a nesting level; collapsed or not is in `nativeKind`. */
  | 'group-start'
  | 'group-end'
  /** The page asked for everything before this to be forgotten. */
  | 'clear'
  /** Carries a stack rather than a value. */
  | 'trace'
  /** Structured output the page wanted laid out, not printed. */
  | 'table'
  | 'dir'
  | 'count'
  /** `timeEnd` and the profiler's bookends: a measurement, not a statement. */
  | 'timing'
  | 'other';

/**
 * Every message type the three engines are known to emit, and what each one
 * means in the shared vocabulary.
 *
 * Keyed by the engine's own word, lowercased, because that is the only form
 * Playwright hands over and the engines differ in spelling as well as in which
 * types they emit at all — Chromium produces most of this list, Gecko and
 * WebKit a subset. An unlisted word is not a bug: it maps to
 * `{ level: 'log', kind: 'other' }` and shows up as a plain line, which is
 * always better than dropping a message the page really printed.
 */
export const CONSOLE_MESSAGE_TYPES: Record<string, { level: ConsoleLevel; kind: ConsoleKind }> = {
  log: { level: 'log', kind: 'message' },
  debug: { level: 'debug', kind: 'message' },
  info: { level: 'info', kind: 'message' },
  warn: { level: 'warn', kind: 'message' },
  warning: { level: 'warn', kind: 'message' },
  error: { level: 'error', kind: 'message' },
  assert: { level: 'error', kind: 'message' },
  trace: { level: 'log', kind: 'trace' },
  table: { level: 'log', kind: 'table' },
  dir: { level: 'log', kind: 'dir' },
  dirxml: { level: 'log', kind: 'dir' },
  count: { level: 'log', kind: 'count' },
  timeend: { level: 'log', kind: 'timing' },
  profile: { level: 'log', kind: 'timing' },
  profileend: { level: 'log', kind: 'timing' },
  clear: { level: 'log', kind: 'clear' },
  startgroup: { level: 'log', kind: 'group-start' },
  startgroupcollapsed: { level: 'log', kind: 'group-start' },
  endgroup: { level: 'log', kind: 'group-end' },
};

/** What an unrecognised message type becomes: a plain line, never a dropped one. */
export const UNKNOWN_CONSOLE_MESSAGE: { level: ConsoleLevel; kind: ConsoleKind } = {
  level: 'log',
  kind: 'other',
};

/**
 * Where a console message came from.
 *
 * Optional because it is not reliably available: Chromium gives a url, a line
 * and a column for everything, while the other two sometimes give nothing.
 */
export interface SourceLocation {
  url: string;
  line?: number;
  column?: number;
}

/**
 * How long identical consecutive messages from one engine are folded together.
 *
 * The console channel queues rather than dropping — every message on it matters
 * — so a page logging inside `requestAnimationFrame` would push sixty events a
 * second per engine through it. Folding happens in the sidecar, before the
 * queue, and arrives as `repeats` on one event.
 */
export const CONSOLE_COALESCE_MS = 250;

/**
 * Most messages one engine may send per second before the rest are counted
 * instead of sent, reported as `dropped` on the next one through.
 *
 * A ceiling rather than a target: coalescing handles the ordinary flood, and
 * this is for the page that logs a thousand *different* lines a second.
 */
export const CONSOLE_RATE_LIMIT = 50;

/**
 * The properties worth comparing, grouped the way the panel shows them.
 *
 * Curated rather than everything `getComputedStyle` enumerates, because the raw
 * comparison is unreadable: the engines expose different property counts,
 * expand shorthands differently, and disagree cosmetically about values nobody
 * asked after. Three hundred rows of which four matter is not a diff.
 *
 * Longhands only, for the same reason — `border` and `font` serialise
 * differently in each engine while their longhands agree.
 */
export const INSPECTED_STYLE_GROUPS = [
  {
    label: 'Layout',
    properties: [
      'display',
      'position',
      'top',
      'right',
      'bottom',
      'left',
      'z-index',
      'float',
      'box-sizing',
      'overflow-x',
      'overflow-y',
    ],
  },
  {
    label: 'Flex & grid',
    properties: [
      'flex-direction',
      'flex-wrap',
      'flex-grow',
      'flex-shrink',
      'flex-basis',
      'justify-content',
      'align-items',
      'align-self',
      'row-gap',
      'column-gap',
      'grid-template-columns',
      'grid-template-rows',
      'grid-area',
      'order',
    ],
  },
  {
    label: 'Box',
    properties: [
      'width',
      'height',
      'margin-top',
      'margin-right',
      'margin-bottom',
      'margin-left',
      'padding-top',
      'padding-right',
      'padding-bottom',
      'padding-left',
      'border-top-width',
      'border-right-width',
      'border-bottom-width',
      'border-left-width',
      'border-top-left-radius',
      'border-top-right-radius',
      'border-bottom-right-radius',
      'border-bottom-left-radius',
    ],
  },
  {
    label: 'Typography',
    properties: [
      'font-family',
      'font-size',
      'font-weight',
      'font-style',
      'line-height',
      'letter-spacing',
      'text-align',
      'text-transform',
      'text-decoration-line',
      'white-space',
      'color',
    ],
  },
  {
    label: 'Paint',
    properties: [
      'background-color',
      'border-top-color',
      'opacity',
      'visibility',
      'box-shadow',
      'filter',
      'mix-blend-mode',
    ],
  },
  {
    label: 'Motion',
    properties: [
      'transform',
      'transform-origin',
      'transition-property',
      'transition-duration',
      'animation-name',
      'animation-duration',
    ],
  },
] as const;

export type InspectedProperty = (typeof INSPECTED_STYLE_GROUPS)[number]['properties'][number];

export const INSPECTED_PROPERTIES: readonly InspectedProperty[] = INSPECTED_STYLE_GROUPS.flatMap(
  group => [...group.properties]
);

/**
 * Decimal places computed lengths are rounded to before they are compared.
 *
 * The engines agree about rendering far more often than they agree about how to
 * spell it, and an un-normalised diff lights up every row. What the walker
 * flattens beside this: colours (`rgba(0, 0, 0, 0.5)` against
 * `rgb(0 0 0 / 0.5)`, and named against functional for the opaque case), matrix
 * precision in `transform`, and font-family quoting and spacing.
 *
 * What it deliberately does *not* flatten: `line-height: normal` against a
 * resolved pixel value, and resolved grid tracks. Those are real disagreements
 * about the used value, which is the thing being compared.
 */
export const STYLE_VALUE_PRECISION = 2;

export type PaneStatus =
  | 'idle'
  | 'launching'
  /** Browser up, capture running. */
  | 'live'
  | 'failed'
  | 'closed';

/**
 * How frames travel from the sidecar to the backend.
 *
 * Not over stdout: that carries newline-delimited JSON, so image bytes would
 * have to be base64, which inflates every frame by a third and costs a JSON
 * parse of a few hundred kilobytes each. Instead the backend listens on a
 * loopback port and the sidecar connects to it, announced through these
 * variables. The first thing written is the token, so nothing else on the
 * machine can feed frames to the window.
 *
 * Each frame is a fixed 16-byte header followed by the image:
 *
 * | offset | size | meaning                                  |
 * | ------ | ---- | ---------------------------------------- |
 * | 0      | 4    | payload length, little-endian            |
 * | 4      | 4    | sequence number                          |
 * | 8      | 2    | width in pixels                          |
 * | 10     | 2    | height in pixels                         |
 * | 12     | 1    | engine, as an index into `ENGINES`        |
 * | 13     | 1    | 1 if this is a settled sharp capture     |
 * | 14     | 1    | 0 for JPEG, 1 for PNG                    |
 * | 15     | 1    | unused                                   |
 */
export const FRAME_PORT_ENV = 'DEVKIT_FRAME_PORT';
export const FRAME_TOKEN_ENV = 'DEVKIT_FRAME_TOKEN';
export const FRAME_HEADER_BYTES = 16;

/**
 * URI scheme the backend serves frame bytes on, as `<scheme>://<engine>/<seq>`.
 *
 * The sequence number is part of the path purely to defeat caching: each frame
 * is a new URL, so the webview never serves a stale one.
 */
export const FRAME_SCHEME = 'devkit-frame';

/**
 * Path segment that asks for an engine's newest frame, whatever its sequence.
 *
 * A frame's URL is normally learnt from the event announcing it, which leaves a
 * frontend that just loaded with nothing to show until the next one — and a
 * settled pane may not produce another for as long as nobody touches it. The
 * backend outlives the webview and still holds the picture, so this asks for it
 * by name instead of by sequence.
 */
export const FRAME_LATEST = 'latest';

/** Tauri event channel every sidecar `Event` is re-emitted on. */
/**
 * Asked to look for a newer DevKit, from the menu rather than on the way up.
 *
 * The check at launch answers "is there one?" once; this answers it again when
 * somebody wonders, which is the only way to find out without restarting.
 */
export const CHECK_FOR_UPDATES_EVENT = 'devkit://check-for-updates';

export const SIDECAR_EVENT = 'devkit://sidecar';

/** Tauri event channel for sidecar process-level trouble (spawn failure, crash, exit). */
export const SIDECAR_STATUS_EVENT = 'devkit://sidecar-status';

export type SidecarStatus =
  | { kind: 'spawned'; pid: number }
  | { kind: 'crashed'; reason: string }
  | { kind: 'exited'; code: number | null };
