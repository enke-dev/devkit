import type { SplitDirection } from '../../utils/layout.utils.js';

/** What clicking the split toggle will do, which is what it should say. */
export function splitLabel(split: SplitDirection): string {
  return split === 'vertical' ? 'Stack the panes' : 'Set the panes side by side';
}
