import '../pane-navbar/pane-navbar.component.js';

import type { ColorScheme, Engine, Event, PaneStatus, Viewport } from '@devkit/protocol';
import { ENGINE_LABELS, FRAME_LATEST } from '@devkit/protocol';
import { html, nothing, svg } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import { styleMap } from 'lit/directives/style-map.js';

import { DevkitElement } from '../../utils/base.utils.js';
import type { NativeCursor } from '../../utils/cursors.utils.js';
import { cursorTypeFor, nativeCursor } from '../../utils/cursors.utils.js';
import type { Timings } from '../../utils/timing.utils.js';
import { takeTimings } from '../../utils/timing.utils.js';
import type { ViewStatus } from '../pane-navbar/pane-navbar.utils.js';
import styles from './pane.component.css';
import {
  drawnCursorFor,
  fitsViewport,
  frameRateLabel,
  frameUrl,
  hostColorScheme,
  isRunning,
  pointWithin,
  recordFrameTime,
  safeCursorCss,
  viewportSize,
} from './pane.utils.js';

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

  /**
   * The scheme this pane's page is told the user prefers.
   *
   * Seeded from the host and then the pane's own: it lives here, not in the
   * sidecar, because this element outlives the engine — a pane relaunched after
   * a crash or a sidecar restart is started again in the scheme it was in.
   */
  @state()
  private accessor scheme: ColorScheme = hostColorScheme();

  get colorScheme(): ColorScheme {
    return this.scheme;
  }

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
   * Measured against the agreed size rather than against the element. This
   * runs for every frame that decodes, and asking the element for its width
   * there forces a layout each time, on a page that is already mid-repaint —
   * which is felt as the panes stuttering while scrolling.
   */
  private showsUndistorted(): boolean {
    return fitsViewport(this.image.naturalWidth, this.image.naturalHeight, this.#viewport);
  }

  /** CSS-pixel size available for rendering, which becomes the engine's viewport. */
  measure(): { width: number; height: number } {
    return viewportSize(this.surfaceElement.getBoundingClientRect());
  }

  /**
   * Translate a window coordinate into viewport pixels, or null if it fell
   * outside the rendered frame.
   */
  toViewportPoint(clientX: number, clientY: number): { x: number; y: number } | null {
    return pointWithin(this.image.getBoundingClientRect(), clientX, clientY);
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
    // Frame rate is only meaningful while the pane is running, and a stopped
    // pane's last rate is a lie about a pane that is no longer producing any.
    if (!isRunning(state)) {
      this.#frameTimes = [];
      this.rate = '';
    }
  }

  showFrame(frame: Extract<Event, { type: 'frame' }>): void {
    this.#askedAt = performance.now();
    this.image.src = frameUrl(this.engine, frame.seq);
    // A frame arriving is itself proof the pane is running: a status event may
    // be missed, but this cannot be — the picture is here.
    this.setState(frame.sharp === true ? 'settled' : 'stream');
    this.#frameTimes = recordFrameTime(this.#frameTimes, performance.now());
    this.rate = frameRateLabel(this.#frameTimes);
  }

  /** Flip the scheme and say so, for whoever tells the engine. */
  private toggleColorScheme(): void {
    this.scheme = this.scheme === 'dark' ? 'light' : 'dark';
    this.dispatchEvent(
      new CustomEvent('devkit-color-scheme', {
        detail: { engine: this.engine, scheme: this.scheme },
        bubbles: true,
        composed: true,
      })
    );
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
    this.style.cursor = safeCursorCss(css);
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
    this.image.src = frameUrl(this.engine, FRAME_LATEST);
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
  takeFetchTimings(): Timings {
    return takeTimings(this.#fetches);
  }

  override render() {
    const label = ENGINE_LABELS[this.engine];
    return html`
      <devkit-pane-navbar
        .engine=${this.engine}
        .version=${this.version}
        .dims=${this.dims}
        .rate=${this.rate}
        .status=${this.status}
        .colorScheme=${this.scheme}
        ?active=${this.active}
        ?solo=${this.solo}
        @devkit-color-scheme=${(event: CustomEvent) => {
          // The header's event is a click; the one that leaves the pane names
          // the engine and the scheme, and only that one goes further.
          event.stopPropagation();
          this.toggleColorScheme();
        }}
      ></devkit-pane-navbar>
      <div class="surface">
        <img alt="${label} rendering" decoding="async">
        ${this.status === 'missing' ? this.renderInstall(label) : nothing}
        ${this.detail ? html`<p class="detail">${this.detail}</p>` : nothing}
        ${this.cursor ? this.renderCursor(this.cursor) : nothing}
      </div>
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
    const shape = drawnCursorFor(this.cursorCss);
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
    'devkit-color-scheme': CustomEvent<{ engine: Engine; scheme: ColorScheme }>;
  }
}
