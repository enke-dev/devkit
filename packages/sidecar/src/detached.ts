import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';

import type { ColorScheme, Engine, Viewport } from '@devkit/protocol';
import type { Browser, BrowserContext } from 'playwright';
import { chromium, firefox, webkit } from 'playwright';

import { log } from './emit.js';

const launchers = { chromium, firefox, webkit } as const;

/**
 * Headed windows opened beside the panes.
 *
 * One browser per engine, kept for as long as it stays open: a second click
 * adds a tab rather than a second window, and closing the last tab is how the
 * user says they are done with it. Nothing is captured or mirrored from here —
 * the point of the window is that the engine's own tools are reachable in it,
 * and those tools are known to take the engine away from Playwright (WebKit
 * resets its emulation, and stops answering the driver, once its inspector is
 * up). Handing the window over entirely is what keeps the pane unaffected.
 */
const detached = new Map<Engine, Browser>();

export async function detach(
  engine: Engine,
  url: string,
  emulation: { viewport: Viewport; colorScheme: ColorScheme }
): Promise<void> {
  const browser = await browserFor(engine);
  // A context of its own so the page starts as the pane's did: same size,
  // same scheme. The window is larger than the page it shows, which is the
  // engine's own chrome and nothing to do with the render.
  const context = await browser.newContext({
    viewport: { width: emulation.viewport.width, height: emulation.viewport.height },
    colorScheme: emulation.colorScheme,
  });
  quitWhenEmpty(browser, context);
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'commit', timeout: 30_000 }).catch(() => {});
  await page.bringToFront().catch(() => {});
  raise(engine);
}

/**
 * Put the window in front of DevKit.
 *
 * Chromium and Gecko activate themselves when launched (Gecko is passed
 * `-foreground` for it). WebKit's MiniBrowser does not, and launched from a
 * background process — which is what the sidecar is under Tauri — it opens
 * behind the window that asked for it.
 *
 * Activated by process id through AppKit rather than by asking Launch Services
 * to open the bundle: from a terminal the latter works, from the sidecar it
 * does not — the request is attributed to DevKit, the very app in front — and
 * AppKit's activation is honoured either way. `osascript` reaches AppKit
 * without sending an Apple event to anyone, so no Automation permission is
 * asked for. The pane's own WebKit runs the same binary, headless, and is told
 * apart by that flag.
 */
function raise(engine: Engine): void {
  if (engine !== 'webkit' || process.platform !== 'darwin') {
    return;
  }
  const executable = join(
    dirname(webkit.executablePath()),
    'Playwright.app/Contents/MacOS/Playwright'
  );
  execFile('ps', ['-axo', 'pid=,command='], (error, stdout) => {
    if (error) {
      log('debug', `could not list processes to raise the WebKit window: ${error.message}`);
      return;
    }
    const [pid] = stdout
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.includes(executable) && !line.includes('--headless'))
      .map(line => Number(line.split(/\s+/)[0]));
    if (pid === undefined) {
      log('debug', 'no headed WebKit process to raise');
      return;
    }
    const script =
      "ObjC.import('AppKit'); " +
      `$.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid})` +
      '.activateWithOptions($.NSApplicationActivateIgnoringOtherApps);';
    execFile('osascript', ['-l', 'JavaScript', '-e', script], failure => {
      if (failure) {
        log('debug', `could not raise the WebKit window: ${failure.message}`);
      }
    });
  });
}

function quitWhenEmpty(browser: Browser, context: BrowserContext): void {
  const check = (): void => {
    const open = browser.contexts().flatMap(candidate => candidate.pages()).length;
    if (open === 0) {
      void browser.close().catch(() => {});
    }
  };
  context.on('page', page => page.on('close', check));
}

async function browserFor(engine: Engine): Promise<Browser> {
  const existing = detached.get(engine);
  if (existing?.isConnected()) {
    return existing;
  }
  const browser = await launchers[engine].launch({ headless: false });
  browser.on('disconnected', () => {
    if (detached.get(engine) === browser) {
      detached.delete(engine);
    }
  });
  detached.set(engine, browser);
  return browser;
}

/** Close every window that is still open, on the way out. */
export async function closeDetached(): Promise<void> {
  const closing = [...detached.values()].map(browser => browser.close().catch(() => {}));
  detached.clear();
  await Promise.allSettled(closing);
}
