/**
 * A pane that dies must say so, and must come back.
 *
 * A pane producing no frames looks exactly like a page where nothing is
 * happening, which is why this is worth a test: the failure is invisible. The
 * engine is killed outright here — no clean shutdown, no chance to say
 * goodbye — because that is the case that used to go unreported. The pane's own
 * `disconnected` handler only spoke while it was capturing, and capturing is
 * false for the whole of a resize.
 *
 *   bun run verify:recovery
 */
import { spawn, execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';

const ENGINES = ['chromium', 'firefox', 'webkit'];
const server = createServer(socket => socket.resume());
await new Promise(r => server.listen(0, '127.0.0.1', r));

const child = spawn('node', ['dist/index.js'], {
  // The package root, not this script's directory: `dist/index.js` is there.
  cwd: new URL('..', import.meta.url).pathname,
  env: {
    ...process.env,
    DEVKIT_FRAME_PORT: String(server.address().port),
    DEVKIT_FRAME_TOKEN: randomBytes(16).toString('hex'),
  },
  stdio: ['pipe', 'pipe', 'inherit'],
});

const events = [];
child.stdout.on('data', chunk =>
  String(chunk)
    .split('\n')
    .filter(Boolean)
    .forEach(line => {
      try {
        const event = JSON.parse(line);
        if (event.type === 'pane')
          events.push(`${event.engine} ${event.status}${event.detail ? ` (${event.detail})` : ''}`);
      } catch {}
    })
);

let id = 0;
const send = m => child.stdin.write(`${JSON.stringify({ id: String(++id), ...m })}\n`);
const wait = ms => new Promise(r => setTimeout(r, ms));

send({ type: 'start', engines: ENGINES, viewport: { width: 600, height: 900, scale: 2 } });
await wait(9000);
events.length = 0;

// Kill Gecko outright: no clean shutdown, no chance to say goodbye.
const pids = execSync("pgrep -f 'firefox.*-juggler' || true")
  .toString()
  .trim()
  .split('\n')
  .filter(Boolean);
console.log(`  killing ${pids.length} firefox process(es)`);
pids.forEach(pid => {
  try {
    process.kill(Number(pid), 'SIGKILL');
  } catch {}
});

await wait(6000);
console.log('  pane events after the kill:');
events.forEach(event => console.log(`    ${event}`));

// The frontend relaunches a closed pane; this stands in for it.
send({ type: 'start', engines: ENGINES, viewport: { width: 600, height: 900, scale: 2 } });
await wait(9000);

const closed = events.filter(event => event.startsWith('firefox closed'));
const relaunched = events.some(event => event === 'firefox live');
const failures = [];
if (closed.length === 0) failures.push('the killed engine was never reported closed');
if (closed.length > 1) failures.push(`reported closed ${closed.length} times, expected once`);
if (!relaunched) failures.push('the pane did not come back after being restarted');

send({ type: 'shutdown' });
await wait(500);

if (failures.length > 0) {
  console.error('\nRECOVERY VERIFICATION FAILED\n');
  failures.forEach(failure => console.error(`  - ${failure}`));
  console.error('\nA pane that stops without saying so stays frozen for the session.\n');
  process.exit(1);
}

console.log('\nA killed engine reports closed once, and comes back when restarted.');
process.exit(0);
