/* eslint-disable no-console */
/**
 * End-to-end test that every pane ends up sharp after you stop interacting.
 *
 * This drives the real sidecar — its own process, its own state machine, its own
 * frame channel — rather than testing the capture logic in isolation, because
 * the bug it was written for only appeared in the interaction between them:
 *
 * A pane that had shown live frames, then settled, could be dropped back to a
 * live frame by the echo of its own screenshot. The next capture came back
 * identical to the last sharp one, took the "nothing changed" shortcut and sent
 * nothing — leaving a CSS-resolution picture on screen with nothing else coming,
 * because the engine had no reason to repaint again. WebKit hit it most: its
 * screenshot repaints the whole page, so its echo is the loudest.
 *
 * The page is deliberately heavy and local. A light one does not reproduce it
 * (the screenshot is too cheap to echo), and a remote one makes the test depend
 * on the network.
 *
 *   bun run verify:settle
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:net';

const HEADER_BYTES = 16;
const TOKEN_BYTES = 32;
const ENGINES = ['chromium', 'firefox', 'webkit'];
const VIEWPORT = { width: 600, height: 900, scale: 2 };
const LAUNCH_MS = 9000;
const LOAD_MS = 5000;
const QUIET_MS = 5000;

/** Expensive to repaint and to encode, so a screenshot really does cost something. */
const HEAVY_PAGE =
  'data:text/html,' +
  encodeURIComponent(
    `<style>body{margin:0;font:14px system-ui}
     li{padding:10px;border-bottom:1px solid #ddd;background:linear-gradient(90deg,#fff,#f4f4f8)}
     a{color:#3b6ef5}a:hover{background:#e8e8ef}</style><ul>` +
      Array.from(
        { length: 1200 },
        (_, i) =>
          `<li><a href="#i${i}">item ${i} — some text that makes this page expensive to repaint and to encode</a></li>`
      ).join('') +
      '</ul>'
  );

interface Frame {
  at: number;
  engine: string;
  sharp: boolean;
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
        at: Date.now(),
        engine: ENGINES[buffer.readUInt8(12)] ?? 'unknown',
        sharp: buffer.readUInt8(13) === 1,
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

let id = 0;
const send = (message: Record<string, unknown>) =>
  sidecar.stdin.write(`${JSON.stringify({ id: String(++id), ...message })}\n`);
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

console.log('Launching three engines…');
send({ type: 'start', engines: ENGINES, viewport: VIEWPORT });
await wait(LAUNCH_MS);
send({ type: 'navigate', url: HEAVY_PAGE });
await wait(LOAD_MS);

console.log('Scrolling and hovering…');
frames.length = 0;
for (let i = 0; i < 60; i += 1) {
  const event = { kind: 'mousemove', x: 120 + (i % 7) * 30, y: 100 + (i % 20) * 35 };
  send({ type: 'input', engine: 'all', source: 'chromium', event });
  send({
    type: 'input',
    engine: 'all',
    source: 'chromium',
    event: { kind: 'wheel', x: 300, y: 400, deltaX: 0, deltaY: 90 },
  });
  await wait(40);
}

const stopped = Date.now();
console.log(`Waiting ${QUIET_MS}ms for the panes to settle…\n`);
await wait(QUIET_MS);
send({ type: 'shutdown' });

const failures: string[] = [];
ENGINES.forEach(engine => {
  const mine = frames.filter(frame => frame.engine === engine);
  const last = mine[mine.length - 1];
  const settledAt = last?.sharp ? last.at - stopped : null;

  if (!last) {
    failures.push(`${engine}: produced no frames at all`);
    console.log(`  ${engine.padEnd(9)} NO FRAMES`);
    return;
  }
  if (!last.sharp) {
    failures.push(
      `${engine}: ended on a live ${last.width}px frame — the pane is left soft with nothing else coming`
    );
  }
  console.log(
    `  ${engine.padEnd(9)} ${String(mine.length).padStart(3)} frames   ` +
      `ended ${last.sharp ? `sharp at +${settledAt}ms (${last.width}px)` : `LIVE (${last.width}px)`}`
  );

  // The shape of the tail is what tells sharp-then-soft-then-sharp apart from
  // settling once: `DEVKIT_TIMELINE=1 bun run verify:settle`.
  if (process.env.DEVKIT_TIMELINE === '1') {
    const tail = mine.filter(frame => frame.at >= stopped);
    console.log(
      `    ${tail.map(f => `+${f.at - stopped}${f.sharp ? `S${f.width}` : `l${f.width}`}`).join(' ')}`
    );
  }
});

server.close();

if (failures.length > 0) {
  console.error('\nPANES DID NOT SETTLE\n');
  failures.forEach(failure => console.error(`  - ${failure}`));
  console.error(
    '\nA pane that ends on a live frame stays soft until something else makes the page' +
      '\nrepaint, which on a still page may be never.\n'
  );
  process.exit(1);
}

console.log('\nEvery pane settled sharp.');
process.exit(0);
