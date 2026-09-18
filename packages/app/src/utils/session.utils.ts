/**
 * The trail the back and forward arrows walk, kept across restarts.
 *
 * Owned here rather than by the engines. Playwright can navigate a page back and
 * forward but will not say whether there is anywhere to go, the three panes move
 * in lockstep so there is one shared position rather than three, and — the part
 * that settles it — a freshly launched engine has no history at all. A trail
 * restored from disk would otherwise light up arrows that do nothing.
 *
 * So stepping back is a navigation to the URL that was there before, not a
 * `goBack()`. The cost is what a real back button gives you inside one session:
 * the page is fetched again rather than restored, so scroll position and form
 * state are lost. For a tool whose point is comparing a render across engines,
 * a predictable re-render is the better trade.
 *
 * This is not the same thing as [`history.utils.ts`](./history.utils.ts), which
 * answers "where have I been" for the address bar. This answers "where does back
 * go".
 */

const KEY = 'devkit.session';

/** Long enough to walk back through an afternoon, short enough to write often. */
const LIMIT = 200;

interface Trail {
  entries: string[];
  index: number;
}

function read(): Trail {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !Array.isArray((parsed as Trail).entries) ||
      typeof (parsed as Trail).index !== 'number'
    ) {
      return { entries: [], index: -1 };
    }
    const entries = (parsed as Trail).entries.filter(entry => typeof entry === 'string');
    // A stored index that no longer fits its list would strand the arrows.
    const index = Math.min(Math.max((parsed as Trail).index, -1), entries.length - 1);
    return { entries, index };
  } catch {
    return { entries: [], index: -1 };
  }
}

const trail = read();

function write(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(trail));
  } catch {
    // A full or blocked store costs the trail, not the navigation.
  }
}

export function canGoBack(): boolean {
  return trail.index > 0;
}

export function canGoForward(): boolean {
  return trail.index >= 0 && trail.index < trail.entries.length - 1;
}

/** Where the trail currently stands, which is where a restart resumes. */
export function current(): string | undefined {
  return trail.entries[trail.index];
}

/**
 * Record arriving somewhere, however it happened: the address bar, a link
 * clicked inside a pane, a redirect.
 *
 * Going somewhere new from the middle of the trail drops everything ahead of it,
 * the way a browser does — the forward trail is only true until you take a
 * different turn.
 */
export function visited(url: string): void {
  if (url === trail.entries[trail.index]) {
    return;
  }
  // Arriving where back or forward was taking us *is* that move; the caller has
  // already stepped the index.
  trail.entries.splice(trail.index + 1);
  trail.entries.push(url);
  if (trail.entries.length > LIMIT) {
    trail.entries.splice(0, trail.entries.length - LIMIT);
  }
  trail.index = trail.entries.length - 1;
  write();
}

/** Step back, returning where to go, or nothing if there is nowhere. */
export function back(): string | undefined {
  if (!canGoBack()) {
    return undefined;
  }
  trail.index -= 1;
  write();
  return trail.entries[trail.index];
}

/** Step forward, returning where to go, or nothing if there is nowhere. */
export function forward(): string | undefined {
  if (!canGoForward()) {
    return undefined;
  }
  trail.index += 1;
  write();
  return trail.entries[trail.index];
}
