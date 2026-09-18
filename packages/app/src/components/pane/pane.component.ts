import '../icon-button/icon-button.component.js';

import type { Engine, Event, PaneStatus, Viewport } from '@devkit/protocol';
import { ENGINE_LABELS, FRAME_LATEST, FRAME_SCHEME } from '@devkit/protocol';
import type { IconDefinition } from '@fortawesome/free-brands-svg-icons';
import { faChrome, faFirefoxBrowser, faSafari } from '@fortawesome/free-brands-svg-icons';
import { html, nothing, svg } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import { styleMap } from 'lit/directives/style-map.js';

import { DevkitElement } from '../../utils/base.utils.js';
import type { NativeCursor } from '../../utils/cursors.utils.js';
import { cursorTypeFor, nativeCursor } from '../../utils/cursors.utils.js';
import styles from './pane.component.css';

/**
 * Stand-in cursor shapes, drawn to look like the system cursors they stand in
 * for — not like an app's own iconography.
 *
 * The pane under the pointer shows the real system pointer, so these have to
 * match it or the panes stop being comparable. Each is drawn in a 24x24 box with
 * its hotspot in the same units, so the shape hangs off the pointed-at pixel the
 * way a real cursor does.
 */
const CURSOR_SHAPES = {
  /** The standard arrow: a narrow wedge with a tail, tip at the top left. */
  arrow: {
    d: 'M2 1.6 L2 17.4 L6.05 13.5 L8.5 19.4 L11.05 18.35 L8.65 12.6 L14 12.55 Z',
    hotspot: [2, 1.6],
    stroked: false,
  },
  /** The pointing hand: one raised finger, three folded, thumb at the side. */
  hand: {
    d:
      'M8.6 3.1a1.45 1.45 0 0 1 2.9 0V10.5h.75V8.75a1.4 1.4 0 0 1 2.8 0V10.6h.75V9.6a1.4 1.4 0 0 1 2.8 0v1.25h.75v-.35' +
      'a1.4 1.4 0 0 1 2.8 0v4.95c0 3.15-2.2 5.45-5.45 5.45h-1.75c-1.95 0-2.95-.7-3.95-2.15l-2.5-3.85' +
      'a1.4 1.4 0 0 1 2.25-1.6l.85 1.2Z',
    hotspot: [10, 3.1],
    stroked: false,
  },
  /** The text I-beam: a stem with serifs top and bottom. */
  beam: {
    d: 'M9.4 4.4 h5.2 M12 4.4 V19.6 M9.4 19.6 h5.2',
    hotspot: [12, 12],
    stroked: true,
  },
} as const;

type CursorShape = keyof typeof CURSOR_SHAPES;

/**
 * The mark each engine is known by, drawn in the header beside its name.
 *
 * These are browser marks, not engine marks — no set draws Blink or Gecko — so
 * each stands in for the engine its browser is built on. The marks belong to
 * their owners; they identify what is rendering, nothing more.
 */
const ENGINE_GLYPHS: Record<Engine, IconDefinition> = {
  chromium: faChrome,
  firefox: faFirefoxBrowser,
  webkit: faSafari,
};

/**
 * Cursor keywords the app will apply to itself.
 *
 * A page can ask for anything, including a `url()` pointing at an image the app
 * cannot load, so only known keywords are passed through.
 */
// prettier-ignore
const SAFE_CURSOR_CSS = new Set([
  'auto', 'default', 'none', 'context-menu', 'help', 'pointer', 'progress', 'wait',
  'cell', 'crosshair', 'text', 'vertical-text', 'alias', 'copy', 'move', 'no-drop',
  'not-allowed', 'grab', 'grabbing', 'e-resize', 'n-resize', 'ne-resize', 'nw-resize',
  's-resize', 'se-resize', 'sw-resize', 'w-resize', 'ew-resize', 'ns-resize',
  'nesw-resize', 'nwse-resize', 'col-resize', 'row-resize', 'all-scroll',
  'zoom-in', 'zoom-out',
]);

/** Which drawn shape stands in for a CSS cursor keyword. */
function shapeFor(css: string): CursorShape {
  if (css === 'pointer' || css === 'grab' || css === 'grabbing') {
    return 'hand';
  }
  if (css === 'text' || css === 'vertical-text') {
    return 'beam';
  }
  return 'arrow';
}

/**
 * Tauri exposes custom schemes differently per platform, matching the shape its
 * own `convertFileSrc` produces.
 */
