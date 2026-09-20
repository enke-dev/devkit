/* eslint-disable no-console */
/**
 * Behaviour test for the introspection walker, across all three engines.
 *
 * The inspector's premise is that a point means the same thing everywhere: the
 * panes share a viewport, input is mirrored in viewport pixels, so
 * `elementFromPoint` with the same coordinates is the only cross-engine
 * identity an element needs. That premise is worth nothing unless the descent
 * behaves the same in each engine, and most of it is engine territory rather
 * than ours:
 *
 * - **Shadow roots.** `elementFromPoint` returns the host, so the walker
 *   descends through `shadowRoot.elementFromPoint` at the same coordinates.
 * - **Frames.** Coordinates inside a frame are that frame's own, so they are
 *   translated on the way down and the rects translated back up on the way
 *   out. A highlight drawn from an untranslated rect lands somewhere else
 *   entirely, and only on the pages that have a frame.
 * - **Computed style spelling.** The engines agree about rendering far more
 *   often than about how to serialise it. Colours, fractions and font-family
 *   quoting are normalised; what survives that is a real difference.
 * - **What cannot be read.** A cross-origin frame cannot be descended into and
 *   a cross-origin stylesheet throws on `.cssRules`. Both have to degrade into
 *   a note rather than into a wrong answer or an empty panel.
 *
 * Two origins are served, because "cross-origin" is the whole point of half of
 * this and one server cannot produce it.
 *
 * It also reports which console message types each engine actually emits, so
 * `CONSOLE_MESSAGE_TYPES` can be checked against the real vocabularies rather
 * than guessed at.
 *
 *   bun run verify:inspect
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { InspectedElement } from '@devkit/protocol';
import { CONSOLE_MESSAGE_TYPES } from '@devkit/protocol';
import type { Browser, Page } from 'playwright';
import { chromium, firefox, webkit } from 'playwright';

import { WALKER_KEY, WALKER_SOURCE } from '../dist/walker.js';

const VIEWPORT = { width: 800, height: 600 };

const STYLESHEET = `
  .card { color: rgba(0, 0, 0, 0.5); font-family: "Helvetica Neue", Arial, sans-serif; }
  @media (min-width: 100px) { .card { letter-spacing: 0.3333333px; } }
`;

const framePage = (origin: string) => `<!doctype html>
<html><head>
  <link rel="stylesheet" href="${origin}/sheet.css">
  <style>
    body { margin: 0; }
    #inner { position: absolute; left: 10px; top: 20px; width: 120px; height: 60px; background: #0a0; }
  </style>
</head>
<body>
  <div id="inner" class="card">inner</div>
  <a id="framelink" href="#" style="position: absolute; left: 10px; top: 100px;">frame link</a>
</body></html>`;

/**
 * The main page: a shadow root, a same-origin frame, a frame from the other
 * origin, and a stylesheet from the other origin.
 */
const mainPage = (own: string, other: string) => `<!doctype html>
<html><head>
  <link rel="stylesheet" href="${own}/sheet.css">
  <link rel="stylesheet" href="${other}/sheet.css">
  <style>#host { position: absolute; left: 40px; top: 40px; }</style>
</head>
<body style="margin: 0">
  <div id="host"></div>
  <a id="link" href="#" style="position: absolute; left: 40px; top: 160px;">a link</a>
  <p id="words" style="position: absolute; left: 40px; top: 300px; margin: 0;
    font: 16px/20px monospace;">hello there</p>
  <!-- Something to scroll past, so a selection can be measured again after one. -->
  <div style="position: absolute; top: 1400px; width: 10px; height: 1400px;"></div>
  <iframe id="frame" src="${own}/frame.html" style="position: absolute; left: 300px; top: 200px;
    width: 300px; height: 200px; border: 5px solid #333; padding: 10px;"></iframe>
  <iframe id="foreign" src="${other}/frame.html" style="position: absolute; left: 300px; top: 430px;
    width: 300px; height: 120px; border: 0;"></iframe>
  <script>
    const root = document.getElementById('host').attachShadow({ mode: 'open' });
    root.innerHTML =
      '<style>.shadowed { width: 150px; height: 80px; background: #06c; color: rgb(255 255 255 / 50%); }</style>' +
      '<div class="shadowed card">shadowed</div>';

    // A repeated line for the coalescing, then one of each shape the shared
    // vocabulary has a name for.
    [0, 1, 2, 3, 4].forEach(() => console.log('repeated line'));
    console.warn('a warning');
    console.info('an info');
    console.debug('a debug');
    console.table([{ a: 1 }]);
    console.group('a group');
    console.groupEnd();
    console.trace('a trace');
    console.count('a count');
    setTimeout(() => { throw new Error('thrown on purpose'); }, 0);
  </script>
</body></html>`;

