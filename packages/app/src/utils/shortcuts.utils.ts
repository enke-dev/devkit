/**
 * The keyboard shortcuts a browser is expected to have.
 *
 * Kept as a table so the list reads as a list. The bindings are not the same on
 * every platform, and not only in which modifier key is used:
 *
 * - macOS navigates history with Cmd and the arrows (or Cmd-[ and Cmd-]).
 * - Windows and Linux use **Alt** and the arrows. Ctrl-Left there moves the
 *   caret by word, so claiming it would take a key the page should get.
 * - Meta on Windows and Linux is the Super key, which belongs to the desktop.
 *   Matching it, as this used to, meant answering to Super-L — the lock screen.
 *
 * So "the primary modifier" is Cmd on Apple platforms and Ctrl everywhere else,
 * and a shortcut may bind differently per platform.
 */

/** Cmd on Apple platforms, Ctrl everywhere else. */
const APPLE = /mac|iphone|ipad/i.test(navigator.userAgent);

interface Binding {
  /** Lower-case `event.key`, or the key as written for named keys. */
  key: string;
  /** Cmd on Apple, Ctrl elsewhere. */
  primary?: boolean;
  alt?: boolean;
  shift?: boolean;
  /** Bind only on this kind of platform; both when omitted. */
  only?: 'apple' | 'other';
}

interface Shortcut {
  bindings: Binding[];
  /** What it is for, in the words a menu would use. */
  describes: string;
}

export const SHORTCUTS = {
  focusAddress: {
    bindings: [
      { key: 'l', primary: true },
      // The Windows convention, alongside Ctrl-L.
      { key: 'd', alt: true, only: 'other' },
    ],
    describes: 'Focus the address bar',
  },
  reload: {
    bindings: [
      { key: 'r', primary: true },
      { key: 'f5', only: 'other' },
    ],
    describes: 'Reload every pane',
  },
  hardReload: {
    // The panes have no cache to bypass — a context is created per session — so
    // this is a reload. It is bound because the fingers expect it.
    bindings: [
      { key: 'r', primary: true, shift: true },
      { key: 'f5', shift: true, only: 'other' },
    ],
    describes: 'Reload every pane',
  },
  back: {
    bindings: [
      { key: 'arrowleft', primary: true, only: 'apple' },
      { key: '[', primary: true, only: 'apple' },
      { key: 'arrowleft', alt: true, only: 'other' },
    ],
    describes: 'Back',
  },
  forward: {
    bindings: [
      { key: 'arrowright', primary: true, only: 'apple' },
      { key: ']', primary: true, only: 'apple' },
      { key: 'arrowright', alt: true, only: 'other' },
    ],
    describes: 'Forward',
  },
} as const satisfies Record<string, Shortcut>;

export type ShortcutName = keyof typeof SHORTCUTS;

function matches(event: KeyboardEvent, binding: Binding): boolean {
  if (binding.only === 'apple' && !APPLE) {
    return false;
  }
  if (binding.only === 'other' && APPLE) {
    return false;
  }
  if (event.key.toLowerCase() !== binding.key) {
    return false;
  }

  // Every modifier is checked, including the ones a binding does not want:
  // Cmd-Shift-R must not answer to Cmd-R's binding.
  const primary = APPLE ? event.metaKey : event.ctrlKey;
  // The other one is the desktop's business — Super on Windows and Linux, and
  // Control on macOS, where it belongs to the terminal conventions.
  const foreign = APPLE ? event.ctrlKey : event.metaKey;

  return (
    primary === (binding.primary ?? false) &&
    !foreign &&
    event.altKey === (binding.alt ?? false) &&
    event.shiftKey === (binding.shift ?? false)
  );
}

/** Which shortcut an event is, if any. */
export function match(event: KeyboardEvent): ShortcutName | null {
  const name = (Object.keys(SHORTCUTS) as ShortcutName[]).find(candidate =>
    SHORTCUTS[candidate].bindings.some(binding => matches(event, binding))
  );
  return name ?? null;
}

/**
 * Keys a pane must never swallow, because they belong to the app or the
 * desktop rather than the page being previewed.
 */
export function isAppShortcut(event: KeyboardEvent): boolean {
  if (match(event) !== null) {
    return true;
  }
  // Quit and close-window never reach us as shortcuts, but a page should not
  // see them on their way past either.
  const primary = APPLE ? event.metaKey : event.ctrlKey;
  return primary && ['q', 'w'].includes(event.key.toLowerCase());
}
