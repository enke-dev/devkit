/**
 * Visited pages, kept across sessions.
 *
 * This is the app's own record of where you have been, not any engine's. The
 * panes' contexts are deliberately ephemeral — no cookies, no cache, no history
 * survives a session — so nothing inside them can answer "what did I look at
 * yesterday". Keeping it here also means one history for all three panes, which
 * matches how they navigate: in lockstep.
 *
 * Stored in `localStorage` because it belongs to the window, is small, and is
 * worth nothing to anyone else. It can throw or come back empty (private
 * windows, blocked site data), so every read is defensive and an unreadable
 * history is an empty one rather than a failure.
 */

export interface Visit {
  url: string;
  title: string;
  /** How often this URL has been opened, which is most of what ranks it. */
  visits: number;
  /** When it was last opened. */
  at: number;
}

const KEY = 'devkit.history';

/** Enough to be useful, small enough to read and write on every navigation. */
const LIMIT = 500;

/**
 * A repeat visit within this window is the same visit.
 *
 * All three panes navigate together and all three report it, so without this a
 * single navigation would count three times.
 */
const SAME_VISIT_MS = 3000;

function read(): Visit[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) {
      return [];
    }
    // Written by us, but a stored shape can outlive the code that wrote it.
    return parsed.filter(
      (entry): entry is Visit =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as Visit).url === 'string' &&
        typeof (entry as Visit).at === 'number'
    );
  } catch {
    return [];
  }
}

function write(entries: Visit[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries.slice(0, LIMIT)));
  } catch {
    // A full or blocked store costs the history, not the navigation.
  }
}

/** Newest first. */
export function all(): Visit[] {
  return [...read()].sort((a, b) => b.at - a.at);
}

/** The page to open on a cold start. */
export function mostRecent(): Visit | undefined {
  return all()[0];
}

/**
 * Record a visit, or refresh the one already there.
 *
 * The title arrives after the URL — a page is navigated to before it is
 * loaded — so an empty title never overwrites a known one.
 */
export function record(url: string, title: string): void {
  const entries = read();
  const existing = entries.find(entry => entry.url === url);
  const now = Date.now();

  if (existing) {
    const repeat = now - existing.at > SAME_VISIT_MS;
    existing.visits += repeat ? 1 : 0;
    existing.at = now;
    if (title) {
      existing.title = title;
    }
    write(entries);
    return;
  }

  write([{ url, title, visits: 1, at: now }, ...entries]);
}

/**
 * Score a candidate against what has been typed.
 *
 * Ranked by where the match is rather than only by how often a page was
 * visited: typing "git" should offer github.com before a page visited more
 * often that merely mentions git in its title. Returns 0 for no match.
 */
function score(entry: Visit, query: string): number {
  const url = entry.url.toLowerCase();
  const title = entry.title.toLowerCase();
  // What the address bar shows without its scheme, which is what people type.
  const bare = url.replace(/^https?:\/\/(www\.)?/, '');

  if (bare.startsWith(query)) {
    return 100;
  }
  if (url.startsWith(query)) {
    return 90;
  }
  if (bare.includes(query)) {
    return 50;
  }
  if (title.startsWith(query)) {
    return 40;
  }
  if (title.includes(query)) {
    return 20;
  }
  return 0;
}

/** Best matches for what is being typed, most useful first. */
export function suggest(input: string, limit: number): Visit[] {
  const query = input.trim().toLowerCase();
  if (query.length === 0) {
    return [];
  }

  return all()
    .map(entry => ({ entry, score: score(entry, query) }))
    .filter(match => match.score > 0)
    .sort((a, b) => b.score - a.score || b.entry.visits - a.entry.visits || b.entry.at - a.entry.at)
    .slice(0, limit)
    .map(match => match.entry);
}
