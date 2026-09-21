import type { Engine, SessionId } from '@devkit/protocol';
import { emit, listen } from '@tauri-apps/api/event';
import type { WebviewWindow } from '@tauri-apps/api/webviewWindow';

import type { DomTreeWire } from './dom.utils.js';
import type { ConsoleEntry, Evaluation, InspectAnswer } from './inspect.utils.js';
import type { InspectorDock } from './layout.utils.js';
import { sessionId } from './session-id.utils.js';

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

/**
 * App window to inspector window: what to show.
 *
 * Named per session rather than once. Tauri's events reach every webview that
 * is listening, so two app windows with their inspectors out would each be
 * shown the other's console — and the channel name is the cheapest place to say
 * whose state this is.
 */
export function inspectorStateEvent(session: SessionId): string {
  return `devkit://inspector-state/${session}`;
}

/** Inspector window to app window: what was asked for. */
export function inspectorIntentEvent(session: SessionId): string {
  return `devkit://inspector-intent/${session}`;
}

/**
 * The window label, which is also how it is found again after a reload — and
 * how the inspector knows which app window it belongs to, since a label
 * outlives a reload where a variable does not.
 */
export function inspectorWindowLabel(session: SessionId): string {
  return `inspector:${session}`;
}

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
  void emit(inspectorStateEvent(ownerSession()), state).catch(() => {
    // The window has gone, or has not arrived yet. Its handshake will ask for
    // everything again, so nothing is lost by a push that lands nowhere.
  });
}

export function sendIntent(intent: InspectorIntent): void {
  void emit(inspectorIntentEvent(ownerSession()), intent).catch(() => {});
}

export function onState(handle: (state: InspectorState) => void): Promise<() => void> {
  return listen<InspectorState>(inspectorStateEvent(ownerSession()), ({ payload }) =>
    handle(payload)
  );
}

export function onIntent(handle: (intent: InspectorIntent) => void): Promise<() => void> {
  return listen<InspectorIntent>(inspectorIntentEvent(ownerSession()), ({ payload }) =>
    handle(payload)
  );
}

/** Whether this webview is the detached inspector rather than the app itself. */
export function isInspectorView(): boolean {
  return new URLSearchParams(window.location.search).get('view') === 'inspector';
}

/**
 * The session both sides of this channel are talking about.
 *
 * The app window's own, or — in a detached inspector, whose label is its
 * owner's with a prefix — the window it was opened from. Taken from the label
 * rather than kept in a variable so that a reloaded inspector, which has
 * forgotten everything else, still knows whose console it is showing.
 */
function ownerSession(): SessionId {
  const label = sessionId();
  const prefix = inspectorWindowLabel('');
  return label.startsWith(prefix) ? label.slice(prefix.length) : label;
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
  const label = inspectorWindowLabel(sessionId());
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) {
    await existing.setFocus();
    return;
  }

  const created: WebviewWindow = new WebviewWindow(label, {
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
  const existing = await WebviewWindow.getByLabel(inspectorWindowLabel(sessionId()));
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
