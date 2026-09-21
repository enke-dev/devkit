import type { Command, DomNode, Engine, Event, InspectedElement } from '@devkit/protocol';
import { ENGINES, SIDECAR_EVENT } from '@devkit/protocol';

/**
 * The real app, with the backend replaced by something this file can time.
 *
 * The app's hardest bugs have all been orderings: an answer that arrives before
 * the thing it belongs to, a tree replaced under a reveal that was walking it.
 * Those depend on which of three round trips lands first, so on a quiet machine
 * they are nearly unreachable and in a real session they are luck. Here every
 * answer is delivered by hand, so the order is the test rather than the weather.
 *
 * Nothing is stubbed above the bridge. The component tree, its state and every
 * decision under test are the ones that ship; only the two functions Tauri
 * would have provided are ours.
 */

const sent: (Command & { id: string })[] = [];
const handlers = new Map<string, (event: { payload: unknown }) => void>();
const answered = new Set<string>();
let nextCallback = 0;

const deliver = (event: Event): void => {
  handlers.get(SIDECAR_EVENT)?.({ payload: event });
};

// Enough of Tauri for the bridge to work against, and no more: a command
// channel that records and acknowledges, and an event channel to push through.
Object.defineProperty(globalThis, '__TAURI_INTERNALS__', {
  value: {
    transformCallback(callback: (payload: unknown) => void) {
      nextCallback += 1;
      (globalThis as Record<string, unknown>)[`_${nextCallback}`] = callback;
      return nextCallback;
    },
    invoke(command: string, args: Record<string, unknown>) {
      if (command === 'plugin:event|listen') {
        const callback = (globalThis as Record<string, unknown>)[`_${String(args.handler)}`];
        handlers.set(String(args.event), callback as (event: { payload: unknown }) => void);
        return Promise.resolve(1);
      }
      if (command === 'sidecar_send') {
        const request = args.request as Command & { id: string };
        sent.push(request);
        // Acknowledged straight back, because the app paces itself against
        // acks: a command that is never answered leaves whatever sent it
        // waiting for the rest of the session.
        queueMicrotask(() => deliver({ type: 'ack', id: request.id, ok: true }));
      }
      return Promise.resolve(null);
    },
  },
});

await import('../../src/components/app/app.component.js');

const app = document.createElement('devkit-app');
document.body.append(app);

/** Every command of one kind, oldest first. */
const of = <T extends Command['type']>(
  type: T
): (Extract<Command, { type: T }> & { id: string })[] =>
  sent.filter(
    (command): command is Extract<Command, { type: T }> & { id: string } => command.type === type
  );

const node = (nodeId: string, name: string, step: string, children?: DomNode[]): DomNode => ({
  nodeId,
  kind: 'element',
  name,
  classes: [],
  attributes: [],
  step,
  childCount: children?.length ?? 0,
  ...(children ? { children } : {}),
});

/**
 * A page shaped to make a reveal do some work.
 *
 * Handles are prefixed per engine, because that is the one rule the protocol
 * will not bend: a handle means nothing in a pane that did not mint it, and a
 * test whose engines share them would pass whatever the app did with them.
 *
 * Three levels come with the root and the fourth does not, so revealing the
 * leaf has to ask for something rather than finding it already in hand.
 */
const rootFor = (engine: string): DomNode => ({
  ...node(`${engine}:doc`, '#document', 'document', [
    node(`${engine}:html`, 'html', 'html[0]', [
      node(`${engine}:body`, 'body', 'body[0]', [node(`${engine}:wrap`, 'div', 'div[0]')]),
    ]),
  ]),
  kind: 'document',
});

const leafOf = (engine: string): DomNode[] => [node(`${engine}:leaf`, 'span', 'span[0]')];

const rect = { x: 0, y: 0, width: 1, height: 1 };

/** What a pane says about the leaf: a description, and the handles to reach it. */
const describedLeaf = (engine: string): InspectedElement =>
  ({
    tag: 'span',
    classes: [],
    index: 0,
    attributes: [],
    path: [],
    documentUrl: 'http://example.test/',
    box: { content: rect, padding: rect, border: rect, margin: rect },
    styles: {},
    rules: [],
    nodeId: `${engine}:leaf`,
    ancestors: [`${engine}:doc`, `${engine}:html`, `${engine}:body`, `${engine}:wrap`],
  }) as unknown as InspectedElement;

