/* eslint-disable no-console */
/**
 * End-to-end test that two comparisons in one sidecar never touch.
 *
 * A session is one window, and the sidecar holds several of them at once. Every
 * piece of that separation is a key somewhere — panes by session, frames by
 * slot, events stamped on the way out — and a single one of them left keyed by
 * engine alone is enough to hand one window the other's page. Which is exactly
 * the failure nobody would report as a bug: two windows that look plausible and
 * show the wrong thing.
 *
 * So both sessions are driven at once, deliberately out of step, and three
 * things are checked:
 *
 * - every event is stamped with a session, and with the right one
 * - every frame carries its own session's slot
 * - each session's page is the one it navigated to, not the other's
 *
 * One engine rather than three: this is about the keys, not about the engines,
 * and Chromium alone keeps the test to a few seconds.
 *
 *   bun run verify:sessions
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:net';

const HEADER_BYTES = 16;
const TOKEN_BYTES = 32;
const ENGINES = ['chromium', 'firefox', 'webkit'];
const LAUNCH_MS = 9000;
const LOAD_MS = 4000;

/** The two windows, as the backend would name them, with the slots it hands out. */
const SESSIONS = [
  { id: 'main', slot: 0, viewport: { width: 640, height: 480, scale: 1 }, title: 'left' },
  { id: 's1', slot: 1, viewport: { width: 800, height: 600, scale: 1 }, title: 'right' },
];

/** Different enough that a page served to the wrong window is unmistakable. */
function page(title: string): string {
  return `data:text/html,${encodeURIComponent(`<title>${title}</title><h1>${title}</h1>`)}`;
}

interface Frame {
  slot: number;
  engine: string;
  width: number;
}
const frames: Frame[] = [];
const token = randomBytes(TOKEN_BYTES / 2).toString('hex');

/** Stand in for the Rust side of the frame channel. */
const server = createServer(socket => {
  let buffer = Buffer.alloc(0);
  let authenticated = false;
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    if (!authenticated) {
      if (buffer.length < TOKEN_BYTES) {
        return;
      }
      buffer = buffer.subarray(TOKEN_BYTES);
      authenticated = true;
    }
    for (;;) {
      if (buffer.length < HEADER_BYTES) {
        return;
      }
      const length = buffer.readUInt32LE(0);
      if (buffer.length < HEADER_BYTES + length) {
        return;
      }
      frames.push({
        slot: buffer.readUInt8(15),
        engine: ENGINES[buffer.readUInt8(12)] ?? 'unknown',
        width: buffer.readUInt16LE(8),
      });
      buffer = buffer.subarray(HEADER_BYTES + length);
    }
  });
});

await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

const sidecar = spawn('node', ['dist/index.js'], {
  env: {
    ...process.env,
    DEVKIT_FRAME_PORT: String((server.address() as AddressInfo).port),
    DEVKIT_FRAME_TOKEN: token,
  },
  stdio: ['pipe', 'pipe', 'inherit'],
});

interface Emission {
  type: string;
  session?: string;
  engine?: string;
  url?: string;
  title?: string;
}
const events: Emission[] = [];

let buffered = '';
sidecar.stdout.on('data', (chunk: Buffer) => {
  buffered += chunk.toString();
  const lines = buffered.split('\n');
  buffered = lines.pop() ?? '';
  lines
    .filter(line => line.trim().length > 0)
    .forEach(line => {
      try {
        events.push(JSON.parse(line) as Emission);
      } catch {
        console.error(`unparsable line: ${line.slice(0, 200)}`);
      }
    });
});

let id = 0;
/** Send as the backend does: the session and its slot stamped on every command. */
const send = (session: (typeof SESSIONS)[number], message: Record<string, unknown>) =>
  sidecar.stdin.write(
    `${JSON.stringify({ id: String(++id), session: session.id, slot: session.slot, ...message })}\n`
  );
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

console.log('Starting two sessions…');
SESSIONS.forEach(session =>
  send(session, {
    type: 'start',
    engines: ['chromium'],
    viewport: session.viewport,
    colorScheme: 'light',
  })
);
await wait(LAUNCH_MS);

console.log('Navigating them apart…');
SESSIONS.forEach(session => send(session, { type: 'navigate', url: page(session.title) }));
await wait(LOAD_MS);

const failures: string[] = [];

/** What the sidecar said about the process rather than about a comparison. */
const GLOBAL = ['hello', 'browsers', 'install-progress', 'log'];

const unstamped = events.filter(
  event => !GLOBAL.includes(event.type) && event.session === undefined
);
if (unstamped.length > 0) {
  const kinds = [...new Set(unstamped.map(event => event.type))].join(', ');
  failures.push(`${unstamped.length} event(s) arrived with no session: ${kinds}`);
}

const strangers = events.filter(
  event => event.session !== undefined && !SESSIONS.some(session => session.id === event.session)
);
if (strangers.length > 0) {
  failures.push(`${strangers.length} event(s) named a session nobody opened`);
}

SESSIONS.forEach(session => {
  const mine = frames.filter(frame => frame.slot === session.slot);
  if (mine.length === 0) {
    failures.push(`${session.id}: produced no frames at all`);
  }

  // Each session asked for its own viewport, so a frame's width says whose pane
  // it came from — a second check on the slot, from the other direction.
  const foreign = mine.filter(frame => frame.width !== session.viewport.width);
  if (foreign.length > 0) {
    failures.push(
      `${session.id}: ${foreign.length} frame(s) at the wrong size — ` +
        `expected ${session.viewport.width}px, saw ${[...new Set(foreign.map(f => f.width))].join(', ')}px`
    );
  }

  const navigations = events.filter(
    event => event.type === 'navigation' && event.session === session.id
  );
  const wrong = navigations.filter(
    event => event.url !== undefined && !event.url.includes(encodeURIComponent(session.title))
  );
  if (navigations.length === 0) {
    failures.push(`${session.id}: never reported a navigation`);
  }
  if (wrong.length > 0) {
    failures.push(
      `${session.id}: reported ${wrong.length} navigation(s) to the other session's page`
    );
  }

  console.log(
    `  ${session.id.padEnd(5)} ${String(mine.length).padStart(3)} frames at ${session.viewport.width}px   ` +
      `${navigations.length} navigation(s)`
  );
});

SESSIONS.forEach(session => send(session, { type: 'close-session' }));
await wait(500);
sidecar.stdin.write(`${JSON.stringify({ id: String(++id), type: 'shutdown' })}\n`);
server.close();

if (failures.length > 0) {
  console.error('\nSESSIONS ARE NOT SEPARATE\n');
  failures.forEach(failure => console.error(`  - ${failure}`));
  console.error(
    '\nTwo windows sharing anything here is two windows showing each other their pages,' +
      '\nwhich looks like a working app right up until somebody reads what is on screen.\n'
  );
  process.exit(1);
}

console.log('\nTwo sessions, nothing shared.\n');
process.exit(0);
