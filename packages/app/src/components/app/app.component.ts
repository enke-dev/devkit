import '../app-navbar/app-navbar.component.js';
import '../divider/divider.component.js';
import '../inspector/inspector.component.js';
import '../pane/pane.component.js';

import type {
  ColorScheme,
  Command,
  Engine,
  Event,
  InputEvent,
  SidecarStatus,
  Viewport,
} from '@devkit/protocol';
import { CHECK_FOR_UPDATES_EVENT, ENGINE_LABELS, ENGINES } from '@devkit/protocol';
import { listenWindow } from '@enke.dev/lit-utils/lib/utils/event.utils.js';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { PropertyValues } from 'lit';
import { html, nothing } from 'lit';
import { customElement, property, queryAll, state } from 'lit/decorators.js';
import { when } from 'lit/directives/when.js';

import { DevkitElement } from '../../utils/base.utils.js';
import { connect, restart, send, sendTracked } from '../../utils/bridge.utils.js';
import { preloadCursors } from '../../utils/cursors.utils.js';
import type { InspectorIntent, InspectorState } from '../../utils/detached.utils.js';
import {
  closeInspectorWindow,
  onIntent,
  openInspectorWindow,
  sendState,
} from '../../utils/detached.utils.js';
import type { DomTree } from '../../utils/dom.utils.js';
import {
  absorb,
  applyChanges,
  collapse,
  emptyTree,
  expand,
  reveal,
  stepsTo,
  toWire,
  watchIds,
} from '../../utils/dom.utils.js';
import * as history from '../../utils/history.utils.js';
import { attachInput } from '../../utils/input.utils.js';
import type { ConsoleEntry, Evaluation, InspectAnswer } from '../../utils/inspect.utils.js';
import { appendConsole, describeRef, readoutSignature } from '../../utils/inspect.utils.js';
import type { InspectorDock, SplitDirection } from '../../utils/layout.utils.js';
import {
  defaultInspectorSize,
  MIN_INSPECTOR,
  MIN_PANE,
  storedDock,
  storedInspectorSize,
  storeDock,
  storedSplit,
  storeInspectorSize,
  storeSplit,
} from '../../utils/layout.utils.js';
import { clamp } from '../../utils/resize.utils.js';
import * as session from '../../utils/session.utils.js';
import { isAppShortcut, match } from '../../utils/shortcuts.utils.js';
import type { AvailableUpdate } from '../../utils/update.utils.js';
import { availableUpdate } from '../../utils/update.utils.js';
import type { AppNavbarComponent } from '../app-navbar/app-navbar.component.js';
import type { DividerMove } from '../divider/divider.component.js';
import type { PaneComponent } from '../pane/pane.component.js';
import { hostColorScheme } from '../pane/pane.utils.js';
import styles from './app.component.css';
import {
  countReceivedFrame,
  fromTextField,
  lastVisited,
  sameViewport,
  sharedViewport,
  startFrameDiagnostics,
  toUrl,
} from './app.utils.js';

/**
 * How often the panes are asked what is under the pointer.
 *
 * Three round trips per sample, each of them behind the same command queue as
 * the input being mirrored, so this strikes the bargain `readCursor` already
 * strikes in the sidecar: throttle, and always take a trailing sample. The
 * pointer stops on the thing you want to know about, and without the trailing
 * one that final position is the one that never gets asked.
 */
const INSPECT_SAMPLE_MS = 90;

/**
 * How long a readout waits for the panes that have not answered yet.
 *
 * Answers arrive one engine at a time, and publishing each as it lands redrew
 * the table with one column, then two, then three — visible as flicker under a
 * pointer that had not moved. So a sample is held until every pane it was sent
 * to has answered, and this is the cap on that for a pane which never will.
 */
const ANSWER_GRACE_MS = 300;

/**
 * How long after the last input the selection is measured again.
 *
 * A backstop, not the mechanism: the panes volunteer a `selection` event the
 * moment they move something, which is what keeps the highlight with its
 * element while scrolling. This catches the movement that arrives afterwards
 * without any further input — a smooth scroll still settling, a layout that
 * reflowed late.
 */
const SETTLE_REMEASURE_MS = 250;

/**
 * A node to open the tree down to, named the way the pane that found it named
 * it — and said which pane that was.
 *
 * The engine is not decoration. A handle means nothing in a pane that did not
 * mint it, and there is a window, between asking one engine for a tree and
 * being given it, in which the tree on screen still belongs to the engine
 * before it. Anything recorded during that window is recorded against the old
 * one, and applying it to the new one asks an engine about somebody else's
 * nodes.
 */
interface RevealTarget {
  engine: Engine;
  nodeId: string;
  ancestors: string[];
}

/**
 * The watch set as it reads when nothing is being watched.
 *
 * A value rather than an empty string, because the empty string is what the
 * field is reset to when a tree is dropped — and telling those apart is the
 * difference between "nobody is watching" and "nobody has said yet".
 */
const NOTHING_WATCHED = 'none';

/** How many past evaluations are kept; older ones scroll out of reach anyway. */
const EVALUATION_LIMIT = 50;

/**
 * The app: one URL, three engines, and everything that has to agree between
 * them — the viewport they share, the input they all replay, the pane the
 * pointer is in.
 *
 * The components below it report intent and are told what to show; nothing about
 * the sidecar reaches them.
 */
@customElement('devkit-app')
export class AppComponent extends DevkitElement.withStyles(styles) {
  @state() private accessor problem = '';

  /**
   * Whether the introspection drawer is open.
   *
   * A property rather than internal state because the host attribute is what
   * gives the drawer its row in the grid — closed, it takes no space at all
   * rather than collapsing to nothing.
   */
  @property({ type: Boolean, reflect: true })
  accessor inspecting = false;

  @state() private accessor inspectorTab: 'elements' | 'console' = 'elements';

  /**
   * Which edge the drawer is attached to; seeded from the last session.
   *
   * Reflected, because it is the host grid that has to change — the drawer
   * takes a row along the bottom or a column down the side, and which of those
   * it is cannot be expressed from inside the drawer.
   */
  @property({ type: String, reflect: true })
  accessor dock: InspectorDock = storedDock();

  /**
   * Whether the inspected element follows the pointer.
   *
   * Separate from the drawer being open, because reading three columns means
   * moving the pointer off the panes — and an inspector that changed what it
   * was describing on the way to being read would be unusable.
   */
  @state() private accessor picking = false;

  @state() private accessor answers: InspectAnswer[] = [];

  /**
   * The tree on screen, which belongs to exactly one engine.
   *
   * One rather than three. Three trees side by side are unreadable past the
   * second level, and the comparison the app is for already happens underneath
   * — the table answers for all three engines about whichever element this tree
   * has selected. Merging them into one annotated tree is the version worth
   * building next, and it needs this to exist first.
   */
  @state() private accessor tree: DomTree | null = null;

  @state() private accessor searching = false;

  /**
   * The root that has been asked for but has not arrived.
   *
   * Reactive because the tree on screen is the previous one until this lands,
   * and swapping both at once is what keeps the panel coherent — the rows and
   * the engine they belong to change in the same frame.
   */
  @state() private accessor pendingRoot: {
    id: string;
    engine: Engine;
    reveal: RevealTarget | null;
  } | null = null;

  @state() private accessor matchCount: number | null = null;
  @state() private accessor messages: ConsoleEntry[] = [];
  @state() private accessor evaluations: Evaluation[] = [];

  /** A newer DevKit, once one has been found; nothing is said until then. */
  @state() private accessor pendingUpdate: AvailableUpdate | null = null;

  /** Set while the newer version is being fetched and put in place. */
  @state() private accessor installingUpdate = false;

  /** Said after a check that found nothing, so asking never looks ignored. */
  @state() private accessor upToDate = false;
  @state() private accessor installed: Record<Engine, boolean> | null = null;
  @state() private accessor setupVisible = false;
  @state() private accessor setupLog = '';

  /** How far each engine's download has got, while it is being downloaded. */
  @state() private accessor downloaded: Partial<Record<Engine, number>> = {};
  @state() private accessor installingAll = false;
  /** How the panes are arranged; seeded from the last session, not defaulted. */
  @state() private accessor split: SplitDirection = storedSplit();

  /** How deep the drawer is, in CSS pixels along whichever edge it is on. */
  @state() private accessor inspectorSize: number = storedInspectorSize(storedDock());

  @state() private accessor canGoBack = session.canGoBack();
  @state() private accessor canGoForward = session.canGoForward();

  /**
   * Where the panes are, which the address bar shows unless it is being edited.
   *
   * Seeded before the first render rather than in `firstUpdated`: setting state
   * from there schedules a second update for something that was known all along.
   */
  @state() private accessor url = lastVisited();

  @queryAll('devkit-pane')
  private accessor paneElements!: NodeListOf<PaneComponent>;