const treeElement = () =>
  app.shadowRoot?.querySelector('devkit-inspector')?.shadowRoot?.querySelector('devkit-dom-tree') ??
  null;

/**
 * Everything the harness offers the driver.
 *
 * Put on the window under one name rather than exported, because the driver is
 * a separate process talking to a page: what it sends across is the text of a
 * function, and the only things that function can reach are the page's own
 * globals.
 */
Object.assign(globalThis, {
  harness: {
    /** Bring the panes up the way the backend does: engines first, then panes. */
    bringUp() {
      deliver({ type: 'browsers', installed: { chromium: true, firefox: true, webkit: true } });
      ENGINES.forEach(engine => deliver({ type: 'pane', engine, status: 'live' }));
    },

    /**
     * Open the drawer the way the toolbar does.
     *
     * Straight at the method: the event that normally reaches it is dispatched by
     * a child, and would not be heard coming from outside. Private is a
     * compile-time word, and this is the call the button makes.
     */
    openInspector() {
      (app as unknown as { setInspecting(open: boolean): void }).setInspecting(true);
    },

    /** Take a pick, and answer it in every engine. */
    pick() {
      (app as unknown as { askInspect(x: number, y: number): void }).askInspect(10, 10);
      const id = of('inspect').at(-1)?.id ?? '';
      ENGINES.forEach(engine =>
        deliver({ type: 'inspected', id, engine, element: describedLeaf(engine) })
      );
    },

    /** Take a pick without answering it, so the answer can be timed by hand. */
    askPick() {
      (app as unknown as { askInspect(x: number, y: number): void }).askInspect(10, 10);
      return of('inspect').at(-1)?.id ?? '';
    },

    answerPick(id: string) {
      ENGINES.forEach(engine =>
        deliver({ type: 'inspected', id, engine, element: describedLeaf(engine) })
      );
    },

    /** Answer the newest outstanding request for a document. */
    answerRoot() {
      const root = of('dom-root').at(-1);
      if (!root || answered.has(root.id)) {
        return false;
      }
      answered.add(root.id);
      deliver({
        type: 'dom-nodes',
        id: root.id,
        engine: root.engine as Engine,
        nodes: [rootFor(root.engine as string)],
      });
      return true;
    },

    /** Answer every outstanding request for children; says how many there were. */
    answerChildren() {
      const asked = of('dom-children').filter(command => !answered.has(command.id));
      asked.forEach(command => {
        answered.add(command.id);
        deliver({
          type: 'dom-nodes',
          id: command.id,
          engine: command.engine as Engine,
          // Only the wrapper has anything below it; the rest came with the root.
          nodes: command.nodeId.endsWith(':wrap') ? leafOf(command.engine as string) : [],
        });
      });
      return asked.length;
    },

    /** Choose another engine, through the event the tabs actually dispatch. */
    switchEngine(engine: Engine) {
      treeElement()?.dispatchEvent(
        new CustomEvent('devkit-dom-engine', { detail: engine, bubbles: true, composed: true })
      );
    },

    /** What a pane says when its document changed more than it can describe. */
    invalidate(engine: Engine) {
      deliver({ type: 'dom-invalidated', engine });
    },

    /** The rows on screen, as text and selectedness. */
    rows() {
      const scroller = treeElement()?.shadowRoot?.querySelector('.scroller');
      return [...(scroller?.querySelectorAll('.row') ?? [])].map(row => ({
        label: row.textContent?.trim().replace(/\s+/g, ' ') ?? '',
        selected: row.getAttribute('data-selected') === 'true',
      }));
    },

    /** Which engine's tree is on screen, as the tabs report it. */
    markedEngine() {
      const marked = treeElement()
        ?.shadowRoot?.querySelector('devkit-tabs')
        ?.shadowRoot?.querySelector('[aria-selected="true"]');
      return marked?.textContent?.trim() ?? '';
    },

    /** Every command kind sent so far, for a failure that needs explaining. */
    sentTypes() {
      return sent.map(command => command.type);
    },
  },
});
