import '../app-navbar/app-navbar.component.js';
import '../pane/pane.component.js';

import type {
  ColorScheme,
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
import { html, nothing } from 'lit';
import { customElement, queryAll, state } from 'lit/decorators.js';
import { when } from 'lit/directives/when.js';

import { DevkitElement } from '../../utils/base.utils.js';
import { connect, restart, send } from '../../utils/bridge.utils.js';
import { preloadCursors } from '../../utils/cursors.utils.js';
import * as history from '../../utils/history.utils.js';
import { attachInput } from '../../utils/input.utils.js';
import type { SplitDirection } from '../../utils/layout.utils.js';
import { storedSplit, storeSplit } from '../../utils/layout.utils.js';
import * as session from '../../utils/session.utils.js';
import { isAppShortcut, match } from '../../utils/shortcuts.utils.js';
import type { AvailableUpdate } from '../../utils/update.utils.js';
import { availableUpdate } from '../../utils/update.utils.js';
import type { AppNavbarComponent } from '../app-navbar/app-navbar.component.js';
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
      default:
        break;
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
   * window. Leaving the window altogether — up to the toolbar, out to another
   * app — is only said once, here.
   */
  @listenWindow('pointerleave')
  protected handlePointerLeave(): void {
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
    this.#activeEngine = null;
    this.#pointer = null;
    this.panes.forEach(pane => {
      pane.hideCursor();
      pane.setCursorPressed(false);
      pane.active = false;
    });
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
    } catch (error) {
      pending.forEach(engine => this.#running.delete(engine));
      this.reportError(error);
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

    if (import.meta.env.DEV) {
      startFrameDiagnostics(() => this.panes);
    }

    // Asked once, on the way up. A newer version is not news that needs to
    // arrive while the app is being used — but it can be asked for again, from
    // the menu, which is the only way to find out without restarting.
    void this.checkForUpdate();
    void listen(CHECK_FOR_UPDATES_EVENT, () => void this.checkForUpdate({ asked: true }));
  }

  override updated(): void {
    this.attachPanes();
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
        @devkit-noticed=${() => {
          this.upToDate = false;
        }}
        .split=${this.split}
        .canGoBack=${this.canGoBack}
        .canGoForward=${this.canGoForward}
        .problem=${this.problem}
        .url=${this.url}
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
      >
        ${ENGINES.map(engine => html`<devkit-pane .engine=${engine}></devkit-pane>`)}
      </main>

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
