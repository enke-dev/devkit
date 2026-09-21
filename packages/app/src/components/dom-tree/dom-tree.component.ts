import '../icon-button/icon-button.component.js';
import '../tabs/tabs.component.js';
import '@phosphor-icons/webcomponents/PhCaretDown';
import '@phosphor-icons/webcomponents/PhCaretRight';
import '@phosphor-icons/webcomponents/PhMagnifyingGlass';

import type { DomNode, Engine } from '@devkit/protocol';
import { ENGINE_LABELS } from '@devkit/protocol';
import { html, nothing } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

import { ariaBoolean } from '../../utils/aria.utils.js';
import { DevkitElement } from '../../utils/base.utils.js';
import type { DomRow, DomTree } from '../../utils/dom.utils.js';
import { labelOf, rowIndexOf, rowsOf } from '../../utils/dom.utils.js';
import type { TabDefinition } from '../tabs/tabs.component.js';
import styles from './dom-tree.component.css';

/**
 * How tall a row is, in pixels.
 *
 * Fixed, and stated here rather than left to the content, because the list is
 * windowed: knowing where row nine thousand starts without having drawn the
 * eight thousand above it is the whole trick, and it only works if every row is
 * the same height. The stylesheet is told this number rather than deciding it.
 */
const ROW_HEIGHT = 20;

/**
 * How many rows are drawn beyond the ones in view.
 *
 * Enough that a flick of the wheel does not outrun the re-render, few enough
 * that the window stays a window. Below about four the top edge shows blank
 * rows during a fast scroll.
 */
const OVERSCAN = 8;

/**
 * One engine's DOM, as a tree that can be walked.
 *
 * Windowed rather than rendered whole. A real page is tens of thousands of
 * nodes and a great many of them are inside something already open, so the
 * honest version of this component — nested elements, one per node — spends its
 * time laying out rows nobody has scrolled to. Here the tree is flattened to a
 * list of the rows that are actually visible, the scroller is given a spacer
 * the height of the whole list, and only the slice under the viewport exists.
 *
 * One engine at a time, chosen here. Three trees side by side would be the
 * obvious thing and is unreadable past the second level; what the engines
 * disagree about is shown underneath, in the table that already does it, for
 * whichever element this tree has selected.
 *
 * Nothing here talks to the sidecar. Rows report what was clicked and are
 * handed a tree, the way every other component in the app works.
 */
@customElement('devkit-dom-tree')
export class DomTreeComponent extends DevkitElement.withStyles(styles) {
  @property({ attribute: false })
  accessor tree!: DomTree;

  /** The engines with a pane running, so the picker offers only real choices. */
  @property({ attribute: false })
  accessor engines: Engine[] = [];

  /** Whether a search is outstanding, which is the only thing worth saying about one. */
  @property({ type: Boolean })
  accessor searching = false;

  /** How many nodes the last search matched, or null when nothing was searched. */
  @property({ attribute: false })
  accessor matchCount: number | null = null;

  /** How far down the scroller is, which decides which rows exist. */
  @state() private accessor scrolled = 0;

  /** How tall the scroller is, which decides how many of them there are. */
  @state() private accessor viewport = 0;

  @query('.scroller')
  private accessor scroller!: HTMLElement;

  #observer: ResizeObserver | null = null;

