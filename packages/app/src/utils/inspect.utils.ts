import type {
  ElementRef,
  Engine,
  Event,
  InspectedElement,
  InspectedProperty,
} from '@devkit/protocol';
import { INSPECTED_PROPERTIES } from '@devkit/protocol';

/**
 * What the introspection panels hold, and the small amount of reasoning that
 * turns three engines' answers into one view.
 *
 * The interesting decisions are all about agreement: the panes are only worth
 * showing as one table when they are describing the same thing, and the app is
 * the only place that can tell — the sidecar answers per engine and never sees
 * the other two.
 */

/** One engine's answer to an `inspect`, kept whether or not it found anything. */
export interface InspectAnswer {
  engine: Engine;
  element: InspectedElement | null;
  error?: string;
}

/** Console messages and page errors, in one list because they belong in one list. */
export type ConsoleEntry = Extract<Event, { type: 'console' } | { type: 'page-error' }>;

/** One expression, and whatever each engine made of it. */
export interface Evaluation {
  id: string;
  expression: string;
  results: { engine: Engine; result: Extract<Event, { type: 'evaluated' }>['result'] }[];
}

/**
 * How many console entries are kept.
 *
 * The sidecar already folds repeats and caps the rate, so this is not a flood
 * defence — it is the point past which nobody scrolls, and beyond which the
 * list costs more to render than it is worth.
 */
export const CONSOLE_LIMIT = 2000;

/** `div#main.card.wide`, the way a breadcrumb says it. */
export function describeRef(ref: Pick<ElementRef, 'tag' | 'id' | 'classes'>): string {
  const id = ref.id ? `#${ref.id}` : '';
  return `${ref.tag}${id}${ref.classes.map(name => `.${name}`).join('')}`;
}

/**
 * The element and its ancestors, outermost first — the order a breadcrumb reads
 * in, which is the reverse of the order the walker reports.
 */
export function breadcrumb(element: InspectedElement): ElementRef[] {
  const own: ElementRef = {
    tag: element.tag,
    classes: element.classes,
    index: element.index,
    ...(element.id === undefined ? {} : { id: element.id }),
  };
  return [...[...element.path].reverse(), own];
}

/**
 * A string that says *which* element this is, and nothing about how it looks.
 *
 * Tag, position among siblings and the boundary each step crossed, from the
 * document down. Deliberately not id or class: those are what the engines are
 * being compared on, and an identity that changed when a class did would call
 * the same element two different ones.
 */
export function identitySteps(element: InspectedElement): string[] {
  return breadcrumb(element).map(
    ref =>
      `${ref.boundary ? `${ref.boundary}>` : ''}${ref.id ? `#${ref.id}` : `${ref.tag}[${ref.index}]`}`
  );
}

export function identityOf(element: InspectedElement): string {
  return identitySteps(element).join('/');
}

/**
 * The first step at which the engines stop agreeing, or -1 if they never do.
 *
 * Without this the panel could say the engines had resolved different elements
 * and then show three identical descriptions of the leaf, which is what they
 * disagreed about least — the difference is always somewhere above it, and an
 * assertion nobody can check is worse than no assertion.
 */
export function divergesAt(answers: InspectAnswer[]): number {
  const chains = found(answers).map(identitySteps);
  if (chains.length < 2) {
    return -1;
  }
  const shortest = Math.min(...chains.map(chain => chain.length));
  const differing = Array.from({ length: shortest }, (_, step) => step).find(
    step => new Set(chains.map(chain => chain[step])).size > 1
  );
  if (differing !== undefined) {
    return differing;
  }
  // Agreed as far as the shorter of them goes: one tree is deeper than the
  // other, and the extra step is the difference.
  return chains.some(chain => chain.length !== shortest) ? shortest : -1;
}

function found(answers: InspectAnswer[]): InspectedElement[] {
  return answers
    .map(answer => answer.element)
    .filter((element): element is InspectedElement => element !== null);
}

/**
 * Whether the engines resolved the same element, which decides whether one
 * table can speak for all of them.
 *
 * An engine that found nothing is left out of the question rather than counted
 * as disagreeing: it has its own column saying so, and letting it break the
 * comparison would hide the agreement between the two that did answer.
 */
export function agreed(answers: InspectAnswer[]): boolean {
  const identities = new Set(found(answers).map(identityOf));
  return identities.size <= 1;
}

/**
 * The properties the engines do not agree about — the only rows worth looking
 * at, and the reason the compared set is curated rather than everything
 * `getComputedStyle` enumerates.
 */
export function differingProperties(answers: InspectAnswer[]): Set<InspectedProperty> {
  const elements = found(answers);
  if (elements.length < 2) {
    return new Set();
  }
  return new Set(
    INSPECTED_PROPERTIES.filter(
      property => new Set(elements.map(element => element.styles[property])).size > 1
    )
  );
}

/**
 * Everything about a readout that is worth redrawing for.
 *
 * Which engines answered, which element each of them resolved, where it sits,
 * and what it computed to. Two samples that agree on all of that describe the
 * same thing, and replacing the panel with an identical one costs a layout and
 * makes the text flicker under a pointer that has not left the element.
 */
export function readoutSignature(answers: InspectAnswer[]): string {
  return answers
    .map(answer => {
      const element = answer.element;
      if (!element) {
        return `${answer.engine}:none:${answer.error ?? ''}`;
      }
      const { x, y, width, height } = element.box.border;
      const styles = INSPECTED_PROPERTIES.map(property => element.styles[property]).join(',');
      return `${answer.engine}:${identityOf(element)}:${x},${y},${width},${height}:${styles}`;
    })
    .join('|');
}

/**
 * Newest last, the way a console reads.
 *
 * `at` orders the three engines against each other and `seq` breaks the ties,
 * which a page logging in a loop produces by the dozen — two engines can easily
 * stamp the same millisecond, and the order they happened to reach the webview
 * in is not an answer.
 */
export function inConsoleOrder(entries: ConsoleEntry[]): ConsoleEntry[] {
  return [...entries].sort(
    (a, b) => a.at - b.at || a.seq - b.seq || a.engine.localeCompare(b.engine)
  );
}

/** Add an entry, keeping the list within `CONSOLE_LIMIT` and in order. */
export function appendConsole(entries: ConsoleEntry[], entry: ConsoleEntry): ConsoleEntry[] {
  return inConsoleOrder([...entries, entry]).slice(-CONSOLE_LIMIT);
}

/** An entry's severity, page errors being errors whether or not they say so. */
export function levelOf(entry: ConsoleEntry): 'log' | 'debug' | 'info' | 'warn' | 'error' {
  return entry.type === 'page-error' ? 'error' : entry.level;
}

/**
 * When an entry arrived, to the millisecond.
 *
 * Milliseconds and not less, because a page can print several within one of
 * them — which is exactly why entries carry a sequence number as well as a
 * time, and why the two together are what puts three engines in one order.
 */
export function timeOf(entry: ConsoleEntry): string {
  const at = new Date(entry.at);
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}.${pad(at.getMilliseconds(), 3)}`;
}

/** What an entry actually says, which for an error is its message. */
export function textOf(entry: ConsoleEntry): string {
  return entry.type === 'page-error' ? entry.message : entry.text;
}

const SEVERITY = ['debug', 'log', 'info', 'warn', 'error'] as const;

/** Whether an entry is at least as severe as the filter asks for. */
export function atLeast(entry: ConsoleEntry, floor: (typeof SEVERITY)[number]): boolean {
  return SEVERITY.indexOf(levelOf(entry)) >= SEVERITY.indexOf(floor);
}

export const CONSOLE_FLOORS = SEVERITY;
