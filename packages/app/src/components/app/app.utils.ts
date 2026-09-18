import type { Engine, Event, Viewport } from '@devkit/protocol';
import { invoke } from '@tauri-apps/api/core';

import { awaitingAck, takeHandoverTimings } from '../../utils/bridge.utils.js';
import * as history from '../../utils/history.utils.js';
import * as session from '../../utils/session.utils.js';
import type { PaneComponent } from '../pane/pane.component.js';

const HOME_URL = 'https://github.com/enke-dev/devkit';

/**
 * Round down to an even number of pixels.
 *
 * Playwright rounds the screencast size down to even (`width & ~1`), and Gecko
 * handles an odd request badly: asked for 533x858 it returns a 532x856 frame
 * whose first row is spoiled — sampled on a solid red page, rgb(255,139,144)
 * against rgb(204,0,1) — which the pane then stretches into a pale line above
 * the page. Asked for 532x858 it returns exactly that, clean from the first row.
 * It reproduces at device scale 1 as well, so it is the odd number, not the
 * scale.
 *
 * Even panes are better anyway: the frame arrives at exactly the size it is
 * displayed at, so nothing is rescaled on the way to the screen.
 */
export function even(value: number): number {
  return value - (value % 2);
}

/**
 * Every pane shares one viewport size, so the renderings stay comparable: a
 * layout difference between engines should come from the engine, not from one
 * pane being forty pixels wider than the next.
 */
export function sharedViewport(sizes: { width: number; height: number }[]): Viewport {
  return {
    width: even(Math.min(...sizes.map(size => size.width))),
    height: even(Math.min(...sizes.map(size => size.height))),
    scale: Math.min(2, window.devicePixelRatio || 1),
  };
}

export function sameViewport(a: Viewport | null, b: Viewport): boolean {
  return a !== null && a.width === b.width && a.height === b.height && a.scale === b.scale;
}

/**
 * Where to open on a cold start: where the trail stands, so a restart resumes
 * with its back arrow still pointing somewhere.
 */
export function lastVisited(): string {
  return session.current() ?? history.mostRecent()?.url ?? HOME_URL;
}

/** Accept bare hosts and search-ish input the way a browser address bar does. */
export function toUrl(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    return trimmed;
  }
  if (
    /^localhost(:\d+)?(\/|$)/i.test(trimmed) ||
    /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(trimmed)
  ) {
    return `http://${trimmed}`;
  }
  return `https://${trimmed}`;
}

/** Whether an event came out of a text field, which is the app's and not the page's. */
export function fromTextField(event: globalThis.Event): boolean {
  return event.composedPath().some(node => node instanceof HTMLInputElement);
}

/**
 * Count frames as the webview receives them, and report once a second.
 *
 * The sidecar's own accounting says how many frames it produced; this says how
 * many survived the trip. The gap between the two is the cost of the transport.
 */
const received = new Map<Engine, { live: number; sharp: number; lastSharpDims: string }>();

export function countReceivedFrame(engine: Engine, frame: Extract<Event, { type: 'frame' }>): void {
  const tally = received.get(engine) ?? { live: 0, sharp: 0, lastSharpDims: '-' };
  if (frame.sharp) {
    tally.sharp += 1;
    tally.lastSharpDims = `${frame.width}x${frame.height}`;
  } else {
    tally.live += 1;
  }
  received.set(engine, tally);
}

export function startFrameDiagnostics(panes: () => PaneComponent[]): void {
  // A frontend exception would stop every pane updating at once, which is worth
  // telling apart from an engine problem.
  const report = (what: string, detail: unknown) =>
    void invoke('debug_log', { message: `${what}: ${String(detail)}`.slice(0, 400) }).catch(
      () => {}
    );
  window.addEventListener('error', event => report('UI ERROR', event.message));
  window.addEventListener('unhandledrejection', event => report('UI REJECTION', event.reason));

  window.setInterval(() => {
    if (received.size === 0) {
      return;
    }
    const line = [...received.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([engine, tally]) => {
        const pane = panes().find(candidate => candidate.engine === engine);
        const failed = pane?.failed ? ` FAILED=${pane.failed}(${pane.lastFailure})` : '';
        const blanks = pane?.blanks ? ` blank=${pane.blanks}/${pane.lastBlankMs}ms` : '';
        const fetched = pane?.takeFetchTimings();
        const fetch = fetched?.count ? ` fetch=${fetched.p50}/${fetched.p95}ms` : '';
        return `${engine} sharp=${tally.sharp}@${tally.lastSharpDims} shown@${pane?.shownDims ?? '-'} live=${tally.live}${fetch}${blanks}${failed}`;
      })
      .join('  ');
    received.clear();
    panes().forEach(pane => {
      pane.loaded = 0;
      pane.blanks = 0;
    });
    // A rising count means acks are going missing, which silently stops the
    // paced input that waits on them.
    const waiting = awaitingAck();
    const handover = takeHandoverTimings();
    const ipc = handover.count ? `  ipc=${handover.p50}/${handover.p95}ms x${handover.count}` : '';
    void invoke('debug_log', {
      message: `received: ${line}${ipc}${waiting > 0 ? `  awaitingAck=${waiting}` : ''}`,
    }).catch(() => {});
  }, 1000);
}
