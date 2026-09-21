/* eslint-disable no-console */
/**
 * Behaviour test for the tree's reveal, against the real app.
 *
 * The tree opens itself to an element on four different cues — a pick, a
 * search, a change of engine, a document that churned under it — and every one
 * of them is a conversation with three panes rather than a call. What has gone
 * wrong here has always been the order the answers came back in:
 *
 * - **A pick that beats the tree.** Opening the drawer asks for a document and
 *   the pointer does not wait for it. A reveal recorded when there is no tree
 *   yet has to survive until there is one.
 * - **A tree that arrives with a reveal already waiting.** A reveal advances on
 *   the answers to the children it asked for. A tree that has just arrived has
 *   none outstanding, so nothing would carry it on.
 * - **Handles that belong to another engine.** Between asking one engine for a
 *   tree and being handed it, the tree on screen is still the engine before it.
 *   Anything recorded in that window names nodes this engine never had.
 * - **A document that churned.** An invalidation means either a new document or
 *   a burst too large to describe, and the pane cannot say which — so the tree
 *   must come back open where it was when the nodes are still there.
 *
 * None of that is reachable by clicking: it depends on which round trip lands
 * first. So the backend is replaced with one this drives by hand, and the
 * ordering becomes the test rather than the weather. Everything above the
 * bridge — the components, their state, every decision under test — is what
 * ships.
 *
 * Kept out of the way when nobody asks for it: the fixture lives under
 * `scripts/`, which Vite never builds — it takes `index.html` alone — and the
 * server below picks its own port, so a run costs a working dev server nothing.
 * The scripts are a TypeScript project of their own for the same reason the
 * sidecar's are: this one spans Node and the page, and widening the app's own
 * config to admit Node is how `src` quietly gains access to it.
 *
 *   bun run verify:reveal
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';

const HERE = new URL('.', import.meta.url).pathname;

let failures = 0;

function check(what: string, ok: boolean, detail = ''): void {
  if (!ok) {
    failures += 1;
  }
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ` — ${detail}` : ''}`);
}

/** What the tree is showing, as one readable line. */
function shown(rows: { label: string; selected: boolean }[]): string {
  return rows.map(row => `${row.label}${row.selected ? '*' : ''}`).join(' / ') || 'nothing';
}

/**
 * The app's own dev server, on a port of its own.
 *
 * The project's config pins port 1430 and refuses to move, which is right for
 * Tauri and wrong for this: a verification run must not care whether somebody
 * is working in the app at the time. The config is still loaded — the
 * components import their styles through its plugins — and only the server is
 * overridden.
 */
const server = await createServer({
  root: `${HERE}..`,
  logLevel: 'silent',
  server: { port: 0, strictPort: false, watch: null },
});
await server.listen();

const origin = server.resolvedUrls?.local[0];
if (origin === undefined) {
  console.log('  FAIL the dev server reported no address');
  await server.close();
  process.exit(1);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });

/**
 * What the page complained about, less the one thing it is entitled to.
 *
 * Outside Tauri there is no `tauri://` or `ipc://`, so anything the app fetches
 * over one of its schemes fails to load. That is this harness missing a
 * runtime, not the app misbehaving, and it is the only failure allowed through
 * — everything else counts, which is what makes the check worth having.
 */
const problems: string[] = [];
const note = (message: string): void => {
  if (!message.includes('ERR_UNKNOWN_URL_SCHEME')) {
    problems.push(message);
  }
};
page.on('pageerror', error => note(String(error)));
page.on('console', message => {
  if (message.type() === 'error') {
    note(message.text());
  }
});

interface Row {
  label: string;
  selected: boolean;
}
interface Harness {
  bringUp(): void;
  openInspector(): void;
  pick(): void;
  askPick(): string;
  answerPick(id: string): void;
  answerRoot(): boolean;
  answerChildren(): number;
  switchEngine(engine: string): void;
  invalidate(engine: string): void;
  blockPane(engine: string): void;
  paneText(engine: string): string;
  startCount(): number;
  rows(): Row[];
  markedEngine(): string;
  sentTypes(): string[];
}
/** Provided by the fixture, inside the page rather than here. */
declare const harness: Harness;

const settle = (ms = 120): Promise<void> => page.waitForTimeout(ms);

/** Answer children until the reveal stops asking for any. */
async function drainChildren(): Promise<void> {
  const rounds = Array.from({ length: 8 }, (_, at) => at);
  for (const _round of rounds) {
    const asked = await page.evaluate(() => harness.answerChildren());
    if (asked === 0) {
      return;
    }
    await settle();
  }
}

