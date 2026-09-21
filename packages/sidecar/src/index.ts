import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';

import type {
  ColorScheme,
  DomNode,
  Engine,
  GlobalEvent,
  InspectedElement,
  Request,
  Viewport,
} from '@devkit/protocol';
import { DOM_WATCH_POLL_MS, ENGINES } from '@devkit/protocol';

import { install, probe } from './browsers.js';
import { closeDetached, detach } from './detached.js';
import { emit, emitFor, log } from './emit.js';
import { closeFrameChannel, connectFrameChannel } from './frame-channel.js';
import { describe, Pane } from './pane.js';
import type { Session } from './session.js';
import { allPanes, closeAllSessions, closeSession, sessionFor } from './session.js';

const require = createRequire(import.meta.url);

function playwrightVersion(): string {
  try {
    return (require('playwright/package.json') as { version: string }).version;
  } catch {
    return 'unknown';
  }
}

function greeting(): GlobalEvent {
  return {
    type: 'hello',
    pid: process.pid,
    playwrightVersion: playwrightVersion(),
    nodeVersion: process.version,
  };
}

/**
 * The panes a command is addressed to, within the session that sent it.
 *
 * `'all'` is the ordinary case for anything the panes do in lockstep; naming
 * one engine is for the things that are worth doing to a single pane, and for
 * an engine that is not running it is simply nobody. Never anybody else's
 * panes: an engine names a column of one window, not every Chromium running.
 */
function targets(session: Session, engine: Engine | 'all'): Pane[] {
  if (engine === 'all') {
    return [...session.panes.values()];
  }
  const pane = session.panes.get(engine);
  return pane === undefined ? [] : [pane];
}

/** Run an action on every live pane of one session, reporting per-engine failures without failing the batch. */
async function forEachPane(session: Session, action: (pane: Pane) => Promise<void>): Promise<void> {
  const results = await Promise.allSettled([...session.panes.values()].map(action));
  results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .forEach(result => log('warn', describe(result.reason)));
}

/**
 * Cursor sampling.
 *
 * Asking an engine what cursor it would show costs a round trip, so it is
 * throttled. A trailing sample matters as much as the throttle: the pointer
 * usually stops on the thing you care about, and without one the last position —
 * the link you are hovering — is the one that never gets sampled.
 */
const CURSOR_SAMPLE_MS = 80;

async function readCursorNow(
  session: Session,
  engine: Engine,
  x: number,
  y: number
): Promise<void> {
  session.cursorSampleAt = Date.now();
  const css = await session.panes.get(engine)?.readCursor(x, y);
  if (!css || session.lastCursorCss.get(engine) === css) {
    return;
  }
  session.lastCursorCss.set(engine, css);
  emitFor(session.id, { type: 'cursor', engine, css });
}

function sampleCursor(session: Session, engine: Engine, x: number, y: number): void {
  if (session.cursorTrailing) {
    clearTimeout(session.cursorTrailing);
  }

  const elapsed = Date.now() - session.cursorSampleAt;
  if (elapsed >= CURSOR_SAMPLE_MS) {
    void readCursorNow(session, engine, x, y);
    return;
  }
  // Too soon: remember this position and sample it once the window closes, so
  // the final resting position is always the one reported.
  session.cursorTrailing = setTimeout(
    () => void readCursorNow(session, engine, x, y),
    CURSOR_SAMPLE_MS - elapsed
  );
}

/** Forget the sampled cursor, so re-entering a pane reports afresh. */
function resetCursor(session: Session): void {
  session.lastCursorCss.clear();
}

