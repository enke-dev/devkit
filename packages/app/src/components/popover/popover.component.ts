import { listenWindow } from '@enke.dev/lit-utils/lib/utils/event.utils.js';
import type { PropertyValues } from 'lit';
import { html, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import { ariaBoolean } from '../../utils/aria.utils.js';
import { DevkitElement } from '../../utils/base.utils.js';
import styles from './popover.component.css';

/** Which corner the panel hangs from, relative to the trigger. */
export type PopoverPlacement = 'bottom-start' | 'bottom-end';

/**
 * Something shown beside the thing that opened it, until it is dismissed.
 *
 * It owns being open. Every caller of a flyout wants the same three
 * behaviours — a click toggles, a click anywhere else closes, Escape closes —
 * and every caller that writes them itself writes them slightly differently.
 * Here they are written once and the caller describes what goes inside.
 *
 * The trigger is slotted rather than rendered, because the things that open a
 * flyout are not alike: a toolbar button in one place, an engine's mark in
 * another. Clicks from slotted content bubble through the flattened tree, so
 * the wrapper around the slot hears them whatever the caller put there.
 */
@customElement('devkit-popover')
export class PopoverComponent extends DevkitElement.withStyles(styles) {
  @property({ type: Boolean, reflect: true })
  accessor open = false;

  @property({ type: String, reflect: true })
  accessor placement: PopoverPlacement = 'bottom-end';

  /** Named for whoever is reading it out; the trigger's own label if it has one. */
  @property()
  accessor label = '';

  /**
   * Toggle when the trigger is clicked, and only then.
   *
   * Bound to the host rather than to a wrapper in the shadow root: the trigger
   * is the caller's own element, and it is the interactive one. A wrapper
   * carrying the handler would be a clickable span standing in front of a
   * perfectly good button.
   *
   * The panel's contents are slotted too and bubble to the same place, so the
   * path is checked — a click inside the panel belongs to whoever put it
   * there, and several of them close the popover themselves.
   */
  private readonly onClick = (event: Event) => {
    const trigger = this.querySelector('[slot="trigger"]');
    if (trigger && event.composedPath().includes(trigger)) {
      this.open = !this.open;
    }
  };

  override connectedCallback(): void {
    super.connectedCallback();
    this.addEventListener('click', this.onClick);
  }

  override disconnectedCallback(): void {
    this.removeEventListener('click', this.onClick);
    super.disconnectedCallback();
  }

  /**
   * Dismiss on anything that is not this popover.
   *
   * On the window, because a click anywhere means the same thing — another
   * pane, the toolbar, the page behind a detached window. The popover's own
   * subtree is excluded so the trigger toggles rather than closing and
   * reopening, and so the panel can be clicked without vanishing underneath.
   */
  @listenWindow('pointerdown')
  protected dismiss(event: PointerEvent): void {
    if (this.open && !event.composedPath().includes(this)) {
      this.open = false;
    }
  }

  @listenWindow('keydown')
  protected dismissOnEscape(event: KeyboardEvent): void {
    if (this.open && event.key === 'Escape') {
      this.open = false;
    }
  }

  /**
   * Say on the trigger itself whether the panel is showing.
   *
   * Set on the slotted element rather than rendered, because the trigger
   * belongs to the caller: it is their button, and this is the one thing about
   * it that only the popover knows.
   */
  override updated(changed: PropertyValues<this>): void {
    const trigger = this.querySelector('[slot="trigger"]');
    trigger?.setAttribute('aria-haspopup', 'true');
    trigger?.setAttribute('aria-expanded', ariaBoolean(this.open));

    // Announced from here rather than from the toggle, so that a caller who
    // closes the panel itself — picking something out of it, most often — is
    // told about it in the same way as a dismissal. Skipped on the first
    // render, which is not a change to anything.
    if (changed.has('open') && changed.get('open') !== undefined) {
      this.dispatchEvent(
        new CustomEvent('devkit-popover-toggle', {
          detail: this.open,
          bubbles: true,
          composed: true,
        })
      );
    }
  }

  override render() {
    return html`
      <span class="trigger">
        <slot name="trigger"></slot>
      </span>
      ${
        this.open
          ? html`
              <div class="panel" part="panel" role="group" aria-label=${this.label || nothing}>
                <slot></slot>
              </div>
            `
          : nothing
      }
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'devkit-popover': PopoverComponent;
  }
  interface HTMLElementEventMap {
    'devkit-popover-toggle': CustomEvent<boolean>;
  }
}
