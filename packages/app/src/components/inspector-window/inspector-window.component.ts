import '../inspector/inspector.component.js';

import { html } from 'lit';
import { customElement, state } from 'lit/decorators.js';

import { DevkitElement } from '../../utils/base.utils.js';
import type { InspectorState } from '../../utils/detached.utils.js';
import { onState, sendIntent } from '../../utils/detached.utils.js';
import type { ConsoleEntry, Evaluation, InspectAnswer } from '../../utils/inspect.utils.js';
import { CONSOLE_LIMIT } from '../../utils/inspect.utils.js';
import type { InspectorDock } from '../../utils/layout.utils.js';
import styles from './inspector-window.component.css';

/**
 * What the detached inspector window renders: the same drawer, in a window.
 *
 * It holds no opinions and asks the sidecar nothing. Everything it shows was
 * pushed to it by the app window, and everything clicked in it is reported
 * back — the relationship every other component here has with the app
 * component, with a window boundary in the middle instead of a shadow root.
 *
 * That is deliberate. This window could subscribe to the sidecar directly, and
 * would then have a console of its own that diverged from the app's the first
 * time either missed an event, and that began empty because it had not been
 * listening when the page loaded.
 */
@customElement('devkit-inspector-window')
export class InspectorWindowComponent extends DevkitElement.withStyles(styles) {
  @state() private accessor answers: InspectAnswer[] = [];
  @state() private accessor messages: ConsoleEntry[] = [];
  @state() private accessor evaluations: Evaluation[] = [];
  @state() private accessor picking = false;
  @state() private accessor tab: 'elements' | 'console' = 'elements';

  override connectedCallback(): void {
    super.connectedCallback();
    void onState(state => this.apply(state)).then(() =>
      // Only once the listener is attached, or the snapshot answering it can
      // arrive before there is anything to hear it.
      sendIntent({ kind: 'ready' })
    );
  }

  private apply(state: InspectorState): void {
    switch (state.kind) {
      case 'snapshot':
        this.answers = state.answers;
        this.messages = state.messages;
        this.evaluations = state.evaluations;
        this.picking = state.picking;
        this.tab = state.tab;
        return;
      case 'answers':
        this.answers = state.answers;
        return;
      case 'console':
        // Appended rather than re-sent whole: the app window keeps them in
        // order, and the limit is applied here as well so a window left open
        // for a day does not grow past it.
        this.messages = [...this.messages, state.entry].slice(-CONSOLE_LIMIT);
        return;
      case 'console-cleared':
        this.messages = [];
        this.evaluations = [];
        return;
      case 'evaluations':
        this.evaluations = state.evaluations;
        return;
      case 'picking':
        this.picking = state.picking;
        return;
      case 'tab':
        this.tab = state.tab;
        return;
    }
  }

  override render() {
    return html`
      <devkit-inspector
        .answers=${this.answers}
        .messages=${this.messages}
        .evaluations=${this.evaluations}
        .picking=${this.picking}
        .tab=${this.tab}
        .dock=${'detached' as const}
        @devkit-inspector-tab=${(event: CustomEvent<'elements' | 'console'>) =>
          sendIntent({ kind: 'tab', tab: event.detail })}
        @devkit-inspector-dock=${(event: CustomEvent<InspectorDock>) =>
          sendIntent({ kind: 'dock', dock: event.detail })}
        @devkit-inspector-close=${() => sendIntent({ kind: 'close' })}
        @devkit-pick=${(event: CustomEvent<boolean>) =>
          sendIntent({ kind: 'pick', picking: event.detail })}
        @devkit-console-clear=${() => sendIntent({ kind: 'clear-console' })}
        @devkit-evaluate=${(event: CustomEvent<string>) =>
          sendIntent({ kind: 'evaluate', expression: event.detail })}
      ></devkit-inspector>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'devkit-inspector-window': InspectorWindowComponent;
  }
}
