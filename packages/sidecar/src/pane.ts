import type {
  ColorScheme,
  DomChange,
  DomMatch,
  DomNode,
  Engine,
  EvaluatedValue,
  InputEvent,
  InspectedElement,
  SourceLocation,
  Viewport,
} from '@devkit/protocol';
import type { Browser, BrowserContext, Page } from 'playwright';
import { chromium, firefox, webkit } from 'playwright';

import { ConsoleRelay } from './console.js';
import { emit, log } from './emit.js';
import { sendFrame } from './frame-channel.js';
import type { Screencast } from './screencast.js';
import { startScreencast } from './screencast.js';
import { WALKER_KEY, WALKER_SOURCE } from './walker.js';

const launchers = { chromium, firefox, webkit } as const;

/**
 * Input kinds after which the selected element may have moved.
 *
 * Movement is nearly all scrolling, and the rest is a click that opened
 * something or a keystroke that reflowed a field. Pointer movement is left out
 * deliberately: it moves nothing, and asking three engines about it on every
 * mouse move is the cost this whole arrangement exists to avoid.
 */
const MOVES_THE_PAGE: InputEvent['kind'][] = ['wheel', 'keydown', 'text', 'mouseup'];

const JPEG_QUALITY = 60;

/**
 * Quiet time before a settled pane is re-captured sharply.
 *
 * Long enough that scrolling does not keep triggering an expensive capture,
 * short enough that a pane does not sit visibly soft after you stop.
 */
const SETTLE_MS = 400;

/**
 * Delay before re-capturing after a lone repaint.
 *
 * Nothing is settling — the change has already happened — so this only needs to
 * be long enough to coalesce a burst that is about to become motion. Waiting
 * the full settle time here is what made hovering feel laggy.
 */
const LONE_REPAINT_MS = 100;

/**
 * How much repainting counts as motion.
 *
 * Used to decide when to spend a sharp capture, and — on WebKit only — when a
 * pane may stream at all.
 */
const MOTION_WINDOW_MS = 250;

/**
 * How many frames inside that window mean the pane is moving.
 *
 * Scaled to what each engine actually delivers. Measured, time from a scroll to
 * the first frame and to the second:
 *
 * | Chromium | 15ms |  23ms |
 * | Gecko    | 13ms |  58ms |
 * | WebKit   | 37ms | 262ms |
 *
 * WebKit's first frame is barely late; its *second* is a quarter of a second
 * behind. Asking it for two frames therefore meant sitting on a frame we already
 * had while the pane looked frozen, which is why it visibly lagged the others at
 * the start of a scroll. One frame is enough there.
 *
 * Streaming on a single frame is only safe because a frame arriving without
 * recent input is attributed to the capture that woke the screencast
 * (`CAPTURE_WAKES_SCREENCAST`). Before that, this would have streamed every
 * stray repaint.
 */
const MOTION_FRAMES: Record<Engine, number> = {
  chromium: 3,
  firefox: 3,
  webkit: 1,
};

/**
 * Engines whose own capture restarts their screencast.
 *
 * WebKit's screenshot does not produce a couple of echo frames — it kicks the
 * screencast back into life. Traced in the running app: a capture is followed,
 * some 780ms later, by a run of frames at ~20fps lasting several hundred
 * milliseconds (`kickFramesStarted()` forcing a repaint). By timing and by count
 * that is indistinguishable from someone scrolling, which is why three attempts
 * to separate the two by a time window all failed, two of them by making the
 * pane feel slower.
 *
 * Chromium and Gecko do not do this — their captures cause no frames at all —
 * so nothing here applies to them, and a page that animates by itself still
 * streams in those panes exactly as before.
 */
const CAPTURE_WAKES_SCREENCAST: Record<Engine, boolean> = {
  chromium: false,
  firefox: false,
  webkit: true,
};

/**
 * How many frames after a capture such an engine may attribute to itself.
 *
 * One burst is 15-20 frames. Past this the pane believes them and streams, so a
 * page genuinely animating in a WebKit pane still comes to life, just a beat
 * later than in the other two.
 */
const EXPLAINABLE_FRAMES = 30;

/**
 * How long after the last input a pane still believes frames are the user's.
 *
 * This is the signal the timing-based attempts were missing. A capture makes the
 * engine repaint, and those frames are indistinguishable from real ones by
 * timing or by count — WebKit re-encodes identical pixels to different bytes, so
 * they do not even compare equal. What separates them is that nobody touched
 * anything: a settled pane, no input for a while, and a short burst of frames is
 * the pane reacting to its own screenshot.
 */
const INPUT_QUIET_MS = 400;

/**
 * How long a pane may draw nothing after being asked for something.
 *
 * Long enough that a page which genuinely repaints nothing — a click on empty
 * space — is not mistaken for a dead capture, short enough that a pane does not
 * sit ignoring its user.
 */
const SILENT_AFTER_DEMAND_MS = 2500;

/** How often a pane may try to put its device scale back. */
const DEVICE_SCALE_REPAIR_MS = 5000;

/**
 * Floor between sharp captures that motion did not ask for, per engine.
 *
 * The engines disagree about what "nothing changed" looks like. Chromium goes
 * quiet. Gecko emits several differing frames a second even on an idle page.
 * WebKit re-encodes identical pixels to different bytes — four frames of a
 * static page produced three distinct hashes — so comparing buffers cannot
 * recognise its own unchanged output at all. Without a floor, the latter two
 * would re-capture far more often than anything actually changed.
 *
 * WebKit's floor used to be far higher, because its captures are the most
 * expensive. That made it visibly sticky: it pushes too few frames to stream,
 * so a sharp capture is the *only* way it can show a hover or a blur, and
 * rate-limiting those rate-limited the pane itself. An unchanged capture now
 * settles the pane by content, which is what bounds the cost — the floor only
 * has to stop a burst.
 */
const IDLE_SHARP_FLOOR_MS: Record<Engine, number> = {
  chromium: 400,
  firefox: 400,
  webkit: 400,
};

/**
/**
 * Window after a sharp capture in which frames are treated as its echo.
 *
 * Taking a screenshot makes the engine repaint, and that repaint arrives as a
 * frame. Such a frame is not shown and does not count as motion — but it still
 * schedules another capture, because it might also be a real change the user
 * made at that moment. **Never drop it outright**: doing that lost hovers, and
 * a pane would sit on a stale image until something else happened to repaint.
 *
 * The loop this could cause is ended by content rather than by time: the
 * capture it schedules produces a screenshot identical to the last one when
 * nothing really changed, and an identical capture stops the chain.
 */
const SHARP_ECHO_MS = 250;