  /** The last selection scrolled to, so a redraw does not keep chasing it. */
  #followed: string | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    // The window is measured rather than assumed: the drawer is resizable on
    // three of its four docks, and a height taken once would keep drawing the
    // number of rows that fitted when the inspector opened.
    this.#observer = new ResizeObserver(entries => {
      const height = entries[0]?.contentRect.height ?? 0;
      if (height !== this.viewport) {
        this.viewport = height;
      }
    });
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.#observer?.disconnect();
    this.#observer = null;
  }

  override firstUpdated(): void {
    if (this.scroller) {
      this.#observer?.observe(this.scroller);
      this.viewport = this.scroller.clientHeight;
    }
  }

  override updated(): void {
    this.followSelection();
  }

  private emit(name: string, detail?: unknown): void {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }

  private get rows(): DomRow[] {
    return rowsOf(this.tree);
  }

  /**
   * Bring the selected row into view, once per selection.
   *
   * Only when it is off screen, and only when the selection actually changed:
   * scrolling on every render would fight anybody reading the tree around a
   * node they had already found.
   */
  private followSelection(): void {
    const selected = this.tree.selectedId;
    const scroller = this.scroller;
    if (!scroller || selected === null || selected === this.#followed) {
      return;
    }
    const at = rowIndexOf(this.rows, selected);
    if (at === -1) {
      // Its ancestors are still arriving; the next update will find it.
      return;
    }

    // Measured from the element, not from what was remembered of it. Both the
    // scroll position and the height available change without this component
    // rendering — a dragged split, a resized drawer, a scroll still settling —
    // and the remembered pair is only as fresh as the last event that happened
    // to update it. Deciding from a stale height is deciding not to scroll, and
    // because the decision is latched below it is never revisited.
    const height = scroller.clientHeight;
    if (height === 0) {
      // Nothing is laid out yet, so there is no telling what is in view. Left
      // unlatched on purpose: the next update measures again.
      return;
    }

    this.#followed = selected;
    const top = at * ROW_HEIGHT;
    if (top < scroller.scrollTop || top + ROW_HEIGHT > scroller.scrollTop + height) {
      scroller.scrollTop = Math.max(0, top - height / 2);
    }
  }

  /**
   * Move the selection with the arrow keys, the way a tree is expected to.
   *
   * Left and right open and close before they move, which is what makes a
   * keyboard walk of a deep tree possible at all: right on a closed row opens
   * it, right again steps into it.
   */
  private handleKey(event: KeyboardEvent): void {
    const rows = this.rows;
    const at = rowIndexOf(rows, this.tree.selectedId);
    const row = at === -1 ? undefined : rows[at];

    /**
     * Move to the next selectable row in that direction.
     *
     * Generated content is skipped over rather than stopped at: it has no node
     * to select, and a row the arrow keys got stuck on would make a keyboard
     * walk of the tree impossible past the first element with a `::before`.
     */
    const step = (from: number, by: number): void => {
      if (from < 0) {
        return;
      }
      const next =
        by > 0
          ? rows.slice(from).find(candidate => !candidate.pseudo)
          : rows.slice(0, from + 1).findLast(candidate => !candidate.pseudo);
      if (next) {
        event.preventDefault();
        this.emit('devkit-dom-select', next.key);
      }
    };

    switch (event.key) {
      case 'ArrowDown':
        step(at + 1, 1);
        return;
      case 'ArrowUp':
        step(at - 1, -1);
        return;
      case 'ArrowRight':
        if (row?.openable && !row.expanded) {
          event.preventDefault();
          this.emit('devkit-dom-toggle', { nodeId: row.key, open: true });
          return;
        }
        step(at + 1, 1);
        return;
      case 'ArrowLeft':
        if (row?.expanded) {
          event.preventDefault();
          this.emit('devkit-dom-toggle', { nodeId: row.key, open: false });
          return;
        }
        // Not open, so the move that means "out" is to the parent.
        step(
          rows.findIndex(candidate => candidate.key === this.parentKeyOf(rows, at)),
          1
        );
        return;
      default:
        return;
    }
  }

  /** The row above this one that is a level shallower, which is its parent's row. */
  private parentKeyOf(rows: DomRow[], at: number): string | undefined {
    const row = rows[at];
    if (!row || row.depth === 0) {
      return undefined;
    }
    return rows
      .slice(0, at)
      .reverse()
      .find(candidate => candidate.depth === row.depth - 1)?.key;
  }

  override render() {
    const rows = this.rows;
    const first = Math.max(0, Math.floor(this.scrolled / ROW_HEIGHT) - OVERSCAN);
    const shown = Math.ceil(this.viewport / ROW_HEIGHT) + OVERSCAN * 2;
    const visible = rows.slice(first, first + shown);

    return html`
      <div class="controls">
        <devkit-tabs
          .tabs=${this.engines.map((engine): TabDefinition => ({
            id: engine,
            label: ENGINE_LABELS[engine],
          }))}
          .selected=${this.tree.engine}
          label="Tree engine"
          @devkit-tab=${(event: CustomEvent<string>) =>
            this.emit('devkit-dom-engine', event.detail as Engine)}
        ></devkit-tabs>
        <label class="search">
          <ph-magnifying-glass></ph-magnifying-glass>
          <input
            type="search"
            placeholder="Selector or text"
            aria-label="Find in the tree"
            @change=${(event: globalThis.Event) =>
              this.emit('devkit-dom-search', (event.target as HTMLInputElement).value)}
          >
        </label>
        ${
          this.searching
            ? html`<span class="matches">searching…</span>`
            : this.matchCount === null
              ? nothing
              : html`<span class="matches">
                  ${this.matchCount} match${this.matchCount === 1 ? '' : 'es'}
                </span>`
        }
      </div>

      <div
        class="scroller"
        tabindex="0"
        role="tree"
        aria-label="DOM tree"
        @scroll=${(event: globalThis.Event) => {
          this.scrolled = (event.target as HTMLElement).scrollTop;
        }}
        @keydown=${this.handleKey}
      >
        ${
          rows.length === 0
            ? html`<p class="hint">Nothing loaded yet.</p>`
            : html`
                <!-- The spacer is the whole list; the rows inside it are only
                     the ones in view, put where they would have been. -->
                <div class="spacer" style="height: ${rows.length * ROW_HEIGHT}px">
                  <div class="window" style="transform: translateY(${first * ROW_HEIGHT}px)">
                    ${repeat(
                      visible,
                      row => row.key,
                      row => this.renderRow(row)
                    )}
                  </div>
                </div>
              `
        }
      </div>
    `;
  }

  private renderRow(row: DomRow) {
    const selected = row.key === this.tree.selectedId;
    // Generated content has no node to describe; the row is a label for
    // something its element already accounts for.
    const select = (): void => {
      if (!row.pseudo) {
        this.emit('devkit-dom-select', row.key);
      }
    };
    return html`
      <div
        class="row"
        role="treeitem"
        aria-level=${row.depth + 1}
        aria-selected=${ariaBoolean(selected)}
        aria-expanded=${row.openable ? ariaBoolean(row.expanded) : nothing}
        aria-label=${row.pseudo ? `::${row.pseudo}` : labelOf(row.node)}
        data-selected=${String(selected)}
        data-kind=${row.pseudo ? 'pseudo' : row.node.kind}
        style="padding-inline-start: ${8 + row.depth * 12}px"
        @click=${select}
        @keydown=${(event: KeyboardEvent) => {
          // The arrow keys are the scroller's, which owns the walk; a row only
          // has to answer for the key that means "this one".
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            select();
          }
        }}
      >
        ${
          row.openable
            ? html`
                <button
                  type="button"
                  class="twisty"
                  aria-label=${row.expanded ? 'Collapse' : 'Expand'}
                  @click=${(event: MouseEvent) => {
                    // The twisty opens the row; it does not also select it.
                    event.stopPropagation();
                    this.emit('devkit-dom-toggle', { nodeId: row.key, open: !row.expanded });
                  }}
                >
                  ${
                    row.expanded
                      ? html`<ph-caret-down></ph-caret-down>`
                      : html`<ph-caret-right></ph-caret-right>`
                  }
                </button>
              `
            : html`<span class="twisty"></span>`
        }
        ${this.renderLabel(row)}
      </div>
    `;
  }

  private renderLabel(row: DomRow) {
    if (row.pseudo) {
      return html`<span class="pseudo">::${row.pseudo}</span>`;
    }

    const node = row.node;
    if (node.kind === 'text') {
      return html`<span class="text">${node.value}</span>`;
    }
    if (node.kind === 'comment') {
      return html`<span class="comment">&lt;!-- ${node.value} --&gt;</span>`;
    }
    if (node.kind !== 'element') {
      return html`<span class="boundary">${node.name}</span>`;
    }

    return html`
      <span class="tag">${node.name}</span>
      ${node.id ? html`<span class="hash">#${node.id}</span>` : nothing}
      ${node.classes.map(name => html`<span class="class">.${name}</span>`)}
      ${this.renderAttributes(node)}
      ${node.note ? html`<span class="note">${node.note}</span>` : nothing}
    `;
  }

  /**
   * The attributes that are worth a row's width.
   *
   * Id and class already have their own marks, and everything else is shown
   * until the line runs out — which the stylesheet does by clipping rather than
   * by this deciding how many fit, because how many fit depends on how wide the
   * drawer is right now.
   */
  private renderAttributes(node: DomNode) {
    return node.attributes.map(
      // Composed before it reaches the template: an attribute name followed by
      // `=` inside markup reads as a binding position to the template parser.
      ([name, value]) => html`<span class="attribute">${`${name}="${value}"`}</span>`
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'devkit-dom-tree': DomTreeComponent;
  }
}
