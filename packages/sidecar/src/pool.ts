import type { Engine } from '@devkit/protocol';
import type { Browser } from 'playwright';
import { chromium, firefox, webkit } from 'playwright';

import { log } from './emit.js';

/**
 * Browsers shared between comparisons, one context each.
 *
 * A pane used to launch a browser of its own, which is three processes per
 * window: four tabs open was twelve browsers, and a browser is a couple of
 * hundred megabytes where a context is a few. Playwright hosts many contexts
 * per browser and a context is already what carries everything a pane sets —
 * its viewport, its device scale, its colour scheme — so two windows' Chromium
 * panes can be two contexts in one Chromium without either knowing.
 *
 * Keyed by engine *and* launch arguments, not by engine alone. Chromium's
 * `--force-device-scale-factor` is the whole reason its screencast is not soft
 * on a HiDPI display, and it is fixed when the process starts: two windows on
 * displays of different scale need two Chromiums, and asking one to serve both
 * would make one of them wrong in a way that looks like a blurry pane rather
 * than like a bug. Gecko and WebKit take no arguments and share unconditionally.
 *
 * What this costs is isolation, and it is worth saying plainly: a browser that
 * crashes takes every pane leasing it, in every window. Each holder is told,
 * each reports its own pane closed, and the frontend brings them back the way
 * it always has — but they now fall together where they used to fall alone.
 */

const launchers = { chromium, firefox, webkit } as const;

/** One pane's claim on a browser. */
export interface Lease {
  readonly browser: Browser;
  /** Give up the claim; the last one out closes the browser. */
  release(): Promise<void>;
}

interface Pooled {
  browser: Browser;
  /** What to tell each holder when the browser goes without being asked. */
  holders: Map<symbol, () => void>;
}

const pool = new Map<string, Pooled>();

/**
 * What decides whether two panes can share a process.
 *
 * The arguments are in the key rather than compared loosely, because they are
 * the whole of what a browser cannot be talked out of once it is running.
 */
function keyFor(engine: Engine, args: string[]): string {
  return args.length === 0 ? engine : `${engine} ${args.join(' ')}`;
}

/**
 * Take a claim on a browser, launching one if nobody has.
 *
 * `onLost` is this pane's own: it is called when the browser disconnects
 * without being asked, which is a crash for every pane sharing it and not just
 * for the one that noticed.
 */
export async function lease(engine: Engine, args: string[], onLost: () => void): Promise<Lease> {
  const key = keyFor(engine, args);
  const holder = Symbol('pane');

  const existing = pool.get(key);
  if (existing?.browser.isConnected()) {
    existing.holders.set(holder, onLost);
    return { browser: existing.browser, release: () => release(key, holder) };
  }

  const browser = await launchers[engine].launch({ headless: true, args });
  const pooled: Pooled = { browser, holders: new Map([[holder, onLost]]) };
  pool.set(key, pooled);

  browser.on('disconnected', () => {
    // Gone is gone: drop it first, so a pane relaunching in answer to the news
    // does not lease the corpse.
    if (pool.get(key) === pooled) {
      pool.delete(key);
    }
    const holders = [...pooled.holders.values()];
    pooled.holders.clear();
    holders.forEach(tell => tell());
  });

  return { browser, release: () => release(key, holder) };
}

async function release(key: string, holder: symbol): Promise<void> {
  const pooled = pool.get(key);
  if (!pooled) {
    return;
  }
  pooled.holders.delete(holder);
  if (pooled.holders.size > 0) {
    return;
  }
  // Nobody is left: the browser goes rather than lingering as a process with
  // no panes, which is what a closed window's engines would otherwise become.
  pool.delete(key);
  await pooled.browser.close().catch(error => {
    log('debug', `browser did not close cleanly: ${String(error)}`);
  });
}

/** Close everything, on the way out. */
export async function closePool(): Promise<void> {
  const browsers = [...pool.values()].map(pooled => pooled.browser);
  pool.clear();
  await Promise.allSettled(browsers.map(browser => browser.close()));
}