/**
 * One engine's browser, context, page and frame capture.
 *
 * The context is created per session with `newContext()` and never persisted:
 * Playwright keeps its storage in memory and discards it on close, so no
 * cookies, cache or history outlive the pane.
 */
export class Pane {
  readonly engine: Engine;

  #browser: Browser | null = null;
  #context: BrowserContext | null = null;
  #page: Page | null = null;
  #screencast: Screencast | null = null;
  /** This pane's console, folded and rate-limited; made with the pane's page. */
  #console: ConsoleRelay | null = null;
  /** Where the selection was last announced, so it is only said when it moves. */
  #lastSelectionAt = '';

  /**
   * Whether this pane has an inspected element at all.
   *
   * Kept here rather than asked of the page, because asking costs the round
   * trip this exists to avoid: scrolling anything, in a session where nobody
   * has opened the inspector, was paying an evaluate per pane per wheel event
   * to be told there was nothing to measure — with the input ack waiting
   * behind all three. That is most sessions, and it made every pane lag.
   */
  #hasSelection = false;

  /** Whether a measurement is already in the air, so a scroll cannot stack them. */
  #measuring = false;

  /**
   * Which document the handles this pane has handed out belong to.
   *
   * The walker names each document it is loaded into and repeats the name on
   * every drain. A name that changed is a navigation nothing told us about, and
   * every `nodeId` the app is holding for this engine died with the document
   * that minted it — so the pane says so once rather than letting the app apply
   * changes to a tree that no longer exists.
   */
  #domGen: string | null = null;

  /** Whether anything is expanded, which is the only reason to poll for changes. */
  #watchingDom = false;

  /** Whether a drain is already in the air, so a slow page cannot stack them. */
  #draining = false;

  /**
   * Whether the walker has already been put back once for this page.
   *
   * The repair is for a document that somehow missed the init script, which is
   * rare and does not become less rare by being attempted again. Without this,
   * a page that fails evaluations for some other reason — mid-navigation, most
   * often — re-injects several kilobytes of source on every cursor sample.
   */
  #repairedWalker = false;

  #viewport: Viewport;
  /** What the page is told the user prefers; a context option, so kept for relaunches. */
  #colorScheme: ColorScheme;
  #seq = 0;
  #capturing = false;
  #settleTimer: NodeJS.Timeout | null = null;
  #lastLive: Buffer | null = null;
  #lastSharp: Buffer | null = null;
  /** Set once a capture comes back unchanged: the pane is done until something really happens. */
  #settled = false;
  /** Whether the frame the pane is currently showing is a sharp one. */
  #showingSharp = false;
  #recentFrames: number[] = [];
  #lastSharpAt = 0;
  /** When this pane last had input applied, which is what makes a frame expected. */
  #lastInputAt = 0;
  /** Set when re-applying the viewport did not bring the scale back. */
  #scaleNudgeFailed = false;

  /** Set while nothing has been shown yet at the size the capture now runs at. */
  #nothingShownYet = false;

  /** Set while a new tab is being followed, so a burst of them is one navigation. */
  #following = false;

  /** When the pane was last asked for something, and when it last answered. */
  #lastDemandAt = 0;
  #lastFrameAt = 0;

  /**
   * The last handful of things done to the pane, for when the device scale
   * goes missing.
   *
   * Input, resizes and navigations have each been ruled out in isolation, so
   * what is left is some combination of them in a running pane. Whatever it is,
   * it happened just before the capture that noticed — so the capture says what
   * it found *and* what led up to it, rather than leaving the next person to
   * guess again.
   */
  #recent: string[] = [];

  /** When the device scale was last put back, so a failed repair cannot loop. */
  #lastRepairAt = 0;
  /** Whether this pane is being closed on purpose, so a disconnect is expected. */
  #closing = false;
  /** Whether this pane's death has already been announced, so it is said once. */
  #announcedClosed = false;
  /** Whether this pane ever finished starting, so launching is not read as dying. */
  #launched = false;
  /** Frames ignored as the settled pane's own doing, since it last really changed. */
  #explainedFrames = 0;

  constructor(engine: Engine, viewport: Viewport, colorScheme: ColorScheme) {
    this.engine = engine;
    this.#viewport = viewport;
    this.#colorScheme = colorScheme;
  }

  get page(): Page | null {
    return this.#page;
  }

  /** What a second window of this engine has to match to show the same thing. */
  get emulation(): { viewport: Viewport; colorScheme: ColorScheme } {
    return { viewport: this.#viewport, colorScheme: this.#colorScheme };
  }

  /** The browser build, once it is up. Reported with the pane's status. */
  get version(): string | undefined {
    return this.#browser?.isConnected() === true ? this.#browser.version() : undefined;
  }

  /**
   * Whether this pane still has a browser behind it.
   *
   * A pane can outlive its browser — a crash, a failed restart, a context torn
   * down mid-resize — and the object left behind looks identical to a working
   * one. Without this, a dead pane is never replaced and its column stays blank
   * for the rest of the session.
   */
  /**
   * Say that this pane has stopped, once.
   *
   * Anything we did not ask for is a death, and has to be said: the frontend
   * brings a closed pane back, and a pane nobody reports sits frozen on its last
   * frame for the rest of the session. Two things watch for it — the browser's
   * own `disconnected` and the heartbeat — and either may notice first.
   *
   * This used to report only while capturing, which is false for the whole of a
   * resize — stop, apply, start — so a browser lost while the window was being
   * dragged between monitors died in silence.
   */
  #announceClosed(detail?: string): void {
    if (this.#announcedClosed || this.#closing) {
      return;
    }
    this.#announcedClosed = true;
    emit({
      type: 'pane',
      engine: this.engine,
      status: 'closed',
      ...(detail === undefined ? {} : { detail }),
    });
  }

  /**
   * Report a pane whose browser has gone without a word.
   *
   * Only once it has been up: a pane that is still launching has no browser
   * either, and calling that a death announces one for every pane that is
   * merely starting.
   */
  checkAlive(): void {
    if (this.#launched && !this.alive) {
      this.#announceClosed('the engine stopped');
    }
  }

  /** Whether frames are actually being produced, which `alive` does not say. */
  get capturing(): boolean {
    return this.#capturing;
  }

  get alive(): boolean {
    return (
      this.#browser !== null &&
      this.#browser.isConnected() &&
      this.#page !== null &&
      !this.#page.isClosed()
    );
  }

