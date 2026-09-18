/**
 * Behaviour test for the screencast each pane depends on.
 *
 * DevKit renders every pane from its engine's own screencast rather than
 * polling screenshots. That is public API (`page.screencast`, Playwright 1.59+),
 * but the three engines behave very differently behind it, and those
 * differences are what the app is tuned around:
 *
 * - Chromium delivers on composite, at display rate.
 * - Gecko and WebKit are capped at 25fps inside Playwright's own browser
 *   patches (`capability.maxFPS = 25`, `const int fps = 25`), and both run on a
 *   timer rather than on repaint.
 * - Gecko and WebKit ignore the requested frame size and deliver CSS
 *   resolution, which is why live frames are requested at CSS resolution and a
 *   settled pane is re-captured with `page.screenshot()` instead.
 *
 * It also checks that a page keeps its device scale across navigations. Gecko
 * was once seen dropping `devicePixelRatio` to 1 from its second navigation
 * onward, which made even a full screenshot come back undersized. It does not
 * reproduce any more, so this is a regression guard rather than a known bug.
 *
 *   bun run verify:screencast
 */
import { createRequire } from 'node:module';

import { chromium, firefox, webkit } from 'playwright';

const require = createRequire(import.meta.url);

const VIEWPORT = { width: 600, height: 400 };
const SCALE = 2;
const FRAME_WINDOW_MS = 4000;
const MIN_FRAMES = 5;

/** A page that repaints continuously, so a working screencast must produce frames. */
const MOVING_PAGE =
  'data:text/html,' +
  encodeURIComponent(
    '<style>body{margin:0;background:#222}div{width:80px;height:80px;background:#3b6ef5;' +
      'animation:m 1s linear infinite}@keyframes m{from{transform:translateX(0)}to{transform:translateX(400px)}}</style><div></div>'
  );

/** Read real dimensions from the JPEG SOF marker rather than trusting metadata. */
function jpegSize(buffer) {
  let i = 2;
  while (i < buffer.length - 9) {
    if (buffer[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = buffer[i + 1];
    const length = buffer.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { width: buffer.readUInt16BE(i + 7), height: buffer.readUInt16BE(i + 5) };
    }
    i += 2 + length;
  }
  return null;
}

const failures = [];
const notes = [];

function check(condition, message) {
  if (!condition) failures.push(message);
  return condition;
}

/**
 * Navigate twice more and confirm the page still renders at device scale.
 *
 * Nothing re-applies the viewport here on purpose: a check that repairs the
 * thing it is checking can only ever pass.
 */
async function checkDeviceScaleSurvivesNavigation(engine, page) {
  await page.goto('data:text/html,<h1>one</h1>', { waitUntil: 'load' });
  await page.goto('data:text/html,<h1>two</h1>', { waitUntil: 'load' });
  await new Promise(resolve => setTimeout(resolve, 300));

  const dpr = await page.evaluate(() => window.devicePixelRatio).catch(() => 0);
  if (dpr !== SCALE) {
    failures.push(`${engine}: devicePixelRatio is ${dpr} after navigating, expected ${SCALE}`);
    return `device scale: LOST (dpr=${dpr})`;
  }
  return 'device scale: holds';
}

const playwrightVersion = require('playwright/package.json').version;
console.log(`Verifying the screencast against Playwright ${playwrightVersion}\n`);

for (const [engine, launcher] of Object.entries({ chromium, firefox, webkit })) {
  const browser = await launcher.launch({
    headless: true,
    args: engine === 'chromium' ? [`--force-device-scale-factor=${SCALE}`] : [],
  });

  try {
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: SCALE });
    const page = await context.newPage();
    await page.goto(MOVING_PAGE, { waitUntil: 'load' });

    const frames = [];
    await page.screencast.start({
      size: { width: VIEWPORT.width, height: VIEWPORT.height },
      quality: 60,
      onFrame: ({ data }) => {
        frames.push(data);
      },
    });
    await new Promise(resolve => setTimeout(resolve, FRAME_WINDOW_MS));
    await page.screencast.stop();

    const fps = (frames.length / FRAME_WINDOW_MS) * 1000;
    if (
      !check(
        frames.length >= MIN_FRAMES,
        `${engine}: only ${frames.length} frames in ${FRAME_WINDOW_MS}ms`
      )
    )
      continue;

    const [first] = frames;
    check(Buffer.isBuffer(first), `${engine}: frame data is not a Buffer`);
    check(first?.[0] === 0xff && first?.[1] === 0xd8, `${engine}: frame data is not a JPEG`);

    const size = jpegSize(first);
    const actual = size ? `${size.width}x${size.height}` : 'unreadable';
    // Resolution is reported rather than enforced: the panes only have to match
    // each other, and what each engine delivers is what this is here to show.
    const scale = await checkDeviceScaleSurvivesNavigation(engine, page);

    notes.push(
      `${engine.padEnd(9)} ${fps.toFixed(1).padStart(5)} fps   frames ${actual} (requested ${VIEWPORT.width}x${VIEWPORT.height})   ${scale}`
    );
  } catch (error) {
    failures.push(`${engine}: ${error.message}`);
  } finally {
    await browser.close();
  }
}

notes.forEach(note => console.log(`  ${note}`));

if (failures.length > 0) {
  console.error('\nSCREENCAST VERIFICATION FAILED\n');
  failures.forEach(failure => console.error(`  - ${failure}`));
  console.error(
    '\nWithout a working screencast every pane is blank: there is no polling fallback.' +
      '\nCheck the `page.screencast` API against the installed Playwright build.\n'
  );
  process.exit(1);
}

console.log('\nScreencast verified: every engine delivers frames.');
