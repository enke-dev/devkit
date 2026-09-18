import type { Page } from 'playwright';

/**
 * Access to an engine's own screencast.
 *
 * Every engine delivers compressed frames while a page is on screen — Chromium
 * on composite over CDP at display rate, Gecko and WebKit on a 25Hz timer
 * (`capability.maxFPS = 25` in Playwright's Firefox patch, `const int fps = 25`
 * in its WebKit one). Those two caps are why the panes do not all run at 60fps,
 * and they sit in the browser builds rather than anywhere we can reach.
 *
 * This used to go through a patched `playwright-core`, because the screencast
 * was internal. It is public API as of Playwright 1.59, and measurement showed
 * the two paths deliver the same frames at the same rate, so the patch is gone.
 *
 * There is deliberately no screenshot-polling fallback: polling costs several
 * times the CPU for a fraction of the frame rate, and an untested fallback is
 * not worth carrying. `bun run verify:screencast` is what guards this.
 */

/** A running screencast subscription. */
export interface Screencast {
  stop: () => Promise<void>;
}

/**
 * Stream frames from a page until stopped.
 *
 * `size` is a request, and the engines disagree about honouring it: Chromium
 * scales its capture to fit, while Gecko and WebKit ignore it and deliver CSS
 * resolution whatever is asked — "The size is ignored in fact", as the comment
 * in Playwright's own Firefox patch puts it. Callers that need panes to match
 * each other must therefore request CSS resolution, the one size all three
 * agree on.
 */
export async function startScreencast(
  page: Page,
  options: { size: { width: number; height: number }; quality: number },
  onFrame: (buffer: Buffer) => void
): Promise<Screencast> {
  await page.screencast.start({
    size: options.size,
    quality: options.quality,
    onFrame: ({ data }) => {
      if (data.length > 0) {
        onFrame(data);
      }
    },
  });

  let stopped = false;
  return {
    stop: async () => {
      if (stopped) {
        return;
      }
      stopped = true;
      // The page may already be gone; the screencast dies with it.
      await page.screencast.stop().catch(() => {});
    },
  };
}
