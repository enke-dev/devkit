import type { Event } from '@devkit/protocol';

/**
 * Newline-delimited JSON writer for stdout.
 *
 * Only control messages travel here — frames go over their own socket — so this
 * queues rather than dropping: every message on this channel matters.
 */

let draining = false;
let pendingOther: Event[] = [];

function writeNow(event: Event): void {
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

export function emit(event: Event): void {
  if (!draining) {
    writeNow(event);
    return;
  }
  pendingOther.push(event);
}

export function log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
  emit({ type: 'log', level, message });
}
