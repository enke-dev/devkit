import type { SessionId } from '@devkit/protocol';
import { getCurrentWindow } from '@tauri-apps/api/window';

/**
 * Which comparison this webview is.
 *
 * The window's own Tauri label, which the backend also stamps on every command
 * this window sends — so the two sides agree on the name without either having
 * to tell the other what it is.
 *
 * Read once. A window's label does not change, and a reload lands in the same
 * window with the same one, which is what lets a frontend that has just booted
 * ask for its own frames and find its own trail.
 *
 * Not the same thing as [`session.utils.ts`](./session.utils.ts): that is the
 * trail the back and forward arrows walk *within* a session. This is which
 * session it is.
 */
let cached: SessionId | null = null;

export function sessionId(): SessionId {
  cached ??= getCurrentWindow().label;
  return cached;
}

/**
 * A storage key belonging to this session alone.
 *
 * `localStorage` is shared by origin, so every window of the app sees one
 * store. What belongs to a comparison — where its back button goes — has to say
 * which comparison, or two windows would walk each other's trail. What belongs
 * to the person using the app — the address bar's memory, how wide they like
 * the drawer — deliberately does not, and stays under its bare key.
 */
export function sessionKey(key: string): string {
  return `${key}.${sessionId()}`;
}
