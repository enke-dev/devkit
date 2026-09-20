import { html, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import { DevkitElement } from '../../utils/base.utils.js';
import styles from './icon-button.component.css';

/**
 * A toolbar button that is a glyph and a hit area, nothing more.
 *
 * Disabled is a real state here rather than a shade of grey: a back arrow that
 * cannot go back should say so before it is clicked, which is the whole reason
 * this is a component and not three `<button>` tags.
 */
@customElement('devkit-icon-button')
export class IconButtonComponent extends DevkitElement.withStyles(styles) {
  @property({ type: Boolean, reflect: true })
  accessor disabled = false;

  /**
   * Whether the thing this button turns on is currently on.
   *
   * A property rather than something a caller can style from outside: the
   * glyph is slotted, so in the flattened tree it inherits from the button in
   * this shadow root and not from the host. Colouring the host does nothing at
   * all, which is how two toggles came to look identical on and off.
   */
  @property({ type: Boolean, reflect: true })
  accessor active = false;

  /** Shown as the tooltip and read out; the glyph itself is decorative. */
  @property()
  accessor label = '';

  override render() {
    return html`
      <button
        type="button"
        ?disabled=${this.disabled}
        title=${this.label}
        aria-label=${this.label}
        aria-pressed=${this.active ? 'true' : nothing}
      >
        <slot></slot>
      </button>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'devkit-icon-button': IconButtonComponent;
  }
}
