/* eslint-disable no-console */
/**
 * Behaviour test for the DOM tree, across all three engines.
 *
 * The tree's premise is the opposite of the point inspector's. A point is an
 * identity every engine can be asked about; a tree is navigated, so every row
 * has to be re-addressable — and a handle is only ever valid in the pane that
 * minted it, for as long as that pane stays on the document that minted it.
 * Everything worth testing here follows from that:
 *
 * - **Handles resolve, and stop resolving.** A node asked for twice is the same
 *   node; a node asked for after a navigation is refused rather than confused
 *   with whatever inherited its number.
 * - **Boundaries are rows.** An open shadow root and a same-origin frame
 *   document each get a row of their own, because an element whose children
 *   silently come from somewhere else is a tree nobody can reason about. A
 *   cross-origin frame is a leaf that says why.
 * - **Identity crosses engines where handles cannot.** The chain of steps one
 *   engine produces has to name the same element in the other two — that is
 *   what lets one selection drive three columns of computed styles.
 * - **Watching reports what is now true.** Mutations arrive coalesced, as
 *   statements rather than as a log, and only for the subtrees that are open.
 * - **The page is still somebody else's.** No enumerable global, and no
 *   observers at all once nothing is expanded.
 *
 *   bun run verify:tree
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { DomChange, DomMatch, DomNode, InspectedElement } from '@devkit/protocol';
import type { Browser, Page } from 'playwright';
import { chromium, firefox, webkit } from 'playwright';

import { WALKER_KEY, WALKER_SOURCE } from '../dist/walker.js';

const VIEWPORT = { width: 800, height: 600 };

const framePage = `<!doctype html>
<html><body style="margin: 0">
  <div id="inner">inner</div>
</body></html>`;

/**
 * A page with one of everything the tree has to have an opinion about.
 *
 * The whitespace between the list items is deliberate and so is the comment:
 * both are nodes, and the tree has a different answer for each of them.
 */
const mainPage = (other: string) => `<!doctype html>
<html><head>
  <style>
    #badge::before { content: "!"; }
    #badge::after { content: none; }
  </style>
</head>
<body style="margin: 0">
  <div id="host"></div>
  <ul id="list">
    <li class="item">one</li>
    <li class="item">two</li>
  </ul>
  <!-- a comment -->
  <p id="badge">badge</p>
  <p id="words">hello there</p>
  <iframe id="frame" src="/frame.html" style="width: 200px; height: 100px;"></iframe>
  <iframe id="foreign" src="${other}/frame.html" style="width: 200px; height: 100px;"></iframe>
  <script>
    const root = document.getElementById('host').attachShadow({ mode: 'open' });
    root.innerHTML = '<div class="shadowed">shadowed</div>';
  </script>
</body></html>`;

const launchers = { chromium, firefox, webkit } as const;
type EngineName = keyof typeof launchers;

let failures = 0;

/** Each engine's identity chain for the same element, compared once all have run. */
const identities = new Map<string, string>();

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
    const { main, frame } = pages();
    const body = (request.url ?? '/').startsWith('/frame.html') ? frame : main;
    response.writeHead(200, { 'content-type': 'text/html' }).end(body);
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

/** Call the walker the way the pane calls it, so this tests what actually ships. */
function call<T>(page: Page, expression: string): Promise<T> {
  return page.evaluate(`globalThis[${JSON.stringify(WALKER_KEY)}].${expression}`) as Promise<T>;
}

const root = (page: Page, depth = 2): Promise<DomNode[]> => call(page, `tree(${depth})`);

const children = (page: Page, nodeId: string, depth = 1): Promise<DomNode[] | null> =>
  call(page, `childrenOf(${JSON.stringify(nodeId)}, ${depth})`);

const describeSteps = (page: Page, steps: string[]): Promise<InspectedElement | null> =>
  call(page, `describeSteps(${JSON.stringify(steps)})`);

const searchNodes = (page: Page, query: string): Promise<DomMatch[]> =>
  call(page, `searchNodes(${JSON.stringify(query)}, 20)`);

