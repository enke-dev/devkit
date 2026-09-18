import type { Engine, InputEvent } from '@devkit/protocol';

import type { PaneComponent } from '../components/pane/pane.component.js';

export interface InputHandlers {
  /**
   * Local feedback, called synchronously for every event. Never paced — this is
   * what makes input feel acknowledged while the engines are still catching up.
   */
  preview: (event: InputEvent, source: Engine) => void;
  /**
   * Send the event to the engines. Resolves when they have replayed it, which
   * is what paces the stream; it must not reject.
   */
  forward: (event: InputEvent, source: Engine) => Promise<void>;
  /** The pointer entered this pane, making it the one being driven. */
  enter: (source: Engine) => void;
  /** The pointer left this pane, so any stand-in cursors should go. */
  leave: (source: Engine) => void;
}

const BUTTONS = ['left', 'middle', 'right'] as const;

function button(index: number): 'left' | 'middle' | 'right' {
  return BUTTONS[index] ?? 'left';
}

/**
 * Turn pointer and keyboard activity over a pane into protocol input events.
 *
 * Continuous input (movement and scrolling) is paced against the engines rather
 * than against the clock: the next event goes out only once the previous one has
 * been replayed. Emitting on a fixed schedule instead lets a standing queue form
 * the first time the engines fall behind — and because the send rate then equals
 * the drain rate exactly, that queue never empties again. The result is input
 * latency that ratchets up over a session and stays up.
 *
 * Pacing keeps at most one event in flight, so a slow moment costs one event of
 * delay instead of a permanent backlog. Discrete events (buttons, keys, text)
 * are sent immediately: they are not superseded by a newer one and dropping or
 * delaying them would lose real intent.
 */
export function attachInput(view: PaneComponent, handlers: InputHandlers): void {
  const surface = view.surface;

  const emit = (event: InputEvent) => {
    handlers.preview(event, view.engine);
    void handlers.forward(event, view.engine);
  };

  let pendingMove: { x: number; y: number } | null = null;
  let pendingWheel: { x: number; y: number; deltaX: number; deltaY: number } | null = null;
  let inFlight = false;

  /** Send whatever continuous input is outstanding, newest position only. */
  const pump = () => {
    if (inFlight) {
      return;
    }
    let event: InputEvent | null = null;
    if (pendingWheel) {
      event = { kind: 'wheel', ...pendingWheel };
      pendingWheel = null;
    } else if (pendingMove) {
      event = { kind: 'mousemove', ...pendingMove };
      pendingMove = null;
    }
    if (!event) {
      return;
    }

    inFlight = true;
    void handlers.forward(event, view.engine).then(() => {
      inFlight = false;
      pump();
    });
  };

  surface.addEventListener('pointermove', event => {
    const point = view.toViewportPoint(event.clientX, event.clientY);
    if (!point) {
      return;
    }
    // Feedback is immediate; only the send waits its turn. A superseded
    // position is simply overwritten — nobody wants to watch a cursor retrace
    // where it has already been.
    handlers.preview({ kind: 'mousemove', ...point }, view.engine);
    pendingMove = point;
    pump();
  });

  surface.addEventListener('pointerdown', event => {
    const point = view.toViewportPoint(event.clientX, event.clientY);
    if (!point) {
      return;
    }
    event.preventDefault();
    // Any queued move is now stale, and replaying it after the press would put
    // the cursor in the wrong place.
    pendingMove = null;
    emit({ kind: 'mousedown', ...point, button: button(event.button) });
  });

  surface.addEventListener('pointerup', event => {
    const point = view.toViewportPoint(event.clientX, event.clientY);
    if (!point) {
      return;
    }
    emit({ kind: 'mouseup', ...point, button: button(event.button) });
  });

  surface.addEventListener('contextmenu', event => event.preventDefault());

  // Entering the pane is what makes it active. There is no separate notion of
  // focus: the pane under the pointer is the one being driven, keyboard
  // included, so nothing has to be clicked first and no focus ring is needed.
  surface.addEventListener('pointerenter', () => handlers.enter(view.engine));

  surface.addEventListener('pointerleave', () => {
    pendingMove = null;
    handlers.leave(view.engine);
  });

  surface.addEventListener(
    'wheel',
    event => {
      const point = view.toViewportPoint(event.clientX, event.clientY);
      if (!point) {
        return;
      }
      event.preventDefault();
      // Scroll deltas accumulate rather than replace: each one is a distinct
      // amount of scrolling, so dropping any would lose distance travelled.
      pendingWheel = {
        ...point,
        deltaX: (pendingWheel?.deltaX ?? 0) + event.deltaX,
        deltaY: (pendingWheel?.deltaY ?? 0) + event.deltaY,
      };
      pump();
    },
    { passive: false }
  );
}
