import { listenWindow } from '@enke.dev/lit-utils/lib/utils/event.utils.js';
import { html, nothing } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';

import { DevkitElement } from '../../utils/base.utils.js';
import * as history from '../../utils/history.utils.js';
import styles from './address-bar.component.css';

/** How many history matches are offered at once. */
const SUGGESTION_LIMIT = 8;

/**
 * The address bar, and the history it suggests from.
 *
 * Emits `devkit-navigate` with the URL to open. It deliberately does not
 * navigate anything itself: the panes move in lockstep and the app owns that.
 */
@customElement('devkit-address-bar')
export class AddressBarComponent extends DevkitElement.withStyles(styles) {
  /**
   * Where the panes are, as they report it.
   *
   * Applied to the field only while it is not being edited: a pane arriving
   * somewhere must never overwrite a half-typed URL.
   */
  @property()
  accessor url = '';

  @query('input')
  private accessor input!: HTMLInputElement;

  @state()
  private accessor suggestions: history.Visit[] = [];

  /** -1 means "what was typed", which is what Return takes by default. */
  @state()
  private accessor selected = -1;

  /** Whether the user is editing, in which case panes must not overwrite it. */
  @state()
  private accessor editing = false;

  get value(): string {
    return this.input?.value ?? '';
  }

  /** ⌘L: take the bar and select what is in it. */
  focusAndSelect(): void {
    this.input.focus();
    this.input.select();
  }

  override updated(changed: Map<string, unknown>): void {
    if (changed.has('url') && !this.editing && this.input) {
      this.input.value = this.url;
    }
  }

  /**
   * Close the list when the window loses focus.
   *
   * A dropdown left open over a pane while the app is in the background looks
   * like part of the page being compared.
   */
  @listenWindow('blur')
  protected handleWindowBlur(): void {
    this.close();
  }

  private close(): void {
    this.suggestions = [];
    this.selected = -1;
  }

  private navigate(raw: string): void {
    const url = raw.trim();
    if (url.length === 0) {
      return;
    }
    this.close();
    this.input.blur();
    this.dispatchEvent(
      new CustomEvent('devkit-navigate', { detail: url, bubbles: true, composed: true })
    );
  }

  private handleInput(): void {
    this.suggestions = history.suggest(this.input.value, SUGGESTION_LIMIT);
    this.selected = -1;
  }

  private handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      this.close();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      this.navigate(this.suggestions[this.selected]?.url ?? this.input.value);
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
      return;
    }
    // Only take the arrows while there is a list; otherwise they belong to the
    // text field.
    if (this.suggestions.length === 0) {
      return;
    }
    event.preventDefault();
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    const count = this.suggestions.length;
    this.selected = this.selected + delta < 0 ? count - 1 : (this.selected + delta) % count;
  }

  override render() {
    return html`
      <input
        type="text"
        spellcheck="false"
        autocomplete="off"
        role="combobox"
        aria-label="Address"
        aria-controls="suggestions"
        aria-expanded=${this.suggestions.length > 0}
        aria-autocomplete="list"
        placeholder="Enter a URL and press Return"
        @input=${this.handleInput}
        @keydown=${this.handleKeydown}
        @focus=${() => {
          this.editing = true;
        }}
        @blur=${() => {
          this.editing = false;
          this.close();
        }}
      >
      ${this.suggestions.length === 0 ? nothing : this.renderSuggestions()}
    `;
  }

  private renderSuggestions() {
    return html`
      <ul id="suggestions" role="listbox" aria-label="Matching pages you have visited">
        ${this.suggestions.map(
          (visit, index) => html`
            <li
              role="option"
              aria-selected=${index === this.selected}
              @mousedown=${(event: MouseEvent) => {
                // `mousedown`, not `click`: the input's blur would close the
                // list before a click ever landed.
                event.preventDefault();
                this.navigate(visit.url);
              }}
            >
              <span class="url">${visit.url.replace(/^https?:\/\//, '')}</span>
              ${visit.title ? html`<span class="title">${visit.title}</span>` : nothing}
            </li>
          `
        )}
      </ul>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'devkit-address-bar': AddressBarComponent;
  }
  interface HTMLElementEventMap {
    'devkit-navigate': CustomEvent<string>;
  }
}