async function start(
  session: Session,
  engines: Engine[],
  nextViewport: Viewport,
  nextColorScheme: ColorScheme
): Promise<void> {
  session.viewport = nextViewport;
  session.colorScheme = nextColorScheme;
  const wanted = engines.filter(engine => ENGINES.includes(engine));

  await Promise.allSettled(
    wanted.map(async engine => {
      const existing = session.panes.get(engine);
      if (existing?.alive) {
        // Alive is not the same as working: a pane whose capture failed to start
        // has a browser, a page, and nothing on screen. Asking to start it again
        // is the moment to notice.
        await existing.ensureCapturing();
        // The pane is fine, but whoever asked may not know that: a reloaded
        // frontend has no state and would otherwise show a live pane as idle,
        // with no version, until something happened to restart it.
        emitFor(session.id, { type: 'pane', engine, status: 'live', version: existing.version });
        return;
      }

      // A pane whose browser has gone is replaced rather than skipped. Skipping
      // it — which is what "already started" used to mean — left a dead engine
      // blank for the rest of the session, with no way to bring it back short of
      // restarting the app.
      if (existing) {
        log('info', `${engine} pane was dead; relaunching`);
        session.panes.delete(engine);
        await existing.close().catch(() => {});
      }

      const pane = new Pane(
        session.id,
        session.slot,
        engine,
        session.viewport,
        session.colorScheme
      );
      session.panes.set(engine, pane);
      try {
        await pane.start();
      } catch {
        // `pane.start` already reported the failure; drop it so a retry can relaunch.
        session.panes.delete(engine);
      }
    })
  );
}

/**
 * Ask each addressed pane about an element and report what it said.
 *
 * Every pane answers for itself, and a pane that cannot answer says so in its
 * own event rather than failing the question for the others: an engine that
 * found nothing where two others found something is the finding, and it cannot
 * be reported if one failure sinks the batch.
 */
async function answerInspect(
  session: Session,
  id: string,
  engine: Engine | 'all',
  ask: (pane: Pane) => Promise<InspectedElement | null>
): Promise<void> {
  await Promise.all(
    targets(session, engine).map(async pane => {
      try {
        emitFor(session.id, {
          type: 'inspected',
          id,
          engine: pane.engine,
          element: await ask(pane),
        });
      } catch (error) {
        emitFor(session.id, {
          type: 'inspected',
          id,
          engine: pane.engine,
          element: null,
          error: describe(error),
        });
      }
    })
  );
}

/**
 * Ask each addressed pane for a slice of its tree and report what it said.
 *
 * Shaped like `answerInspect` and for the same reason: three panes answer one
 * question independently, a pane that cannot answer says so in its own event,
 * and none of that may sink the question for the others.
 */
async function answerDomNodes(
  session: Session,
  id: string,
  engine: Engine | 'all',
  ask: (pane: Pane) => Promise<DomNode[] | null>
): Promise<void> {
  await Promise.all(
    targets(session, engine).map(async pane => {
      try {
        const nodes = await ask(pane);
        emitFor(
          session.id,
          nodes === null
            ? {
                type: 'dom-nodes',
                id,
                engine: pane.engine,
                nodes: [],
                // The handle is from a document this pane has left. Saying so is
                // what lets the app drop its tree instead of drawing somebody
                // else's subtree under a row that outlived its page.
                error: 'that node belongs to a document this pane has left',
              }
            : { type: 'dom-nodes', id, engine: pane.engine, nodes }
        );
      } catch (error) {
        emitFor(session.id, {
          type: 'dom-nodes',
          id,
          engine: pane.engine,
          nodes: [],
          error: describe(error),
        });
      }
    })
  );
}

/**
 * Ask every watching pane what changed, and say so.
 *
 * Polled rather than pushed: pushing means exposing a function on the page's
 * global object for the life of the context, and the walker's whole bargain is
 * that it defines one non-enumerable property and nothing else. The timer only
 * exists while something is expanded, so a session that never opens the
 * Elements tab never pays for it.
 */
let domPoll: NodeJS.Timeout | null = null;

async function pollDom(): Promise<void> {
  const watching = allPanes().filter(pane => pane.watchingDom);
  if (watching.length === 0) {
    if (domPoll) {
      clearInterval(domPoll);
      domPoll = null;
    }
    return;
  }

  await Promise.all(
    watching.map(async pane => {
      const drained = await pane.drainDom().catch(() => null);
      if (drained === null) {
        return;
      }
      if (drained === 'invalidated') {
        emitFor(pane.session, { type: 'dom-invalidated', engine: pane.engine });
        return;
      }
      emitFor(pane.session, { type: 'dom-mutated', engine: pane.engine, changes: drained });
    })
  );
}

