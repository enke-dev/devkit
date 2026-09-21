import '../divider/divider.component.js';
import '../dom-tree/dom-tree.component.js';
import '../icon-button/icon-button.component.js';
import '../popover/popover.component.js';
import '../tabs/tabs.component.js';
import '@phosphor-icons/webcomponents/PhBrowsers';
import '@phosphor-icons/webcomponents/PhCaretDown';
import '@phosphor-icons/webcomponents/PhCheck';
import '@phosphor-icons/webcomponents/PhCrosshair';
import '@phosphor-icons/webcomponents/PhSquareHalf';
import '@phosphor-icons/webcomponents/PhSquareHalfBottom';
import '@phosphor-icons/webcomponents/PhTrash';
import '@phosphor-icons/webcomponents/PhX';

import type { ConsoleLevel, Engine, InspectedElement, MatchedRule } from '@devkit/protocol';
import { ENGINE_LABELS, ENGINES, INSPECTED_STYLE_GROUPS } from '@devkit/protocol';
import type { TemplateResult } from 'lit';
import { html, nothing } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

import { ariaBoolean } from '../../utils/aria.utils.js';
import { DevkitElement } from '../../utils/base.utils.js';
import type { DomTree } from '../../utils/dom.utils.js';
import type { ConsoleEntry, Evaluation, InspectAnswer } from '../../utils/inspect.utils.js';
import {
  agreed,
  breadcrumb,
  CONSOLE_LEVEL_LABELS,
  CONSOLE_LEVELS,
  describeRef,
  differingProperties,
  divergesAt,
  identitySteps,
  levelOf,
  sourceOf,
  textOf,
  timeOf,
} from '../../utils/inspect.utils.js';
import type { InspectorDock } from '../../utils/layout.utils.js';
import {
  INSPECTOR_DOCKS,
  MIN_DETAILS,
  MIN_TREE,
  storedTreeSize,
  storeTreeSize,
} from '../../utils/layout.utils.js';
import { clamp } from '../../utils/resize.utils.js';
import type { DividerMove } from '../divider/divider.component.js';
import type { PopoverComponent } from '../popover/popover.component.js';
import type { TabDefinition } from '../tabs/tabs.component.js';
import styles from './inspector.component.css';

type Tab = 'elements' | 'console';

/** The drawer's two panels, in the order they are offered. */
const TABS: TabDefinition[] = [
  { id: 'elements', label: 'Elements' },
  { id: 'console', label: 'Console' },
];

/** Each placement, named as the place rather than as the move to it. */
const DOCK_LABELS: Record<InspectorDock, string> = {
  detached: 'Separate window',
  left: 'Dock to the left',
  bottom: 'Dock to the bottom',
  right: 'Dock to the right',
};

/**
 * The glyph for a placement.
 *
 * Two overlapping windows for undocked and a filled half-square for each edge,
 * which is the vocabulary the developer tools everyone already knows use for
 * this exact row. Phosphor ships only the bottom and left halves, so the right
 * one is the left one mirrored.
 */
const DOCK_GLYPHS: Record<InspectorDock, () => TemplateResult> = {
  detached: () => html`<ph-browsers></ph-browsers>`,
  left: () => html`<ph-square-half></ph-square-half>`,
  bottom: () => html`<ph-square-half-bottom class="mirrored"></ph-square-half-bottom>`,
  right: () => html`<ph-square-half class="mirrored"></ph-square-half>`,
};

function dockGlyph(dock: InspectorDock): TemplateResult {
  return DOCK_GLYPHS[dock]();
}
/**
 * The introspection drawer: what is under the pointer, what the pages printed,
 * and a line to ask them something.
 *
 * It compares rather than reports. A single engine's computed styles are
 * something every browser already shows better than this ever will — what no
 * browser can show is the same element in three engines at once, so the column
 * layout and the marking of rows that disagree are the whole point of it.
 *
 * Nothing here talks to the sidecar. The drawer reports intent and is handed
 * answers, the way every other component in the app is.
 */
@customElement('devkit-inspector')
export class InspectorComponent extends DevkitElement.withStyles(styles) {
  /** One answer per pane that was asked, in whatever order they arrived. */
  @property({ attribute: false })
  accessor answers: InspectAnswer[] = [];

  @property({ attribute: false })
  accessor messages: ConsoleEntry[] = [];

  @property({ attribute: false })
  accessor evaluations: Evaluation[] = [];

