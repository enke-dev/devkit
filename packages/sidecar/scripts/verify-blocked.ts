/* eslint-disable no-console */
/**
 * A pane macOS refused must say which permission it wants.
 *
 * Gecko reads `~/Library/Application Support/Firefox/profiles.ini` on the way
 * up whatever profile it was handed. That directory belongs to another app, so
 * a process without the grant is refused and Firefox exits saying it could not
 * find its profile — which names neither the file nor the permission. The
 * sidecar has to recognise that and say `blocked`, or the app can only quote it.
 *
 * The denial depends on how the process was started, not on what it does: a
 * child of a terminal inherits the terminal's grants and launches fine, and
 * only a process whose ancestry is launchd is refused. So this submits itself
 * through `launchctl` and drives the sidecar from there. Running it directly
 * would test nothing.
 *
 * Where the grant is present the denial cannot be staged at all, and the script
 * says so rather than claiming a pass it did not earn.
 *
 *   bun run verify:blocked
 */
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The package root, not this script's directory: `dist/index.js` is there. */
const root = new URL('..', import.meta.url).pathname;

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** The half that runs under launchd: drive the sidecar and write down what it said. */
async function runChild(out: string): Promise<void> {
  process.chdir(root);
  const child = spawn(process.execPath, ['dist/index.js'], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  const panes: { status: string; blocked?: string; detail?: string }[] = [];
  child.stdout.on('data', chunk =>
    String(chunk)
      .split('\n')
      .filter(Boolean)
      .forEach(line => {
        try {
          const event = JSON.parse(line);
          if (event.type === 'pane' && event.engine === 'firefox') {
            panes.push({ status: event.status, blocked: event.blocked, detail: event.detail });
          }
        } catch {
          // Not every line is an event; logs share the stream.
        }
      })
  );

  child.stdin.write(
    `${JSON.stringify({
      id: 1,
      type: 'start',
      engines: ['firefox'],
      viewport: { width: 800, height: 600, scale: 1 },
      colorScheme: 'light',
    })}\n`
  );

  // Long enough for a launch to fail and be reported; a failure is quick.
  await wait(30_000);
  const { writeFileSync } = await import('node:fs');
  writeFileSync(out, JSON.stringify(panes));
  child.kill();
}

if (process.argv.includes('--child')) {
  const out = process.argv[process.argv.indexOf('--child') + 1] ?? '';
  await runChild(out);
  process.exit(0);
}

const out = join(tmpdir(), `devkit-blocked-${process.pid}.json`);
rmSync(out, { force: true });

const label = `devkit-verify-blocked-${process.pid}`;
const submitted = spawnSync('launchctl', [
  'submit',
  '-l',
  label,
  '--',
  process.execPath,
  new URL(import.meta.url).pathname,
  '--child',
  out,
]);
if (submitted.status !== 0) {
  console.error('\nBLOCKED VERIFICATION FAILED\n');
  console.error('  - launchctl would not take the job, so the denial could not be staged');
  process.exit(1);
}

console.log('Submitted through launchd; a refused launch takes a few seconds to report.');
let panes: { status: string; blocked?: string; detail?: string }[] = [];
for (let waited = 0; waited < 60_000; waited += 1000) {
  await wait(1000);
  try {
    panes = JSON.parse(readFileSync(out, 'utf8'));
    break;
  } catch {
    // Not written yet.
  }
}
spawnSync('launchctl', ['remove', label]);
rmSync(out, { force: true });

if (panes.length === 0) {
  console.error('\nBLOCKED VERIFICATION FAILED\n');
  console.error('  - the sidecar reported nothing about the pane at all');
  process.exit(1);
}

if (panes.some(pane => pane.status === 'live')) {
  console.log('\nGecko launched under launchd, so this machine already holds the grant.');
  console.log('Nothing to verify: the denial cannot be staged while the permission is there.');
  process.exit(0);
}

const failed = panes.find(pane => pane.status === 'failed');
const failures = [];
if (!failed) {
  failures.push('the pane neither came up nor failed');
} else if (failed.blocked !== 'app-data') {
  failures.push(
    `the failure was reported as ${failed.blocked ?? 'unclassified'}, so the app can only quote it`
  );
  failures.push(
    `what the browser said: ${(failed.detail ?? '').replace(/\s+/g, ' ').slice(0, 160)}`
  );
}

if (failures.length > 0) {
  console.error('\nBLOCKED VERIFICATION FAILED\n');
  failures.forEach(failure => console.error(`  - ${failure}`));
  console.error("\nAn unclassified refusal reaches the user as the browser's own words.\n");
  process.exit(1);
}

console.log('\nA pane macOS refused is reported as blocked, not as a browser crash.');
process.exit(0);