  /** The pane under the pointer, which is the one input is attributed to. */
  #activeEngine: Engine | null = null;
  /**
   * Whether input is going to one pane only, for as long as Alt is held.
   *
   * Everything is mirrored to all three by default — that is the point of the
   * tool — but sometimes a page has to be driven without three engines racing
   * through it: dismissing a cookie banner, filling a form, following a link
   * that only one of them has. Held rather than toggled, so there is no mode to
   * forget you are in.
   *
   * Alt is free for this because no modifier is forwarded to the engines: the
   * protocol's input events carry a button and a position, so no page has ever
   * seen `altKey` from us. If that changes, this claim on it has to be revisited.
   */
  #solo = false;
  /** The pointer's last position in a pane, so the stand-ins can be redrawn. */
  #pointer: { x: number; y: number } | null = null;
  #started = false;
  #running = new Set<Engine>();
  #relaunching = new Set<Engine>();
  #lastViewport: Viewport | null = null;
  #resizeTimer: number | undefined;
  /**
   * Panes already wired for input.
   *
   * Keyed by the element, not by its engine. Keyed by engine, a pane element
   * replaced under us — which is what a hot reload does — would be skipped as
   * "already attached" and silently receive no input for the rest of the
   * session, with nothing to see but a pane that ignores the mouse.
   */
  #attached = new WeakSet<PaneComponent>();

  /**
   * The inspect question currently outstanding, and the one the answers on
   * screen belong to.
   *
   * Answers name the command rather than the pane, and a sample the pointer has
   * already moved past is still in flight when the next one goes out — so
   * anything that does not name the latest question is dropped rather than
   * allowed to overwrite it.
   */
  #inspectId: string | null = null;

  /**
   * What each outstanding tree question was asking for, so its answer can be
   * put somewhere.
   *
   * The parent whose children were asked for, or null for the root. Answers
   * arrive per engine and name only the command, so without this a subtree
   * would have nowhere to hang.
   */
  #domRequests = new Map<string, string | null>();

  /**
   * A node to open the way down to, and select when it gets there.
   *
   * Revealing is not one round trip: each level of the chain may need its
   * children fetched, and the level below it cannot be opened until they land.
   * So it is a standing intention rather than a call, retried every time a
   * slice of tree arrives.
   */
  #revealing: RevealTarget | null = null;

  /** The watch set as last sent, so an unchanged one is not sent again. */
  #watching = '';

  /** The newest search, so the answers to the prefixes typed on the way are ignored. */
  #searchId: string | null = null;
  #inspectAt = 0;
  #inspectTrailing: number | undefined;

  /** Answers to the outstanding question, held until they are all in. */
  #pendingAnswers = new Map<Engine, InspectAnswer>();
  #expected = 0;
  #publishTimer: number | undefined;

  /** The backstop measurement, taken once the input has stopped. */
  #remeasureTrailing: number | undefined;

  /**
   * Whether the release of an intercepted press still has to be swallowed.
   *
   * A press taken for the picker must take its release with it: sending one
   * without the other leaves three engines believing a button is still held.
   */
  #swallowUp = false;

  private get panes(): PaneComponent[] {
    return [...this.paneElements];
  }

  private pane(engine: Engine): PaneComponent | undefined {
    return this.panes.find(pane => pane.engine === engine);
  }

  private get navbar(): AppNavbarComponent {
    return this.renderRoot.querySelector('devkit-app-navbar') as AppNavbarComponent;
  }

  // -------------------------------------------------------------------------
  // Viewport
  // -------------------------------------------------------------------------

  private currentViewport(): Viewport {
    return sharedViewport(this.panes.map(pane => pane.measure()));
  }