  /**
   * The tree being shown, which belongs to exactly one engine.
   *
   * Null until the Elements tab has asked for one. The drawer opens on that tab
   * and most sessions never leave it, so this is a first-frame state rather
   * than a common one — but a drawer that cannot draw itself before the round
   * trip lands is a drawer that flashes empty every time it opens.
   */
  @property({ attribute: false })
  accessor tree: DomTree | null = null;

  /** The engines with a pane running, so the tree's picker offers real choices. */
  @property({ attribute: false })
  accessor treeEngines: Engine[] = [];

  @property({ type: Boolean })
  accessor searching = false;

  @property({ attribute: false })
  accessor matchCount: number | null = null;

  /** Whether the inspected element follows the pointer, or is being held still. */
  @property({ type: Boolean, reflect: true })
  accessor picking = false;

  @property({ type: String, reflect: true })
  accessor tab: Tab = 'elements';

  /**
   * Which edge the drawer is attached to.
   *
   * Reflected because the drawer's own borders depend on it: the rule belongs
   * along the edge it is actually against, and nowhere else.
   */
  @property({ type: String, reflect: true })
  accessor dock: InspectorDock = 'bottom';

  /**
   * Show only the rows the engines disagree about.
   *
   * Off by default, because an inspector that hides what agrees is useless for
   * the ordinary question of "what is this element" — but the moment there is a
   * difference to chase, everything else is in the way.
   */
  @state() private accessor onlyDifferences = false;

  /** Mirrors the placement flyout, so its trigger can show that it is open. */
  @state() private accessor dockOpen = false;

  /**
   * How tall the tree is, once somebody has said.
   *
   * Null until then, and null is a real value rather than a missing one: an
   * untouched split takes its share of whatever height the drawer has, which is
   * the right answer at every dock. A number is a measurement somebody made,
   * and is kept.
   *
   * Owned here rather than by the app, unlike the drawer's own size. This is a
   * layout inside the drawer, and the drawer is rendered in two places — put it
   * in the app and the detached window would have to be sent it, for a number
   * nothing outside these two panels has any use for.
   */
  @state() private accessor treeSize: number | null = storedTreeSize();

  /** Which levels are shown; all of them until somebody says otherwise. */
  @state() private accessor levels: ConsoleLevel[] = [...CONSOLE_LEVELS];

  /** Which engines are shown, by the same arrangement. */
  @state() private accessor engines: Engine[] = [...ENGINES];
  @state() private accessor search = '';

  @query('input.expression')
  private accessor expressionField!: HTMLInputElement;

  @query('devkit-popover.dock')
  private accessor dockPopover!: PopoverComponent;

  @query('.elements')
  private accessor elements!: HTMLElement;

  /**
   * What the split was at when its drag began, and how far it may go.
   *
   * Measured once, at the start. The tree's height is what the drag is
   * changing, so reading it again on every movement would be reading back the
   * previous movement rather than the pointer.
   */
  #splitDrag = { from: 0, most: 0 };

  private emit(name: string, detail?: unknown): void {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }

  /** The engines that answered, in the fixed order, so columns never reorder. */
  private get columns(): InspectAnswer[] {
    return ENGINES.map(engine => this.answers.find(answer => answer.engine === engine)).filter(
      (answer): answer is InspectAnswer => answer !== undefined
    );
  }

  override render() {
    return html`
      <header>
        <devkit-tabs
          .tabs=${TABS}
          .selected=${this.tab}
          label="Inspector panels"
          @devkit-tab=${(event: CustomEvent<string>) =>
            this.emit('devkit-inspector-tab', event.detail as Tab)}
        ></devkit-tabs>
        <devkit-icon-button
          ?active=${this.picking}
          label=${this.picking ? 'Stop following the pointer' : 'Pick an element'}
          @click=${() => this.emit('devkit-pick', !this.picking)}
        >
          <!-- The weight changes with the colour: picking is a mode, and a mode
               you can be in without noticing is a mode that bites. -->
          <ph-crosshair weight=${this.picking ? 'bold' : 'regular'}></ph-crosshair>
        </devkit-icon-button>
        <devkit-popover
          class="dock"
          label="Dock side"
          @devkit-popover-toggle=${(event: CustomEvent<boolean>) => {
            this.dockOpen = event.detail;
          }}
        >
          <devkit-icon-button slot="trigger" label="Dock side" ?active=${this.dockOpen}>
            <!-- Unlike the pane split toggle, this one shows where the drawer
                 is rather than where it would go: it opens a list of the
                 places rather than moving to the next of them. -->
            ${dockGlyph(this.dock)}
          </devkit-icon-button>
          ${this.renderDockChoices()}
        </devkit-popover>
        <devkit-icon-button
          label="Close the inspector"
          @click=${() => this.emit('devkit-inspector-close')}
        >
          <ph-x></ph-x>
        </devkit-icon-button>
      </header>

      ${this.tab === 'elements' ? this.renderElements() : this.renderConsole()}
    `;
  }

