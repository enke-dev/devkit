import { html } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import { DevkitElement } from '../../utils/base.utils.js';
import { startDrag } from '../../utils/resize.utils.js';
import styles from './divider.component.css';

/** How far a drag has come from where it began, in CSS pixels. */
export interface DividerMove {
  deltaX: number;
  deltaY: number;
}

/**
 * A line between two things that can be taken hold of.
 *
 * One pixel of ink and seven of target: the grip reaches either side as a
 * pseudo-element, so the line stays as thin as every other edge in the app
 * while being no harder to hit than a scrollbar. Hovering anywhere in that
 * reach lights the line, because a pseudo-element is part of its element for
 * hit-testing and `:hover` alike.
 *
 * It reports movement rather than applying it. What a drag means depends
 * entirely on what is being divided — which side grows, what the bounds are,
 * what to store afterwards — and none of that belongs to the line. So the
 * pointer bookkeeping lives here, once, and the arithmetic stays with whoever
 * owns the layout.
 */
@customElement('devkit-divider')
export class DividerComponent extends DevkitElement.withStyles(styles) {
  /**
   * Which way the line runs, which is the opposite of the way it is dragged.
   *
   * The reading a separator's `aria-orientation` takes, and the one that picks
   * the cursor: a horizontal line is dragged up and down.
   */
  @property({ type: String, reflect: true })
  accessor orientation: 'horizontal' | 'vertical' = 'horizontal';

  /** Named for whoever is reading it out — "Resize the inspector". */
  @property()
  accessor label = '';

  private emit(name: string, detail?: unknown): void {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }

  private start(event: PointerEvent): void {
    // Said before the first movement, so whoever owns the layout can take the
    // measurements the drag will be reckoned against — the size it started at,
    // and the room it has to move in.
    this.emit('devkit-divider-start');
    startDrag(event, {
      move: (deltaX, deltaY) => this.emit('devkit-divider-move', { deltaX, deltaY }),
      end: () => this.emit('devkit-divider-end'),
    });
  }

  override render() {
    return html`
      <div
        class="grip"
        role="separator"
        aria-orientation=${this.orientation}
        aria-label=${this.label}
        @pointerdown=${this.start}
      ></div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'devkit-divider': DividerComponent;
  }
}
