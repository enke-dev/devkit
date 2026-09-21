import { html } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import { ariaBoolean } from '../../utils/aria.utils.js';
import { DevkitElement } from '../../utils/base.utils.js';
import styles from './tabs.component.css';

/** One tab: what it is called, and what it is called by. */
export interface TabDefinition {
  id: string;
  label: string;
}

/**
 * A row of tabs, marked along the rule beneath them.
 *
 * Tabs rather than buttons, and the distinction is the whole reason this is a
 * component: they say which of several panels you are looking at — a place you
 * are, not a thing to press — so the one you are on is marked along its
 * container's own edge instead of being given a plate of its own. Written twice
 * that came out twice differently, which is how the drawer's tabs and the
 * tree's engine picker ended up looking like two unrelated controls.
 *
 * It owns the keyboard as well as the look, which is the part a second
 * hand-rolled copy never gets: a tablist is one stop in the tab order and the
 * arrows move within it, so reaching the third tab does not mean pressing Tab
 * three times.
 *
 * Deliberately not styled to a size. It takes its font from wherever it is put,
 * so the same control reads as the drawer's header in one place and as the
 * tree's toolbar in another without either of them restating it.
 */
@customElement('devkit-tabs')
export class TabsComponent extends DevkitElement.withStyles(styles) {
  @property({ attribute: false })
  accessor tabs: TabDefinition[] = [];

  /** Which tab is current; anything that matches no tab simply selects none. */
  @property()
  accessor selected = '';

  /** Named for whoever is reading it out — "Inspector panels", "Tree engine". */
  @property()
  accessor label = '';

  private select(id: string): void {
    if (id === this.selected) {
      return;
    }
    this.dispatchEvent(
      new CustomEvent('devkit-tab', { detail: id, bubbles: true, composed: true })
    );
  }

  /**
   * Move along the row with the arrows, wrapping at both ends.
   *
   * Selection follows focus, which is what the tabs everyone already knows do
   * and what makes the arrows worth having: a tab you have to arrow to and then
   * press is two gestures for something that was one with the pointer.
   */
  private handleKey(event: KeyboardEvent): void {
    const at = this.tabs.findIndex(tab => tab.id === this.selected);
    const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key];

    const wanted =
      step === undefined
        ? { Home: this.tabs[0], End: this.tabs[this.tabs.length - 1] }[event.key]
        : this.tabs[(at + step + this.tabs.length) % this.tabs.length];
    if (!wanted) {
      return;
    }

    event.preventDefault();
    this.select(wanted.id);
    // The row is one stop in the tab order, so the moved-to tab has to take the
    // focus with it or the next arrow would start over from the old one.
    this.renderRoot.querySelector<HTMLElement>(`#tab-${CSS.escape(wanted.id)}`)?.focus();
  }

  override render() {
    return html`
      <div role="tablist" aria-label=${this.label} @keydown=${this.handleKey}>
        ${this.tabs.map(tab => {
          const current = tab.id === this.selected;
          return html`
            <button
              type="button"
              role="tab"
              id=${`tab-${tab.id}`}
              aria-selected=${ariaBoolean(current)}
              tabindex=${current ? 0 : -1}
              @click=${() => this.select(tab.id)}
            >
              ${tab.label}
            </button>
          `;
        })}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'devkit-tabs': TabsComponent;
  }
}
