import type { ColorScheme, Engine, SessionId, SessionSlot, Viewport } from '@devkit/protocol';
import { DEFAULT_SESSION, MAX_SESSIONS } from '@devkit/protocol';

import type { Pane } from './pane.js';

/**
 * One comparison, and everything the sidecar holds for it.
 *
 * A session is one window: three engines showing one URL at one size. The
 * sidecar used to hold exactly one of each of these as a module-level variable,
 * which is the same thing said in a way that cannot have a second — two windows
 * would have shared one set of panes, one viewport and one cursor sample.
 *
 * Nothing here is shared between sessions on purpose. The browsers are not:
 * a pane is a browser, and two windows looking at two pages need two of them.
 * Neither is the viewport, which is what the window was resized to, nor the
 * colour scheme, which is a per-pane choice within a window.
 *
 * What stays process-wide is what describes the process — the installed
 * browsers, a download in progress — and the headed windows opened by
 * `detach`, which are handed to the user outright and belong to them rather
 * than to the comparison they were opened from.
 */
export interface Session {
  readonly id: SessionId;
  /** How the frame headers name this session; assigned by whoever drives us. */
  readonly slot: SessionSlot;
  readonly panes: Map<Engine, Pane>;
  viewport: Viewport;
  colorScheme: ColorScheme;
  /**
   * The cursor each pane last reported, so it is only sent when it changes.
   *
   * Per session because the pointer is: it is over one window's pane, and what
   * another window's Chromium last showed says nothing about it.
   */
  readonly lastCursorCss: Map<Engine, string>;
  cursorSampleAt: number;
  cursorTrailing: NodeJS.Timeout | null;
}

const sessions = new Map<SessionId, Session>();

/** The viewport a session starts with, until its window says what it really is. */
const INITIAL_VIEWPORT: Viewport = { width: 1280, height: 800, scale: 1 };

/**
 * The smallest slot nobody is using.
 *
 * Only reached when whoever is driving did not say — the `verify:*` scripts,
 * which are their own host. The backend hands out slots itself, because it is
 * the side that has to map a frame header back to a window.
 */
function freeSlot(): SessionSlot {
  const taken = new Set([...sessions.values()].map(session => session.slot));
  const slot = [...Array(MAX_SESSIONS).keys()].find(candidate => !taken.has(candidate));
  if (slot === undefined) {
    throw new Error(`no free session slot; ${MAX_SESSIONS} comparisons are already open`);
  }
  return slot;
}

/**
 * The session a command is addressed to, made if this is the first word of it.
 *
 * Created on demand rather than opened explicitly: every command that matters
 * to a window that has none yet is a command that would have had to open one,
 * and a handshake that can be forgotten is a window that silently does nothing.
 */
export function sessionFor(id: SessionId = DEFAULT_SESSION, slot?: SessionSlot): Session {
  const existing = sessions.get(id);
  if (existing) {
    return existing;
  }

  const session: Session = {
    id,
    slot: slot ?? freeSlot(),
    panes: new Map(),
    viewport: INITIAL_VIEWPORT,
    colorScheme: 'light',
    lastCursorCss: new Map(),
    cursorSampleAt: 0,
    cursorTrailing: null,
  };
  sessions.set(id, session);
  return session;
}

/** Every session, for the things that are done to all of them at once. */
export function allSessions(): Session[] {
  return [...sessions.values()];
}

/** Every pane in the process, for the heartbeat and for shutting down. */
export function allPanes(): Pane[] {
  return allSessions().flatMap(session => [...session.panes.values()]);
}

/**
 * Close a session's panes and forget it.
 *
 * Its browsers go with it. A window that has been closed has nothing to show
 * three headless browsers to, and they would otherwise sit there rendering for
 * nobody until the app exits.
 */
export async function closeSession(id: SessionId): Promise<void> {
  const session = sessions.get(id);
  if (!session) {
    return;
  }
  sessions.delete(id);
  if (session.cursorTrailing) {
    clearTimeout(session.cursorTrailing);
  }
  const closing = [...session.panes.values()].map(pane => pane.close());
  session.panes.clear();
  await Promise.allSettled(closing);
}

/** Close everything, on the way out. */
export async function closeAllSessions(): Promise<void> {
  await Promise.allSettled([...sessions.keys()].map(closeSession));
}