  /**
   * Every placement at once, the current one marked.
   *
   * A cycling button asked people to guess what came next and hid the rest of
   * the choices while they did. They fit in a row, so they are all shown —
   * which is what the tools this borrows from settled on for the same reason.
   */
  private renderDockChoices() {
    return html`
      <span class="dock-title">Dock side</span>
      <div class="choices">
        ${INSPECTOR_DOCKS.map(
          dock => html`
            <devkit-icon-button
              role="menuitemradio"
              aria-checked=${ariaBoolean(dock === this.dock)}
              ?active=${dock === this.dock}
              label=${DOCK_LABELS[dock]}
              @click=${() => {
                this.dockPopover.open = false;
                if (dock !== this.dock) {
                  this.emit('devkit-inspector-dock', dock);
                }
              }}
            >
              ${dockGlyph(dock)}
            </devkit-icon-button>
          `
        )}
      </div>
    `;
  }

  // -------------------------------------------------------------------------
  // Elements
  // -------------------------------------------------------------------------

  /**
   * The tree, and what the engines say about whichever row it has selected.
   *
   * Two panels rather than one because they answer different questions and one
   * of them is per engine while the other is not: the tree is one engine's DOM,
   * and the table underneath is all three engines' account of the element the
   * tree is pointing at. Stacking them is what lets a row be clicked and a
   * disagreement be read without either panel changing what it means.
   */
  private renderElements() {
    return html`
      <div
        class="elements"
        style=${this.treeSize === null ? nothing : `--tree-size: ${Math.round(this.treeSize)}px`}
      >
        ${
          this.tree
            ? html`
                <devkit-dom-tree
                  .tree=${this.tree}
                  .engines=${this.treeEngines}
                  ?searching=${this.searching}
                  .matchCount=${this.matchCount}
                ></devkit-dom-tree>
              `
            : html`<p class="hint">Loading the tree…</p>`
        }
        <devkit-divider
          orientation="horizontal"
          label="Resize the tree"
          @devkit-divider-start=${() => this.beginSplitDrag()}
          @devkit-divider-move=${(event: CustomEvent<DividerMove>) => this.moveSplit(event.detail)}
          @devkit-divider-end=${() => {
            if (this.treeSize !== null) {
              storeTreeSize(this.treeSize);
            }
          }}
        ></devkit-divider>
        ${this.renderDetails()}
      </div>
    `;
  }

