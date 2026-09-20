import type { ConsoleKind, ConsoleLevel, Engine, SourceLocation } from '@devkit/protocol';
import {
  CONSOLE_COALESCE_MS,
  CONSOLE_MESSAGE_TYPES,
  CONSOLE_RATE_LIMIT,
  UNKNOWN_CONSOLE_MESSAGE,
} from '@devkit/protocol';

import { emit } from './emit.js';

interface Pending {
  level: ConsoleLevel;
  kind: ConsoleKind;
  nativeKind: string;
  text: string;
  location: SourceLocation | undefined;
  at: number;
  repeats: number;
}

/** How long the rate limit counts over. */
const WINDOW_MS = 1000;

function sameMessage(a: Pending, b: Pending): boolean {
  return (
    a.level === b.level &&
    a.nativeKind === b.nativeKind &&
    a.text === b.text &&
    a.location?.url === b.location?.url &&
    a.location?.line === b.location?.line
  );
}

/**
 * One engine's console, folded into something three columns can hold.
 *
 * Two things are wrong with passing messages straight through. A page logging
 * inside `requestAnimationFrame` produces sixty a second — times three engines
 * — and this channel queues rather than dropping, because everything else on it
 * matters. And a wall of one repeated line says no more than the line does.
 *
 * So identical consecutive messages are folded into one carrying `repeats`, and
 * beyond `CONSOLE_RATE_LIMIT` the rest are counted rather than sent. Both
 * happen here, before the queue, rather than in the view: a view that throws
 * messages away still paid to receive them.
 *
 * The cost is latency. A message waits up to `CONSOLE_COALESCE_MS` to find out
 * whether it is about to repeat — but only when nothing follows it, since
 * anything different flushes it immediately. That is affordable because nobody
 * watches a console the way they watch a cursor; what must stay instant is
 * `evaluate`, and that answers on its own path.
 */
export class ConsoleRelay {
  readonly #engine: Engine;

  #seq = 0;
  #pending: Pending | null = null;
  #timer: NodeJS.Timeout | null = null;

  /** Messages counted instead of sent, and when the current window opened. */
  #dropped = 0;
  #sent = 0;
  #windowAt = 0;

  constructor(engine: Engine) {
    this.#engine = engine;
  }

  /**
   * A console message, classified twice: how bad it is and what shape it has.
   *
   * The engines are asked for their own word and it is kept — the vocabularies
   * differ, and one of them may later deserve its own treatment — but what the
   * app switches on is the shared pair.
   */
  message(nativeKind: string, text: string, location?: SourceLocation): void {
    const classified = CONSOLE_MESSAGE_TYPES[nativeKind.toLowerCase()] ?? UNKNOWN_CONSOLE_MESSAGE;
    const next: Pending = {
      level: classified.level,
      kind: classified.kind,
      nativeKind,
      text,
      location,
      at: Date.now(),
      repeats: 1,
    };

    if (this.#pending && sameMessage(this.#pending, next)) {
      this.#pending.repeats += 1;
      return;
    }

    // Anything different means the one before it is not going to repeat, so it
    // goes now rather than sitting out the rest of its window.
    this.#flush();
    this.#pending = next;
    this.#timer = setTimeout(() => this.#flush(), CONSOLE_COALESCE_MS);
  }

  /**
   * An uncaught exception or unhandled rejection.
   *
   * Never coalesced: two identical stack traces are two failures, and a page
   * throwing the same error on every frame is exactly what somebody opened this
   * to see. It still shares the rate limit, because a throwing loop is a flood
   * like any other.
   */
  error(message: string, stack?: string): void {
    this.#flush();
    if (!this.#allowed()) {
      return;
    }
    emit({
      type: 'page-error',
      engine: this.#engine,
      seq: this.#seq++,
      at: Date.now(),
      message,
      ...(stack === undefined ? {} : { stack }),
      ...this.#drops(),
    });
  }

  /** Send whatever is held, so nothing is lost when the pane goes. */
  dispose(): void {
    this.#flush();
  }

  #flush(): void {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    const pending = this.#pending;
    this.#pending = null;
    if (!pending || !this.#allowed()) {
      return;
    }

    emit({
      type: 'console',
      engine: this.#engine,
      seq: this.#seq++,
      at: pending.at,
      level: pending.level,
      kind: pending.kind,
      nativeKind: pending.nativeKind,
      text: pending.text,
      ...(pending.location === undefined ? {} : { location: pending.location }),
      ...(pending.repeats > 1 ? { repeats: pending.repeats } : {}),
      ...this.#drops(),
    });
  }

  /**
   * Whether there is room in this second's budget, counting the message against
   * it either way.
   */
  #allowed(): boolean {
    const now = Date.now();
    if (now - this.#windowAt >= WINDOW_MS) {
      this.#windowAt = now;
      this.#sent = 0;
    }
    if (this.#sent >= CONSOLE_RATE_LIMIT) {
      this.#dropped += 1;
      return false;
    }
    this.#sent += 1;
    return true;
  }

  /** What was lost since the last message got through, said once and reset. */
  #drops(): { dropped?: number } {
    if (this.#dropped === 0) {
      return {};
    }
    const dropped = this.#dropped;
    this.#dropped = 0;
    return { dropped };
  }
}
