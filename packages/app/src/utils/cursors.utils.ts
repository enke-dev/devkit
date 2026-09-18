import { invoke } from '@tauri-apps/api/core';

/**
 * The host's cursor images, fetched once and kept as data URLs.
 *
 * Drawing a stand-in cursor means drawing the one the user would see if they
 * were really over that page — their theme, their size, not an approximation of
 * it. The webview cannot read any of that, so the backend extracts the images
 * and they are cached here.
 *
 * Fetching is done up front, not on demand: a cursor that arrives after the
 * pointer has already moved on is a cursor that visibly pops in, and the whole
 * point of the overlay is immediate feedback.
 */

/** The shapes the backend knows how to extract, named the way CSS names them. */
export type CursorType = 'default' | 'text' | 'hand' | 'wait' | 'crosshair';

export interface NativeCursor {
  /** `data:image/png;base64,…` */
  image: string;
  /** Where in the image the pointed-at pixel sits, in image pixels. */
  hotspotX: number;
  hotspotY: number;
  /** Size of the image, in image pixels. */
  width: number;
  height: number;
  /** Image pixels per CSS pixel — 2 for a Retina cursor. */
  scale: number;
}

/** Everything `cursorTypeFor` can name, so no lookup ever misses. */
const PRELOAD: CursorType[] = ['default', 'text', 'hand', 'wait', 'crosshair'];

/**
 * `null` records a cursor the platform does not have — macOS has no public wait
 * cursor, for one — so a miss is remembered rather than retried on every move.
 */
const cache = new Map<CursorType, NativeCursor | null>();

/** Which extracted cursor stands in for a CSS cursor keyword. */
export function cursorTypeFor(css: string): CursorType {
  if (css === 'pointer' || css === 'grab' || css === 'grabbing') {
    return 'hand';
  }
  if (css === 'text' || css === 'vertical-text') {
    return 'text';
  }
  if (css === 'wait' || css === 'progress') {
    return 'wait';
  }
  if (css === 'crosshair' || css === 'cell') {
    return 'crosshair';
  }
  return 'default';
}

export async function preloadCursors(types: CursorType[] = PRELOAD): Promise<void> {
  await Promise.all(
    types.map(async type => {
      if (cache.has(type)) {
        return;
      }
      try {
        const cursor = await invoke<NativeCursor>('get_native_cursor_by_type', {
          cursorType: type,
        });
        cache.set(type, cursor);
      } catch {
        // Not having a cursor is not a failure: the caller draws its own.
        cache.set(type, null);
      }
    })
  );
}

/** The cached cursor, or `null` if it was never fetched or does not exist. */
export function nativeCursor(type: CursorType): NativeCursor | null {
  return cache.get(type) ?? null;
}