const FRAME_ORIGIN = navigator.userAgent.includes('Windows')
  ? `http://${FRAME_SCHEME}.localhost`
  : `${FRAME_SCHEME}://localhost`;

/** Frontend-only state: the engine's binary has not been downloaded yet. */
export type ViewStatus = Exclude<PaneStatus, 'live'> | 'missing' | 'stream' | 'settled';

/**
 * One label for the whole of a pane's condition, and the colour it is said in.
 *
 * A running pane is always in one of two modes, and both are healthy: streaming
 * live frames because something is moving, or sitting on the device-resolution
 * still taken once it settled.
 */
const STATUS: Record<ViewStatus, { label: string; colour: string }> = {
  missing: { label: 'not installed', colour: 'var(--text-dim)' },
  idle: { label: 'idle', colour: 'var(--text-dim)' },
  launching: { label: 'launching…', colour: 'var(--pending)' },
  stream: { label: 'stream', colour: 'var(--pending)' },
  settled: { label: 'settled', colour: 'var(--ok)' },
  failed: { label: 'failed', colour: 'var(--danger)' },
  closed: { label: 'closed', colour: 'var(--text-dim)' },
};

/** The two modes a running pane alternates between. */
const RUNNING: ViewStatus[] = ['stream', 'settled'];

/** How long the frame-rate meter averages over. */
const METER_WINDOW_MS = 2000;

/** A gap longer than this ends a burst: the next frame starts the average afresh. */
const BURST_GAP_MS = 400;

/**
 * One engine's pane: header, frame surface, stand-in cursor and its own frame
 * rate accounting.
 *
 * Frames are not carried in the event that announces them. The event supplies a
 * sequence number and the image element fetches the bytes from the backend over
 * a URI scheme, so decoding happens off the main thread and a frame already
 * stale when fetched is simply replaced by a newer one.
 */
@customElement('devkit-pane')
export class PaneComponent extends DevkitElement.withStyles(styles) {
  @property()
  accessor engine!: Engine;

  /** The size frames are currently drawn at, as last agreed. */
  #viewport: Viewport | null = null;

  /** When the pane last went blank, and how long it took to come back. */
  #blankedAt = 0;

  /** How often the pane blanked, and the last wait, for the diagnostics line. */
  blanks = 0;
  lastBlankMs = 0;

  /** When the frame now loading was asked for, and how long recent ones took. */
  #askedAt = 0;
  #fetches: number[] = [];

  /** The pane the pointer is in, which is not the same as where the keyboard goes. */
  @property({ type: Boolean, reflect: true })
  accessor active = false;

  /**
   * Whether input is currently going to one pane alone.
   *
   * Said in the header, never over the frame: dimming or tinting a rendering
   * would falsify the one thing the panes exist to show.
   */
  @property({ type: Boolean, reflect: true })
  accessor solo = false;

  @property({ attribute: 'has-frame', type: Boolean, reflect: true })
  accessor hasFrame = false;

  @state()
  private accessor status: ViewStatus = 'idle';

  @state()
  private accessor detail = '';

  @state()
  private accessor version = '';

  /** The size the page is being rendered at, in CSS pixels. */
  @state()
  private accessor dims = '';

  @state()
  private accessor rate = '';

  @state()
  private accessor progress = '';

  @state()
  private accessor installing = false;

  @state()
  private accessor cursor: { x: number; y: number; pressed: boolean } | null = null;

  /**
   * The shape the engine last reported, kept apart from the drawn cursor.
   *
   * Separate because hiding the stand-in used to take the shape with it: it
   * lived on the cursor object, `hideCursor` set that to null, and the next
   * `showCursor` fell back to an arrow. Let go of Alt over a link and the link
   * was hovered while the stand-ins pointed at it as arrows, until something
   * moved and the engine reported again.
   */
  @state()
  private accessor cursorCss = 'default';

  @query('img')
  private accessor image!: HTMLImageElement;

  @query('.surface')
  private accessor surfaceElement!: HTMLElement;

  #frameTimes: number[] = [];

  /** Diagnostics: frames that rendered, and frames whose fetch failed. */
  loaded = 0;
  failed = 0;
  lastFailure = '';
  shownDims = '-';

  get surface(): HTMLElement {
    return this.surfaceElement;
  }

