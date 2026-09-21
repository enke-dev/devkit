import type { Emission, GlobalEvent, SessionId, SessionScopedEvent } from '@devkit/protocol';

/**
 * Newline-delimited JSON writer for stdout.
 *
 * Only control messages travel here — frames go over their own socket — so this
 * queues rather than dropping: every message on this channel matters.
 *
 * Two doors rather than one, because there are two kinds of message and the
 * difference is not one to leave to whoever is writing the call. `emit` is for
 * the handful that describe the process — the greeting, the installed browsers,
 * a download's progress, a log line — and reaches every window. Everything else
 * is one session's business and goes through `emitFor`, which is the only way
 * to say so; the types make forgetting it a compile error rather than an event
 * that quietly lands in all three windows.
 */

let draining = false;
let pendingOther: Emission[] = [];

function writeNow(event: Emission): void {
  const line = `${JSON.stringify(event)}\n`;
  if (!process.stdout.write(line)) {
    draining = true;
    process.stdout.once('drain', () => {
      draining = false;
      flush();
    });
  }
}

function flush(): void {
  const other = pendingOther;
  pendingOther = [];
  other.forEach(event => {
    if (draining) {
      pendingOther.push(event);
    } else {
      writeNow(event);
    }
  });
}

function write(event: Emission): void {
  if (!draining) {
    writeNow(event);
    return;
  }
  pendingOther.push(event);
}

/** Say something about the process itself, to every window at once. */
export function emit(event: GlobalEvent): void {
  write(event);
}

/** Say something about one session's panes, to the window that owns them. */
export function emitFor(session: SessionId, event: SessionScopedEvent): void {
  write({ ...event, session });
}

export function log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
  emit({ type: 'log', level, message });
}