  /**
   * Rearrange the panes.
   *
   * The window has not changed size, so nothing observing it will notice — but
   * every pane just did, and they share one viewport. The engines are told once
   * the new arrangement has actually been laid out.
   */
  private setSplit(split: SplitDirection): void {
    if (split === this.split) {
      return;
    }
    this.split = split;
    storeSplit(split);
    // Straight through rather than behind the resize debounce: an arrangement
    // is chosen once and nothing follows it, so waiting to see whether more is
    // coming only holds the panes blank for as long as the wait.
    void this.updateComplete.then(() => {
      window.clearTimeout(this.#resizeTimer);
      this.#settleViewport();
    });
  }

  /**
   * Settle the panes on one viewport, once the resizing has stopped.
   *
   * Dragging a window edge is a burst of sizes on the way to the one that is
   * meant, and every one of them would cost three engines a resize.
   */
  @listenWindow('resize')
  protected syncViewport(): void {
    // Dragging an edge takes the pointer out of the panes without the webview
    // ever seeing it leave, so the stand-ins would sit where it was last known
    // to be for the whole drag.
    this.clearCursors();
    window.clearTimeout(this.#resizeTimer);
    this.#resizeTimer = window.setTimeout(() => this.#settleViewport(), 150);
  }

  /** Measure the panes, tell them, and tell the engines when it moved. */
  #settleViewport(): void {
    if (!this.#started) {
      return;
    }
    const viewport = this.currentViewport();
    // Told to the panes every time, even when it has not changed: a pane that
    // reshaped without moving the agreed size — one grew as another shrank, or
    // the rounding landed the same — is waiting to hear what shape it is now
    // before it shows anything again.
    this.panes.forEach(pane => pane.applyViewport(viewport));

    if (sameViewport(this.#lastViewport, viewport)) {
      return;
    }
    this.#lastViewport = viewport;
    void send({ type: 'resize', viewport }).catch(error => this.reportError(error));
  }

  // -------------------------------------------------------------------------
  // Navigation
  // -------------------------------------------------------------------------

  private navigate(raw: string): void {
    const url = toUrl(raw);
    if (!url) {
      return;
    }
    this.url = url;
    // Whatever was being inspected belongs to the page being left.
    this.clearInspection();
    // Recorded on the way out as well as when a pane reports arriving: a URL
    // that fails to load is still one you visited and will probably try again.
    history.record(url, '');
    session.visited(url);
    this.updateNavState();
    void send({ type: 'navigate', url }).catch(error => this.reportError(error));
  }

  private updateNavState(): void {
    this.canGoBack = session.canGoBack();
    this.canGoForward = session.canGoForward();
  }

  /**
   * Step along the trail by navigating, rather than asking the engines to go
   * back. The trail outlives the engines — it is restored from disk — so theirs
   * would be empty after a restart, and three engines each keeping their own
   * would be three answers to a question the panes share.
   */
  private step(url: string | undefined): void {
    if (!url) {
      return;
    }
    this.url = url;
    this.updateNavState();
    void send({ type: 'navigate', url }).catch(error => this.reportError(error));
  }

  private goBack(): void {
    this.step(session.back());
  }

  private goForward(): void {
    this.step(session.forward());
  }

  // -------------------------------------------------------------------------
  // Keyboard
  // -------------------------------------------------------------------------

  /**
   * App shortcuts first, then the page.
   *
   * Keyboard goes to the pane under the pointer: nothing has to be clicked
   * first, which matches how the panes already behave for the mouse.
   */
  @listenWindow('keydown')
  protected handleKeydown(event: KeyboardEvent): void {
    this.setSolo(event.altKey);
    switch (match(event)) {
      case 'focusAddress':
        event.preventDefault();
        this.navbar.focusAddress();
        return;
      case 'reload':
      case 'hardReload':
        event.preventDefault();
        void send({ type: 'reload' }).catch(error => this.reportError(error));
        return;
      case 'back':
        event.preventDefault();
        this.goBack();
        return;
      case 'forward':
        event.preventDefault();
        this.goForward();
        return;
      case 'inspector':
        event.preventDefault();
        this.setInspecting(!this.inspecting);
        return;
      case 'pick':
        event.preventDefault();
        this.inspecting = true;
        this.setPicking(true);
        return;
      default:
        break;
    }

    // The way out of a mode, wherever the pointer happens to be. Only claimed
    // while picking, so a page that uses Escape keeps it the rest of the time.
    if (event.key === 'Escape' && this.picking) {
      event.preventDefault();
      this.setPicking(false);
      return;
    }

    this.forwardKey(event, 'keydown');
  }

  @listenWindow('keyup')
  protected handleKeyup(event: KeyboardEvent): void {
    this.setSolo(event.altKey);
    this.forwardKey(event, 'keyup');
  }

  /**
   * A key held while the window goes away is never released as far as we are
   * concerned, so solo mode would stick.
   */
  @listenWindow('blur')
  protected handleWindowBlur(): void {
    this.setSolo(false);
    // The pointer is somewhere else entirely; a stand-in still drawn claims it
    // is in the pane.
    this.clearCursors();
  }

  /**
   * The pointer left the window.
   *
   * A pane only hears about a pointer that leaves it for somewhere else in the
   * window. Leaving the window altogether — out to another application, off
   * the side of the screen — is only said once, here.
   *
   * `pointerout` with nothing on the other side of it, rather than
   * `pointerleave`: leave does not bubble, so a listener on the window never
   * hears it at all. Measured in all three engines — leaving the page fired
   * nothing on the window and this handler had never once run, which is why
   * the stand-ins stayed drawn in panes the pointer had long left.
   */
  @listenWindow('pointerout')
  protected handlePointerOut(event: PointerEvent): void {
    if (event.relatedTarget === null) {
      this.leftTheWindow();
    }
  }

  /**
   * The pointer reached the very edge of the window, which is as close to
   * leaving as anything will say.
   *
   * No engine ever reports a coordinate outside the window: measured in all
   * three, creeping left from x=40 to x=-40 delivers 40, 20, 8, 2, 0 and then
   * nothing at all. The last movement before the pointer leaves therefore
   * lands exactly on the boundary pixel, and that — not a negative number, and
   * not an exit event, none of which arrive reliably — is the signal.
   *
   * The cost is the outermost pixel of the window, where the stand-ins go even
   * though the pointer is still technically inside. They come back the moment
   * it moves inwards, which is cheaper than leaving them stranded in a pane
   * nobody is pointing at.
   */
  @listenWindow('pointermove')
  protected watchForTheEdge(event: PointerEvent): void {
    const atEdge =
      event.clientX <= 0 ||
      event.clientY <= 0 ||
      event.clientX >= window.innerWidth - 1 ||
      event.clientY >= window.innerHeight - 1;
    if (atEdge) {
      this.leftTheWindow();
    }
  }

  /**
   * The same question asked of the mouse events rather than the pointer ones.
   *
   * Not redundant in practice: an engine can synthesise one family at a window
   * boundary and not the other, and which family is missing is the sort of
   * thing that differs between a browser and the webview built from it.
   */
  @listenWindow('mouseout')
  protected handleMouseOut(event: MouseEvent): void {
    if (event.relatedTarget === null) {
      this.leftTheWindow();
    }
  }

  /**
   * Take the stand-ins down.
   *
   * Which event reports a pointer leaving the window depends on the platform
   * and on how it left — dragged off an edge, snatched away by another
   * application, moved out slowly enough that the window stops tracking it.
   * So every signal that can mean it comes here, and the cost of one arriving
   * that did not have to is nothing.
   */
  private leftTheWindow(): void {
    this.clearCursors();
  }

  private forwardKey(event: KeyboardEvent, kind: 'keydown' | 'keyup'): void {
    if (!this.#activeEngine || isAppShortcut(event)) {
      return;
    }
    // Typing in the address bar is the app's, not the page's.
    if (fromTextField(event)) {
      return;
    }
    event.preventDefault();
    // A key can scroll the page as surely as the wheel can — space, the arrows,
    // page up and down — and no-ops when nothing is selected.
    this.scheduleRemeasure();
    void send({ type: 'input', engine: this.target(), event: { kind, key: event.key } }).catch(
      error => this.reportError(error)
    );
  }

  /**
   * Which panes an input is for: all of them, or the one being driven alone.
   *
   * The keyboard follows the pointer here, as it does everywhere else in the
   * app — typing into a form in solo mode would be pointless if the keystrokes
   * still went to all three.
   */
  private target(): Engine | 'all' {
    return this.#solo && this.#activeEngine ? this.#activeEngine : 'all';
  }

  @listenWindow('paste')
  protected handlePaste(event: ClipboardEvent): void {
    if (!this.#activeEngine) {
      return;
    }
    if (fromTextField(event)) {
      return;
    }
    const text = event.clipboardData?.getData('text');
    if (!text) {
      return;
    }
    event.preventDefault();
    void send({ type: 'input', engine: this.target(), event: { kind: 'text', text } }).catch(
      error => this.reportError(error)
    );
  }

  // -------------------------------------------------------------------------
  // Input mirroring
  // -------------------------------------------------------------------------

  /**
   * Input goes to every pane at once, for the same reason navigation does: the
   * point of the tool is watching three engines react to the same thing.
   */
  private forwardInput(event: InputEvent, source: Engine): Promise<void> {
    // Scrolling moves the selected element; the highlight has to follow it.
    // Taken here rather than in the preview because wheel events never reach
    // the preview — they are paced straight through.
    if (event.kind === 'wheel') {
      this.scheduleRemeasure();
    }
    // Always resolves: a rejection here would stall the pacing loop that awaits it.
    return send({ type: 'input', engine: this.#solo ? source : 'all', event, source }).catch(
      error => this.reportError(error)
    );
  }

  /**
   * Mirror the pointer into the panes the user is not in. The active pane
   * already shows the real OS cursor, so drawing a second one there would just
   * double it up.
   */
  private paintCursors(event: InputEvent, source: Engine): void {
    // Sampled from the local preview rather than from the send: this runs for
    // every movement the webview sees, which is the only place the pointer's
    // real path is known before pacing thins it out.
    if (this.inspecting && this.picking && event.kind === 'mousemove') {
      this.sampleInspect(event.x, event.y);
    }

    if ('x' in event) {
      // Remembered so the stand-ins can be put back the moment Alt is released,
      // rather than waiting for the next time the pointer moves.
      this.#pointer = { x: event.x, y: event.y };
    }

    // Driving one pane alone: the panes not being driven have no pointer in
    // them, so drawing one would say they were following along.
    if (this.#solo) {
      this.panes.forEach(pane => pane.hideCursor());
      return;
    }

    if (event.kind === 'mousedown' || event.kind === 'mouseup') {
      const pressed = event.kind === 'mousedown';
      this.panes.forEach(pane => pane.engine !== source && pane.setCursorPressed(pressed));
    }
    if (!('x' in event)) {
      return;
    }
    this.panes.forEach(pane => {
      if (pane.engine === source) {
        pane.hideCursor();
      } else {
        pane.showCursor(event.x, event.y);
      }
    });
  }

  /**
   * Follow Alt, from whatever says so first.
   *
   * Taken from every event that carries modifier state rather than from keydown
   * alone: a keyup can go missing — the window loses focus mid-press, the key is
   * released over another application — and a solo mode nobody asked to leave is
   * worse than one that is late to start.
   */
  private setSolo(held: boolean): void {
    if (held === this.#solo) {
      return;
    }
    this.#solo = held;
    this.panes.forEach(pane => {
      pane.solo = held;
    });

    // Both directions take effect on the key, not on the next movement. The
    // stand-ins are only ever drawn while the pointer is moving, so letting go
    // of Alt used to leave the panes bare until it moved again.
    this.showStandIns();
    this.syncPointerPresence();
  }

  /**
   * Tell the panes that are no longer being driven where the pointer is, or
   * that it has left them.
   *
   * Hiding a stand-in says nothing to the engine behind it: the page was told
   * the pointer was over that link and never told otherwise, so it stays hovered
   * — lit up in a pane nobody is driving. Moving to (-1,-1) is how the pointer
   * leaves; measured, all three engines drop `:hover` for it.
   *
   * Coming back is the same move in reverse, and it does double duty: the panes
   * regain the hover they should have, and the cursor sample it triggers is what
   * gives every stand-in its shape — a hand over a link rather than whatever it
   * was pointing at when Alt went down.
   */
  private syncPointerPresence(): void {
    const pointer = this.#pointer;
    const active = this.#activeEngine;
    if (!pointer || !active) {
      return;
    }

    if (this.#solo) {
      ENGINES.filter(engine => engine !== active).forEach(engine => {
        void send({ type: 'input', engine, event: { kind: 'mousemove', x: -1, y: -1 } }).catch(
          error => this.reportError(error)
        );
      });
      return;
    }

    void this.forwardInput({ kind: 'mousemove', ...pointer }, active);
  }

  /** Draw or clear the stand-in cursors for the pointer's current position. */
  private showStandIns(): void {
    const pointer = this.#pointer;
    this.panes.forEach(pane => {
      if (this.#solo || pointer === null || pane.engine === this.#activeEngine) {
        pane.hideCursor();
      } else {
        pane.showCursor(pointer.x, pointer.y);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Introspection
  // -------------------------------------------------------------------------

  private setInspecting(open: boolean): void {
    this.inspecting = open;
    // Closing the drawer must stop the sampling behind it, or three engines go
    // on being asked about every pointer movement for a panel nobody can see.
    this.setPicking(open && this.picking);
    if (open) {
      this.ensureTree();
    } else {
      // Stopped before the tree is dropped rather than after: both orders read
      // the same, and only one of them still knows what to stop.
      this.stopWatching();
      this.clearInspection();
    }
    if (this.dock !== 'detached') {
      return;
    }
    if (open) {
      void openInspectorWindow(() => this.setInspecting(false));
    } else {
      void closeInspectorWindow();
    }
  }

  /**
   * Move the drawer to the other edge.
   *
   * The window has not changed size, but every pane just did — they share one
   * viewport, so the engines have to be told. Straight through rather than
   * behind the resize debounce, for the same reason the pane split is: an edge
   * is chosen once and nothing follows it, so waiting to see whether more is
   * coming only holds the panes blank for as long as the wait.
   */
  private setDock(dock: InspectorDock): void {
    if (dock === this.dock) {
      return;
    }
    const wasDetached = this.dock === 'detached';
    this.dock = dock;
    storeDock(dock);
    // Moving the drawer is a fresh start for its size, and only for its size:
    // a height dragged along the bottom is not a width down the side. The
    // panes keep whatever division they were given.
    this.inspectorSize = defaultInspectorSize(dock);
    storeInspectorSize(this.inspectorSize);
    if (wasDetached) {
      void closeInspectorWindow();
    }
    if (dock === 'detached' && this.inspecting) {
      void openInspectorWindow(() => this.setInspecting(false));
    }
    void this.updateComplete.then(() => {
      window.clearTimeout(this.#resizeTimer);
      this.#settleViewport();
    });
  }

  /**
   * Answer the detached window, which knows nothing of its own.
   *
   * Everything it shows was pushed from here and everything clicked in it comes
   * back as an intent, which is the relationship every other component in this
   * app already has — the window boundary changes the transport, not the
   * design. Nothing is pushed while the drawer is attached, where the same
   * state reaches the same component through a property binding.
   */
  private push(state: InspectorState): void {
    if (this.dock === 'detached') {
      sendState(state);
    }
  }

  private pushSnapshot(): void {
    sendState({
      kind: 'snapshot',
      answers: this.answers,
      messages: this.messages,
      evaluations: this.evaluations,
      picking: this.picking,
      tab: this.inspectorTab,
      tree: this.tree === null ? null : toWire(this.tree),
      treeEngines: [...this.#running],
      searching: this.searching,
      matchCount: this.matchCount,
    });
  }

  /**
   * Send the detached window the tree, when there is one to send.
   *
   * Driven from `updated` rather than from the half-dozen places the tree
   * changes, because every one of them would otherwise have to remember — and
   * the one that forgot would leave a detached window showing a tree that no
   * longer matches what the panes are doing.
   */
  private pushTree(): void {
    this.push({
      kind: 'tree',
      tree: this.tree === null ? null : toWire(this.tree),
      treeEngines: [...this.#running],
      searching: this.searching,
      matchCount: this.matchCount,
    });
  }

  private handleIntent(intent: InspectorIntent): void {
    switch (intent.kind) {
      case 'ready':
        // A window that has just loaded, or reloaded, knows nothing and there
        // is no way to tell from here when its webview finished booting — so
        // it says so and is answered in full.
        this.pushSnapshot();
        return;
      case 'tab':
        this.setTab(intent.tab);
        return;
      case 'pick':
        this.setPicking(intent.picking);
        return;
      case 'dock':
        this.setDock(intent.dock);
        return;
      case 'evaluate':
        this.evaluate(intent.expression);
        return;
      case 'clear-console':
        this.clearConsole();
        return;
      case 'close':
        this.setInspecting(false);
        return;
      case 'tree-engine':
        this.switchTreeEngine(intent.engine);
        return;
      case 'tree-toggle':
        this.toggleRow(intent.nodeId, intent.open);
        return;
      case 'tree-select':
        this.selectRow(intent.nodeId);
        return;
      case 'tree-search':
        this.searchTree(intent.query);
        return;
    }
  }

  private setTab(tab: 'elements' | 'console'): void {
    this.inspectorTab = tab;
    this.push({ kind: 'tab', tab });
    if (tab === 'elements') {
      this.ensureTree();
    } else {
      // The tree is kept — coming back to it should not mean loading it again —
      // but nothing is watching it while it is not on screen.
      this.stopWatching();
    }
  }

  private clearConsole(): void {
    this.messages = [];
    this.evaluations = [];
    this.push({ kind: 'console-cleared' });
  }

  // -------------------------------------------------------------------------
  // Dividers
  // -------------------------------------------------------------------------

  /**
   * What the drawer's edge was at when its drag began, and how far it may go.
   *
   * Taken once, at the start: measuring on every movement would read a host
   * that the previous movement had already resized, and the drag would chase
   * its own tail.
   */
  #inspectorDrag = { from: 0, most: 0 };

  private beginInspectorDrag(): void {
    const host = this.getBoundingClientRect();
    this.#inspectorDrag = {
      from: this.inspectorSize,
      most: (this.dock === 'bottom' ? host.height : host.width) - MIN_PANE,
    };
  }

  /**
   * Drag the drawer's edge.
   *
   * Which direction makes it bigger depends on which edge it is against, which
   * is the only thing the three docked placements do differently here.
   */
  private moveInspectorDivider({ deltaX, deltaY }: DividerMove): void {
    const { from, most } = this.#inspectorDrag;
    const grown = this.dock === 'bottom' ? -deltaY : this.dock === 'right' ? -deltaX : deltaX;
    this.inspectorSize = clamp(from + grown, MIN_INSPECTOR, most);
  }

  /**
   * Agree a viewport straight away rather than waiting out the resize debounce.
   *
   * The debounce is for a burst of sizes on the way to one that is meant; a
   * released divider is the one that was meant.
   */
  private settleNow(): void {
    window.clearTimeout(this.#resizeTimer);
    this.#settleViewport();
  }

  private setPicking(picking: boolean): void {
    if (picking === this.picking) {
      return;
    }
    this.picking = picking;
    this.push({ kind: 'picking', picking });
    if (!picking) {
      window.clearTimeout(this.#inspectTrailing);
    }
  }

  private clearInspection(): void {
    window.clearTimeout(this.#publishTimer);
    window.clearTimeout(this.#remeasureTrailing);
    this.#pendingAnswers = new Map();
    this.#inspectId = null;
    this.answers = [];
    this.panes.forEach(pane => pane.showHighlight(null));
    // Said out loud, because the panes cannot tell. Each one holds the element
    // it last inspected and measures it again after every input that could have
    // moved the page — an evaluation per pane per scroll, for a highlight that
    // has just been taken off the screen. Worse than the cost: it goes on
    // volunteering where the element has got to, so one drawn before the drawer
    // was shut comes back the first time the page scrolls after it is reopened.
    void send({ type: 'deselect', engine: 'all' }).catch(() => {
      // Nothing to let go of in a pane that has gone.
    });
    // Every handle in the tree names a node in the document being left. The
    // walkers are per document and have already forgotten them.
    this.clearTree();
    this.ensureTree();
  }

  private sampleInspect(x: number, y: number): void {
    window.clearTimeout(this.#inspectTrailing);
    const elapsed = performance.now() - this.#inspectAt;
    if (elapsed >= INSPECT_SAMPLE_MS) {
      this.askInspect(x, y);
      return;
    }
    this.#inspectTrailing = window.setTimeout(
      () => this.askInspect(x, y),
      INSPECT_SAMPLE_MS - elapsed
    );
  }

  private askInspect(x: number, y: number): void {
    this.#inspectAt = performance.now();
    this.ask({ type: 'inspect', engine: 'all', x, y });
  }

  /** Put the question to every pane and start waiting for a whole readout. */
  private ask(command: Extract<Command, { type: 'inspect' | 'remeasure' | 'dom-describe' }>): void {
    const { id, done } = sendTracked(command);
    this.#inspectId = id;
    this.#pendingAnswers = new Map();
    // Only the panes that are actually running will answer; a pane that died
    // between the question and the answer is covered by the grace period.
    this.#expected = Math.max(1, this.#running.size);
    window.clearTimeout(this.#publishTimer);
    this.#publishTimer = window.setTimeout(() => this.publishAnswers(), ANSWER_GRACE_MS);
    void done.catch((error: unknown) => this.reportError(error));
  }

  // -------------------------------------------------------------------------
  // The tree
  // -------------------------------------------------------------------------

  /**
   * Make sure there is a tree to show, and that it belongs to a live engine.
   *
   * Called whenever the reasons to have one change — the drawer opening, the
   * tab changing, a pane coming up. Cheap to call and does nothing in the
   * common case, which is that the tree on screen is already the right one.
   */
  private ensureTree(): void {
    if (!this.inspecting || this.inspectorTab !== 'elements') {
      return;
    }
    const engines = [...this.#running];
    if (engines.length === 0) {
      return;
    }
    const engine = this.tree && engines.includes(this.tree.engine) ? this.tree.engine : engines[0];
    if (engine === undefined) {
      return;
    }
    if (this.pendingRoot?.engine === engine) {
      // Already on its way. Asking again would leave the first answer with no
      // request to belong to, and the tree would take whichever arrived last.
      return;
    }
    if (!this.tree || this.tree.engine !== engine) {
      this.startTree(engine);
      return;
    }
    // The tree survived being looked away from — the console tab, or the drawer
    // being shut and opened again — but the watch behind it did not, because
    // looking away is exactly when it is turned off. Nothing else would ever
    // turn it back on: a tree that is already right is a tree nothing rebuilds.
    this.pushWatch();
  }

  /**
   * Ask an engine for a tree, and show the one that is there until it answers.
   *
   * The old tree is deliberately left standing. Emptying it here put a blank
   * panel on screen for the length of a round trip — read as the tree closing
   * itself, and as a flicker when the answer was quick — and it also left the
   * reveal with nowhere to go: a tree with no root has no rows, so everything a
   * reveal wanted to open had to be asked for against an empty one, which is a
   * race it sometimes lost.
   *
   * So the replacement is assembled from the answer instead, in one step. What
   * is on screen until then belongs to the engine whose tab is still marked,
   * which is the honest thing to be showing.
   */
  private startTree(engine: Engine, revealTo: RevealTarget | null = null): void {
    // Both belong to the tree being replaced. A reveal that outlived it would
    // ask for its ancestors by handle, be refused, start the tree again, and go
    // round — and the outstanding questions would graft their answers onto
    // whatever had taken their parents' place.
    this.#revealing = null;
    this.#domRequests.clear();
    // Whatever was being watched is about to stop being what is shown.
    this.stopWatching();
    const { id, done } = sendTracked({ type: 'dom-root', engine, depth: 3 });
    this.pendingRoot = { id, engine, reveal: revealTo };
    void done.catch((error: unknown) => this.reportError(error));
  }

  /**
   * Show another engine's tree, open to whatever the last one had selected.
   *
   * Switching engines is asking the same question of a different engine, so
   * arriving at the top of an unopened document would throw away the only thing
   * being compared. The element is already identified in every engine: a
   * selection is described by all three at once, and each pane answers with its
   * own handles — so the column for the engine being switched to is holding the
   * chain to open, and the reveal costs nothing but the twisties on the way.
   *
   * An engine that found no such element simply reveals nothing, which is the
   * same finding its column was already showing.
   *
   * Only ever from somebody choosing an engine. A tree started again because
   * its document was replaced must not seed a reveal from answers describing
   * the document that went — the handles would be refused, the refusal would
   * start the tree again, and the two would take turns.
   */
  private switchTreeEngine(engine: Engine): void {
    this.startTree(engine, this.revealTargetFor(engine));
  }

  /**
   * Where a given engine's tree should be opened to, from what it last said.
   *
   * The selection is described by every engine at once and each answers with
   * its own handles, so the column for this engine is already holding the chain
   * — no round trip, and nothing to resolve.
   */
  private revealTargetFor(engine: Engine): RevealTarget | null {
    const element = this.answers.find(answer => answer.engine === engine)?.element;
    if (!element?.nodeId || !element.ancestors) {
      return null;
    }
    return { engine, nodeId: element.nodeId, ancestors: element.ancestors };
  }

  /** Drop the tree, for a navigation that made every handle in it meaningless. */
  private clearTree(): void {
    this.tree = null;
    this.matchCount = null;
    this.pendingRoot = null;
    this.#domRequests.clear();
    this.#revealing = null;
    this.#watching = '';
  }

  /**
   * Ask for a node's children, unless that question is already in the air.
   *
   * A reveal opens several levels at once and is retried every time any of them
   * lands, so without this the levels still outstanding would be asked for
   * again on each arrival — once per slice, multiplying with the depth of the
   * thing being revealed.
   */
  private fetchChildren(nodeId: string): void {
    const tree = this.tree;
    if (!tree || [...this.#domRequests.values()].includes(nodeId)) {
      return;
    }
    const { id, done } = sendTracked({ type: 'dom-children', engine: tree.engine, nodeId });
    this.#domRequests.set(id, nodeId);
    void done.catch((error: unknown) => this.reportError(error));
  }

  /**
   * Take a slice of tree.
   *
   * Only the engine whose tree is on screen is listened to. The command goes to
   * one pane, but an engine that was switched away from between the question
   * and the answer would otherwise graft its subtree onto somebody else's tree.
   */
  private onDomNodes(event: Extract<Event, { type: 'dom-nodes' }>): void {
    const pending = this.pendingRoot;
    if (pending && event.id === pending.id) {
      this.takeRoot(pending, event);
      return;
    }

    const parentId = this.#domRequests.get(event.id);
    if (parentId === undefined) {
      return;
    }
    this.#domRequests.delete(event.id);

    const tree = this.tree;
    if (!tree || tree.engine !== event.engine) {
      return;
    }
    if (event.error !== undefined) {
      // The pane has left the document these handles belonged to. Nothing can
      // be grafted onto a tree that no longer describes anything.
      this.startTree(event.engine);
      return;
    }

    this.tree = absorb(tree, parentId, event.nodes);
    this.pushWatch();
    this.continueReveal();
  }

  /**
   * Swap in the tree that was asked for, and open it where it was asked to be.
   *
   * The reveal starts here rather than when the switch was made, which is the
   * whole point of waiting: the chain it opens hangs off the root, and asking
   * for its levels before the root existed meant answers arriving for a tree
   * that had nothing to attach them to.
   *
   * An engine that could not answer leaves the previous tree alone. There is
   * nothing better to show, and a blank panel says something untrue about the
   * engine rather than about the request.
   */
  private takeRoot(
    pending: NonNullable<AppComponent['pendingRoot']>,
    event: Extract<Event, { type: 'dom-nodes' }>
  ): void {
    this.pendingRoot = null;
    if (event.error !== undefined) {
      this.reportError(new Error(event.error));
      return;
    }
    // A reveal already standing for this engine wins. It was asked for after
    // this root was, so it is the more recent intention — somebody picked an
    // element while the tree was still on its way — and one recorded against
    // the engine that was on screen before this one names nodes this engine
    // never had.
    const standing = this.#revealing?.engine === pending.engine ? this.#revealing : null;
    this.#revealing = null;

    this.tree = absorb(emptyTree(pending.engine), null, event.nodes);
    this.matchCount = null;
    this.pushWatch();

    // Reopened from here and nowhere else. A reveal advances on the answers to
    // the children it asked for, and a tree that has only just arrived has none
    // outstanding — so a reveal that was waiting for this root would simply
    // have sat there. That is what left the first pick after the drawer opened
    // expanding nothing at all, whenever the pick beat the root.
    const target = standing ?? pending.reveal;
    if (target) {
      this.revealNode(target);
    }
  }

  /**
   * Open or close a row.
   *
   * The children are asked for only the first time: a row that has been opened
   * before still has them, and a page that changed underneath said so through
   * its watch rather than by making every twisty a round trip.
   */
  private toggleRow(nodeId: string, open: boolean): void {
    const tree = this.tree;
    if (!tree) {
      return;
    }
    if (!open) {
      this.tree = collapse(tree, nodeId);
      this.pushWatch();
      return;
    }
    const opened = expand(tree, nodeId);
    this.tree = opened.tree;
    if (opened.fetch) {
      this.fetchChildren(nodeId);
    }
    this.pushWatch();
  }

  /**
   * Select a row, and ask every engine about the element it stands for.
   *
   * By identity rather than by handle: the handle is this engine's, and the
   * question is what all three make of the same element. A pane that has no
   * such element answers with nothing, which is the column that says so.
   */
  private selectRow(nodeId: string, describe = true): void {
    const tree = this.tree;
    if (!tree || (nodeId === tree.selectedId && !describe)) {
      return;
    }
    this.tree = { ...tree, selectedId: nodeId };
    if (describe) {
      this.ask({ type: 'dom-describe', engine: 'all', steps: stepsTo(tree, nodeId) });
    }
  }

  private searchTree(query: string): void {
    const tree = this.tree;
    if (!tree) {
      return;
    }
    if (query.trim().length === 0) {
      this.matchCount = null;
      return;
    }
    this.searching = true;
    const { id, done } = sendTracked({ type: 'dom-search', engine: tree.engine, query });
    // Search answers name the command, and only the newest one is wanted: a
    // typed query produces several and the earlier ones describe prefixes.
    this.#searchId = id;
    void done.catch((error: unknown) => this.reportError(error));
  }

  private onDomFound(event: Extract<Event, { type: 'dom-found' }>): void {
    if (event.id !== this.#searchId) {
      return;
    }
    this.searching = false;
    this.matchCount = event.matches.length;
    const first = event.matches[0];
    if (first) {
      // Named from the answer rather than from the tree on screen: searching is
      // asked of one engine, and which engine that was is what the handles
      // belong to — whatever the panel has switched to since.
      this.revealNode({ engine: event.engine, nodeId: first.nodeId, ancestors: first.ancestors });
    }
  }

  /**
   * Open the way down to a node and select it when it arrives.
   *
   * Recorded rather than done, because the chain cannot be walked in one go:
   * each level's children have to land before the next can be opened.
   */
  private revealNode(target: RevealTarget): void {
    this.#revealing = target;
    this.continueReveal();
  }

  private continueReveal(): void {
    const wanted = this.#revealing;
    const tree = this.tree;
    if (!wanted || !tree) {
      return;
    }
    if (wanted.engine !== tree.engine) {
      // Recorded against the tree that was on screen while this one was being
      // fetched. Its handles name nodes in another engine, and asking this one
      // about them would be refused — which would start the tree again, and
      // lose whatever it had opened in the meantime.
      this.#revealing = null;
      return;
    }
    const opened = reveal(tree, wanted.ancestors);
    this.tree = opened.tree;
    opened.fetch.forEach(id => this.fetchChildren(id));
    if (opened.fetch.length > 0) {
      return;
    }
    if (!this.tree.nodes.has(wanted.nodeId)) {
      // Everything on the way is open and the node is still not here: this
      // engine does not have it. Nothing more to wait for.
      this.#revealing = null;
      return;
    }
    this.#revealing = null;
    this.pushWatch();
    // Selected without describing: whoever asked for the reveal — the picker,
    // a search — already has the answers, and asking again would replace a
    // whole readout with an identical one.
    this.selectRow(wanted.nodeId, false);
  }

  /**
   * Tell the pane which subtrees are on screen.
   *
   * Sent only when it changed, which is what keeps walking the tree with the
   * arrow keys from being a command per keystroke. An empty set is the off
   * switch and is sent as readily as any other: it is what stops the page
   * observing itself.
   */
  private pushWatch(): void {
    const tree = this.tree;
    if (!tree) {
      return;
    }
    const ids = watchIds(tree);
    const signature = `${tree.engine}:${ids.join(',')}`;
    if (signature === this.#watching) {
      return;
    }
    this.#watching = signature;
    void send({ type: 'dom-watch', engine: tree.engine, nodeIds: ids }).catch((error: unknown) =>
      this.reportError(error)
    );
  }

  /**
   * Take the page's observers away, without forgetting the tree.
   *
   * The distinction matters: a drawer that is merely not showing the tree
   * should cost the page nothing, and should still have the tree when it is
   * shown again.
   */
  private stopWatching(): void {
    if (this.#watching === NOTHING_WATCHED) {
      return;
    }
    this.#watching = NOTHING_WATCHED;
    // Every pane rather than the tree's own. Only one is ever watching, but
    // this is also what runs when the tree has just been thrown away — and
    // asking which engine that tree belonged to is how this came to do nothing
    // at all on the path that needed it most.
    void send({ type: 'dom-watch', engine: 'all', nodeIds: [] }).catch(() => {
      // A pane that cannot be told has nothing to stop: it is gone, and its
      // observers went with its document.
    });
  }

  private onDomMutated(event: Extract<Event, { type: 'dom-mutated' }>): void {
    const tree = this.tree;
    if (!tree || tree.engine !== event.engine) {
      return;
    }
    const applied = applyChanges(tree, event.changes);
    this.tree = applied.tree;
    applied.refetch.forEach(id => this.fetchChildren(id));
    this.pushWatch();
  }

  /**
   * Take the selection's measurements again once the input has stopped.
   *
   * Only a backstop. Tracking a scroll is the panes' own job — they volunteer a
   * `selection` event between moving the page and capturing the frame that
   * shows it moved, which is the one moment a rectangle and a picture agree.
   * Polling from here could only ever measure somewhere in the middle of that.
   *
   * What it still covers is movement that follows the input rather than
   * accompanying it: a smooth scroll coasting to a stop, a layout settling a
   * beat late. So it is purely trailing, and does nothing at all while picking,
   * where every movement already produces a fresh readout.
   */
  private scheduleRemeasure(): void {
    if (this.picking || this.answers.length === 0) {
      return;
    }
    window.clearTimeout(this.#remeasureTrailing);
    this.#remeasureTrailing = window.setTimeout(
      () => this.ask({ type: 'remeasure', engine: 'all' }),
      SETTLE_REMEASURE_MS
    );
  }

  /**
   * Take a click for the picker rather than letting it reach the page.
   *
   * Picking an element ends the mode and keeps the element selected, which is
   * what the gesture means in every other inspector. The click must not also
   * reach the page: following a link would take the page out from under the
   * element that was just selected.
   */
  private interceptInput(event: InputEvent): boolean {
    if (event.kind === 'mouseup' && this.#swallowUp) {
      this.#swallowUp = false;
      return true;
    }
    if (event.kind !== 'mousedown' || !this.inspecting || !this.picking) {
      return false;
    }
    this.#swallowUp = true;
    this.setPicking(false);
    // The point that was actually clicked, rather than whatever the throttle
    // last managed to sample on the way to it.
    this.askInspect(event.x, event.y);
    return true;
  }

  /**
   * Take one engine's answer, and draw it over that engine's own pane.
   *
   * Each pane is highlighted from its own answer rather than from a shared one:
   * when two engines put the same element in different places, the two
   * rectangles being in different places is the finding, and a single overlay
   * would have to pick one of them to be wrong about.
   */
  private onInspected(event: Extract<Event, { type: 'inspected' }>): void {
    // Anything not naming the outstanding question describes a point the
    // pointer has already left.
    if (event.id !== this.#inspectId) {
      return;
    }
    this.#pendingAnswers.set(event.engine, {
      engine: event.engine,
      element: event.element,
      ...(event.error === undefined ? {} : { error: event.error }),
    });
    if (this.#pendingAnswers.size >= this.#expected) {
      this.publishAnswers();
    }
  }

  /**
   * Show a readout, once it is whole and if it says anything new.
   *
   * Two guards, both against the same thing: a panel that changes while the
   * pointer is standing still. One holds a sample until every pane has
   * answered, so the table never grows a column at a time; the other drops a
   * sample that describes exactly what is already on screen, which is most of
   * them — the pointer moves a few pixels within one element far more often
   * than it crosses into another.
   */
  private publishAnswers(): void {
    window.clearTimeout(this.#publishTimer);
    if (this.#pendingAnswers.size === 0) {
      return;
    }
    const answers = ENGINES.map(engine => this.#pendingAnswers.get(engine)).filter(
      (answer): answer is InspectAnswer => answer !== undefined
    );
    if (readoutSignature(answers) !== readoutSignature(this.answers)) {
      this.answers = answers;
      this.push({ kind: 'answers', answers });
      // Each pane is highlighted from its own answer: when two engines put the
      // same element in different places, two rectangles in different places is
      // the finding, and one shared overlay would have to be wrong about one.
      this.panes.forEach(pane => {
        const element = answers.find(answer => answer.engine === pane.engine)?.element ?? null;
        pane.showHighlight(element ? element.box : null, element ? describeRef(element) : '');
      });
    }

    // Outside that guard, which is about not redrawing a panel that would come
    // out identical. The tree is not the panel, and the one moment it most
    // needs telling is the moment the guard fires: a click lands where the
    // pointer already was, so what it commits is usually the very element the
    // last sample described — identical readout, and the only chance the tree
    // had to learn which row it was.
    this.revealPicked(answers);
  }

  /**
   * Ask all three the same question.
   *
   * What one engine answers is something its own developer tools already say
   * better; three answers side by side is the thing none of them can show.
   */
  private evaluate(expression: string): void {
    const { id, done } = sendTracked({ type: 'evaluate', engine: 'all', expression });
    this.evaluations = [...this.evaluations, { id, expression, results: [] }].slice(
      -EVALUATION_LIMIT
    );
    this.push({ kind: 'evaluations', evaluations: this.evaluations });
    void done.catch((error: unknown) => this.reportError(error));
  }

  private setActivePane(source: Engine): void {
    this.#activeEngine = source;
    this.panes.forEach(pane => {
      pane.active = pane.engine === source;
    });
  }

  /**
   * Look for a newer DevKit.
   *
   * Asking and being told nothing is indistinguishable from asking and being
   * ignored, so a check somebody made on purpose says so either way. The one on
   * the way up stays quiet: nobody asked.
   */
  private async checkForUpdate({ asked = false } = {}): Promise<void> {
    const update = await availableUpdate();
    this.pendingUpdate = update;
    if (asked && !update) {
      this.upToDate = true;
    }
  }

  /**
   * Replace this DevKit with the newer one and come back.
   *
   * The sidecar is a child of this process and its engines are children of
   * that, so they all go when the app does — there is nothing to wind down
   * first.
   */
  private async installUpdate(): Promise<void> {
    const update = this.pendingUpdate;
    if (!update) {
      return;
    }
    // Said on the button that was pressed, not in the badge beside it: that one
    // is for things that have gone wrong, and is coloured accordingly.
    this.installingUpdate = true;
    try {
      await update.install();
    } catch (error) {
      this.installingUpdate = false;
      this.pendingUpdate = null;
      this.reportError(error);
    }
  }

  private clearCursors(): void {
    const wasIn = this.#activeEngine;
    this.#activeEngine = null;
    this.#pointer = null;
    this.panes.forEach(pane => {
      pane.hideCursor();
      pane.setCursorPressed(false);
      pane.active = false;
    });

    // Only if the pointer was in a pane at all, because this runs on every
    // movement along the window's edge and the pages should hear about the
    // pointer leaving once.
    if (wasIn === null) {
      return;
    }
    // The pages are told as well, not just the panes. Until they are, the
    // element the pointer left is still hovered and the engines still answer
    // with its cursor — which is how a hand followed the pointer out of the
    // pane it belonged to. Moving to (-1,-1) is how a pointer leaves; the
    // shape that comes back for it is the arrow, and every pane takes it.
    void send({
      type: 'input',
      engine: 'all',
      event: { kind: 'mousemove', x: -1, y: -1 },
      source: wasIn,
    }).catch((error: unknown) => this.reportError(error));
  }

  // -------------------------------------------------------------------------
  // Engines
  // -------------------------------------------------------------------------

  /**
   * Engines download independently, so a missing one only disables its own pane.
   * The full-screen prompt is reserved for a genuinely cold start, where there is
   * nothing to show in any pane anyway.
   */
  private onBrowsers(installed: Record<Engine, boolean>): void {
    this.installed = installed;
    const available = ENGINES.filter(engine => installed[engine]);
    this.setupVisible = available.length === 0;

    ENGINES.filter(engine => !installed[engine]).forEach(engine => {
      const pane = this.pane(engine);
      pane?.resetInstallButton();
      pane?.setStatus('missing');
    });

    if (available.length > 0) {
      void this.startPanes(available);
    }
  }

  /**
   * Bring a dead pane back, once, after a pause. The pause keeps a repeatedly
   * failing engine from being relaunched in a loop.
   */
  private scheduleRelaunch(engine: Engine): void {
    this.#running.delete(engine);
    if (this.#relaunching.has(engine)) {
      return;
    }
    this.#relaunching.add(engine);
    window.setTimeout(() => {
      this.#relaunching.delete(engine);
      void this.startPanes([engine]);
    }, 2000);
  }

  private async startPanes(engines: Engine[]): Promise<void> {
    const pending = engines.filter(engine => !this.#running.has(engine));
    if (pending.length === 0) {
      return;
    }
    pending.forEach(engine => this.#running.add(engine));

    const viewport = this.currentViewport();
    this.#lastViewport = viewport;
    this.panes.forEach(pane => pane.applyViewport(viewport));
    this.#started = true;
    // Panes come up in the host's scheme; one that was switched before its
    // engine died is put back into its own once the engine is up again.
    const colorScheme = hostColorScheme();
    try {
      await send({ type: 'start', engines: pending, viewport, colorScheme });
      await Promise.all(
        pending
          .map(engine => this.pane(engine))
          .filter(
            (pane): pane is PaneComponent => pane !== undefined && pane.colorScheme !== colorScheme
          )
          .map(pane => this.setColorScheme(pane.engine, pane.colorScheme))
      );
      this.problem = '';
      this.navigate(lastVisited());
      // A drawer that was open before its engines were has nothing to show
      // until one of them is up.
      this.ensureTree();
    } catch (error) {
      pending.forEach(engine => this.#running.delete(engine));
      this.reportError(error);
    }
  }

  /**
   * Open the pane's page in a headed window, and say so while it is opening.
   *
   * The ack is the window: the sidecar answers once the page has committed in
   * it, so the button is held until then rather than for a guessed while.
   */
  private async detach(engine: Engine): Promise<void> {
    const pane = this.pane(engine);
    if (!pane || pane.detaching) {
      return;
    }
    pane.detaching = true;
    try {
      await send({ type: 'detach', engine });
    } catch (error) {
      this.reportError(error);
    } finally {
      pane.detaching = false;
    }
  }

  private setColorScheme(engine: Engine, scheme: ColorScheme): Promise<void> {
    return send({ type: 'color-scheme', engine, scheme }).catch(error => this.reportError(error));
  }

  /**
   * Download engines. With no argument this fetches everything missing, which is
   * what the cold-start prompt wants; a pane asks only for its own engine so the
   * others are not held up behind a download they do not need.
   */
  private requestInstall(engines?: Engine[]): void {
    void send({ type: 'install', ...(engines ? { engines } : {}) }).catch((error: unknown) => {
      this.reportError(error);
      (engines ?? ENGINES).forEach(engine => this.pane(engine)?.resetInstallButton());
      this.installingAll = false;
    });
  }

  // -------------------------------------------------------------------------
  // Sidecar
  // -------------------------------------------------------------------------

  private reportError(error: unknown): void {
    this.problem = error instanceof Error ? error.message : String(error);
  }

  /**
   * Put the element that was just picked where the tree can show it.
   *
   * The picker answers with handles as well as descriptions, so the row is
   * already identified — what is left is opening the twisties on the way down
   * to it. Only the engine whose tree is on screen has anything to say here;
   * the others answered about their own documents, in handles this tree cannot
   * use.
   *
   * Followed while picking too, not only once the mode ends. Pointing at a
   * pane and watching the row light up is most of what the two panels are for
   * together, and it is what the picker in every other inspector does. The tree
   * only scrolls when the row is out of sight, so resting on one element costs
   * nothing and moving across a page does not fight whoever is reading it.
   */
  private revealPicked(answers: InspectAnswer[]): void {
    // The engine whose tree is on screen, or — when none is yet — the one whose
    // tree is on its way. Requiring a tree here is what made the very first
    // pick after the drawer opened expand nothing: the drawer asks for a root
    // and the pointer beats the answer to it, so the reveal was dropped at a
    // moment when there was nothing to drop it for. Recorded against the
    // pending engine instead, it is waiting when the root lands.
    const engine = this.tree?.engine ?? this.pendingRoot?.engine;
    if (engine === undefined) {
      return;
    }
    const element = answers.find(answer => answer.engine === engine)?.element;
    if (!element?.nodeId || !element.ancestors) {
      return;
    }
    // Already showing it. Worth checking because this runs on every sample the
    // picker takes, and a pointer resting on one element produces the same
    // answer eleven times a second — each of which would otherwise rebuild the
    // tree to arrive at what it already said.
    if (this.tree?.selectedId === element.nodeId && this.#revealing === null) {
      return;
    }
    this.revealNode({ engine, nodeId: element.nodeId, ancestors: element.ancestors });
  }

  private onEvent(event: Event): void {
    switch (event.type) {
      case 'hello':
        // The sidecar greets on spawn, which happens before this webview exists,
        // so this is never the trigger to start anything — the frontend asks.
        return;

      case 'browsers':
        this.onBrowsers(event.installed);
        return;

      case 'install-progress':
        // An engine-attributed line belongs to that pane's own download; an
        // unattributed one came from the all-engines prompt.
        if (event.percent !== undefined && event.engine) {
          this.downloaded = { ...this.downloaded, [event.engine]: event.percent };
        }
        if (event.engine) {
          this.pane(event.engine)?.showProgress(event.message);
        } else {
          this.setupLog = `${this.setupLog}${event.message}\n`;
        }
        return;

      case 'pane':
        this.pane(event.engine)?.setStatus(event.status, event.detail, event.version);
        // A pane whose engine died is relaunched rather than left blank.
        if (event.status === 'closed' || event.status === 'failed') {
          this.scheduleRelaunch(event.engine);
        }
        return;

      case 'navigation': {
        // Panes navigate in lockstep, so any pane's URL is the shared URL; the
        // first to report wins and the rest are redundant confirmation.
        const real = event.url && event.url !== 'about:blank';
        if (real && event.loading) {
          // Whatever was being inspected belonged to the page being left, and
          // the engines have already forgotten it — each walker is per
          // document. Handled here rather than beside the address bar because
          // this is where every navigation arrives: a link clicked in a pane,
          // a page redirecting itself, a step along the trail, a reload. Only
          // the first of those passes through anything the app initiated.
          this.clearInspection();
        }
        if (real) {
          this.url = event.url;
          // As soon as the navigation commits, not when the page finishes
          // loading: a link clicked in a pane is somewhere you have been the
          // moment the address changes, and waiting for `load` left the back
          // arrow dead — for good, on a page that never finishes loading.
          session.visited(event.url);
          this.updateNavState();
        }
        // The title is the exception: it only exists once the page has loaded,
        // and it is what makes the history readable — "Berlin - Wikipedia"
        // rather than a line of URL.
        if (real && !event.loading) {
          history.record(event.url, event.title);
        }
        if (event.engine === 'chromium' && !event.loading && event.title) {
          document.title = `${event.title} — DevKit`;
        }
        return;
      }

      case 'frame':
        countReceivedFrame(event.engine, event);
        this.pane(event.engine)?.showFrame(event);
        return;

      case 'cursor':
        // Every pane takes the shape the pointed-at engine reports, so the panes
        // stay comparable: the real pointer over the active one, a drawn
        // stand-in over the others.
        this.panes.forEach(pane => pane.setCursorShape(event.css));
        return;

      case 'log':
        if (event.level === 'error' || event.level === 'warn') {
          // eslint-disable-next-line no-console -- the sidecar's own warnings have nowhere else to go
          console.warn('[sidecar]', event.message);
        }
        // Everything reaches the terminal in development, the quieter levels
        // included: the sidecar says what a repair did there, and dropping it
        // left the one mechanism that recovers a pane unobservable.
        if (import.meta.env.DEV) {
          void invoke('debug_log', {
            message: `sidecar ${event.level}: ${event.message}`.slice(0, 400),
          }).catch(() => {});
        }
        return;

      case 'selection':
        // Volunteered by the pane the instant it moved something, ahead of the
        // frame that shows it — so it is drawn straight onto the pane rather
        // than waiting for a whole readout to be assembled. Ignored while
        // picking, where every movement already produces a fresh one, and
        // ignored with the drawer shut, where there is nothing to annotate.
        if (this.inspecting && !this.picking) {
          this.pane(event.engine)?.showHighlight(
            event.element ? event.element.box : null,
            event.element ? describeRef(event.element) : ''
          );
        }
        return;

      case 'inspected':
        this.onInspected(event);
        return;

      case 'dom-nodes':
        this.onDomNodes(event);
        return;

      case 'dom-found':
        this.onDomFound(event);
        return;

      case 'dom-mutated':
        this.onDomMutated(event);
        return;

      case 'dom-invalidated':
        // The pane's document was replaced, or changed so much at once that
        // describing it costs more than asking again.
        //
        // Which of those it was decides whether the handles are worthless, and
        // the pane cannot tell us — so the selection is offered back and the
        // answer settles it. A page that merely churned still has the nodes it
        // had, and the tree comes back open where it was; a page that navigated
        // refuses the chain, and the refusal starts a plain tree with no reveal
        // to try again with. Rebuilding blind cost a revealed tree everything
        // it had opened, a beat after it opened it.
        if (this.tree?.engine === event.engine) {
          this.startTree(event.engine, this.revealTargetFor(event.engine));
        }
        return;

      case 'evaluated': {
        const { id, engine, result } = event;
        this.evaluations = this.evaluations.map(evaluation =>
          evaluation.id === id
            ? { ...evaluation, results: [...evaluation.results, { engine, result }] }
            : evaluation
        );
        this.push({ kind: 'evaluations', evaluations: this.evaluations });
        return;
      }

      case 'console':
      case 'page-error':
        // Kept whether or not the drawer is open: a console switched on after
        // the page loaded has already missed what it was opened to see.
        this.messages = appendConsole(this.messages, event);
        // Appended across the boundary rather than re-sent whole: the buffer
        // runs to two thousand entries, and all but one of them is already
        // there.
        this.push({ kind: 'console', entry: event });
        return;

      case 'ack':
        return;
    }
  }

  private onStatus(status: SidecarStatus): void {
    switch (status.kind) {
      case 'spawned':
        this.problem = '';
        this.#running.clear();
        this.#started = false;
        void send({ type: 'probe' }).catch(error => this.reportError(error));
        return;
      case 'crashed':
        this.#started = false;
        this.#running.clear();
        this.problem = `Sidecar crashed: ${status.reason} — click to restart`;
        return;
      case 'exited':
        this.#started = false;
        this.#running.clear();
        this.panes.forEach(pane => pane.setStatus('closed'));
        this.problem = 'Sidecar stopped — click to restart';
        return;
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  override firstUpdated(): void {
    this.attachPanes();

    // Not on `window`, which never hears either of these: `mouseleave` and
    // `pointerleave` do not bubble, so a listener there is only called if the
    // window is itself the target, which it never is. They are heard on the
    // document, and they are heard in addition to `pointerout` because no one
    // of the three can be relied on across platforms.
    document.addEventListener('mouseleave', () => this.leftTheWindow());
    document.documentElement.addEventListener('pointerleave', () => this.leftTheWindow());

    // Fetched now rather than when a cursor is first needed: an image that
    // arrives mid-movement pops in, and a pane that has none falls back to its
    // drawn shape in the meantime.
    void preloadCursors();

    // Measuring a pane means measuring its rendered surface, so the first
    // viewport can only be taken once the panes have rendered too.
    new ResizeObserver(() => this.syncViewport()).observe(
      this.renderRoot.querySelector('.panes') as HTMLElement
    );

    // The sidecar is already running by the time this webview loads, so the
    // frontend asks for state rather than waiting for an announcement it cannot
    // have heard.
    void connect({
      onEvent: event => this.onEvent(event),
      onStatus: status => this.onStatus(status),
    })
      .then(() => send({ type: 'probe' }))
      .catch(error => this.reportError(error));

    // The detached inspector has no state of its own; it reports what was
    // clicked and is told what to show.
    void onIntent(intent => this.handleIntent(intent));

    // A window left open across a reload of this one is still there, and still
    // waiting to be told things.
    if (this.dock === 'detached' && this.inspecting) {
      void openInspectorWindow(() => this.setInspecting(false));
    }

    if (import.meta.env.DEV) {
      startFrameDiagnostics(() => this.panes);
    }

    // Asked once, on the way up. A newer version is not news that needs to
    // arrive while the app is being used — but it can be asked for again, from
    // the menu, which is the only way to find out without restarting.
    void this.checkForUpdate();
    void listen(CHECK_FOR_UPDATES_EVENT, () => void this.checkForUpdate({ asked: true }));
  }

  override updated(changed: PropertyValues): void {
    this.attachPanes();
    if (changed.has('tree') || changed.has('searching') || changed.has('matchCount')) {
      this.pushTree();
    }
    // The grid keeps its placement in the stylesheet and takes only the one
    // number from here, which is the least that has to be inline for an edge
    // somebody can drag.
    this.style.setProperty('--inspector-size', `${Math.round(this.inspectorSize)}px`);
  }

  /**
   * Panes are rendered once and live for the session; wire each one once.
   *
   * After its own first render, not after ours: a child component renders after
   * its parent, so the surface the listeners attach to does not exist yet when
   * this element first updates.
   */
  private attachPanes(): void {
    this.panes.forEach(pane => {
      if (this.#attached.has(pane)) {
        return;
      }
      this.#attached.add(pane);
      void pane.updateComplete.then(() => {
        attachInput(pane, {
          preview: (event, source) => this.paintCursors(event, source),
          forward: (event, source) => this.forwardInput(event, source),
          enter: source => this.setActivePane(source),
          leave: () => this.clearCursors(),
          intercept: event => this.interceptInput(event),
        });
      });
    });
  }

  override render() {
    return html`
      <devkit-app-navbar
        .updateVersion=${this.pendingUpdate?.version ?? ''}
        .updating=${this.installingUpdate}
        .upToDate=${this.upToDate}
        .inspecting=${this.inspecting}
        .split=${this.split}
        .canGoBack=${this.canGoBack}
        .canGoForward=${this.canGoForward}
        .problem=${this.problem}
        .url=${this.url}
        @devkit-noticed=${() => (this.upToDate = false)}
        @devkit-inspector=${(event: CustomEvent<boolean>) => this.setInspecting(event.detail)}
        @devkit-navigate=${(event: CustomEvent<string>) => this.navigate(event.detail)}
        @devkit-split=${(event: CustomEvent<SplitDirection>) => this.setSplit(event.detail)}
        @devkit-back=${() => this.goBack()}
        @devkit-forward=${() => this.goForward()}
        @devkit-reload=${() => void send({ type: 'reload' }).catch(e => this.reportError(e))}
        @devkit-update=${() => void this.installUpdate()}
        @devkit-restart=${() => {
          this.problem = 'Restarting the sidecar…';
          void restart().catch(error => this.reportError(error));
        }}
      ></devkit-app-navbar>

      <main
        class="panes"
        data-split=${this.split}
        @devkit-install=${(event: CustomEvent<Engine>) => this.requestInstall([event.detail])}
        @devkit-color-scheme=${(event: CustomEvent<{ engine: Engine; scheme: ColorScheme }>) =>
          void this.setColorScheme(event.detail.engine, event.detail.scheme)}
        @devkit-detach=${(event: CustomEvent<Engine>) => void this.detach(event.detail)}
      >
        ${ENGINES.map(engine => html`<devkit-pane .engine=${engine}></devkit-pane>`)}
      </main>

      ${when(
        this.inspecting && this.dock !== 'detached',
        () => html`
          <devkit-divider
            class="inspector-divider"
            label="Resize the inspector"
            orientation=${this.dock === 'bottom' ? 'horizontal' : 'vertical'}
            @devkit-divider-start=${() => this.beginInspectorDrag()}
            @devkit-divider-move=${(event: CustomEvent<DividerMove>) =>
              this.moveInspectorDivider(event.detail)}
            @devkit-divider-end=${() => {
              storeInspectorSize(this.inspectorSize);
              this.settleNow();
            }}
          ></devkit-divider>
          <devkit-inspector
            .answers=${this.answers}
            .messages=${this.messages}
            .evaluations=${this.evaluations}
            .picking=${this.picking}
            .tab=${this.inspectorTab}
            .dock=${this.dock}
            .tree=${this.tree}
            .treeEngines=${[...this.#running]}
            ?searching=${this.searching}
            .matchCount=${this.matchCount}
            @devkit-dom-engine=${(event: CustomEvent<Engine>) =>
              this.switchTreeEngine(event.detail)}
            @devkit-dom-toggle=${(event: CustomEvent<{ nodeId: string; open: boolean }>) =>
              this.toggleRow(event.detail.nodeId, event.detail.open)}
            @devkit-dom-select=${(event: CustomEvent<string>) => this.selectRow(event.detail)}
            @devkit-dom-search=${(event: CustomEvent<string>) => this.searchTree(event.detail)}
            @devkit-inspector-dock=${(event: CustomEvent<InspectorDock>) =>
              this.setDock(event.detail)}
            @devkit-inspector-tab=${(event: CustomEvent<'elements' | 'console'>) =>
              this.setTab(event.detail)}
            @devkit-inspector-close=${() => this.setInspecting(false)}
            @devkit-pick=${(event: CustomEvent<boolean>) => this.setPicking(event.detail)}
            @devkit-console-clear=${() => this.clearConsole()}
            @devkit-evaluate=${(event: CustomEvent<string>) => this.evaluate(event.detail)}
          ></devkit-inspector>
        `
      )}
      ${this.setupVisible ? this.renderSetup() : nothing}
    `;
  }

  /**
   * One engine on the setup list: whether it is here, and how far off it is.
   *
   * The downloader's own output used to be shown as it arrived, which is a wall
   * of redrawn progress bars saying one number. The number is what was wanted,
   * so that is what is drawn.
   */
  private renderEngineToDownload(engine: Engine) {
    const installed = this.installed?.[engine] ?? false;
    const percent = this.downloaded[engine];
    const state = installed ? 'installed' : percent === undefined ? 'missing' : `${percent}%`;
    return html`
      <li data-installed=${String(installed)}>
        <span class="engine">${ENGINE_LABELS[engine]}</span>
        <span class="state">${state}</span>
        ${when(
          !installed && percent !== undefined,
          () => html`<span class="bar"><span style=${`width: ${percent ?? 0}%`}></span></span>`
        )}
      </li>
    `;
  }

  private renderSetup() {
    return html`
      <div class="setup">
        <div class="card">
          <h1>Browser engines needed</h1>
          <p>
            DevKit drives its own copies of Chromium, Gecko and WebKit through Playwright, so each
            pane renders in the real engine rather than a system webview. They download once, into
            Playwright's shared cache.
          </p>
          <ul>
            ${ENGINES.map(engine => this.renderEngineToDownload(engine))}
          </ul>
          <button
            type="button"
            ?disabled=${this.installingAll}
            @click=${() => {
              this.installingAll = true;
              this.panes.forEach(pane => pane.setInstalling());
              this.requestInstall();
            }}
          >
            ${this.installingAll ? 'Downloading…' : 'Download engines'}
          </button>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'devkit-app': AppComponent;
  }
}