  /**
   * Render frames at exactly the engine's viewport size rather than stretching
   * them to the pane. Scaling would soften the image and break the 1:1 mapping
   * that lets a click land where the user aimed it.
   */
  applyViewport(viewport: Viewport): void {
    this.#viewport = viewport;
    this.image.style.width = `${viewport.width}px`;
    this.image.style.height = `${viewport.height}px`;
    this.dims = `${viewport.width}×${viewport.height}`;
    // The picture on screen was made for the shape the pane used to be. Hiding
    // it is the point: stretched to the new one it reads as a broken render
    // rather than as a pane waiting for its next frame.
    this.hasFrame = this.showsUndistorted();
  }

  /**
   * Whether what is decoded fits the box it is being drawn in.
   *
   * Compared as a shape rather than as a size: a frame may legitimately arrive
   * at either resolution — live frames at CSS, settled captures at device — and
   * an engine may miss the requested size by a pixel. Neither looks wrong. Only
   * a different shape does.
   */
  private showsUndistorted(): boolean {
    const { naturalWidth, naturalHeight } = this.image;
    if (naturalWidth === 0 || naturalHeight === 0) {
      return false;
    }
    const viewport = this.#viewport;
    if (viewport === null) {
      // Nothing has been agreed yet, so there is no shape to be wrong about.
      return true;
    }
    // Measured against the agreed size rather than against the element. This
    // runs for every frame that decodes, and asking the element for its width
    // there forces a layout each time, on a page that is already mid-repaint —
    // which is felt as the panes stuttering while scrolling.
    return Math.abs(naturalWidth / naturalHeight - viewport.width / viewport.height) < 0.01;
  }

  /** CSS-pixel size available for rendering, which becomes the engine's viewport. */
  measure(): { width: number; height: number } {
    const rect = this.surfaceElement.getBoundingClientRect();
    return {
      width: Math.max(320, Math.round(rect.width)),
      height: Math.max(240, Math.round(rect.height)),
    };
  }

