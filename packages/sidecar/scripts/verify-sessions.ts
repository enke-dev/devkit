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
 * So both sessions are driven at once, deliberately out of step, and four
 * things are checked:
 *
 * - every event is stamped with a session, and with the right one
 * - every frame carries its own session's slot
 * - each session's page is the one it navigated to, not the other's
 * - two sessions at the same device scale share one browser process, and two at
 *   different scales do not
 * - a suspended session stops producing frames and its neighbour does not, and
 *   it produces them again when it is brought back
 *
 * The last is the other half of the same idea and fails the other way round: a
 * pool that never shares is only wasteful, while a pool that shares what it must
 * not hands a window a browser launched at somebody else's scale factor — a
 * pane that is soft rather than a pane that is wrong, which is exactly the kind
 * of thing nobody reports.
 *
 * One engine rather than three: this is about the keys, not about the engines,
 * and Chromium alone keeps the test to a few seconds.
 *
 *   bun run verify:sessions
 */
import { execFileSync, spawn } from 'node:child_process';
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

/** A third comparison, at the other device scale, which may not share a process. */
const RETINA = {
  id: 's2',
  slot: 2,
  viewport: { width: 640, height: 480, scale: 2 },
  title: 'retina',
};

/**
 * How many browsers the sidecar has open, counted as processes.
 *
 * Its own children rather than everything on the machine: a developer running
 * DevKit while its tests run would otherwise be counted too, and the number
 * this asserts on is precisely "browsers this sidecar launched".
 */
function browserCount(pid: number): number {
  try {
    return execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
      .split('\n')
      .filter(line => line.trim().length > 0).length;
  } catch {
    // `pgrep` exits non-zero when nothing matches, which is a count of none.
    return 0;
  }
}

/** Different enough that a page served to the wrong window is unmistakable. */
function page(title: string): string {
  return `data:text/html,${encodeURIComponent(`<title>${title}</title><h1>${title}</h1>`)}`;
}

/**
 * A page that repaints for ever, so silence means something.
 *
 * Suspending a settled pane is indistinguishable from not suspending it: both
 * produce nothing. The only way to see a capture stop is to stop one that would
 * otherwise still be going.
 */
const MOVING_PAGE =
  'data:text/html,' +
  encodeURIComponent(
    '<style>body{margin:0;background:#222}div{width:60px;height:60px;background:#3b6ef5;' +
      'animation:m 1s linear infinite}@keyframes m{from{transform:translateX(0)}' +
      'to{transform:translateX(300px)}}</style><div></div>'
  );

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

// Both sessions render at the same scale, so the pool has no reason to run two
// Chromiums — and every reason not to, since that is a couple of hundred
// megabytes per window that nobody is looking at differently.
const shared = browserCount(sidecar.pid ?? 0);
if (shared !== 1) {
  failures.push(`two sessions at one scale opened ${shared} browsers, not 1`);
}

console.log('Starting a third session at another device scale…');
send(RETINA, {
  type: 'start',
  engines: ['chromium'],
  viewport: RETINA.viewport,
  colorScheme: 'light',
});
await wait(LAUNCH_MS);

// `--force-device-scale-factor` is fixed when Chromium starts, so this one
// cannot be served by the browser the other two share.
const separate = browserCount(sidecar.pid ?? 0);
if (separate !== 2) {
  failures.push(`a session at a second scale brought the count to ${separate}, not 2`);
}

send(RETINA, { type: 'close-session' });
await wait(2000);
const afterClose = browserCount(sidecar.pid ?? 0);
if (afterClose !== 1) {
  failures.push(`closing the third session left ${afterClose} browsers, not 1`);
}

console.log(
  `  browsers  ${shared} shared · ${separate} with a second scale · ${afterClose} after close`
);

/** What the sidecar said about the process rather than about a comparison. */
const GLOBAL = ['hello', 'browsers', 'install-progress', 'log'];

const unstamped = events.filter(
  event => !GLOBAL.includes(event.type) && event.session === undefined
);
if (unstamped.length > 0) {
  const kinds = [...new Set(unstamped.map(event => event.type))].join(', ');
  failures.push(`${unstamped.length} event(s) arrived with no session: ${kinds}`);
}

const opened = [...SESSIONS, RETINA];
const strangers = events.filter(
  event => event.session !== undefined && !opened.some(session => session.id === event.session)
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

// ---------------------------------------------------------------------------
// Suspending one comparison leaves the other alone
// ---------------------------------------------------------------------------

console.log('Setting both sessions animating…');
SESSIONS.forEach(session => send(session, { type: 'navigate', url: MOVING_PAGE }));
await wait(LOAD_MS);

const [hidden, watched] = SESSIONS;
if (hidden === undefined || watched === undefined) {
  throw new Error('this test needs two sessions');
}

send(hidden, { type: 'suspend-session', suspended: true });
// Long enough for frames already in flight to land, so what is counted next is
// what the pane produced *after* it was told to stop.
await wait(1500);

const beforeQuiet = frames.length;
await wait(2500);
const quiet = frames.slice(beforeQuiet);

if (quiet.some(frame => frame.slot === hidden.slot)) {
  failures.push(
    `the suspended session produced ${quiet.filter(f => f.slot === hidden.slot).length} frame(s) while nobody was looking at it`
  );
}
if (!quiet.some(frame => frame.slot === watched.slot)) {
  failures.push('the session nobody suspended stopped producing frames as well');
}

send(hidden, { type: 'suspend-session', suspended: false });
const beforeResume = frames.length;
await wait(2500);
const resumed = frames.slice(beforeResume).filter(frame => frame.slot === hidden.slot);
if (resumed.length === 0) {
  failures.push('a session brought back produced no frames at all');
}

console.log(
  `  suspend  ${quiet.filter(f => f.slot === hidden.slot).length} frames while hidden · ` +
    `${quiet.filter(f => f.slot === watched.slot).length} from its neighbour · ` +
    `${resumed.length} once back`
);

SESSIONS.forEach(session => send(session, { type: 'close-session' }));
await wait(500);
sidecar.stdin.write(`${JSON.stringify({ id: String(++id), type: 'shutdown' })}\n`);
server.close();

if (failures.length > 0) {
  console.error('\nSESSIONS ARE NOT SEPARATE\n');
  failures.forEach(failure => console.error(`  - ${failure}`));
  console.error(
    '\nTwo windows sharing state is two windows showing each other their pages, which looks' +
      '\nlike a working app right up until somebody reads what is on screen. Two windows not' +
      '\nsharing a browser is three processes per tab.\n'
  );
  process.exit(1);
}

console.log('\nTwo sessions: nothing of theirs shared, one browser between them.\n');
process.exit(0);
