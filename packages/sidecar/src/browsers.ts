import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import type { Engine } from '@devkit/protocol';
import { ENGINES } from '@devkit/protocol';
import { chromium, firefox, webkit } from 'playwright';

import { emit } from './emit.js';

const require = createRequire(import.meta.url);

const launchers = { chromium, firefox, webkit } as const;

/**
 * Whether Playwright has already downloaded this engine's binary.
 *
 * `executablePath()` reports where the binary *would* live, without checking —
 * so the filesystem check is the actual test. It throws for engines Playwright
 * cannot place at all, which we treat as not installed.
 */
export function isInstalled(engine: Engine): boolean {
  try {
    return existsSync(launchers[engine].executablePath());
  } catch {
    return false;
  }
}

export function probe(): Record<Engine, boolean> {
  return Object.fromEntries(ENGINES.map(engine => [engine, isInstalled(engine)])) as Record<
    Engine,
    boolean
  >;
}

/**
 * Path to Playwright's own CLI, which owns the download logic we shell out to.
 *
 * `cli.js` is not listed in Playwright's `exports` map, so it cannot be resolved
 * as a subpath. The manifest is exported, though, and names the CLI in `bin` —
 * which keeps this working if the file ever moves.
 */
function resolveCli(): string {
  const manifestPath = require.resolve('playwright/package.json');
  const manifest = require(manifestPath) as { bin?: Record<string, string> };
  const entry = manifest.bin?.['playwright'];
  if (!entry) {
    throw new Error('The installed Playwright package declares no CLI entry point.');
  }

  const cli = join(dirname(manifestPath), entry);
  if (!existsSync(cli)) {
    throw new Error(`Playwright CLI missing at ${cli}; sidecar dependencies may be incomplete.`);
  }
  return cli;
}

/**
 * Download whichever browser binaries are missing.
 *
 * Progress lines come straight from Playwright's downloader, which reports
 * percentages per archive — good enough to drive a progress display without
 * parsing its format.
 */
/**
 * Read a downloader line for which engine it concerns and how far along it is.
 *
 * Playwright announces each download by name and then prints a bar carrying a
 * percentage. Reading both means the app can show progress per engine even when
 * several were asked for at once, which is the ordinary case on a first run.
 */
function readProgress(line: string): { engine: Engine | null; percent: number | null } {
  const [, named] = /downloading\s+(chromium|firefox|webkit)/i.exec(line) ?? [];
  const [, measured] = /(\d+)%\s+of/.exec(line) ?? [];
  return {
    engine: named === undefined ? null : (named.toLowerCase() as Engine),
    percent: measured === undefined ? null : Number(measured),
  };
}

export async function install(missing: Engine[]): Promise<void> {
  // Playwright's downloader interleaves its output, so progress can only be
  // attributed to an engine when it is the only one being fetched.
  const subject = missing.length === 1 ? (missing[0] as Engine) : null;

  if (missing.length === 0) {
    emit({
      type: 'install-progress',
      engine: null,
      message: 'All engines already installed.',
      done: true,
    });
    return;
  }

  const cli = resolveCli();
  emit({
    type: 'install-progress',
    engine: subject,
    message: `Downloading ${missing.join(', ')}…`,
    done: false,
  });

  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'install', ...missing], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    // Which engine the bars belong to, until the next one is announced.
    let current: Engine | null = subject;

    const relay = (chunk: Buffer) => {
      chunk
        .toString()
        .split(/\r?\n/)
        .filter(line => line.trim().length > 0)
        .forEach(message => {
          const { engine, percent } = readProgress(message);
          if (engine) {
            current = engine;
          }
          emit({
            type: 'install-progress',
            engine: current,
            message,
            ...(percent === null ? {} : { percent }),
            done: false,
          });
        });
    };

    child.stdout.on('data', relay);
    child.stderr.on('data', relay);
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`playwright install exited with code ${code}`));
      }
    });
  });

  emit({
    type: 'install-progress',
    engine: subject,
    message: 'Browser download complete.',
    done: true,
  });
}