/** Start the poll if anything is watching and it is not already running. */
function armDomPoll(): void {
  if (domPoll || !allPanes().some(pane => pane.watchingDom)) {
    return;
  }
  // Unreferenced: watching a tree should not be the reason the process stays up.
  domPoll = setInterval(() => void pollDom(), DOM_WATCH_POLL_MS);
  domPoll.unref();
}

async function handle(session: Session, request: Request): Promise<void> {
  switch (request.type) {
    case 'probe':
      // Repeat the greeting: it is written once at spawn, which is before the
      // window exists, so a reloaded frontend has never seen it.
      emit(greeting());
      emit({ type: 'browsers', installed: probe() });
      return;

    case 'install': {
      const installed = probe();
      const wanted = request.engines ?? ENGINES;
      await install(wanted.filter(engine => !installed[engine]));
      emit({ type: 'browsers', installed: probe() });
      return;
    }

    case 'start':
      await start(session, request.engines, request.viewport, request.colorScheme);
      return;

    case 'navigate':
      // The new page has its own idea of what is under the pointer.
      resetCursor(session);
      await forEachPane(session, pane => pane.navigate(request.url));
      return;

    case 'reload':
      await forEachPane(session, pane => pane.reload());
      return;

    case 'resize':
      session.viewport = request.viewport;
      await forEachPane(session, pane => pane.resize(session.viewport));
      return;

    case 'color-scheme':
      await session.panes.get(request.engine)?.setColorScheme(request.scheme);
      return;

    case 'detach': {
      const pane = session.panes.get(request.engine);
      const url = pane?.page?.url();
      if (!pane || !url) {
        throw new Error(`${request.engine} pane is not running`);
      }
      await detach(request.engine, url, pane.emulation);
      return;
    }

    case 'input': {
      // Only the pane under the pointer is asked about the cursor, and only
      // while the pointer is moving over it.
      if (request.source && request.event.kind === 'mousemove') {
        sampleCursor(session, request.source, request.event.x, request.event.y);
      }

      // A pane that is mid-navigation will reject input; that is expected and
      // must not fail the event for the other panes.
      const results = await Promise.allSettled(
        targets(session, request.engine).map(pane => pane.applyInput(request.event))
      );
      results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .forEach(result => log('debug', `input dropped: ${describe(result.reason)}`));
      return;
    }

    case 'inspect':
      await answerInspect(session, request.id, request.engine, pane =>
        pane.inspect(request.x, request.y)
      );
      return;

    case 'remeasure':
      await answerInspect(session, request.id, request.engine, pane => pane.remeasure());
      return;

    case 'deselect':
      await Promise.all(targets(session, request.engine).map(pane => pane.deselect()));
      return;

    case 'dom-root':
      await answerDomNodes(session, request.id, request.engine, pane =>
        pane.domRoot(request.depth)
      );
      return;

    case 'dom-children':
      await answerDomNodes(session, request.id, request.engine, pane =>
        pane.domChildren(request.nodeId, request.depth)
      );
      return;

    case 'dom-describe':
      // Answered by `inspected`, the same event a point inspect produces: the
      // tree changed how an element is named, not what is said about it.
      await answerInspect(session, request.id, request.engine, pane =>
        pane.domDescribe(request.steps)
      );
      return;

    case 'dom-search': {
      const pane = session.panes.get(request.engine);
      const matches = pane ? await pane.domSearch(request.query, request.limit) : [];
      emitFor(session.id, {
        type: 'dom-found',
        id: request.id,
        engine: request.engine,
        matches,
      });
      return;
    }

    case 'dom-watch':
      await Promise.all(
        targets(session, request.engine).map(pane => pane.domWatch(request.nodeIds).catch(() => {}))
      );
      armDomPoll();
      return;

    case 'evaluate': {
      await Promise.all(
        targets(session, request.engine).map(async pane => {
          try {
            const result = await pane.evaluate(request.expression);
            emitFor(session.id, {
              type: 'evaluated',
              id: request.id,
              engine: pane.engine,
              result,
            });
          } catch (error) {
            // An expression that threw is answered by the page itself; this is
            // the pane failing to be asked at all, which is still an answer the
            // column has to show rather than a blank.
            emitFor(session.id, {
              type: 'evaluated',
              id: request.id,
              engine: pane.engine,
              result: { kind: 'error', message: describe(error) },
            });
          }
        })
      );
      return;
    }

    case 'close-session':
      await closeSession(session.id);
      return;

    case 'suspend-session':
      // Declared in the protocol so the shape is settled; a window that asks
      // for it today is answered without being lied to about what happened.
      log('debug', `suspend-session is not implemented yet (${String(request.suspended)})`);
      return;

    case 'shutdown':
      await shutdown(0);
      return;
  }
}