try {
  await page.goto(`${origin}scripts/reveal/harness.html`, { waitUntil: 'networkidle' });
  await settle(400);

  await page.evaluate(() => harness.bringUp());
  await settle();
  await page.evaluate(() => harness.openInspector());
  await settle(250);

  check(
    'opening the drawer asks for a document',
    (await page.evaluate(() => harness.sentTypes())).includes('dom-root')
  );

  // --- a pick that beats the tree it opens ----------------------------------
  // The drawer has asked for a document and has not been given one. This is the
  // first pick of a session, and the one that expanded nothing at all.
  await page.evaluate(() => harness.pick());
  await settle(250);
  check(
    'shows nothing while the document is still on its way',
    (await page.evaluate(() => harness.rows())).length === 0
  );

  await page.evaluate(() => harness.answerRoot());
  await settle(200);
  await drainChildren();
  await settle(200);

  let rows = await page.evaluate(() => harness.rows());
  check(
    'opens to a pick that arrived before it did',
    rows.length === 5 && rows[rows.length - 1]?.selected === true,
    shown(rows)
  );

  // --- a pick once the tree is there ----------------------------------------
  await page.evaluate(() => harness.pick());
  await settle(250);
  await drainChildren();
  rows = await page.evaluate(() => harness.rows());
  check(
    'stays open on a pick it already had',
    rows.length === 5 && rows[rows.length - 1]?.selected === true,
    shown(rows)
  );

  // --- changing engine ------------------------------------------------------
  // The handles are per pane, so this only works if the tree opens itself from
  // what the engine being switched to said, rather than from what the last one
  // did.
  await page.evaluate(() => harness.switchEngine('webkit'));
  await settle(120);
  check(
    'keeps the tree it has while the next one is fetched',
    (await page.evaluate(() => harness.rows())).length === 5,
    shown(await page.evaluate(() => harness.rows()))
  );

  await page.evaluate(() => harness.answerRoot());
  await settle(200);
  await drainChildren();
  await settle(200);

  rows = await page.evaluate(() => harness.rows());
  check(
    'opens the next engine to the same element',
    rows.length === 5 && rows[rows.length - 1]?.selected === true,
    shown(rows)
  );
  check(
    'and marks the engine it is showing',
    (await page.evaluate(() => harness.markedEngine())) === 'WebKit',
    await page.evaluate(() => harness.markedEngine())
  );

  // --- a document that churned ----------------------------------------------
  // The nodes are still there, so what was open has to come back open. This is
  // the one that read as the tree closing itself a beat after it opened.
  await page.evaluate(() => harness.invalidate('webkit'));
  await settle(150);
  await page.evaluate(() => harness.answerRoot());
  await settle(200);
  await drainChildren();
  await settle(200);

  rows = await page.evaluate(() => harness.rows());
  check(
    'comes back open after a churn it can still resolve',
    rows.length === 5 && rows[rows.length - 1]?.selected === true,
    shown(rows)
  );

  // --- a pick taken while a tree is on its way -------------------------------
  // The reveal is recorded against the engine being fetched, not the one on
  // screen, and the handles are prefixed per engine — so a tree that took the
  // wrong one would ask this engine about nodes it never had.
  await page.evaluate(() => harness.switchEngine('firefox'));
  await settle(80);
  await page.evaluate(() => {
    const id = harness.askPick();
    harness.answerPick(id);
  });
  await settle(150);
  await page.evaluate(() => harness.answerRoot());
  await settle(200);
  await drainChildren();
  await settle(200);

  rows = await page.evaluate(() => harness.rows());
  check(
    'opens correctly when a pick lands mid-switch',
    rows.length === 5 && rows[rows.length - 1]?.selected === true,
    shown(rows)
  );

  // A pane macOS refused, which is not a crash and must not be treated as one.
  const startsBefore = await page.evaluate(() => harness.startCount());
  await page.evaluate(() => harness.blockPane('firefox'));
  await settle(200);

  const blockedText = await page.evaluate(() => harness.paneText('firefox'));
  check(
    'a blocked pane offers to ask for the permission',
    blockedText.includes('Allow access'),
    blockedText || 'the pane said nothing'
  );
  check(
    'a blocked pane does not send anybody to Settings before they were asked',
    !blockedText.includes('Open Settings'),
    blockedText
  );
  check(
    'a blocked pane does not quote the browser instead',
    !blockedText.includes('Could not find profile folder'),
    blockedText
  );

  // Past the two seconds a dead engine would have been restarted after.
  await settle(2600);
  check(
    'a blocked pane is not relaunched into the same refusal',
    (await page.evaluate(() => harness.startCount())) === startsBefore,
    `start sent ${(await page.evaluate(() => harness.startCount())) - startsBefore} more time(s)`
  );

  check('the page reported no errors', problems.length === 0, problems.slice(0, 3).join(' | '));
} catch (error) {
  failures += 1;
  console.log(`  FAIL threw — ${String(error)}`);
} finally {
  await browser.close().catch(() => {});
  await server.close().catch(() => {});
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
