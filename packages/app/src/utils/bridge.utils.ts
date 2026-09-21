import type { Command, Event, SidecarStatus } from '@devkit/protocol';
import { PRIVACY_SETTINGS_URL, SIDECAR_EVENT, SIDECAR_STATUS_EVENT } from '@devkit/protocol';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import type { Timings } from './timing.utils.js';
import { takeTimings } from './timing.utils.js';

/**
 * Frontend end of the sidecar protocol.
 *
 * Commands go out through a Tauri command; every reply — including the `ack`
 * for the command just sent — comes back on the event channel. Sending returns
 * a promise that settles on the matching ack, so callers can await a navigation
 * without inventing their own correlation.
 */

let nextId = 0;
const pending = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();

/** How long the last second's commands took to reach the backend. */
const handovers: number[] = [];

/**
 * Send, and say which id the answers will carry.
 *
 * Most commands are answered only by their `ack`, which `send` already waits
 * on. `inspect` and `evaluate` are answered by an event per pane as well, and
 * those events name the command rather than the pane — so a caller that asked
 * three questions in a row has to know which of them a given answer belongs to,
 * and the id is the only thing that says.
 */
export function sendTracked(command: Command): { id: string; done: Promise<void> } {
  const id = `c${nextId++}`;
  const done = new Promise<void>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    const startedAt = performance.now();
    invoke('sidecar_send', { request: { ...command, id } })
      .then(() => handovers.push(performance.now() - startedAt))
      .catch((error: unknown) => {
        pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
  });
  return { id, done };
}

export function send(command: Command): Promise<void> {
  return sendTracked(command).done;
}

/**
 * What it costs to hand a command to the backend, taken here rather than from a
 * profiler: attaching one captures screenshots of its own and inflates exactly
 * this number.
 *
 * Reading them clears them, so each report covers the interval since the last.
 */
export function takeHandoverTimings(): Timings {
  return takeTimings(handovers);
}

/**
 * How many commands are still waiting for their ack.
 *
 * A number that climbs and never falls means replies are going missing, and a
 * caller that paces itself against one is waiting for something that will not
 * arrive.
 */
export function awaitingAck(): number {
  return pending.size;
}

export function restart(): Promise<void> {
  return invoke('sidecar_restart');
}

/**
 * Open the Settings pane a blocked engine needs a grant from.
 *
 * Opening it is all anyone can do: macOS has no way to ask for these grants,
 * only to show where they are given.
 */
export function openPrivacySettings(): Promise<void> {
  return invoke('open_privacy_settings', { url: PRIVACY_SETTINGS_URL });
}

function settle(event: Extract<Event, { type: 'ack' }>): void {
  const waiter = pending.get(event.id);
  if (!waiter) {
    return;
  }

  // Commands are answered in the order they were sent, so anything still
  // waiting ahead of this one is never going to be answered — a line the
  // sidecar could not read carries no id and is dropped without a reply. Left
  // alone those promises settle neither way, and a caller pacing itself against
  // one waits for the rest of the session.
  for (const [id, stale] of pending) {
    if (id === event.id) {
      break;
    }
    pending.delete(id);
    stale.reject(new Error('no reply; the command before it was dropped'));
  }

  pending.delete(event.id);
  if (event.ok) {
    waiter.resolve();
  } else {
    waiter.reject(new Error(event.error));
  }
}

export async function connect(handlers: {
  onEvent: (event: Event) => void;
  onStatus: (status: SidecarStatus) => void;
}): Promise<void> {
  await listen<Event>(SIDECAR_EVENT, ({ payload }) => {
    if (payload.type === 'ack') {
      settle(payload);
    }
    handlers.onEvent(payload);
  });
  await listen<SidecarStatus>(SIDECAR_STATUS_EVENT, ({ payload }) => {
    if (payload.kind !== 'spawned') {
      // The sidecar is gone; nothing will ever ack these.
      pending.forEach(waiter => waiter.reject(new Error('sidecar stopped')));
      pending.clear();
    }
    handlers.onStatus(payload);
  });
}