  /**
   * Take the split's measurements before it moves.
   *
   * The tree's own height rather than `treeSize`, because until the first drag
   * there is no `treeSize` — the split is a share of the panel, and what the
   * drag starts from is whatever that came out as.
   */
  private beginSplitDrag(): void {
    const panel = this.elements;
    const tree = panel?.firstElementChild;
    this.#splitDrag = {
      from: tree?.getBoundingClientRect().height ?? MIN_TREE,
      most: (panel?.getBoundingClientRect().height ?? 0) - MIN_DETAILS,
    };
  }

  private moveSplit({ deltaY }: DividerMove): void {
    const { from, most } = this.#splitDrag;
    this.treeSize = clamp(from + deltaY, MIN_TREE, most);
  }

  private renderDetails() {
    const columns = this.columns;
    if (columns.length === 0) {
      return html`
        <p class="hint">
          ${
            this.picking
              ? 'Point at a pane to inspect what is under the pointer.'
              : 'Select a row, or pick an element, to compare it across the engines.'
          }
        </p>
      `;
    }

    const differing = differingProperties(columns);
    return html`
      <div class="body" role="tabpanel" aria-labelledby="tab-elements">
        ${this.renderSubject(columns)}
        <div class="controls">
          <label>
            <input
              type="checkbox"
              .checked=${this.onlyDifferences}
              @change=${(event: globalThis.Event) => {
                this.onlyDifferences = (event.target as HTMLInputElement).checked;
              }}
            >
            Only differences${differing.size > 0 ? ` (${differing.size})` : ''}
          </label>
        </div>
        ${this.renderStyles(columns, differing)} ${this.renderRules(columns)}
      </div>
    `;
  }

  /**
   * What is being described, and whether the engines agree that it is one
   * thing.
   *
   * Disagreement is not an error here — the panes share a viewport and a point,
   * and two engines resolving different elements at the same point is a real
   * difference in how they laid the page out. So it is stated and each engine's
   * own answer is named, rather than one of them being picked to stand for all.
   */
  private renderSubject(columns: InspectAnswer[]) {
    const elements = columns
      .map(column => column.element)
      .filter((element): element is InspectedElement => element !== null);
    if (elements.length === 0) {
      return html`<p class="hint">No engine found anything at that point.</p>`;
    }

    if (!agreed(columns)) {
      // The whole trail, not just the leaf: the engines almost always agree
      // about what they landed on and disagree about where it sits, so showing
      // the leaf alone prints the same thing three times and calls it a
      // difference.
      const diverges = divergesAt(columns);
      return html`
        <div class="subject disputed">
          <p class="warn">The engines resolved different elements at this point.</p>
          <ul>
            ${columns.map(column => {
              const steps = column.element ? identitySteps(column.element) : [];
              return html`
                <li>
                  <span class="engine">${ENGINE_LABELS[column.engine]}</span>
                  ${
                    column.element
                      ? html`
                          <ol class="chain">
                            ${steps.map(
                              (step, at) => html`
                                <li data-diverges=${String(at === diverges)}>
                                  <code>${step}</code>
                                </li>
                              `
                            )}
                          </ol>
                        `
                      : html`<code>${column.error ?? 'nothing'}</code>`
                  }
                </li>
              `;
            })}
          </ul>
        </div>
      `;
    }

    const [element] = elements;
    if (!element) {
      return nothing;
    }
    return html`
      <div class="subject">
        <ol class="crumbs">
          ${breadcrumb(element).map(
            ref => html`
              <li>
                ${ref.boundary ? html`<span class="boundary">${ref.boundary}</span>` : nothing}
                <code>${describeRef(ref)}</code>
              </li>
            `
          )}
        </ol>
        ${element.documentUrl ? html`<p class="where">${element.documentUrl}</p>` : nothing}
        ${element.pierceNote ? html`<p class="warn">${element.pierceNote}</p>` : nothing}
        ${
          element.attributes.length > 0
            ? html`
                <ul class="attributes">
                  ${element.attributes.map(
                    // Composed before it reaches the template: an attribute
                    // name followed by `=` inside markup reads as a binding
                    // position to the template parser, whatever it is nested in.
                    ([name, value]) => html`<li><code>${`${name}="${value}"`}</code></li>`
                  )}
                </ul>
              `
            : nothing
        }
      </div>
    `;
  }

  private renderStyles(columns: InspectAnswer[], differing: Set<string>) {
    return html`
      <table class="styles">
        <thead>
          <tr>
            <th scope="col">Property</th>
            ${columns.map(column => html`<th scope="col">${ENGINE_LABELS[column.engine]}</th>`)}
          </tr>
        </thead>
        ${INSPECTED_STYLE_GROUPS.map(group => {
          const rows = group.properties.filter(
            property => !this.onlyDifferences || differing.has(property)
          );
          if (rows.length === 0) {
            return nothing;
          }
          return html`
            <tbody>
              <tr class="group">
                <th scope="rowgroup" colspan=${columns.length + 1}>${group.label}</th>
              </tr>
              ${rows.map(
                property => html`
                  <tr data-differs=${String(differing.has(property))}>
                    <th scope="row">${property}</th>
                    ${columns.map(
                      column => html`
                        <td>${column.element ? column.element.styles[property] : '—'}</td>
                      `
                    )}
                  </tr>
                `
              )}
            </tbody>
          `;
        })}
      </table>
    `;
  }

  /**
   * Matched rules, per engine and collapsed.
   *
   * Never the primary panel: reading a stylesheet served from another origin
   * throws, so on a great many real pages there is nothing here at all. That is
   * why each engine says how much it could not see rather than presenting a
   * short list as the whole truth.
   */
  private renderRules(columns: InspectAnswer[]) {
    return html`
      <div class="rules">
        ${columns.map(column => {
          const element = column.element;
          if (!element) {
            return nothing;
          }
          return html`
            <details>
              <summary>
                ${ENGINE_LABELS[column.engine]} ·
                ${
                  element.rules === null
                    ? 'no stylesheet could be read'
                    : `${element.rules.length} matched rule${element.rules.length === 1 ? '' : 's'}`
                }
              </summary>
              ${element.rulesNote ? html`<p class="warn">${element.rulesNote}</p>` : nothing}
              ${(element.rules ?? []).map(rule => this.renderRule(rule))}
            </details>
          `;
        })}
      </div>
    `;
  }

  private renderRule(rule: MatchedRule) {
    return html`
      <div class="rule">
        <p class="selector">
          ${rule.conditions.map(condition => html`<span class="condition">${condition}</span>`)}
          <code>${rule.selector || 'element.style'}</code>
          <span class="origin">${rule.origin}</span>
        </p>
        <ul>
          ${rule.declarations.map(
            ([property, value]) => html`<li><code>${property}: ${value};</code></li>`
          )}
        </ul>
      </div>
    `;
  }

  // -------------------------------------------------------------------------
  // Console
  // -------------------------------------------------------------------------

  private get visibleMessages(): ConsoleEntry[] {
    const needle = this.search.trim().toLowerCase();
    return this.messages.filter(
      entry =>
        this.engines.includes(entry.engine) &&
        this.levels.includes(levelOf(entry)) &&
        (needle === '' || textOf(entry).toLowerCase().includes(needle))
    );
  }

  /** Kept in the canonical order, so the summary reads the same however it was reached. */
  private static toggled<T>(chosen: T[], all: T[], value: T): T[] {
    return chosen.includes(value)
      ? chosen.filter(candidate => candidate !== value)
      : all.filter(candidate => chosen.includes(candidate) || candidate === value);
  }

  /**
   * One of the two filters: a summary you can read at a glance, and the whole
   * list of choices behind it.
   *
   * Shaped after the developer tools this sits beside, because a console
   * filter is a thing people already know how to use and there is nothing to
   * be gained by it working differently here.
   */
  private renderFilter<T extends string>(
    name: string,
    summary: string,
    all: T[],
    labels: Record<T, string>,
    chosen: T[],
    choose: (next: T[]) => void
  ) {
    return html`
      <devkit-popover class="filter" placement="bottom-start" label=${name}>
        <button slot="trigger" class="filter-trigger" type="button">
          ${summary}
          <ph-caret-down></ph-caret-down>
        </button>
        <button
          type="button"
          class="choice all"
          @click=${() => choose([...all])}
          ?disabled=${chosen.length === all.length}
        >
          All ${name}
        </button>
        <span class="ruler"></span>
        ${all.map(
          value => html`
            <button
              type="button"
              class="choice"
              role="menuitemcheckbox"
              aria-checked=${ariaBoolean(chosen.includes(value))}
              @click=${() => choose(InspectorComponent.toggled(chosen, all, value))}
            >
              <span class="tick">
                ${chosen.includes(value) ? html`<ph-check></ph-check>` : nothing}
              </span>
              ${labels[value]}
            </button>
          `
        )}
      </devkit-popover>
    `;
  }

  /** "All levels", the one that is left, or how many there are. */
  private static summarise<T extends string>(
    chosen: T[],
    all: T[],
    labels: Record<T, string>,
    name: string
  ): string {
    if (chosen.length === all.length) {
      return `All ${name}`;
    }
    if (chosen.length === 0) {
      return `No ${name}`;
    }
    const [only] = chosen;
    return only !== undefined && chosen.length === 1 ? labels[only] : `${chosen.length} ${name}`;
  }

  /**
   * One stream rather than three.
   *
   * Every row says which engine printed it, which is what makes a line only one
   * of them printed visible at a glance — three separate lists would put that
   * same fact in the gaps between them, where it has to be looked for. The
   * engine chips turn columns off for when the noise is coming from one of them.
   */
  private renderConsole() {
    const visible = this.visibleMessages;
    return html`
      <div class="body console" role="tabpanel" aria-labelledby="tab-console">
        <div class="controls">
          ${this.renderFilter(
            'levels',
            InspectorComponent.summarise(
              this.levels,
              CONSOLE_LEVELS,
              CONSOLE_LEVEL_LABELS,
              'levels'
            ),
            CONSOLE_LEVELS,
            CONSOLE_LEVEL_LABELS,
            this.levels,
            next => {
              this.levels = next;
            }
          )}
          ${this.renderFilter(
            'engines',
            InspectorComponent.summarise([...this.engines], [...ENGINES], ENGINE_LABELS, 'engines'),
            [...ENGINES],
            ENGINE_LABELS,
            this.engines,
            next => {
              this.engines = next;
            }
          )}
          <input
            type="search"
            placeholder="Filter"
            .value=${this.search}
            @input=${(event: globalThis.Event) => {
              this.search = (event.target as HTMLInputElement).value;
            }}
          >
          <span class="count">${visible.length}/${this.messages.length}</span>
          <devkit-icon-button
            label="Clear the console"
            @click=${() => this.emit('devkit-console-clear')}
          >
            <ph-trash></ph-trash>
          </devkit-icon-button>
        </div>

        <ol class="log">
          ${repeat(
            visible,
            entry => `${entry.engine}:${entry.seq}`,
            entry => this.renderEntry(entry)
          )}
        </ol>
        ${
          this.messages.length > 0 && visible.length === 0
            ? html`<p class="hint">Nothing matches the filter.</p>`
            : nothing
        }
        ${this.renderEvaluations()} ${this.renderExpressionField()}
      </div>
    `;
  }

  private renderEntry(entry: ConsoleEntry) {
    const level = levelOf(entry);
    const source = sourceOf(entry);
    return html`
      <li data-level=${level} data-engine=${entry.engine}>
        <div class="who">
          <span class="engine">${ENGINE_LABELS[entry.engine]}</span>
          <span class="when">${timeOf(entry)}</span>
        </div>
        <div class="what">
          <div class="said">
            ${
              entry.type === 'console' && entry.kind !== 'message'
                ? html`<span class="kind" title=${entry.nativeKind}>${entry.kind}</span>`
                : nothing
            }
            <span class="text">${textOf(entry)}</span>
            ${
              entry.type === 'console' && entry.repeats
                ? html`<span class="repeats">×${entry.repeats}</span>`
                : nothing
            }
            ${
              entry.dropped
                ? html`<span class="dropped" title="Messages discarded to keep up">
                    +${entry.dropped} dropped
                  </span>`
                : nothing
            }
          </div>
          ${
            entry.type === 'page-error' && entry.stack
              ? html`<pre class="stack">${entry.stack}</pre>`
              : nothing
          }
          ${
            source === null
              ? nothing
              : html`<span class="where"
                  ><span class="head">${source.head}</span
                  ><span class="tail">${source.tail}</span></span
                >`
          }
        </div>
      </li>
    `;
  }

  private renderEvaluations() {
    return html`
      <ol class="evaluations">
        ${repeat(
          this.evaluations,
          evaluation => evaluation.id,
          evaluation => html`
            <li>
              <p class="expression"><code>${evaluation.expression}</code></p>
              <ul>
                ${evaluation.results.map(
                  ({ engine, result }) => html`
                    <li data-kind=${result.kind}>
                      <span class="engine">${ENGINE_LABELS[engine]}</span>
                      ${
                        result.kind === 'value'
                          ? html`<span class="type">${result.type}</span
                              ><code>${result.preview}</code>`
                          : html`<code class="failed">${result.message}</code>`
                      }
                    </li>
                  `
                )}
              </ul>
            </li>
          `
        )}
      </ol>
    `;
  }

  /**
   * One expression, three answers.
   *
   * Sent to every pane at once for the same reason input is: what a single
   * engine returns is something its own developer tools already say, and the
   * question worth asking here is where the three differ.
   */
  private renderExpressionField() {
    return html`
      <form
        class="ask"
        @submit=${(event: SubmitEvent) => {
          event.preventDefault();
          const expression = this.expressionField.value.trim();
          if (expression === '') {
            return;
          }
          this.emit('devkit-evaluate', expression);
          this.expressionField.value = '';
        }}
      >
        <input
          class="expression"
          type="text"
          spellcheck="false"
          autocomplete="off"
          placeholder="Evaluate in all three engines…"
        >
      </form>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'devkit-inspector': InspectorComponent;
  }
  interface HTMLElementEventMap {
    'devkit-inspector-tab': CustomEvent<Tab>;
    'devkit-inspector-dock': CustomEvent<InspectorDock>;
    'devkit-inspector-close': CustomEvent<void>;
    'devkit-console-clear': CustomEvent<void>;
    'devkit-evaluate': CustomEvent<string>;
    'devkit-pick': CustomEvent<boolean>;
  }
}