  async start(): Promise<void> {
    this.#closing = false;
    this.#announcedClosed = false;
    this.#launched = false;
    emit({ type: 'pane', engine: this.engine, status: 'launching' });
    try {
      this.#browser = await launchers[this.engine].launch({
        headless: true,
        args: this.#launchArgs(),
      });
      // A browser that dies on its own must say so, or the pane silently stops
      // updating and looks merely idle.
      this.#browser.on('disconnected', () => {
        this.#announceClosed();
        this.#capturing = false;
      });
      this.#context = await this.#newContext();
      this.#page = await this.#context.newPage();
      // Only once the pane has its own page: creating it announces a page too,
      // and a listener watching for new tabs would have closed the pane's own.
      this.#followPopups(this.#context, this.#page);
      this.#watchNavigation(this.#page);
      // Made with the page and not before: a relaunch is a new page, and a
      // relay left attached to the old one would report a console nobody can
      // see while the new one stayed silent.
      this.#lastSelectionAt = '';
      this.#hasSelection = false;
      this.#repairedWalker = false;
      this.#console = new ConsoleRelay(this.engine);
      this.#watchConsole(this.#page);
      await this.#startCapture();
      // The build number travels with the status: a pane is only comparable to
      // the others if you know which build drew it.
      this.#launched = true;
      emit({ type: 'pane', engine: this.engine, status: 'live', version: this.#browser.version() });
    } catch (error) {
      emit({ type: 'pane', engine: this.engine, status: 'failed', detail: describe(error) });
      await this.close();
      throw error;
    }
  }

  /**
   * Chromium's screencast captures the surface at the browser's own scale factor
   * and ignores the context's `deviceScaleFactor`, so without this flag its pane
   * arrives at CSS resolution while Gecko and WebKit arrive at device
   * resolution — one pane upscaled and soft, which is useless for comparing
   * rendering. The flag scales the surface without touching layout: the page
   * still sees a 900x700 viewport.
   *
   * It is a launch argument, so changing DPR means relaunching the browser.
   */
  #launchArgs(): string[] {
    if (this.engine !== 'chromium') {
      return [];
    }
    return [`--force-device-scale-factor=${this.#viewport.scale}`];
  }

  /**
   * The context, with the introspection walker already in it.
   *
   * Injected here rather than passed with every call: the walker is a few
   * kilobytes of source, an inspect happens on every pointer move the inspector
   * is open for, and parsing it three times per movement is a cost paid for
   * nothing. `addInitScript` runs it before any script of the page's own, in
   * every frame, for every document the context ever loads — so a navigation
   * does not have to be noticed and re-armed.
   */
  async #newContext(): Promise<BrowserContext> {
    if (!this.#browser) {
      throw new Error('browser not launched');
    }
    const context = await this.#browser.newContext({
      viewport: { width: this.#viewport.width, height: this.#viewport.height },
      deviceScaleFactor: this.#viewport.scale,
      colorScheme: this.#colorScheme,
    });
    await context.addInitScript(WALKER_SOURCE);
    return context;
  }

  /**
   * Switch the scheme the page is told the user prefers.
   *
   * Emulated per page and applied in place: the page's media queries
   * re-evaluate and its `matchMedia` listeners fire, nothing relaunches. It is
   * remembered as well, so a pane relaunched for a DPR change comes back in the
   * scheme it was in rather than in Playwright's default.
   */
  async setColorScheme(scheme: ColorScheme): Promise<void> {
    this.#note(`scheme:${scheme}`);
    this.#colorScheme = scheme;
    await this.#page?.emulateMedia({ colorScheme: scheme });
  }

  /**
   * Take a link that asks for a new tab into the pane itself.
   *
   * A pane is one page, so a `target="_blank"` link opened a page nothing shows
   * and the click looked as though it had done nothing at all. Every pane gets
   * the same click, so each follows its own popup and the three stay on the
   * same URL — which is the whole arrangement.
   *
   * The popup is where the engine decided the link goes, redirects and all, so
   * it is asked rather than the anchor's `href` read.
   */
  /**
   * Keep a short trail of what was done to the pane, collapsing repeats.
   *
   * Continuous input would otherwise fill it with a hundred identical moves and
   * push out the one thing that mattered.
   */
  #note(what: string): void {
    // Anything done to a pane is a reason to expect a frame from it.
    this.#lastDemandAt = Date.now();
    const last = this.#recent[this.#recent.length - 1];
    const [head, count] = last?.split(' x') ?? [];
    if (head === what) {
      this.#recent[this.#recent.length - 1] = `${what} x${Number(count ?? 1) + 1}`;
      return;
    }
    this.#recent = [...this.#recent, what].slice(-12);
  }

  #followPopups(context: BrowserContext, own: Page): void {
    context.on('page', popup => {
      void (async () => {
        // Compared against the page this pane was given, not against whatever
        // `#page` holds now: a relaunch swaps that, and closing the pane's own
        // page leaves it blank for the rest of the session.
        if (popup === own || popup === this.#page) {
          return;
        }

        // Clicking a link ten times opens ten tabs, and following each of them
        // means ten navigations of one page, every one interrupting the last.
        // The page then never settles, and since these run outside the command
        // queue the pane stops answering anything at all. One at a time, and
        // the tabs that arrive meanwhile are simply closed — they all go to the
        // same place anyway.
        const alreadyFollowing = this.#following;
        this.#following = true;
        try {
          // A popup starts blank and is given its URL a moment later.
          if (popup.url() === 'about:blank') {
            await popup.waitForURL(url => url.href !== 'about:blank', { timeout: 5_000 });
          }
          const url = popup.url();
          await popup.close();
          if (!alreadyFollowing && url && url !== 'about:blank' && url !== this.#page?.url()) {
            await this.navigate(url);
          }
        } catch (error) {
          log('debug', `${this.engine} could not follow a new tab: ${describe(error)}`);
          await popup.close().catch(() => {});
        } finally {
          this.#following = alreadyFollowing;
        }
      })();
    });
  }

  #watchNavigation(page: Page): void {
    const report = async (loading: boolean) => {
      try {
        emit({
          type: 'navigation',
          engine: this.engine,
          url: page.url(),
          title: loading ? '' : await page.title(),
          loading,
        });
      } catch {
        // Page torn down or mid-navigation; the next event will correct the UI.
      }
    };

    page.on('framenavigated', frame => {
      if (frame !== page.mainFrame()) {
        return;
      }
      // A new document means a new walker, no selection in it, and a fresh
      // chance to repair one that never arrived.
      this.#lastSelectionAt = '';
      this.#hasSelection = false;
      this.#repairedWalker = false;
      void report(true);
    });
    page.on('load', () => {
      // Navigation commits before the page has painted, so whatever was captured
      // in between can be blank. A load is therefore always worth one capture,
      // even if the pane looks settled: otherwise a page that paints once and
      // then sits still leaves the blank frame on screen until something else
      // happens to repaint it.
      this.#recapture();
      void report(false);
    });
    page.on('crash', () =>
      emit({ type: 'pane', engine: this.engine, status: 'failed', detail: 'page crashed' })
    );
  }

  /** Force a fresh capture, whatever the pane currently believes about itself. */
  #recapture(): void {
    this.#settled = false;
    this.#lastLive = null;
    this.#lastSharp = null;
    if (this.#settleTimer) {
      clearTimeout(this.#settleTimer);
    }
    this.#settleTimer = setTimeout(() => void this.#captureSharp(), LONE_REPAINT_MS);
  }

  async navigate(url: string): Promise<void> {
    this.#note(`navigate:${url.slice(0, 60)}`);
    if (!this.#page) {
      throw new Error(`${this.engine} pane is not running`);
    }
    // `commit` returns as soon as the response lands; frames then stream in as
    // the page paints, rather than the UI freezing until every subresource lands.
    await this.#page.goto(url, { waitUntil: 'commit', timeout: 30_000 });
  }

  async reload(): Promise<void> {
    await this.#page?.reload({ waitUntil: 'commit', timeout: 30_000 });
  }

  async resize(viewport: Viewport): Promise<void> {
    this.#note(`resize:${viewport.width}x${viewport.height}@${viewport.scale}x`);
    const scaleChanged = viewport.scale !== this.#viewport.scale;
    this.#viewport = viewport;
    if (!this.#page || !this.#browser) {
      return;
    }

    // A DPR change cannot be applied in place: `deviceScaleFactor` is fixed at
    // context creation, and Chromium's scale factor is fixed at launch. Restart
    // the whole pane and put it back where it was.
    if (scaleChanged) {
      await this.#relaunchInPlace();
      return;
    }

    await this.#page.setViewportSize({ width: viewport.width, height: viewport.height });
    // The screencast was started for the old size; restart it for the new one.
    await this.#stopCapture();
    try {
      await this.#startCapture();
    } catch (error) {
      // Say so rather than leaving a pane that looks idle: the frontend brings
      // a failed pane back, and a pane with no capture shows nothing forever.
      emit({
        type: 'pane',
        engine: this.engine,
        status: 'failed',
        detail: `capture did not restart: ${describe(error)}`,
      });
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  /**
   * Replay one input event against this pane's page.
   *
   * Playwright's mouse is stateful, so every positioned event moves the cursor
   * first: a pane that never saw the intervening mousemoves would otherwise
   * press at the previous position.
   */
  async applyInput(event: InputEvent): Promise<void> {
    await this.#applyInput(event);
    // Deliberately not awaited. The ack for this input is what paces the next
    // one, so anything waited for here is added to the latency of every scroll
    // — and the measurement is an announcement, not part of applying the input.
    // It is already sent after the input was applied, which is the ordering
    // that matters.
    if (MOVES_THE_PAGE.includes(event.kind)) {
      void this.#volunteerSelection();
    }
  }

  async #applyInput(event: InputEvent): Promise<void> {
    this.#note(
      event.kind === 'mousemove' || event.kind === 'wheel'
        ? event.kind
        : `${event.kind}:${'button' in event ? event.button : 'key' in event ? event.key : ''}`
    );
    this.#lastInputAt = Date.now();
    // Whatever follows is the user's, not the pane's own echo.
    this.#explainedFrames = 0;
    const page = this.#page;
    if (!page || page.isClosed()) {
      return;
    }

    switch (event.kind) {
      case 'mousemove':
        await page.mouse.move(event.x, event.y);
        return;
      case 'mousedown':
        await page.mouse.move(event.x, event.y);
        await page.mouse.down({ button: event.button });
        return;
      case 'mouseup':
        await page.mouse.move(event.x, event.y);
        await page.mouse.up({ button: event.button });
        return;
      case 'wheel':
        await this.#wheel(event.x, event.y, event.deltaX, event.deltaY);
        return;
      case 'keydown':
        await page.keyboard.down(event.key);
        return;
      case 'keyup':
        await page.keyboard.up(event.key);
        return;
      case 'text':
        await page.keyboard.insertText(event.text);
        return;
    }
  }

  /**
   * What cursor the page would show at a point.
   *
   * The answer comes from the injected walker, which shares its descent with
   * the inspector — so this is right inside shadow roots and frames too, where
   * asking the top document alone reported whatever the host or the iframe
   * element resolved to.
   *
   * Never throws: this runs on every pointer move, and a pane that stopped
   * answering about its cursor must not turn into a rejected input event.
   */
  async readCursor(x: number, y: number): Promise<string | null> {
    const page = this.#page;
    if (!page || page.isClosed()) {
      return null;
    }
    return this.#withWalker<string | null>(
      page,
      `globalThis[${JSON.stringify(WALKER_KEY)}].cursorAt(${x}, ${y})`
    ).catch(() => null);
  }

  // -------------------------------------------------------------------------
  // Introspection
  // -------------------------------------------------------------------------

  /**
   * Relay this page's console.
   *
   * `text()` rather than `args()`: reading the arguments means an evaluation
   * per handle per message, and the three engines disagree about what a handle
   * to a DOM node or a cyclic object even serialises to — which turns a console
   * into three different consoles for reasons that have nothing to do with the
   * page. The printed line is what every engine agrees on.
   */
  #watchConsole(page: Page): void {
    page.on('console', message => {
      const where = message.location();
      const location: SourceLocation | undefined = where?.url
        ? {
            url: where.url,
            ...(where.lineNumber ? { line: where.lineNumber } : {}),
            ...(where.columnNumber ? { column: where.columnNumber } : {}),
          }
        : undefined;
      this.#console?.message(message.type(), message.text(), location);
    });
    page.on('pageerror', error => this.#console?.error(error.message, error.stack));
  }

  /**
   * What this engine finds at a point.
   *
   * The point is the identity — there is no selector and no node handle — so
   * this takes the same viewport coordinates as input and hands back a
   * description. What another engine found at the same point is another
   * description, and comparing them is the whole feature.
   */
  async inspect(x: number, y: number): Promise<InspectedElement | null> {
    const page = this.#page;
    if (!page || page.isClosed()) {
      throw new Error(`${this.engine} pane is not running`);
    }
    const element = await this.#withWalker<InspectedElement | null>(
      page,
      `globalThis[${JSON.stringify(WALKER_KEY)}].inspect(${x}, ${y})`
    );
    this.#hasSelection = element !== null;
    return element;
  }

  /**
   * Say where the selected element has got to, if it moved.
   *
   * Called straight after the input that could have moved it and inside the
   * same command turn, so the measurement lands after the scroll and before the
   * next frame is captured. That ordering is the whole point: a frontend that
   * polls instead measures somewhere in the middle, and the highlight lags its
   * element for as long as the gap.
   *
   * Never throws. This runs off the back of ordinary input, and a pane that
   * cannot answer about its selection must not turn a scroll into a dropped
   * input event.
   */
  async #volunteerSelection(): Promise<void> {
    const page = this.#page;
    // The cheap questions first, and both of them matter: a pane with nothing
    // selected must cost nothing at all, and a scroll must not stack a
    // measurement behind every wheel event it produces.
    if (!this.#hasSelection || this.#measuring || !page || page.isClosed()) {
      return;
    }
    this.#measuring = true;
    const element = await this.#withWalker<InspectedElement | null | undefined>(
      page,
      `globalThis[${JSON.stringify(WALKER_KEY)}].remeasure()`
    ).catch(() => undefined);
    this.#measuring = false;

    // The page disagrees about there being a selection — it navigated, most
    // likely — so stop paying for the question until something is inspected
    // again.
    if (element === undefined) {
      this.#hasSelection = false;
      return;
    }
    if (element === null) {
      this.#hasSelection = false;
    }

    // Said only when it changed, like the cursor. Scrolling a page whose
    // selection is fixed, or typing into a field beside it, moves nothing.
    const where = element === null ? 'gone' : JSON.stringify(element.box.border);
    if (where === this.#lastSelectionAt) {
      return;
    }
    this.#lastSelectionAt = where;
    emit({ type: 'selection', engine: this.engine, element });
  }

  /**
   * The element this pane last inspected, measured again where it now is.
   *
   * Null when nothing has been inspected yet, or when what was inspected has
   * since left the document.
   */
  async remeasure(): Promise<InspectedElement | null> {
    const page = this.#page;
    if (!page || page.isClosed()) {
      throw new Error(`${this.engine} pane is not running`);
    }
    const element = await this.#withWalker<InspectedElement | null>(
      page,
      `globalThis[${JSON.stringify(WALKER_KEY)}].remeasure()`
    );
    // An element that has gone takes the reason to keep asking with it.
    this.#hasSelection = element !== null;
    return element;
  }

  // -------------------------------------------------------------------------
  // The tree
  // -------------------------------------------------------------------------

  /**
   * Ask the walker something about its tree.
   *
   * Everything here goes through one helper because everything here fails the
   * same way: a stale handle, a page mid-navigation, a walker that is not there
   * yet. The caller decides what an unanswerable question looks like — a null
   * subtree, an empty list — and none of them is an error worth failing a
   * command over, because the app has three panes and only one of them has to
   * be able to answer for the view to be useful.
   */
  #askWalker<T>(call: string): Promise<T> {
    const page = this.#page;
    if (!page || page.isClosed()) {
      throw new Error(`${this.engine} pane is not running`);
    }
    return this.#withWalker<T>(page, `globalThis[${JSON.stringify(WALKER_KEY)}].${call}`);
  }

  /** The document row, with a few levels already under it. */
  async domRoot(depth?: number): Promise<DomNode[]> {
    return this.#askWalker<DomNode[]>(`tree(${JSON.stringify(depth ?? null)})`);
  }

  /**
   * One node's children, or null when the handle no longer means anything here.
   *
   * Null is not an error: a pane that navigated has every reason to refuse, and
   * saying so is what lets the app throw its tree away rather than draw a
   * subtree from the wrong document.
   */
  async domChildren(nodeId: string, depth?: number): Promise<DomNode[] | null> {
    return this.#askWalker<DomNode[] | null>(
      `childrenOf(${JSON.stringify(nodeId)}, ${JSON.stringify(depth ?? null)})`
    );
  }

  /**
   * Everything the panels say about the element an identity chain names here.
   *
   * Null when this engine has no such element, which is an answer: the app
   * shows it as a column that found nothing, beside two that did.
   */
  async domDescribe(steps: string[]): Promise<InspectedElement | null> {
    const element = await this.#askWalker<InspectedElement | null>(
      `describeSteps(${JSON.stringify(steps)})`
    );
    // The same bookkeeping a point inspect does: the highlight follows whatever
    // was selected last, however it was selected.
    this.#hasSelection = element !== null;
    return element;
  }

  async domSearch(query: string, limit?: number): Promise<DomMatch[]> {
    return this.#askWalker<DomMatch[]>(
      `searchNodes(${JSON.stringify(query)}, ${JSON.stringify(limit ?? null)})`
    );
  }

  /**
   * Tell the page which subtrees are on screen.
   *
   * An empty set is the off switch, and it is the state every pane stays in
   * until somebody opens the Elements tab: no observers in the page, no polling
   * out of it.
   */
  async domWatch(nodeIds: string[]): Promise<void> {
    this.#watchingDom = nodeIds.length > 0;
    await this.#askWalker<number>(`watch(${JSON.stringify(nodeIds)})`);
  }

  /** Whether this pane has anything worth polling for. */
  get watchingDom(): boolean {
    return this.#watchingDom;
  }

  /**
   * What changed in the watched subtrees since this was last asked.
   *
   * Never throws, and never stacks: this runs on a timer, and a pane that
   * cannot answer — mid-navigation, most often — must not turn a poll into a
   * rejected command or leave three drains in flight behind a slow page.
   *
   * A generation that moved is reported as an invalidation rather than as
   * changes. The changes would be honest and useless: they describe a document
   * the app has no handles into.
   */
  async drainDom(): Promise<DomChange[] | 'invalidated' | null> {
    const page = this.#page;
    if (!this.#watchingDom || this.#draining || !page || page.isClosed()) {
      return null;
    }
    this.#draining = true;
    const drained = await this.#askWalker<{
      gen: string;
      invalidated: boolean;
      changes: DomChange[];
    }>('drain()').catch(() => null);
    this.#draining = false;

    if (!drained) {
      return null;
    }
    if (this.#domGen !== null && this.#domGen !== drained.gen) {
      // A new document, and with it a walker that never heard of the handles
      // the app holds. Watching stops until the app has asked for a tree again.
      this.#domGen = drained.gen;
      this.#watchingDom = false;
      return 'invalidated';
    }
    this.#domGen = drained.gen;
    if (drained.invalidated) {
      return 'invalidated';
    }
    return drained.changes.length > 0 ? drained.changes : null;
  }

  /**
   * Run an expression in this page and describe what it produced.
   *
   * Awaited, so a promise answers with its value rather than with the fact that
   * it is a promise. Described rather than returned, so a DOM node or a cyclic
   * object comes back as text instead of failing the round trip in whichever
   * way this particular engine fails it.
   */
  async evaluate(expression: string): Promise<EvaluatedValue> {
    const page = this.#page;
    if (!page || page.isClosed()) {
      throw new Error(`${this.engine} pane is not running`);
    }
    const key = JSON.stringify(WALKER_KEY);
    const source = `(async () => {
      const api = globalThis[${key}];
      try {
        return api.describe(await (${expression}));
      } catch (error) {
        return api.fail(error);
      }
    })()`;
    return this.#withWalker<EvaluatedValue>(page, source);
  }

  /**
   * Evaluate against the injected walker, putting it back if it is not there.
   *
   * The init script covers every document the context loads, so the walker is
   * normally already in place. What it does not cover is a page that was
   * committed before the context finished being set up, and a navigation that
   * lands between the call and its evaluation. Those are rare enough to repair
   * rather than to guard against on every call: the retry re-injects and asks
   * again, and a second failure is a real one and is allowed through.
   */
  async #withWalker<T>(page: Page, source: string): Promise<T> {
    try {
      return (await page.evaluate(source)) as T;
    } catch (error) {
      // Once per page. Evaluations fail for reasons that have nothing to do
      // with the walker — a navigation landing mid-call, most often — and this
      // runs on every cursor sample, so retrying the injection each time meant
      // re-parsing several kilobytes of source throughout every page load.
      if (this.#repairedWalker) {
        throw error;
      }
      this.#repairedWalker = true;
      await page.evaluate(WALKER_SOURCE).catch(() => {});
      return (await page.evaluate(source)) as T;
    }
  }

  /** Firefox rejects `mouse.wheel`, so scrolling falls back to the page itself. */
  async #wheel(x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
    const page = this.#page;
    if (!page) {
      return;
    }
    await page.mouse.move(x, y);
    try {
      await page.mouse.wheel(deltaX, deltaY);
    } catch {
      // Typed through `globalThis` rather than the DOM lib: this callback runs
      // in the browser, but the sidecar itself is a Node program.
      await page
        .evaluate(
          ([dx, dy]: number[]) =>
            (globalThis as { scrollBy?: (x: number, y: number) => void }).scrollBy?.(
              dx ?? 0,
              dy ?? 0
            ),
          [deltaX, deltaY]
        )
        .catch(() => {});
    }
  }

  // -------------------------------------------------------------------------
  // Capture
  // -------------------------------------------------------------------------

  /**
   * Live frames come from the engine's own screencast, which pushes only when
   * the page composites — so a motionless pane costs nothing, on every engine.
   *
   * Frames are requested at CSS resolution, the only size all three engines
   * agree to deliver: Chromium scales to fit the request, while Gecko and WebKit
   * ignore it and push CSS resolution regardless. `#captureSharp` restores
   * device resolution once a pane settles.
   */
  async #startCapture(): Promise<void> {
    if (this.#capturing || !this.#page) {
      return;
    }

    // The flag goes up only once the screencast is actually running. Setting it
    // first latched a failed start permanently on: `#capturing` stayed true with
    // no screencast behind it, every later attempt returned here, and the pane
    // sat frozen on its last frame with nothing said about it. A resize that
    // restarts the capture — dragging the window between monitors does it
    // repeatedly — is exactly where that start can fail.
    // Nobody has a picture at this size yet: the pane it feeds is blank until
    // one arrives, so the first frame goes out whatever else it looks like.
    this.#nothingShownYet = true;

    const screencast = await startScreencast(
      this.#page,
      {
        size: { width: this.#viewport.width, height: this.#viewport.height },
        quality: JPEG_QUALITY,
      },
      buffer => this.#onLiveFrame(buffer)
    );
    this.#screencast = screencast;
    this.#capturing = true;
  }

  /**
   * Put a pane that has stopped streaming back to work.
   *
   * A pane can be perfectly alive — browser up, page open — and yet produce no
   * frames, because starting its capture failed. Nothing else notices: it looks
   * exactly like a page where nothing is happening.
   */
  async ensureCapturing(): Promise<void> {
    if (!this.alive) {
      return;
    }

    if (!this.#capturing) {
      log('info', `${this.engine} was not capturing; starting again`);
      await this.#startCapture();
      this.#recapture();
      return;
    }

    // A screencast can stop delivering while the object behind it still looks
    // alive, and nothing else notices: the pane keeps its last picture, ignores
    // everything, and says nothing. Quiet on its own means nothing — a settled
    // page produces no frames for minutes — so what is asked is whether the
    // pane answered the last thing done to it. Input, a resize or a navigation
    // that drew no frame at all is a capture that has stopped.
    const unanswered = this.#lastDemandAt > this.#lastFrameAt;
    if (!unanswered || Date.now() - this.#lastDemandAt < SILENT_AFTER_DEMAND_MS) {
      return;
    }

    log(
      'warn',
      `${this.engine} drew nothing since it was last asked ` +
        `${Date.now() - this.#lastDemandAt}ms ago; restarting its capture ` +
        `(leading up to it: ${this.#recent.join(' | ')})`
    );
    await this.#stopCapture();
    await this.#startCapture();
    this.#recapture();
  }

  /**
   * Narrate the settle state machine: `DEVKIT_DEBUG_SETTLE=1`.
   *
   * Inert otherwise. It is here because this logic is timing-dependent and only
   * misbehaves in the running app — neither a unit test nor the settle harness
   * reproduces what a real page does to it.
   */
  #trace(what: string): void {
    if (process.env['DEVKIT_DEBUG_SETTLE'] === '1') {
      log('warn', `settle ${this.engine} ${Date.now() % 100000} ${what}`);
    }
  }

  #onLiveFrame(buffer: Buffer): void {
    if (!this.#capturing) {
      return;
    }

    // Duplicates are discarded before anything else looks at them. Gecko pushes
    // ~22fps of byte-identical frames on a page where nothing is happening, and
    // counting those as activity would keep the pane permanently "busy".
    if (this.#lastLive?.equals(buffer)) {
      return;
    }
    this.#lastLive = buffer;
    this.#lastFrameAt = Date.now();

    // A capture that just started is answering a pane with nothing on it — a
    // resize, a relaunch, a first run. Sustained repainting is what the rules
    // below are for; the frame that proves the new size arrived is not that,
    // and holding it back leaves the pane blank until a sharp capture is
    // scheduled, taken and delivered. Measured at 470-875ms against the 23-52ms
    // the engines take to produce it.
    if (this.#nothingShownYet) {
      this.#nothingShownYet = false;
      this.#settled = false;
      this.#send(buffer, jpegSize(buffer), false);
      this.#scheduleSharpCapture(false);
      return;
    }

    const now = Date.now();

    // A frame arriving right after our own capture is probably that capture's
    // echo, so it is not shown — but it still schedules a re-capture, in case it
    // was also a real change.
    //
    // Echoes are also kept out of the motion window. Counting them made a
    // settled pane look busy: WebKit's screenshot repaints the whole page, its
    // echo arrives as several frames, and the next real frame then found a full
    // motion window and dropped the pane back to a live one.
    if (now < this.#lastSharpAt + SHARP_ECHO_MS) {
      // Once a capture has come back unchanged, further echoes are just the
      // tail of our own work: scheduling for them spins a capture every floor
      // interval forever, which cost ~25% CPU on an idle app.
      this.#trace(`echo settled=${this.#settled}`);
      if (!this.#settled) {
        this.#scheduleSharpCapture(false);
      }
      return;
    }

    this.#recentFrames = [...this.#recentFrames, now].filter(time => now - time < MOTION_WINDOW_MS);

    // Motion is measured only over the recent window. It deliberately does not
    // latch: a pane that stayed "in motion" because it once was would never
    // settle on a live page, and so would never be re-captured sharply.
    const motion = this.#recentFrames.length >= MOTION_FRAMES[this.engine];

    // Frames that arrive without the user having done anything, on an engine
    // whose capture wakes its own screencast, are attributed to that capture and
    // not shown. The pane still re-captures, so a page that really changed
    // appears — sharply, which while nobody is interacting is the better picture
    // anyway.
    //
    // Deliberately not conditioned on the pane being settled: a page whose
    // captures keep differing never settles, and that is exactly the case where
    // WebKit was flipping between `settled` and `stream` about twice a second.
    // Input clears the attribution immediately, so none of this is paid for
    // while you are scrolling — which is what the earlier time windows got
    // wrong, swallowing the very frames that carried the scrolling.
    if (
      CAPTURE_WAKES_SCREENCAST[this.engine] &&
      now - this.#lastInputAt > INPUT_QUIET_MS &&
      this.#explainedFrames < EXPLAINABLE_FRAMES
    ) {
      this.#explainedFrames += 1;
      this.#trace(`ignored: idle, explained=${this.#explainedFrames}`);
      this.#scheduleSharpCapture(false);
      return;
    }

    // A frame outside the echo window is somebody else's doing, so the pane is
    // live again.
    this.#settled = false;

    // Only sustained repainting streams. A lone repaint is answered with a
    // quick sharp capture instead, which keeps a still pane at full resolution
    // rather than dropping it to a blurrier live frame.
    this.#trace(
      `frame motion=${motion} recent=${this.#recentFrames.length} sinceSharp=${Date.now() - this.#lastSharpAt}ms`
    );
    if (motion) {
      this.#send(buffer, jpegSize(buffer), false);
    }
    this.#scheduleSharpCapture(motion);
  }

  async #stopCapture(): Promise<void> {
    this.#capturing = false;
    this.#nothingShownYet = false;
    this.#lastLive = null;
    this.#lastSharp = null;
    this.#settled = false;
    this.#showingSharp = false;
    this.#explainedFrames = 0;
    this.#recentFrames = [];
    if (this.#settleTimer) {
      clearTimeout(this.#settleTimer);
      this.#settleTimer = null;
    }
    await this.#screencast?.stop();
    this.#screencast = null;
  }

  /**
   * Re-arm the settle timer on every frame, so the sharp capture happens once
   * the page goes quiet rather than repeatedly during motion.
   */
  #scheduleSharpCapture(motion: boolean): void {
    if (motion) {
      // Defer: capturing mid-scroll wastes an expensive screenshot on a picture
      // that is already out of date.
      if (this.#settleTimer) {
        clearTimeout(this.#settleTimer);
      }
      this.#settleTimer = setTimeout(() => void this.#captureSharp(), SETTLE_MS);
      return;
    }

    // A lone repaint does not displace a pending capture, and is rate-limited
    // rather than dropped: waiting out the floor still shows the change, where
    // discarding it would strand a hover highlight until something else
    // repainted.
    if (this.#settleTimer) {
      return;
    }
    const floor = IDLE_SHARP_FLOOR_MS[this.engine];
    const wait = Math.max(LONE_REPAINT_MS, floor - (Date.now() - this.#lastSharpAt));
    this.#settleTimer = setTimeout(() => void this.#captureSharp(), wait);
  }

  /**
   * One screenshot at device resolution, taken only once a pane has stopped
   * moving.
   *
   * Screencast frames are CSS resolution, which is soft on a HiDPI display, and
   * this is the only way to get device resolution out of Gecko and WebKit at
   * all. It is expensive — WebKit repaints the whole page for any screenshot —
   * which is exactly why it waits for a moment when nothing else is happening.
   */
  async #captureSharp(): Promise<void> {
    this.#settleTimer = null;
    const page = this.#page;
    if (!this.#capturing || !page || page.isClosed() || this.#viewport.scale === 1) {
      return;
    }

    try {
      const buffer = await page.screenshot({
        type: 'jpeg',
        quality: JPEG_QUALITY,
        timeout: 5_000,
        animations: 'allow',
        caret: 'initial',
      });
      this.#lastSharpAt = Date.now();

      // A frame may have arrived while the screenshot was being taken, in which
      // case the pane is moving again and this one is already out of date.
      if (this.#settleTimer || !this.#capturing) {
        return;
      }

      const size = jpegSize(buffer);
      const expected = Math.ceil(this.#viewport.width * this.#viewport.scale);
      // Checked before the unchanged-capture shortcut, or a pane that has gone
      // quiet would report an undersized capture once and then never again.
      if (size) {
        await this.#checkCaptureSize(page, size);
      }

      // A capture is taken against whatever viewport the page had when the
      // screenshot started, so one that lands after a resize describes a shape
      // the pane has already left. Sending it costs the pane its picture: the
      // frame does not fit, so it is not shown, and the next capture is a
      // settle away. A capture at CSS resolution is a different fault — the
      // device scale is gone, which `#checkCaptureSize` has just asked about —
      // and is still worth showing.
      if (size && size.width !== expected && size.width !== this.#viewport.width) {
        log(
          'debug',
          `${this.engine} discarded a capture of ${size.width}x${size.height}, a viewport it no longer has`
        );
        this.#scheduleSharpCapture(false);
        return;
      }

      // Screenshots are deterministic for unchanged content on all three
      // engines, so an identical capture means the repaint that asked for it
      // changed nothing — it was our own echo. Settling here is what ends the
      // capture-echo-capture chain, by content rather than by a timer.
      //
      // Skipping the send is only safe while a sharp frame is still the one on
      // screen. If a live frame has been shown since, the pane is sitting on a
      // CSS-resolution picture and nothing else is coming — the engine has no
      // reason to repaint — so this capture is its last chance to go sharp.
      if (this.#lastSharp?.equals(buffer)) {
        this.#trace(`capture identical showingSharp=${this.#showingSharp}`);
        this.#settled = true;
        if (!this.#showingSharp) {
          this.#send(buffer, jpegSize(buffer), true);
        }
        return;
      }
      this.#trace('capture changed');
      this.#lastSharp = buffer;
      this.#settled = false;
      // A fresh capture can explain a fresh burst.
      this.#explainedFrames = 0;

      // Only claim sharpness when the capture really carries more pixels than a
      // live frame. Engines have been seen returning CSS-resolution screenshots
      // despite a device-scale context, and a pane that claims to be sharp while
      // showing a CSS-resolution image defeats the point of the label.
      this.#send(buffer, size, size ? size.width > this.#viewport.width : true);
    } catch (error) {
      log('debug', `${this.engine} sharp capture skipped: ${describe(error)}`);
    }
  }

  /**
   * Notice a settled capture that is not the size it should be, and put it back.
   *
   * Gecko drops the context's `deviceScaleFactor` — the page reports
   * `devicePixelRatio` 1 — and from then on even a full screenshot comes back at
   * CSS resolution, so the pane sits visibly soft next to the other two. It has
   * never been pinned down to a trigger: it does not reproduce in isolation
   * across fresh contexts, resizes, repeated navigations or screencast
   * restarts, but it happens in the running app.
   *
   * So this asks the page what it believes rather than trusting our record of
   * what we asked for, and repairs it when they disagree. The repair is a
   * viewport nudge — one pixel away and back — because re-applying the emulated
   * viewport is what fixes it, and `setViewportSize` is the public way to say
   * that. Playwright ignores a resize to the size it already believes it has,
   * hence the detour.
   */
  async #checkCaptureSize(page: Page, size: { width: number; height: number }): Promise<void> {
    const expected = Math.ceil(this.#viewport.width * this.#viewport.scale);
    if (size.width === expected) {
      return;
    }

    const actual = await page
      .evaluate(() => {
        const view = globalThis as {
          devicePixelRatio?: number;
          innerWidth?: number;
          innerHeight?: number;
        };
        return { dpr: view.devicePixelRatio, w: view.innerWidth, h: view.innerHeight };
      })
      .catch(() => null);

    log(
      'warn',
      `${this.engine} sharp capture came back ${size.width}x${size.height}, expected ${expected} wide ` +
        `(pane viewport ${this.#viewport.width}x${this.#viewport.height} @${this.#viewport.scale}x; ` +
        `page reports ${actual ? `${actual.w}x${actual.h} dpr=${actual.dpr}` : 'unavailable'}; ` +
        `leading up to it: ${this.#recent.join(' | ')})`
    );

    // Only worth repairing when the page really has lost the scale. An
    // undersized capture with the right dpr is a different fault, and nudging
    // the viewport would just cost a reflow.
    if (actual?.dpr === this.#viewport.scale) {
      return;
    }
    // Rate-limited: a repair that does not take must not turn into a loop of
    // reflows, one per settled capture.
    if (Date.now() - this.#lastRepairAt < DEVICE_SCALE_REPAIR_MS) {
      return;
    }
    this.#lastRepairAt = Date.now();
    await this.#restoreDeviceScale(page);
  }

  /**
   * Start the pane again and put it back where it was.
   *
   * The scale a context renders at is fixed when the context is made, and
   * Chromium's is fixed when the browser is launched, so anything that has to
   * change it starts over.
   */
  async #relaunchInPlace(): Promise<void> {
    const url = this.#page?.url();
    await this.close();
    // If the relaunch fails the pane is dead, and must be reported rather than
    // left looking idle — `start` will replace it on the next attempt.
    await this.start();
    if (url && url !== 'about:blank') {
      await this.navigate(url).catch(() => {});
    }
  }

  /** Re-apply the emulated viewport, the only way the public API allows. */
  async #restoreDeviceScale(page: Page): Promise<void> {
    const { width, height } = this.#viewport;
    try {
      await page.setViewportSize({ width, height: Math.max(1, height - 1) });
      await page.setViewportSize({ width, height });
      const dpr = await page
        .evaluate(() => (globalThis as { devicePixelRatio?: number }).devicePixelRatio ?? 0)
        .catch(() => 0);
      const restored = dpr === this.#viewport.scale;
      log(
        restored ? 'info' : 'warn',
        `${this.engine} device scale ${restored ? 'restored' : `still ${dpr}`} after re-applying the viewport`
      );

      if (restored) {
        this.#scaleNudgeFailed = false;
        // The pane is showing a stale picture by now.
        this.#recapture();
        return;
      }

      // A nudge that does not take leaves the pane rendering at half the
      // resolution of the others, which is the one thing this tool exists to
      // make comparable — and every frame it sends is wrong until something
      // changes. The scale is fixed when the context is made, so the only way
      // back is to make a new one. Given one failed nudge first, so a single
      // odd capture does not cost a relaunch.
      if (this.#scaleNudgeFailed) {
        this.#scaleNudgeFailed = false;
        log('warn', `${this.engine} relaunching to recover its device scale`);
        await this.#relaunchInPlace();
        return;
      }

      this.#scaleNudgeFailed = true;
      this.#recapture();
    } catch (error) {
      log('debug', `${this.engine} device scale repair failed: ${describe(error)}`);
    }
  }

  /**
   * Send a frame, reporting the image's real size rather than the requested one.
   *
   * The bytes go over the frame channel rather than stdout, so they never become
   * base64 or part of a JSON document.
   */
  #send(buffer: Buffer, size: { width: number; height: number } | null, sharp: boolean): void {
    this.#showingSharp = sharp;
    sendFrame({
      engine: this.engine,
      seq: this.#seq++,
      width: size?.width ?? this.#viewport.width,
      height: size?.height ?? this.#viewport.height,
      sharp,
      payload: buffer,
    });
  }

  async close(): Promise<void> {
    // From here a disconnect is our own doing, and not worth reporting.
    this.#closing = true;
    // Anything the relay was holding back belongs to the session that is
    // ending, and is the last thing that page will ever say.
    this.#console?.dispose();
    this.#console = null;
    await this.#stopCapture();
    await this.#context?.close().catch(() => {});
    await this.#browser?.close().catch(() => {});
    this.#context = null;
    this.#browser = null;
    this.#page = null;
  }
}

/** Read a JPEG's real dimensions from its SOF marker. */
function jpegSize(buffer: Buffer): { width: number; height: number } | null {
  let offset = 2;
  while (offset < buffer.length - 9) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (
      marker !== undefined &&
      marker >= 0xc0 &&
      marker <= 0xcf &&
      ![0xc4, 0xc8, 0xcc].includes(marker)
    ) {
      return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
    }
    offset += 2 + length;
  }
  return null;
}

export function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
