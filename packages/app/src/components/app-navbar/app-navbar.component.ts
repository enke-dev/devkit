import '../address-bar/address-bar.component.js';
import '../icon-button/icon-button.component.js';
// Per icon, not the whole family: the barrel registers every element there is.
import '@phosphor-icons/webcomponents/PhArrowClockwise';
import '@phosphor-icons/webcomponents/PhBug';
import '@phosphor-icons/webcomponents/PhCaretLeft';
import '@phosphor-icons/webcomponents/PhCaretRight';
import '@phosphor-icons/webcomponents/PhSquareSplitHorizontal';
import '@phosphor-icons/webcomponents/PhSquareSplitVertical';

import { html } from 'lit';
import { customElement, property, query } from 'lit/decorators.js';
import { choose } from 'lit/directives/choose.js';
import { when } from 'lit/directives/when.js';

import { DevkitElement } from '../../utils/base.utils.js';
import type { SplitDirection } from '../../utils/layout.utils.js';
import { oppositeSplit } from '../../utils/layout.utils.js';
import type { AddressBarComponent } from '../address-bar/address-bar.component.js';
import styles from './app-navbar.component.css';
import { splitLabel } from './app-navbar.utils.js';

/**
 * The toolbar: where you are, where you can go back to, and what has gone wrong.
 *
 * It reports intent as events (`devkit-back`, `devkit-forward`, `devkit-reload`,
 * `devkit-navigate`, `devkit-restart`) and is told what to show. Nothing about
 * the engines is decided here.
 */
@customElement('devkit-app-navbar')
export class AppNavbarComponent extends DevkitElement.withStyles(styles) {
  @property({ type: Boolean, reflect: true, attribute: 'can-go-back' })
  accessor canGoBack = false;

  @property({ type: Boolean, reflect: true, attribute: 'can-go-forward' })
  accessor canGoForward = false;

  @property({ type: String, reflect: true })
  accessor split: SplitDirection = 'horizontal';

  /** Empty means everything is fine, which is most of the time. */
  @property({ type: String, reflect: true })
  accessor problem = '';

  /** The version waiting to be installed, if a newer one has been published. */
  @property({ type: String, reflect: true, attribute: 'update-version' })
  accessor updateVersion = '';

  /** Set while that version is being fetched and put in place. */
  @property({ type: Boolean, reflect: true })
  accessor updating = false;

  /** Set when a check somebody asked for found nothing newer. */
  @property({ type: Boolean, reflect: true, attribute: 'up-to-date' })
  accessor upToDate = false;

  /** Where the panes are; handed straight to the address bar. */
  @property({ type: String, reflect: true })
  accessor url = '';

  /** Whether the introspection drawer is open, which the toggle reflects. */
  @property({ type: Boolean, reflect: true })
  accessor inspecting = false;

  @query('devkit-address-bar')
  private accessor addressBar!: AddressBarComponent;

  focusAddress(): void {
    this.addressBar.focusAndSelect();
  }

  private emit(name: string, detail?: unknown): void {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }

  /**
   * A toggle shows what it will do rather than what is already true — the
   * arrangement itself is on screen behind it, so repeating it says nothing.
   */
  private renderSplitToggle() {
    const split = oppositeSplit(this.split);
    return html`
      <devkit-icon-button
        label=${splitLabel(split)}
        @click=${() => this.emit('devkit-split', split)}
      >
        ${choose(split, [
          ['horizontal', () => html`<ph-square-split-vertical></ph-square-split-vertical>`],
          ['vertical', () => html`<ph-square-split-horizontal></ph-square-split-horizontal>`],
        ])}
      </devkit-icon-button>
    `;
  }

  override render() {
    return html`
      <nav>
        <devkit-icon-button
          label="Back"
          ?disabled=${!this.canGoBack}
          @click=${() => this.emit('devkit-back')}
        >
          <ph-caret-left></ph-caret-left>
        </devkit-icon-button>
        <devkit-icon-button
          label="Forward"
          ?disabled=${!this.canGoForward}
          @click=${() => this.emit('devkit-forward')}
        >
          <ph-caret-right></ph-caret-right>
        </devkit-icon-button>
        <devkit-icon-button label="Reload" @click=${() => this.emit('devkit-reload')}>
          <ph-arrow-clockwise></ph-arrow-clockwise>
        </devkit-icon-button>
      </nav>

      <devkit-address-bar .url=${this.url}></devkit-address-bar>

      <nav>
        ${this.renderSplitToggle()}
        <devkit-icon-button
          ?active=${this.inspecting}
          label=${this.inspecting ? 'Hide the inspector' : 'Show the inspector'}
          @click=${() => this.emit('devkit-inspector', !this.inspecting)}
        >
          <ph-bug></ph-bug>
        </devkit-icon-button>
        ${when(
          this.upToDate,
          () => html`
            <button type="button" class="uptodate" @click=${() => this.emit('devkit-noticed')}>
              Up to date
            </button>
          `
        )}
        ${when(
          this.updateVersion !== '',
          () => html`
            <button
              type="button"
              class="update"
              ?disabled=${this.updating}
              @click=${() => this.emit('devkit-update')}
            >
              ${this.updating ? `Installing ${this.updateVersion}…` : `Update to ${this.updateVersion}`}
            </button>
          `
        )}
        ${when(
          this.problem.trim() !== '',
          () => html`
            <button type="button" class="problem" @click=${() => this.emit('devkit-restart')}>
              ${this.problem}
            </button>
          `
        )}
      </nav>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'devkit-app-navbar': AppNavbarComponent;
  }
}
