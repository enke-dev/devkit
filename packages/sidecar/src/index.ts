import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';

import type { ColorScheme, Engine, Event, Request, Viewport } from '@devkit/protocol';
import { ENGINES } from '@devkit/protocol';

import { install, probe } from './browsers.js';
import { emit, log } from './emit.js';
import { closeFrameChannel, connectFrameChannel } from './frame-channel.js';
import { describe, Pane } from './pane.js';

const require = createRequire(import.meta.url);

function playwrightVersion(): string {
  try {
    return (require('playwright/package.json') as { version: string }).version;
  } catch {
    return 'unknown';
  }
}

function greeting(): Event {
  return {
    type: 'hello',
    pid: process.pid,
    playwrightVersion: playwrightVersion(),
    nodeVersion: process.version,
  };
}

const panes = new Map<Engine, Pane>();
let viewport: Viewport = { width: 1280, height: 800, scale: 1 };
let colorScheme: ColorScheme = 'light';

/** Run an action on every live pane, reporting per-engine failures without failing the batch. */
async function forEachPane(action: (pane: Pane) => Promise<void>): Promise<void> {
  const results = await Promise.allSettled([...panes.values()].map(action));
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
const lastCursorCss = new Map<Engine, string>();
let cursorSampleAt = 0;
let cursorTrailing: NodeJS.Timeout | null = null;

async function readCursorNow(engine: Engine, x: number, y: number): Promise<void> {
  cursorSampleAt = Date.now();
  const css = await panes.get(engine)?.readCursor(x, y);
  if (!css || lastCursorCss.get(engine) === css) {
    return;
  }
  lastCursorCss.set(engine, css);
  emit({ type: 'cursor', engine, css });
}

function sampleCursor(engine: Engine, x: number, y: number): void {
  if (cursorTrailing) {
    clearTimeout(cursorTrailing);
  }

  const elapsed = Date.now() - cursorSampleAt;
  if (elapsed >= CURSOR_SAMPLE_MS) {
    void readCursorNow(engine, x, y);
    return;
  }
  // Too soon: remember this position and sample it once the window closes, so
  // the final resting position is always the one reported.
  cursorTrailing = setTimeout(() => void readCursorNow(engine, x, y), CURSOR_SAMPLE_MS - elapsed);
}

/** Forget the sampled cursor, so re-entering a pane reports afresh. */
function resetCursor(): void {
  lastCursorCss.clear();
}

async function start(
  engines: Engine[],
  nextViewport: Viewport,
  nextColorScheme: ColorScheme
): Promise<void> {
  viewport = nextViewport;
  colorScheme = nextColorScheme;
  const wanted = engines.filter(engine => ENGINES.includes(engine));

  await Promise.allSettled(
    wanted.map(async engine => {
      const existing = panes.get(engine);
      if (existing?.alive) {
        // Alive is not the same as working: a pane whose capture failed to start
        // has a browser, a page, and nothing on screen. Asking to start it again
        // is the moment to notice.
        await existing.ensureCapturing();
        // The pane is fine, but whoever asked may not know that: a reloaded
        // frontend has no state and would otherwise show a live pane as idle,
        // with no version, until something happened to restart it.
        emit({ type: 'pane', engine, status: 'live', version: existing.version });
        return;
      }

      // A pane whose browser has gone is replaced rather than skipped. Skipping
      // it — which is what "already started" used to mean — left a dead engine
      // blank for the rest of the session, with no way to bring it back short of
      // restarting the app.
      if (existing) {
        log('info', `${engine} pane was dead; relaunching`);
        panes.delete(engine);
        await existing.close().catch(() => {});
      }

      const pane = new Pane(engine, viewport, colorScheme);
      panes.set(engine, pane);
      try {
        await pane.start();
      } catch {
        // `pane.start` already reported the failure; drop it so a retry can relaunch.
        panes.delete(engine);
      }
    })
  );
}

async function handle(request: Request): Promise<void> {
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
      await start(request.engines, request.viewport, request.colorScheme);
      return;

    case 'navigate':
      // The new page has its own idea of what is under the pointer.
      resetCursor();
      await forEachPane(pane => pane.navigate(request.url));
      return;

    case 'reload':
      await forEachPane(pane => pane.reload());
      return;

    case 'resize':
      viewport = request.viewport;
      await forEachPane(pane => pane.resize(viewport));
      return;

    case 'color-scheme':
      await panes.get(request.engine)?.setColorScheme(request.scheme);
      return;

    case 'input': {
      // Only the pane under the pointer is asked about the cursor, and only
      // while the pointer is moving over it.
      if (request.source && request.event.kind === 'mousemove') {
        sampleCursor(request.source, request.event.x, request.event.y);
      }

      // A pane that is mid-navigation will reject input; that is expected and
      // must not fail the event for the other panes.
      const targets = request.engine === 'all' ? [...panes.values()] : [panes.get(request.engine)];
      const results = await Promise.allSettled(
        targets
          .filter((pane): pane is Pane => pane !== undefined)
          .map(pane => pane.applyInput(request.event))
      );
      results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .forEach(result => log('debug', `input dropped: ${describe(result.reason)}`));
      return;
    }

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
  panes.forEach(pane => {
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
  const closing = [...panes.values()].map(pane => pane.close());
  panes.clear();
  await Promise.allSettled(closing);
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
      try {
        await handle(request);
        emit({ type: 'ack', id: request.id, ok: true });
      } catch (error) {
        emit({ type: 'ack', id: request.id, ok: false, error: describe(error) });
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
