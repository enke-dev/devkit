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

/**
 * How deep the drawer is, kept across restarts.
 *
 * Only the drawer. The panes always share their space evenly, because they
 * share one viewport as well: every engine renders at the smallest pane's
 * size, so making one pane bigger would not give that engine more page — it
 * would shrink the viewport all three render at and leave the enlarged pane
 * holding a smaller picture. The even split is the only one where the space a
 * pane has and the page it shows are the same thing.
 */

const INSPECTOR_SIZE_KEY = 'devkit.inspectorSize';

/**
 * How little of the window the panes may be squeezed into.
 *
 * The bound on how far the drawer can be dragged, not a size anything is set
 * to: the panes are the point of the app, and a drawer that can cover them
 * entirely is a drawer that can lose them.
 */
export const MIN_PANE = 140;

/** Smallest the drawer may be dragged to, in CSS pixels. */
export const MIN_INSPECTOR = 120;

/**
 * What a placement opens at.
 *
 * A side drawer is read in columns of text and a bottom one in rows of them,
 * so they do not want the same measurement — which is also why moving the
 * drawer resets its size rather than carrying a height over into a width.
 */
export function defaultInspectorSize(dock: InspectorDock): number {
  return dock === 'bottom' ? 280 : 380;
}

export function storedInspectorSize(dock: InspectorDock): number {
  try {
    const stored = Number(localStorage.getItem(INSPECTOR_SIZE_KEY));
    return Number.isFinite(stored) && stored >= MIN_INSPECTOR ? stored : defaultInspectorSize(dock);
  } catch {
    return defaultInspectorSize(dock);
  }
}

export function storeInspectorSize(size: number): void {
  try {
    localStorage.setItem(INSPECTOR_SIZE_KEY, String(Math.round(size)));
  } catch {
    // A blocked store costs the preference, not the layout.
  }
}

/**
 * How tall the tree is inside the Elements panel, kept across restarts.
 *
 * Null until somebody drags it, which is not the same as a number: an untouched
 * split takes its share of whatever height the drawer has, and a remembered one
 * is a measurement. Seeding it with a number instead would fix the tree at a
 * bottom drawer's height the first time the inspector was ever opened at the
 * side.
 */
const TREE_SIZE_KEY = 'devkit.treeSize';

/**
 * How little either half of the Elements panel may be squeezed to.
 *
 * Enough rows to still be a tree, and enough of the table below to still be a
 * comparison. The bound on the drag rather than a size anything is set to.
 */
export const MIN_TREE = 120;
export const MIN_DETAILS = 120;

export function storedTreeSize(): number | null {
  try {
    const stored = localStorage.getItem(TREE_SIZE_KEY);
    const size = Number(stored);
    return stored !== null && Number.isFinite(size) && size >= MIN_TREE ? size : null;
  } catch {
    return null;
  }
}

export function storeTreeSize(size: number): void {
  try {
    localStorage.setItem(TREE_SIZE_KEY, String(Math.round(size)));
  } catch {
    // A blocked store costs the preference, not the layout.
  }
}
