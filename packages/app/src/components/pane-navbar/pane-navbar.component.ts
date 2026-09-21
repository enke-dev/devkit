import '../icon-button/icon-button.component.js';
import '../popover/popover.component.js';
import '@phosphor-icons/webcomponents/PhArrowSquareOut';
import '@phosphor-icons/webcomponents/PhCircleNotch';
import '@phosphor-icons/webcomponents/PhMoon';
import '@phosphor-icons/webcomponents/PhSun';

import type { ColorScheme, Engine } from '@devkit/protocol';
import { ENGINE_LABELS } from '@devkit/protocol';
import { html, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { choose } from 'lit/directives/choose.js';
import { styleMap } from 'lit/directives/style-map.js';

import { DevkitElement } from '../../utils/base.utils.js';
import styles from './pane-navbar.component.css';
import type { ViewStatus } from './pane-navbar.utils.js';
import { isRunning, renderEngineGlyph, statusColour, statusLabel } from './pane-navbar.utils.js';

/**
 * A pane's header: which engine is rendering, at what size, how fast, and in
 * what condition.
 *
 * It only states what the pane tells it. Everything here is said in the header
 * and never over the frame: dimming or tinting a rendering would falsify the
 * one thing the panes exist to show.
 */
@customElement('devkit-pane-navbar')
export class PaneNavbarComponent extends DevkitElement.withStyles(styles) {
  @property()
  accessor engine!: Engine;

  /** The browser build behind the engine, once it has reported one. */
  @property()
  accessor version = '';

  /** The size the page is being rendered at, in CSS pixels. */
  @property()
  accessor dims = '';

  @property()
  accessor rate = '';

  @property()
  accessor status: ViewStatus = 'idle';

  /** A window is being opened; ends when the sidecar says the page is up in it. */
  @property({ type: Boolean })
  accessor detaching = false;

  /** The scheme the page is being told the user prefers. */
  @property()
  accessor colorScheme: ColorScheme = 'light';

  /** The pane the pointer is in. */
  @property({ type: Boolean, reflect: true })
  accessor active = false;

  /** Whether input is currently going to one pane alone. */
  @property({ type: Boolean, reflect: true })
  accessor solo = false;

  /** Engine and build in one line, for the mark's tooltip. */
  private get identity(): string {
    return [ENGINE_LABELS[this.engine], this.version].filter(Boolean).join(' ');
  }

  override render() {
    return html`
      <span class="title">
        <!-- The mark never leaves, however narrow the pane gets — it is how
             you know which engine you are looking at. What it hides beside it
             comes back through the flyout it opens. -->
        <devkit-popover class="identity" placement="bottom-start" label="Engine">
          <button slot="trigger" class="mark" type="button" title=${this.identity}>
            ${renderEngineGlyph(this.engine)}
          </button>
          <span class="identity-name">${ENGINE_LABELS[this.engine]}</span>
          ${this.version ? html`<span class="identity-version">${this.version}</span>` : nothing}
        </devkit-popover>
        <span class="name">${ENGINE_LABELS[this.engine]}</span>
        <span class="version">${this.version}</span>
      </span>
      <span class="dims">${this.dims}</span>
      <nav>
        <devkit-icon-button
          label=${
            this.detaching
              ? `Opening ${ENGINE_LABELS[this.engine]} window`
              : `Open in a ${ENGINE_LABELS[this.engine]} window`
          }
          ?disabled=${this.detaching || !isRunning(this.status)}
          @click=${() => this.dispatchEvent(new CustomEvent('devkit-detach'))}
        >
          ${
            this.detaching
              ? html`<ph-circle-notch class="spin"></ph-circle-notch>`
              : html`<ph-arrow-square-out></ph-arrow-square-out>`
          }
        </devkit-icon-button>
        <devkit-icon-button
          label="Render ${this.colorScheme === 'dark' ? 'light' : 'dark'}"
          @click=${() => this.dispatchEvent(new CustomEvent('devkit-color-scheme'))}
        >
          ${choose(this.colorScheme, [
            ['dark', () => html`<ph-moon></ph-moon>`],
            ['light', () => html`<ph-sun></ph-sun>`],
          ])}
        </devkit-icon-button>
      </nav>
      <span class="meter">${this.rate}</span>
      <!-- The dot survives every width; the word beside it does not. A
           colour alone still says which of the two running modes a pane is
           in, and whether it is running at all. -->
      <span class="status" style=${styleMap({ color: statusColour(this.status) })}>
        <span class="label">${statusLabel(this.status)}</span>
      </span>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'devkit-pane-navbar': PaneNavbarComponent;
  }
}