/** A link, a run of text, and blank paper — what the cursor probe has to tell apart. */
const ON_LINK = { x: 55, y: 168 };
const ON_TEXT = { x: 60, y: 310 };
const ON_NOTHING = { x: 650, y: 100 };
/** The frame's own link, which only a descending probe can see. */
const ON_FRAME_LINK = { x: 300 + 5 + 10 + 20, y: 200 + 5 + 10 + 108 };

/** Inside the shadow content, inside the same-origin frame, inside the foreign one. */
const IN_SHADOW = { x: 100, y: 80 };
const IN_FRAME = { x: 300 + 5 + 10 + 10 + 20, y: 200 + 5 + 10 + 20 + 20 };
const IN_FOREIGN = { x: 300 + 40, y: 430 + 50 };

/** Where the same-origin frame's content begins: its offset plus its border and padding. */
const FRAME_ORIGIN = { x: 300 + 5 + 10, y: 200 + 5 + 10 };

const launchers = { chromium, firefox, webkit } as const;
type EngineName = keyof typeof launchers;

let failures = 0;

/** Each engine's identity for the same point, compared once they have all run. */
const identities = new Map<string, string>();

/**
 * The identity the app compares, derived exactly as it derives it.
 *
 * Same-tag indices rather than raw child indices: a raw one moves whenever
 * anything is inserted beside an element, and three engines were reported
 * disagreeing about an element all three had found.
 */
function identityOf(element: InspectedElement): string {
  return [
    ...[...element.path].reverse(),
    { tag: element.tag, index: element.index, id: element.id },
  ]
    .map(ref => {
      const boundary = 'boundary' in ref && ref.boundary ? `${String(ref.boundary)}>` : '';
      return `${boundary}${ref.id ? `#${ref.id}` : `${ref.tag}[${ref.index}]`}`;
    })
    .join('/');
}

function check(engine: string, what: string, ok: boolean, detail = ''): void {
  if (!ok) {
    failures += 1;
  }
  console.log(
    `  ${ok ? 'ok  ' : 'FAIL'} ${engine.padEnd(9)} ${what}${detail ? ` — ${detail}` : ''}`
  );
}

function serve(pages: () => { main: string; frame: string }): Promise<{
  origin: string;
  close: () => Promise<void>;
}> {
  const server = createServer((request, response) => {
    const url = request.url ?? '/';
    const { main, frame } = pages();
    if (url.startsWith('/sheet.css')) {
      response.writeHead(200, { 'content-type': 'text/css' }).end(STYLESHEET);
      return;
    }
    if (url.startsWith('/frame.html')) {
      response.writeHead(200, { 'content-type': 'text/html' }).end(frame);
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' }).end(main);
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>(done => server.close(() => done())),
      });
    });
  });
}

function cursorAt(page: Page, x: number, y: number): Promise<string | null> {
  return page.evaluate(`globalThis[${JSON.stringify(WALKER_KEY)}].cursorAt(${x}, ${y})`) as Promise<
    string | null
  >;
}