  /**
   * Translate a window coordinate into viewport pixels, or null if it fell
   * outside the rendered frame.
   */
  toViewportPoint(clientX: number, clientY: number): { x: number; y: number } | null {
    const rect = this.image.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return null;
    }
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) {
      return null;
    }
    return { x: Math.round(x), y: Math.round(y) };
  }

  /**
   * `version` is the browser build, reported once when the engine comes up. It
   * is remembered rather than cleared by later status changes: a pane that has
   * closed was still rendered by that build.
   */
  setStatus(status: PaneStatus | 'missing', detail?: string, version?: string): void {
    // A pane that has just come up has produced no frame yet, so it starts in
    // the mode that needs no evidence; the first frame says which it really is.
    this.setState(status === 'live' ? 'stream' : status);
    this.detail = detail ?? '';
    if (version) {
      this.version = version;
    }
  }

  private setState(state: ViewStatus): void {
    if (state === this.status) {
      return;
    }
    this.status = state;
    this.style.setProperty('--status-color', STATUS[state].colour);
    // Frame rate is only meaningful while the pane is running, and a stopped
    // pane's last rate is a lie about a pane that is no longer producing any.
    if (!RUNNING.includes(state)) {
      this.#frameTimes = [];
      this.rate = '';
    }
  }

  showFrame(frame: Extract<Event, { type: 'frame' }>): void {
    // The sequence number only makes the URL unique; the backend always answers
    // with this engine's newest frame.
    this.#askedAt = performance.now();
    this.image.src = `${FRAME_ORIGIN}/${this.engine}/${frame.seq}`;
    // A frame arriving is itself proof the pane is running: a status event may
    // be missed, but this cannot be — the picture is here.
    this.setState(frame.sharp === true ? 'settled' : 'stream');
    this.recordFrame();
  }

  /**
   * Rate of the burst being shown, not of the last two seconds: a pane that
   * settles and streams again starts a new burst, and averaging across the quiet
   * in between made a pane appear to start at 2fps and climb.
   */
  private recordFrame(): void {
    const now = performance.now();
    const previous = this.#frameTimes[this.#frameTimes.length - 1];
    if (previous !== undefined && now - previous > BURST_GAP_MS) {
      this.#frameTimes = [];
    }

    this.#frameTimes = [...this.#frameTimes, now].filter(time => now - time < METER_WINDOW_MS);
    const span = now - (this.#frameTimes[0] ?? now);
    const fps = span > 0 ? ((this.#frameTimes.length - 1) / span) * 1000 : 0;
    // Below one frame a second there is no rate worth reporting.
    this.rate = fps >= 1 ? `${fps.toFixed(0)} fps` : '';
  }

  showProgress(message: string): void {
    this.progress = message;
  }

  setInstalling(): void {
    this.installing = true;
  }

  resetInstallButton(): void {
    this.installing = false;
    this.progress = '';
  }

  /**
   * Draw a stand-in pointer at a viewport coordinate.
   *
   * Only panes the user is not physically over get one — the active pane keeps
   * the real OS cursor. The overlay exists because frames lag: a pane repainting
   * at 5fps would otherwise give no sign that the input registered at all.
   */
  showCursor(x: number, y: number): void {
    this.cursor = { x, y, pressed: this.cursor?.pressed ?? false };
  }

  hideCursor(): void {
    this.cursor = null;
  }

  setCursorPressed(pressed: boolean): void {
    if (this.cursor) {
      this.cursor = { ...this.cursor, pressed };
    }
  }

  /**
   * Take the shape the engine says it would be showing.
   *
   * Two cursors come out of this: the CSS one, which is what the pointer over
   * the active pane actually shows, and the drawn one the other panes use.
   */
  setCursorShape(css: string): void {
    // Set on the pane: nothing between it and the frame sets a cursor, so the
    // image the pointer is actually over inherits it.
    this.style.cursor = SAFE_CURSOR_CSS.has(css) ? css : 'default';
    this.cursorCss = css;
  }

  /**
   * Show what this engine last rendered, rather than waiting for it to render
   * again.
   *
   * A frame's URL is otherwise only ever learnt from the event announcing it,
   * so a webview that just loaded has nothing to draw — and a settled pane
   * produces nothing further until something makes the page repaint. The pane
   * would sit empty until it was clicked, hovered, or happened to belong to an
   * engine chatty enough to send a frame unprompted.
   */
  private restoreFrame(): void {
    this.image.src = `${FRAME_ORIGIN}/${this.engine}/${FRAME_LATEST}`;
  }

  override firstUpdated(): void {
    // The picture is sized to the viewport the engines agreed on, which is only
    // renegotiated once the resizing stops. Until then the pane has already
    // taken its new shape while still holding a frame drawn for the old one —
    // clipped to a fragment of itself, or adrift in a pane it no longer fills.
    // Neither is worth showing, and the pane's own box changing is the earliest
    // anything knows.
    new ResizeObserver(() => {
      // Read from the pane itself so the number moves with the drag; the agreed
      // viewport only catches up once the resizing stops.
      const { width, height } = this.measure();
      this.dims = `${width}×${height}`;
      if (this.hasFrame) {
        this.blanks += 1;
        this.#blankedAt = performance.now();
      }
      // Whatever is on screen was drawn for the shape the pane no longer is.
      // What brings it back is a frame that fits, which is decided per frame
      // below rather than remembered here: a pane whose shape changed without
      // the agreed size moving would otherwise wait for a message that never
      // comes, and stay blank for as long as it kept streaming.
      this.hasFrame = false;
    }).observe(this.surface);

    // A frame that never loads leaves the previous one on screen, which looks
    // exactly like a frozen pane — so failures are counted, not swallowed.
    this.image.addEventListener('load', () => {
      this.loaded += 1;
      // Only the way back from blank is guarded. A pane already showing takes
      // whatever its engine sends next: the frames come from one engine at one
      // size, and testing each of them lets a single odd frame blink the pane
      // off and on through the fade.
      if (this.#askedAt > 0) {
        this.#fetches.push(performance.now() - this.#askedAt);
        this.#askedAt = 0;
      }
      const wasBlank = !this.hasFrame;
      this.hasFrame = this.hasFrame || this.showsUndistorted();
      if (wasBlank && this.hasFrame && this.#blankedAt > 0) {
        this.lastBlankMs = Math.round(performance.now() - this.#blankedAt);
        this.#blankedAt = 0;
      }
      // The decoded size is the only unarguable statement of what is on screen:
      // a sharp frame decodes at device resolution, a live one at CSS.
      this.shownDims = `${this.image.naturalWidth}x${this.image.naturalHeight}`;
    });
    this.image.addEventListener('error', () => {
      // Having rendered nothing yet is the ordinary state on a first run, not a
      // frame that went missing.
      if (this.image.src.endsWith(`/${FRAME_LATEST}`)) {
        return;
      }
      this.failed += 1;
      this.lastFailure = this.image.src.slice(-40);
    });

    this.restoreFrame();
  }

  /**
   * How long frames took to arrive since they were asked for — the fetch over
   * the frame scheme and the decode, which is where the time goes.
   *
   * Reading them clears them, so each report covers its own interval.
   */
  takeFetchTimings(): { count: number; p50: number; p95: number } {
    const sorted = [...this.#fetches].sort((a, b) => a - b);
    this.#fetches.length = 0;
    const at = (fraction: number) =>
      Math.round(sorted[Math.floor((sorted.length - 1) * fraction)] ?? 0);
    return { count: sorted.length, p50: at(0.5), p95: at(0.95) };
  }

  override render() {
    const label = ENGINE_LABELS[this.engine];
    return html`
      <header>
        <span class="title">
          ${this.renderEngineGlyph()} ${label}
          <span class="version">${this.version}</span>
        </span>
        <span class="dims">${this.dims}</span>
        <span class="meter">${this.rate}</span>
        <span class="status">${STATUS[this.status].label}</span>
      </header>
      <div class="surface">
        <img alt="${label} rendering" decoding="async">
        ${this.status === 'missing' ? this.renderInstall(label) : nothing}
        ${this.detail ? html`<p class="detail">${this.detail}</p>` : nothing}
        ${this.cursor ? this.renderCursor(this.cursor) : nothing}
      </div>
    `;
  }

  /** The engine's mark, sized and coloured by the title it sits in. */
  private renderEngineGlyph() {
    const [width, height, , , path] = ENGINE_GLYPHS[this.engine].icon;
    return html`
      <svg class="engine" viewBox="0 0 ${width} ${height}" aria-hidden="true">
        ${svg`<path d=${String(path)} />`}
      </svg>
    `;
  }

  private renderInstall(label: string) {
    return html`
      <div class="empty">
        <p>${label} has not been downloaded yet.</p>
        <button
          type="button"
          class="install"
          ?disabled=${this.installing}
          @click=${() => {
            this.setInstalling();
            this.dispatchEvent(
              new CustomEvent('devkit-install', {
                detail: this.engine,
                bubbles: true,
                composed: true,
              })
            );
          }}
        >
          ${this.installing ? 'Downloading…' : 'Download engine'}
        </button>
        ${this.progress ? html`<p class="progress">${this.progress}</p>` : nothing}
      </div>
    `;
  }

  /**
   * The host's own cursor if it could be extracted, the drawn one otherwise.
   *
   * The real image is always the better stand-in — it is what the user sees on
   * the pane they are actually over, so the panes stay comparable. The drawn
   * shapes remain for the cursors a platform does not hand out, and for the
   * moment before the first fetch returns.
   */
  private renderCursor(cursor: { x: number; y: number; pressed: boolean }) {
    const native = nativeCursor(cursorTypeFor(this.cursorCss));
    return native ? this.renderNativeCursor(native, cursor) : this.renderDrawnCursor(cursor);
  }

  private renderNativeCursor(
    native: NativeCursor,
    cursor: { x: number; y: number; pressed: boolean }
  ) {
    // The image is in device pixels and the pane in CSS pixels; drawing it at
    // its own size would double a Retina cursor.
    const width = native.width / native.scale;
    const height = native.height / native.scale;
    return html`
      <div
        class="cursor native"
        aria-hidden="true"
        data-pressed=${String(cursor.pressed)}
        style=${styleMap({
          width: `${width}px`,
          height: `${height}px`,
          backgroundImage: `url("${native.image}")`,
          backgroundSize: `${width}px ${height}px`,
          transform: `translate3d(${cursor.x - native.hotspotX / native.scale}px, ${
            cursor.y - native.hotspotY / native.scale
          }px, 0)`,
        })}
      ></div>
    `;
  }

  private renderDrawnCursor(cursor: { x: number; y: number; pressed: boolean }) {
    const shape = CURSOR_SHAPES[shapeFor(this.cursorCss)];
    const [hx, hy] = shape.hotspot;
    return html`
      <svg
        class="cursor"
        viewBox="0 0 24 24"
        width="24"
        height="24"
        aria-hidden="true"
        data-stroked=${String(shape.stroked)}
        data-pressed=${String(cursor.pressed)}
        style=${styleMap({ transform: `translate(${cursor.x - hx}px, ${cursor.y - hy}px)` })}
      >
        ${svg`<path class="halo" d=${shape.d} /><path class="shape" d=${shape.d} />`}
      </svg>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'devkit-pane': PaneComponent;
  }
  interface HTMLElementEventMap {
    'devkit-install': CustomEvent<Engine>;
  }
}
