import type { ColorScheme, Engine, InputEvent, Viewport } from '@devkit/protocol';
import type { Browser, BrowserContext, Page } from 'playwright';
import { chromium, firefox, webkit } from 'playwright';

import { emit, log } from './emit.js';
import { sendFrame } from './frame-channel.js';
import type { Screencast } from './screencast.js';
import { startScreencast } from './screencast.js';

const launchers = { chromium, firefox, webkit } as const;

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

  #newContext(): Promise<BrowserContext> {
    if (!this.#browser) {
      throw new Error('browser not launched');
    }
    return this.#browser.newContext({
      viewport: { width: this.#viewport.width, height: this.#viewport.height },
      deviceScaleFactor: this.#viewport.scale,
      colorScheme: this.#colorScheme,
    });
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
   * Asked of the engine rather than inferred, so `cursor: pointer` on a link —
   * or a text caret, or a custom cursor — is whatever that engine decided,
   * which is the interesting answer for a tool that compares engines.
   */
  async readCursor(x: number, y: number): Promise<string | null> {
    const page = this.#page;
    if (!page || page.isClosed()) {
      return null;
    }
    return page
      .evaluate(
        // Typed loosely: this runs in the browser, while the sidecar is a Node
        // program compiled without the DOM lib.
        ([px, py]: number[]) => {
          const x = px ?? 0;
          const y = py ?? 0;
          const view = globalThis as unknown as {
            document?: {
              elementFromPoint?: (x: number, y: number) => unknown;
              createRange?: () => {
                selectNodeContents: (node: unknown) => void;
                getClientRects: () => ArrayLike<{
                  left: number;
                  right: number;
                  top: number;
                  bottom: number;
                }>;
              };
            };
            getComputedStyle?: (element: unknown) => { cursor?: string };
          };
          const doc = view.document;
          const element = doc?.elementFromPoint?.(x, y) as
            | {
                closest?: (s: string) => unknown;
                childNodes?: ArrayLike<{ nodeType?: number; nodeValue?: string }>;
              }
            | undefined;
          if (!element || !view.getComputedStyle) {
            return null;
          }

          const css = view.getComputedStyle(element).cursor || 'auto';
          if (css !== 'auto') {
            return css;
          }

          // WebKit reports `auto` even over links, where Chromium and Gecko say
          // `pointer`, so what a link resolves to has to be worked out.
          if (
            element.closest?.(
              'a[href], button, summary, [role="button"], [role="link"], input[type="submit"], input[type="button"]'
            )
          ) {
            return 'pointer';
          }

          // `auto` also covers ordinary content, where a browser shows an I-beam
          // over text and an arrow beside it. Caret hit-testing is no good here:
          // it snaps to the nearest text and so claims "text" across whole
          // paragraphs of empty space. Measuring the glyph boxes themselves is
          // what makes the cursor change back when leaving the words.
          const nodes = element.childNodes ?? [];
          const range = doc?.createRange?.();
          const TEXT_NODE = 3;
          for (let i = 0; range && i < nodes.length; i += 1) {
            const node = nodes[i];
            if (!node || node.nodeType !== TEXT_NODE || !node.nodeValue?.trim()) {
              continue;
            }
            range.selectNodeContents(node);
            // `getClientRects` is array-like rather than an array, and this runs
            // in the page, so it is copied before being searched.
            const rects = Array.from(range.getClientRects());
            if (
              rects.some(
                rect => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
              )
            ) {
              return 'text';
            }
          }
          return 'default';
        },
        [x, y]
      )
      .catch(() => null);
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
