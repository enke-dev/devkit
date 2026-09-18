/**
 * Stages the Node runtime as the Tauri sidecar binary.
 *
 * Playwright needs a real Node environment, so DevKit's "sidecar binary" is the
 * interpreter itself; the entry script ships separately as a resource. In dev we
 * hardlink the local Node so this costs nothing. A release build for another
 * platform must drop that platform's Node binary in the same place.
 *
 * This script may itself be run by Bun, so it resolves Node explicitly rather
 * than trusting `process.execPath` to be the runtime we want to stage.
 *
 * Two environment variables cover release builds:
 *   DEVKIT_NODE_BINARY  path to the Node build to stage, instead of the local one
 *   DEVKIT_TARGET       Rust target triple to name it for, instead of the host
 *
 * Both are needed when building for a platform other than this one: the staged
 * binary must be that platform's Node, and nothing here can check that it is.
 *
 * The staged runtime is what the app ships, so it must not be "whatever was on
 * the builder's PATH". `.node-version` decides, and a mismatch fails the build:
 * a shell left on an older Node would otherwise bundle it into the release
 * without a word.
 */
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function run(command: string, args: string[]): string {
  return execFileSync(command, args, { encoding: 'utf8' }).trim();
}

function resolveNode(): string {
  const override = process.env.DEVKIT_NODE_BINARY;
  if (override) {
    if (!existsSync(override))
      throw new Error(
        `DEVKIT_NODE_BINARY points at a missing file: ${override}`,
      );
    return override;
  }

  // `process.execPath` is only the answer when Node is what is running us.
  if (/(^|[/\\])node(\.exe)?$/.test(process.execPath)) return process.execPath;
  try {
    const which = process.platform === 'win32' ? 'where' : 'which';
    const found = run(which, ['node']).split(/\r?\n/)[0];
    if (found) return found;
  } catch {
    // fall through to the error below
  }
  throw new Error(
    'Node.js not found on PATH. The Playwright sidecar runs on Node, even when Bun drives the build.',
  );
}

function hostTriple(): string {
  const line = run('rustc', ['-vV'])
    .split('\n')
    .find((entry) => entry.startsWith('host:'));
  if (!line)
    throw new Error(
      'Could not determine the Rust host triple; is rustc on PATH?',
    );
  return line.replace('host:', '').trim();
}

function targetTriple(): string {
  return process.env.DEVKIT_TARGET || hostTriple();
}

/** The version this project ships, as `.node-version` states it. */
function requiredVersion(): string | null {
  const path = join(root, '.node-version');
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8').trim().replace(/^v/, '');
}

function checkVersion(binary: string, target: string) {
  const required = requiredVersion();
  if (!required) return;

  // A Node built for somewhere else cannot be run here to be asked what it is,
  // and refusing to stage it for that reason would rule out building for
  // anything but the machine doing the building. The version is then the
  // caller's word — which is all it can be, and they had to name the file.
  if (target !== hostTriple()) {
    console.log(
      `staging a Node for ${target}, which this machine cannot run; taking ${required} on trust`,
    );
    return;
  }

  const actual = run(binary, ['--version']).trim().replace(/^v/, '');
  if (actual === required) return;

  throw new Error(
    `the sidecar would ship Node ${actual}, but .node-version asks for ${required}\n` +
      `  staged from: ${binary}\n` +
      `  run the build through that version — \`fnm exec bun run build\`, or set DEVKIT_NODE_BINARY`,
  );
}

const node = resolveNode();
const target = targetTriple();
checkVersion(node, target);
const suffix = target.includes('windows') ? '.exe' : '';
const destination = join(
  root,
  'src-tauri/binaries',
  `devkit-node-${target}${suffix}`,
);

mkdirSync(dirname(destination), { recursive: true });
rmSync(destination, { force: true });

try {
  // A hardlink keeps the staged runtime free in development; a release build
  // copying another platform's Node will fall through to a real copy.
  linkSync(node, destination);
} catch {
  // Different filesystem (or Windows): fall back to a real copy.
  copyFileSync(node, destination);
}
chmodSync(destination, 0o755);

console.log(`sidecar binary ready: ${destination} -> ${node}`);
