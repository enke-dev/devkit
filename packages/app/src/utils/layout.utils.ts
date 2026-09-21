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

/** The split the panes are not in, which is the one a toggle asks for. */
export function oppositeSplit(split: SplitDirection): SplitDirection {
  return split === 'horizontal' ? 'vertical' : 'horizontal';
}

export function storeSplit(split: SplitDirection): void {
  try {
    localStorage.setItem(KEY, split);
  } catch {
    // A blocked store costs the preference, not the layout.
  }
}

/**
 * Which edge the introspection drawer is attached to.
 *
 * Worth a choice for the same reason the developer tools everyone already
 * knows offer one: the drawer and the panes compete for the same screen, and
 * which way to give ground depends on the page. A tall page wants the drawer at
 * the side; a wide one, or three panes stacked, wants it along the bottom.
 */
export type InspectorDock = 'detached' | 'left' | 'bottom' | 'right';

const DOCK_KEY = 'devkit.inspectorDock';

/**
 * Along the bottom by default: the panes are side by side by default too, and
 * taking a column from three of them at once costs more than taking a row.
 */
const DOCK_FALLBACK: InspectorDock = 'bottom';

/**
 * The placements, in the order they are offered.
 *
 * Undocked first and then inwards, which is the order the developer tools
 * everyone already knows put them in — there is nothing to be gained by
 * inventing a different one for the same three choices.
 */
export const INSPECTOR_DOCKS: InspectorDock[] = ['detached', 'left', 'bottom', 'right'];

export function storedDock(): InspectorDock {
  try {
    const stored = localStorage.getItem(DOCK_KEY);
    return INSPECTOR_DOCKS.find(dock => dock === stored) ?? DOCK_FALLBACK;
  } catch {
    return DOCK_FALLBACK;
  }
}

export function storeDock(dock: InspectorDock): void {
  try {
    localStorage.setItem(DOCK_KEY, dock);
  } catch {
    // A blocked store costs the preference, not the layout.
  }
}