function remeasure(page: Page): Promise<InspectedElement | null> {
  return page.evaluate(
    `globalThis[${JSON.stringify(WALKER_KEY)}].remeasure()`
  ) as Promise<InspectedElement | null>;
}

function inspect(page: Page, x: number, y: number): Promise<InspectedElement | null> {
  return page.evaluate(
    `globalThis[${JSON.stringify(WALKER_KEY)}].inspect(${x}, ${y})`
  ) as Promise<InspectedElement | null>;
}

/** The exact wrapper `Pane.evaluate` builds, so this tests what actually ships. */
function evaluated(
  page: Page,
  expression: string
): Promise<{
  kind: string;
  type?: string;
  preview?: string;
  message?: string;
  json?: unknown;
}> {
  const key = JSON.stringify(WALKER_KEY);
  return page.evaluate(`(async () => {
    const api = globalThis[${key}];
    try {
      return api.describe(await (${expression}));
    } catch (error) {
      return api.fail(error);
    }
  })()`) as Promise<{ kind: string; type?: string; preview?: string; message?: string }>;
}

async function run(engine: EngineName, origin: string): Promise<void> {
  console.log(`\n${engine}`);
  let browser: Browser | null = null;
  try {
    browser = await launchers[engine].launch({ headless: true });
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    await context.addInitScript(WALKER_SOURCE);
    const page = await context.newPage();

    const kinds = new Set<string>();
    const errors: string[] = [];
    page.on('console', message => kinds.add(message.type()));
    page.on('pageerror', error => errors.push(error.message));

    await page.goto(origin, { waitUntil: 'load' });
    await page.waitForTimeout(600);

    // --- nothing selected yet -------------------------------------------------
    // The sidecar branches on this: undefined means this pane has no selection
    // and has nothing to announce, null means the selection has gone and the
    // highlight must go with it. A pane that confused the two would announce a
    // vanished selection on every scroll of every page.
    check(
      engine,
      'says nothing when nothing is selected',
      (await remeasure(page)) === undefined,
      String(await remeasure(page))
    );

    // --- shadow DOM ---------------------------------------------------------
    const shadowed = await inspect(page, IN_SHADOW.x, IN_SHADOW.y);
    check(
      engine,
      'pierces an open shadow root',
      shadowed?.classes.includes('shadowed') === true,
      shadowed ? `found ${shadowed.tag}.${shadowed.classes.join('.')}` : 'found nothing'
    );
    check(
      engine,
      'records the shadow boundary',
      shadowed?.path.some(step => step.boundary === 'shadow') === true
    );

    // --- same-origin frames --------------------------------------------------
    const inner = await inspect(page, IN_FRAME.x, IN_FRAME.y);
    check(
      engine,
      'descends into a same-origin frame',
      inner?.id === 'inner',
      inner ? `found ${inner.tag}#${inner.id ?? ''}` : 'found nothing'
    );
    check(
      engine,
      'records the frame boundary',
      inner?.path.some(step => step.boundary === 'frame') === true
    );
    check(
      engine,
      'names the frame document',
      inner?.documentUrl.endsWith('/frame.html') === true,
      inner?.documentUrl
    );
    check(
      engine,
      'translates rects to the top viewport',
      Math.abs((inner?.box.border.x ?? 0) - (FRAME_ORIGIN.x + 10)) < 1.5,
      `border.x = ${inner?.box.border.x}, expected ${FRAME_ORIGIN.x + 10}`
    );
    check(
      engine,
      'translates vertically too',
      Math.abs((inner?.box.border.y ?? 0) - (FRAME_ORIGIN.y + 20)) < 1.5,
      `border.y = ${inner?.box.border.y}, expected ${FRAME_ORIGIN.y + 20}`
    );

    // --- cross-origin frames --------------------------------------------------
    const foreign = await inspect(page, IN_FOREIGN.x, IN_FOREIGN.y);
    check(
      engine,
      'stops at a cross-origin frame',
      foreign?.id === 'foreign',
      foreign ? `found ${foreign.tag}#${foreign.id ?? ''}` : 'found nothing'
    );
    check(
      engine,
      'says why it stopped',
      (foreign?.pierceNote ?? '').includes('cross-origin'),
      foreign?.pierceNote ?? 'nothing said'
    );

    // --- normalised styles ------------------------------------------------------
    check(
      engine,
      'normalises a translucent colour',
      shadowed?.styles.color === 'rgba(255, 255, 255, 0.5)',
      shadowed?.styles.color
    );
    check(
      engine,
      'normalises font-family quoting',
      inner?.styles['font-family'] === 'Helvetica Neue, Arial, sans-serif',
      inner?.styles['font-family']
    );
    check(
      engine,
      'rounds fractional lengths',
      inner?.styles['letter-spacing'] === '0.33px',
      inner?.styles['letter-spacing']
    );

    // --- matched rules ------------------------------------------------------------
    const rules = inner?.rules ?? [];
    check(
      engine,
      'reads same-origin stylesheets',
      rules.some(rule => rule.origin.endsWith('/sheet.css')),
      `${inner?.rules?.length ?? 'null'} rules`
    );
    check(
      engine,
      'keeps @media conditions',
      rules.some(rule => rule.conditions.some(condition => condition.startsWith('@media')))
    );

    const outer = await inspect(page, 100, 500);
    check(
      engine,
      'notes stylesheets it could not read',
      (outer?.rulesNote ?? '').includes('cross-origin'),
      outer?.rulesNote ?? 'nothing said'
    );

    // --- nothing in particular there -------------------------------------------------
    const nowhere = await inspect(page, VIEWPORT.width - 2, VIEWPORT.height - 2);
    check(engine, 'answers for empty space', nowhere !== null, nowhere?.tag ?? 'null');

    // --- the cursor probe, which shares the descent -------------------------------------
    // WebKit answers `auto` over a link where the other two answer `pointer`,
    // so this is the one place the walker has to reason rather than report.
    check(
      engine,
      'reads a link as a pointer',
      (await cursorAt(page, ON_LINK.x, ON_LINK.y)) === 'pointer',
      String(await cursorAt(page, ON_LINK.x, ON_LINK.y))
    );
    check(
      engine,
      'reads running text as a caret',
      (await cursorAt(page, ON_TEXT.x, ON_TEXT.y)) === 'text',
      String(await cursorAt(page, ON_TEXT.x, ON_TEXT.y))
    );
    check(
      engine,
      'reads blank paper as an arrow',
      (await cursorAt(page, ON_NOTHING.x, ON_NOTHING.y)) === 'default',
      String(await cursorAt(page, ON_NOTHING.x, ON_NOTHING.y))
    );
    // The probe used to ask the top document only, so a link inside a frame
    // resolved to the iframe element and reported an arrow.
    check(
      engine,
      'reads a link inside a frame',
      (await cursorAt(page, ON_FRAME_LINK.x, ON_FRAME_LINK.y)) === 'pointer',
      String(await cursorAt(page, ON_FRAME_LINK.x, ON_FRAME_LINK.y))
    );

    // --- evaluate --------------------------------------------------------------------
    const value = await evaluated(page, 'Promise.resolve({ a: 1 })');
    check(
      engine,
      'awaits and describes a value',
      value.kind === 'value' && value.type === 'Object',
      `${value.type} ${value.preview}`
    );
    check(
      engine,
      'offers json for a plain object',
      JSON.stringify(value.json) === '{"a":1}',
      JSON.stringify(value.json)
    );

    const node = await evaluated(page, 'document.body');
    check(
      engine,
      'describes a DOM node rather than serialising it',
      (node.type ?? '').endsWith('Element') && node.preview === '<body>',
      `${node.type} ${node.preview}`
    );

    const cyclic = await evaluated(page, '(() => { const a = {}; a.self = a; return a; })()');
    check(
      engine,
      'survives a cyclic object',
      cyclic.kind === 'value' && cyclic.json === undefined,
      cyclic.preview
    );

    const thrown = await evaluated(page, 'nope.not.here');
    check(engine, 'reports a throwing expression', thrown.kind === 'error', thrown.message);

    // --- a selection outlives a scroll ---------------------------------------------------
    // The highlight is drawn from rectangles, so an element that scrolls has to
    // be measured again. Asking by point would answer about whatever scrolled
    // into the point instead, which is wrong rather than merely stale.
    const before = await inspect(page, ON_TEXT.x, ON_TEXT.y);
    // Measured with no wait at all: a pane announces the move between applying
    // the scroll and the frame that shows it, so the answer has to be current
    // the moment the scroll has been applied rather than a settle later.
    await page.evaluate('window.scrollTo(0, 120)');
    const after = await remeasure(page);
    check(
      engine,
      'remeasures the element it was holding',
      after?.id === 'words' && before?.id === 'words',
      `${before?.id ?? 'null'} then ${after?.id ?? 'null'}`
    );
    check(
      engine,
      'the box follows the scroll',
      Math.abs((before?.box.border.y ?? 0) - (after?.box.border.y ?? 0) - 120) < 1.5,
      `${before?.box.border.y} then ${after?.box.border.y}`
    );
    check(
      engine,
      'keeps the rules it already read',
      (after?.rules?.length ?? 0) === (before?.rules?.length ?? -1)
    );

    await page.evaluate("document.getElementById('words').remove()");
    check(engine, 'forgets an element that left the document', (await remeasure(page)) === null);
    await page.evaluate('window.scrollTo(0, 0)');

    if (shadowed) {
      identities.set(engine, identityOf(shadowed));
    }

    // --- the page is left alone -------------------------------------------------------
    const leaked = await page.evaluate(
      "Object.keys(globalThis).some(name => name.indexOf('devkit') !== -1)"
    );
    check(engine, 'installs nothing enumerable', leaked === false);

    // --- console vocabulary --------------------------------------------------------------
    const unknown = [...kinds].filter(kind => !CONSOLE_MESSAGE_TYPES[kind.toLowerCase()]);
    console.log(`  note ${engine.padEnd(9)} console types: ${[...kinds].sort().join(', ')}`);
    check(
      engine,
      'every console type it emits is classified',
      unknown.length === 0,
      unknown.length > 0 ? `unclassified: ${unknown.join(', ')}` : ''
    );
    // Exactly one: the page's own. A second means the walker put something in
    // the page's console, which is the one thing it must never do — WebKit
    // reports a security error for so much as reaching at a cross-origin frame.
    check(
      engine,
      'reports the page error and adds none of its own',
      errors.length === 1,
      errors.join(' | ')
    );
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${engine.padEnd(9)} threw — ${String(error)}`);
  } finally {
    await browser?.close().catch(() => {});
  }
}

let ownOrigin = '';
let otherOrigin = '';
const own = await serve(() => ({
  main: mainPage(ownOrigin, otherOrigin),
  frame: framePage(ownOrigin),
}));
const other = await serve(() => ({
  main: mainPage(otherOrigin, ownOrigin),
  frame: framePage(otherOrigin),
}));
ownOrigin = own.origin;
otherOrigin = other.origin;

for (const engine of Object.keys(launchers) as EngineName[]) {
  await run(engine, ownOrigin);
}
await own.close();
await other.close();

// The premise of the whole feature: one point, one element, whoever is asked.
const agreed = new Set(identities.values());
if (agreed.size > 1) {
  failures += 1;
  console.log('\n  FAIL      the engines identify the same point differently');
  identities.forEach((identity, engine) => console.log(`            ${engine}: ${identity}`));
} else {
  console.log(`\n  ok        all engines identify the point as ${[...agreed][0] ?? 'nothing'}`);
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
