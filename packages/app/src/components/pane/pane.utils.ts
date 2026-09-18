import type { ColorScheme, Engine, Viewport } from '@devkit/protocol';
import { FRAME_SCHEME } from '@devkit/protocol';

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

export type CursorShape = (typeof CURSOR_SHAPES)[keyof typeof CURSOR_SHAPES];

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

/**
 * Tauri exposes custom schemes differently per platform, matching the shape its
 * own `convertFileSrc` produces.
 */
const FRAME_ORIGIN = navigator.userAgent.includes('Windows')
  ? `http://${FRAME_SCHEME}.localhost`
  : `${FRAME_SCHEME}://localhost`;

/** How long the frame-rate meter averages over. */
const METER_WINDOW_MS = 2000;

/** A gap longer than this ends a burst: the next frame starts the average afresh. */
const BURST_GAP_MS = 400;

/** The smallest viewport an engine is asked to render. */
const MIN_VIEWPORT = { width: 320, height: 240 };

/** Which drawn shape stands in for a CSS cursor keyword. */
export function drawnCursorFor(css: string): CursorShape {
  if (css === 'pointer' || css === 'grab' || css === 'grabbing') {
    return CURSOR_SHAPES.hand;
  }
  if (css === 'text' || css === 'vertical-text') {
    return CURSOR_SHAPES.beam;
  }
  return CURSOR_SHAPES.arrow;
}

/** The cursor keyword as the app may apply it, or `default` for anything unknown. */
export function safeCursorCss(css: string): string {
  return SAFE_CURSOR_CSS.has(css) ? css : 'default';
}

/**
 * Where a frame's bytes are fetched from. The sequence number only makes the
 * URL unique; the backend always answers with this engine's newest frame.
 */
export function frameUrl(engine: Engine, seq: number | string): string {
  return `${FRAME_ORIGIN}/${engine}/${seq}`;
}

/**
 * The scheme the host machine is set to, which is where a pane starts.
 *
 * Read once at start rather than followed: Playwright would otherwise render
 * every page light regardless, and the host's setting is the least surprising
 * thing to seed a pane with. From there each pane is switched on its own.
 */
export function hostColorScheme(): ColorScheme {
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * Whether a decoded frame fits the box it is being drawn in.
 *
 * Compared as a shape rather than as a size: a frame may legitimately arrive at
 * either resolution — live frames at CSS, settled captures at device — and an
 * engine may miss the requested size by a pixel. Neither looks wrong. Only a
 * different shape does. With nothing agreed yet there is no shape to be wrong
 * about.
 */
export function fitsViewport(
  naturalWidth: number,
  naturalHeight: number,
  viewport: Viewport | null
): boolean {
  if (naturalWidth === 0 || naturalHeight === 0) {
    return false;
  }
  if (viewport === null) {
    return true;
  }
  return Math.abs(naturalWidth / naturalHeight - viewport.width / viewport.height) < 0.01;
}

/** CSS-pixel size available for rendering, which becomes the engine's viewport. */
export function viewportSize(rect: DOMRectReadOnly): { width: number; height: number } {
  return {
    width: Math.max(MIN_VIEWPORT.width, Math.round(rect.width)),
    height: Math.max(MIN_VIEWPORT.height, Math.round(rect.height)),
  };
}

/**
 * Translate a window coordinate into pixels of the given box, or null if it
 * fell outside.
 */
export function pointWithin(
  rect: DOMRectReadOnly,
  clientX: number,
  clientY: number
): { x: number; y: number } | null {
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
 * Add a frame's arrival to the meter.
 *
 * Kept to the burst being shown, not the last two seconds: a pane that settles
 * and streams again starts a new burst, and averaging across the quiet in
 * between made a pane appear to start at 2fps and climb.
 */
export function recordFrameTime(times: number[], now: number): number[] {
  const previous = times[times.length - 1];
  const burst = previous !== undefined && now - previous > BURST_GAP_MS ? [] : times;
  return [...burst, now].filter(time => now - time < METER_WINDOW_MS);
}

/** What a running pane that is delivering no frames reads: the truth, not a placeholder. */
export const IDLE_RATE = '0 fps';

/**
 * The meter's reading. A burst of one frame has no rate yet and reads as zero,
 * the same as a pane that has stopped: the meter is always a number, so it
 * never blinks in and out as the pane moves and settles.
 */
export function frameRateLabel(times: number[]): string {
  const now = times[times.length - 1];
  if (now === undefined) {
    return IDLE_RATE;
  }
  const span = now - (times[0] ?? now);
  const fps = span > 0 ? ((times.length - 1) / span) * 1000 : 0;
  return `${fps.toFixed(0)} fps`;
}