const watch = (page: Page, ids: string[]): Promise<number> =>
  call(page, `watch(${JSON.stringify(ids)})`);

const drain = (page: Page): Promise<{ gen: string; invalidated: boolean; changes: DomChange[] }> =>
  call(page, 'drain()');

/** A child of a node, found by the step that names it. */
function childBy(nodes: DomNode[], step: string): DomNode | undefined {
  return nodes.find(node => node.step === step);
}

/** Everything under a node that was sent with it, flattened. */
function flatten(node: DomNode): DomNode[] {
  return [node, ...(node.children ?? []).flatMap(flatten)];
}

async function run(engine: EngineName, origin: string): Promise<void> {
  console.log(`\n${engine}`);
  let browser: Browser | null = null;
  try {
    browser = await launchers[engine].launch({ headless: true });
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    await context.addInitScript(WALKER_SOURCE);
    const page = await context.newPage();

    await page.goto(origin, { waitUntil: 'load' });
    await page.waitForTimeout(500);

    // --- the root ------------------------------------------------------------
    const [document] = await root(page, 3);
    check(engine, 'answers with one document row', document?.kind === 'document', document?.kind);
    const deep = document ? flatten(document) : [];
    const body = deep.find(node => node.name === 'body');
    check(engine, 'sends the depth it was asked for', body !== undefined, `${deep.length} nodes`);

    const bodyRows = body?.nodeId ? ((await children(page, body.nodeId, 1)) ?? []) : [];
    check(engine, 'gives a node its children by handle', bodyRows.length > 0, `${bodyRows.length}`);

    // --- handles are stable ---------------------------------------------------
    const again = body?.nodeId ? ((await children(page, body.nodeId, 1)) ?? []) : [];
    check(
      engine,
      'mints one handle per node',
      bodyRows.every((node, at) => node.nodeId === again[at]?.nodeId)
    );

    // --- boundaries are rows --------------------------------------------------
    const host = childBy(bodyRows, '#host');
    const hostRows = host?.nodeId ? ((await children(page, host.nodeId, 1)) ?? []) : [];
    const shadow = childBy(hostRows, 'shadow');
    check(engine, 'gives an open shadow root a row', shadow?.kind === 'shadow-root', shadow?.kind);
    check(
      engine,
      'puts the shadow content under it',
      (shadow?.children ?? []).some(node => node.classes.includes('shadowed')),
      (shadow?.children ?? []).map(node => node.name).join(', ')
    );

    const frame = childBy(bodyRows, '#frame');
    // Deep enough to reach through the frame's own document, html and body:
    // a frame costs three levels before any of its content appears.
    const frameRows = frame?.nodeId ? ((await children(page, frame.nodeId, 4)) ?? []) : [];
    const inner = childBy(frameRows, 'frame');
    check(
      engine,
      'gives a same-origin frame document a row',
      inner?.kind === 'frame-document',
      inner?.kind
    );
    check(
      engine,
      'descends into it',
      flatten(inner ?? ({ children: [] } as unknown as DomNode)).some(node => node.id === 'inner')
    );

    const foreign = childBy(bodyRows, '#foreign');
    check(
      engine,
      'stops at a cross-origin frame and says so',
      (foreign?.note ?? '').includes('cross-origin'),
      foreign?.note ?? 'nothing said'
    );

    // --- what a row is --------------------------------------------------------
    const list = childBy(bodyRows, '#list');
    const items = list?.nodeId ? ((await children(page, list.nodeId, 1)) ?? []) : [];
    check(
      engine,
      'drops whitespace-only text between elements',
      items.every(node => node.kind === 'element'),
      items.map(node => node.kind).join(', ')
    );
    check(
      engine,
      'counts same-tag siblings for the step',
      items.map(node => node.step).join(' ') === 'li[0] li[1]',
      items.map(node => node.step).join(' ')
    );
    check(
      engine,
      'keeps the text inside an element',
      (items[0]?.children ?? []).some(node => node.kind === 'text' && node.value === 'one'),
      (items[0]?.children ?? []).map(node => `${node.kind}:${node.value ?? ''}`).join(', ')
    );
    check(
      engine,
      'keeps comments',
      bodyRows.some(node => node.kind === 'comment' && (node.value ?? '').includes('a comment'))
    );

    // --- generated content ----------------------------------------------------
    const badge = childBy(bodyRows, '#badge');
    check(
      engine,
      'reports generated content that renders',
      badge?.pseudo?.includes('before') === true,
      (badge?.pseudo ?? []).join(', ') || 'none'
    );
    check(
      engine,
      'leaves out the one set to none',
      badge?.pseudo?.includes('after') !== true,
      (badge?.pseudo ?? []).join(', ') || 'none'
    );

    // --- search ---------------------------------------------------------------
    const bySelector = await searchNodes(page, '.item');
    check(engine, 'searches by selector', bySelector.length === 2, `${bySelector.length} matches`);
    check(
      engine,
      'hands back the ancestors to open',
      (bySelector[0]?.ancestors.length ?? 0) > 2,
      `${bySelector[0]?.ancestors.length ?? 0} deep`
    );
    const byText = await searchNodes(page, 'hello there');
    check(
      engine,
      'falls back to text when a selector matches nothing',
      byText.some(match => match.label.includes('#words')),
      byText.map(match => match.label).join(', ') || 'none'
    );
    const inShadow = await searchNodes(page, '.shadowed');
    check(engine, 'searches inside shadow roots', inShadow.length === 1, `${inShadow.length}`);

    // --- identity, which is what crosses engines -------------------------------
    const words = childBy(bodyRows, '#words');
    const steps = ['document', 'html[0]', 'body[0]', words?.step ?? ''];
    const described = await describeSteps(page, steps);
    check(
      engine,
      'describes an element by its identity chain',
      described?.id === 'words',
      described ? `${described.tag}#${described.id ?? ''}` : 'nothing'
    );
    check(
      engine,
      'the description carries a handle back',
      described?.nodeId !== undefined && described.nodeId === words?.nodeId
    );
    check(
      engine,
      'and the ancestors to reveal it',
      (described?.ancestors?.length ?? 0) >= 3,
      `${described?.ancestors?.length ?? 0}`
    );
    const missing = await describeSteps(page, ['document', 'html[0]', 'body[0]', '#nope']);
    check(engine, 'answers null for a chain it has no element for', missing === null);
    if (words) {
      identities.set(engine, steps.join('/'));
    }

    // --- revealing, which is what switching engines does ------------------------
    // The app opens one engine's tree to what another engine had selected by
    // walking the chain that engine's own description came back with. Each
    // ancestor's children have to arrive, and the last of them has to contain
    // the node — otherwise the tree opens to the right depth and selects
    // nothing.
    const chain = described?.ancestors ?? [];
    const walked = await Promise.all(chain.map(id => children(page, id, 0)));
    check(
      engine,
      'every ancestor on the way can be opened',
      walked.every(rows => rows !== null),
      `${walked.filter(rows => rows !== null).length}/${chain.length} opened`
    );
    check(
      engine,
      'the last of them holds the node',
      (walked[walked.length - 1] ?? []).some(row => row.nodeId === described?.nodeId),
      (walked[walked.length - 1] ?? []).map(row => row.step).join(', ') || 'nothing'
    );

    // --- watching -------------------------------------------------------------
    check(engine, 'watches nothing until asked', (await drain(page)).changes.length === 0);
    const listId = list?.nodeId ?? '';
    // Both the list and its first item, because a row is only on screen if its
    // parent is expanded: the list being open shows the items, and the item
    // being open is what shows the text inside it.
    const firstItemId = items[0]?.nodeId ?? '';
    await watch(page, [listId, firstItemId]);
    await page.evaluate(`(() => {
      const list = document.getElementById('list');
      const extra = document.createElement('li');
      extra.className = 'item';
      extra.textContent = 'three';
      list.appendChild(extra);
      list.setAttribute('data-state', 'grown');
      list.firstElementChild.firstChild.nodeValue = 'ONE';
    })()`);
    await page.waitForTimeout(100);
    const changed = await drain(page);
    check(
      engine,
      'reports a changed child list',
      changed.changes.some(change => change.kind === 'children' && change.nodeId === listId),
      changed.changes.map(change => change.kind).join(', ') || 'nothing'
    );
    check(
      engine,
      'reports a changed attribute',
      changed.changes.some(
        change =>
          change.kind === 'attributes' &&
          change.attributes.some(([name, value]) => name === 'data-state' && value === 'grown')
      )
    );
    check(
      engine,
      'reports changed text',
      changed.changes.some(change => change.kind === 'value' && change.value === 'ONE')
    );
    check(engine, 'drains what it reported', (await drain(page)).changes.length === 0);

    // An item the app has a handle for, rather than the one just appended: a
    // node nobody was ever told about needs no telling that it has gone, and
    // the changed child list above already says the list is different.
    await page.evaluate("document.querySelectorAll('#list .item')[1].remove()");
    await page.waitForTimeout(100);
    check(
      engine,
      'reports a node that left',
      (await drain(page)).changes.some(
        change => change.kind === 'removed' && change.nodeId === items[1]?.nodeId
      )
    );

    // A change outside every watched subtree is a change nobody can see.
    await page.evaluate("document.getElementById('badge').setAttribute('data-x', '1')");
    await page.waitForTimeout(100);
    check(
      engine,
      'ignores changes to rows nobody has open',
      (await drain(page)).changes.length === 0
    );

    // --- a storm is an invalidation rather than a log ---------------------------
    await page.evaluate(`(() => {
      const list = document.getElementById('list');
      Array.from({ length: 400 }).forEach((_, at) => {
        const item = document.createElement('li');
        item.textContent = String(at);
        list.appendChild(item);
      });
    })()`);
    // Described first: a node with no handle produces no change at all, so a
    // storm only counts once the app is actually holding the rows it touches.
    await children(page, listId, 0);
    await drain(page);
    await page.evaluate(`(() => {
      Array.from(document.getElementById('list').children).forEach((item, at) =>
        item.setAttribute('data-at', String(at))
      );
    })()`);
    await page.waitForTimeout(150);
    const stormed = await drain(page);
    check(
      engine,
      'gives up describing a storm and says to start again',
      stormed.invalidated,
      `${stormed.changes.length} changes`
    );

    // --- watching stops ---------------------------------------------------------
    await watch(page, []);
    await page.evaluate("document.getElementById('list').setAttribute('data-state', 'quiet')");
    await page.waitForTimeout(100);
    check(engine, 'stops watching when the set empties', (await drain(page)).changes.length === 0);

    // --- handles die with their document -----------------------------------------
    const before = await drain(page);
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(300);
    check(
      engine,
      'refuses a handle from the document it left',
      (await children(page, listId, 1)) === null
    );
    check(
      engine,
      'names the new document differently',
      (await drain(page)).gen !== before.gen,
      `${before.gen} then ${(await drain(page)).gen}`
    );

    // --- the page is left alone ----------------------------------------------------
    const leaked = await page.evaluate(
      "Object.keys(globalThis).some(name => name.indexOf('devkit') !== -1)"
    );
    check(engine, 'installs nothing enumerable', leaked === false);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${engine.padEnd(9)} threw — ${String(error)}`);
  } finally {
    await browser?.close().catch(() => {});
  }
}

let otherOrigin = '';
const other = await serve(() => ({ main: mainPage(''), frame: framePage }));
otherOrigin = other.origin;
const own = await serve(() => ({ main: mainPage(otherOrigin), frame: framePage }));

for (const engine of Object.keys(launchers) as EngineName[]) {
  await run(engine, own.origin);
}
await own.close();
await other.close();

// The premise of the selection: one chain, one element, whoever is asked.
const agreed = new Set(identities.values());
if (agreed.size > 1) {
  failures += 1;
  console.log('\n  FAIL      the engines name the same element differently');
  identities.forEach((identity, engine) => console.log(`            ${engine}: ${identity}`));
} else {
  console.log(`\n  ok        all engines name the element ${[...agreed][0] ?? 'nothing'}`);
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