/**
 * How often panes are checked for having quietly stopped.
 *
 * A pane that produces no frames looks exactly like a page where nothing is
 * happening, so absence of frames cannot be the signal — a settled pane is
 * silent for minutes at a time. What can be checked is whether the browser is
 * still there and whether a capture is attached, which is what this does.
 */
const HEARTBEAT_MS = 3000;

function heartbeat(): void {
  allPanes().forEach(pane => {
    // A browser that went without a word, which the pane says once however it
    // is noticed.
    pane.checkAlive();
    if (!pane.alive) {
      return;
    }
    // Alive but silent: the capture failed to start, or stopped with the pane
    // still standing. Nothing else would ever notice.
    void pane.ensureCapturing().catch(error => log('warn', describe(error)));
  });
}

async function shutdown(code: number): Promise<void> {
  closeFrameChannel();
  await Promise.allSettled([closeAllSessions(), closeDetached()]);
  process.exit(code);
}

function parse(line: string): Request | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed === 'object' && parsed !== null && 'type' in parsed && 'id' in parsed) {
      return parsed as Request;
    }
    log('warn', `ignoring malformed command: ${line.slice(0, 200)}`);
    return null;
  } catch {
    log('warn', `ignoring unparsable command: ${line.slice(0, 200)}`);
    return null;
  }
}

function main(): void {
  // Anything Playwright or a dependency prints to stdout would corrupt the
  // protocol stream, so stderr is the only free-form output channel.
  // eslint-disable-next-line no-console -- reassigning it is the point: stdout is the protocol stream
  console.log = (...args: unknown[]) => log('info', args.map(String).join(' '));

  emit(greeting());

  connectFrameChannel();

  // Unreferenced: a heartbeat should not be the reason the process stays up.
  setInterval(heartbeat, HEARTBEAT_MS).unref();

  const input = createInterface({ input: process.stdin });

  // Commands are serialised: a `navigate` must not interleave with the `resize`
  // behind it, or panes end up applying them in different orders.
  let queue: Promise<void> = Promise.resolve();

  input.on('line', line => {
    if (line.trim().length === 0) {
      return;
    }
    const request = parse(line);
    if (!request) {
      return;
    }

    queue = queue.then(async () => {
      // Named before the command runs, so the ack goes back to whoever asked
      // even when the command was `close-session` and the session is gone by
      // the time there is anything to say about it.
      const session = sessionFor(request.session, request.slot);
      try {
        await handle(session, request);
        emitFor(session.id, { type: 'ack', id: request.id, ok: true });
      } catch (error) {
        emitFor(session.id, { type: 'ack', id: request.id, ok: false, error: describe(error) });
      }
    });
  });

  input.on('close', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));
  process.on('SIGINT', () => void shutdown(0));
  process.on('uncaughtException', error => {
    log('error', `uncaught: ${describe(error)}`);
  });
}

main();
