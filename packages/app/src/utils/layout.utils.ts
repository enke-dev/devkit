/**
 * How the panes are arranged, kept across restarts.
 *
 * Named after the divider the toolbar icon draws rather than after the axis the
 * panes run along: a horizontal split puts them side by side, a vertical one
 * stacks them. It says nothing about how many there are — the layout holds for
 * two panes or for however many engines a user later chooses to compare.
 */

export type SplitDirection = 'horizontal' | 'vertical';

const KEY = 'devkit.split';

/** Side by side: the comparison most pages want, being taller than they are wide. */
const FALLBACK: SplitDirection = 'horizontal';

export function storedSplit(): SplitDirection {
  try {
    const stored = localStorage.getItem(KEY);
    return stored === 'horizontal' || stored === 'vertical' ? stored : FALLBACK;
  } catch {
    return FALLBACK;
  }
}

export function storeSplit(split: SplitDirection): void {
  try {
    localStorage.setItem(KEY, split);
  } catch {
    // A blocked store costs the preference, not the layout.
  }
}
