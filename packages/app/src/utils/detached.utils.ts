import type { Engine } from '@devkit/protocol';
import { emit, listen } from '@tauri-apps/api/event';
import type { WebviewWindow } from '@tauri-apps/api/webviewWindow';

import type { DomTreeWire } from './dom.utils.js';
import type { ConsoleEntry, Evaluation, InspectAnswer } from './inspect.utils.js';
import type { InspectorDock } from './layout.utils.js';

/**
 * The inspector in a window of its own.
 *
 * Two webviews, one truth. The app window stays the only place that knows
 * anything: it owns the buffers, it asks the sidecar, and it draws the
 * highlights — because the panes are in it and nothing else can. The detached
 * window is a view, told what to show and reporting what was clicked, which is
 * exactly the arrangement every component in the app already has with the app
 * component. The window boundary changes the transport, not the design.
 *
 * The alternative — a second window subscribing to the sidecar itself, which it
 * could, since the backend broadcasts to every webview — was not taken. It
 * would have two consoles filling independently, diverging the moment one of
 * them missed an event, and a console that opened empty because it had not been
 * listening yet. That is the same mistake as starting the console when the
 * drawer opens rather than when the pane does.
 */

/** App window to inspector window: what to show. */
export const INSPECTOR_STATE_EVENT = 'devkit://inspector-state';

/** Inspector window to app window: what was asked for. */
export const INSPECTOR_INTENT_EVENT = 'devkit://inspector-intent';

/** The window label, which is also how it is found again after a reload. */
export const INSPECTOR_WINDOW = 'inspector';

/**
 * State pushed to the detached window.
 *
 * Incremental for the console, whole for everything else. The console is the
 * only buffer that grows without bound — two thousand entries across the
 * boundary on every new line would be most of what the channel ever carried,
 * and all but one entry of it would already be there.
 */
export type InspectorState =
  | {
      kind: 'snapshot';
      answers: InspectAnswer[];
      messages: ConsoleEntry[];
      evaluations: Evaluation[];
      picking: boolean;
      tab: 'elements' | 'console';
      tree: DomTreeWire | null;
      treeEngines: Engine[];
      searching: boolean;
      matchCount: number | null;
    }
  | { kind: 'answers'; answers: InspectAnswer[] }
  /**
   * The tree, whole.
   *
   * Sent on every change rather than diffed. It changes when somebody opens a
   * twisty or the page moves something they are looking at, which is orders of
   * magnitude rarer than a console line — the one thing here that earned an
   * incremental channel.
   */
  | {
      kind: 'tree';
      tree: DomTreeWire | null;
      treeEngines: Engine[];
      searching: boolean;
      matchCount: number | null;
    }
  | { kind: 'console'; entry: ConsoleEntry }
  | { kind: 'console-cleared' }
  | { kind: 'evaluations'; evaluations: Evaluation[] }
  | { kind: 'picking'; picking: boolean }
  | { kind: 'tab'; tab: 'elements' | 'console' };

/**
 * What the detached window asks for.
 *
 * `ready` is the handshake: a window that has just loaded knows nothing, and
 * the app window cannot tell when its webview finished booting — so the view
 * says so and is answered with a snapshot. It is sent on every load, including
 * a reload of a window that was already open.
 */
export type InspectorIntent =
  | { kind: 'ready' }
  | { kind: 'tab'; tab: 'elements' | 'console' }
  | { kind: 'pick'; picking: boolean }
  | { kind: 'dock'; dock: InspectorDock }
  | { kind: 'close' }
  | { kind: 'evaluate'; expression: string }
  | { kind: 'clear-console' }
  | { kind: 'tree-engine'; engine: Engine }
  | { kind: 'tree-toggle'; nodeId: string; open: boolean }
  | { kind: 'tree-select'; nodeId: string }
  | { kind: 'tree-search'; query: string };

export function sendState(state: InspectorState): void {
  void emit(INSPECTOR_STATE_EVENT, state).catch(() => {
    // The window has gone, or has not arrived yet. Its handshake will ask for
    // everything again, so nothing is lost by a push that lands nowhere.
  });
}

export function sendIntent(intent: InspectorIntent): void {
  void emit(INSPECTOR_INTENT_EVENT, intent).catch(() => {});
}

export function onState(handle: (state: InspectorState) => void): Promise<() => void> {
  return listen<InspectorState>(INSPECTOR_STATE_EVENT, ({ payload }) => handle(payload));
}

export function onIntent(handle: (intent: InspectorIntent) => void): Promise<() => void> {
  return listen<InspectorIntent>(INSPECTOR_INTENT_EVENT, ({ payload }) => handle(payload));
}

/** Whether this webview is the detached inspector rather than the app itself. */
export function isInspectorView(): boolean {
  return new URLSearchParams(window.location.search).get('view') === 'inspector';
}

/**
 * Whether the window is being closed by us rather than by whoever is using it.
 *
 * Both arrive as the same `tauri://destroyed`, and they mean opposite things: a
 * window closed from its own title bar is the inspector being dismissed, while
 * one closed because the drawer is being re-attached is the inspector carrying
 * on somewhere else. Reading the second as the first is what made re-docking
 * from a detached window close the inspector outright — the window went, the
 * panes resized, and nothing came back.
 */
let closingOnPurpose = false;

/**
 * Open the inspector window, or bring back the one that is already open.
 *
 * Imported when it is needed rather than at the top: the window API pulls in
 * machinery the app window has no use for until somebody detaches, and the
 * common case is that nobody ever does.
 */
export async function openInspectorWindow(onClosed: () => void): Promise<void> {
  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
  const existing = await WebviewWindow.getByLabel(INSPECTOR_WINDOW);
  if (existing) {
    await existing.setFocus();
    return;
  }

  const created: WebviewWindow = new WebviewWindow(INSPECTOR_WINDOW, {
    url: 'index.html?view=inspector',
    title: 'DevKit Inspector',
    width: 620,
    height: 760,
    minWidth: 360,
    minHeight: 320,
  });
  // Closing the window is one of the ways the detached inspector is dismissed,
  // and a preference that outlived the window would leave the app believing it
  // had an inspector somewhere. Only when it was not us who closed it, though:
  // re-attaching the drawer closes this window on its way to somewhere else.
  await created.once('tauri://destroyed', () => {
    const deliberate = closingOnPurpose;
    closingOnPurpose = false;
    if (!deliberate) {
      onClosed();
    }
  });
}

export async function closeInspectorWindow(): Promise<void> {
  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
  const existing = await WebviewWindow.getByLabel(INSPECTOR_WINDOW);
  if (!existing) {
    return;
  }
  closingOnPurpose = true;
  try {
    await existing.close();
  } catch {
    // Nothing was closed, so nothing is coming: the flag must not be left
    // standing to swallow the next close, which would be a real one.
    closingOnPurpose = false;
  }
}
