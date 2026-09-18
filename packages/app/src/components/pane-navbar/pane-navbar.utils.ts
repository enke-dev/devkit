import type { Engine, PaneStatus } from '@devkit/protocol';
import type { IconDefinition } from '@fortawesome/free-brands-svg-icons';
import { faChrome, faFirefoxBrowser, faSafari } from '@fortawesome/free-brands-svg-icons';
import type { TemplateResult } from 'lit';
import { html, svg } from 'lit';

/** Frontend-only state: the engine's binary has not been downloaded yet. */
export type ViewStatus = Exclude<PaneStatus, 'live'> | 'missing' | 'stream' | 'settled';

/**
 * One label for the whole of a pane's condition, and the colour it is said in.
 *
 * A running pane is always in one of two modes, and both are healthy: streaming
 * live frames because something is moving, or sitting on the device-resolution
 * still taken once it settled.
 */
const STATUS: Record<ViewStatus, { label: string; colour: string }> = {
  missing: { label: 'not installed', colour: 'var(--text-dim)' },
  idle: { label: 'idle', colour: 'var(--text-dim)' },
  launching: { label: 'launching…', colour: 'var(--pending)' },
  stream: { label: 'stream', colour: 'var(--pending)' },
  settled: { label: 'settled', colour: 'var(--ok)' },
  failed: { label: 'failed', colour: 'var(--danger)' },
  closed: { label: 'closed', colour: 'var(--text-dim)' },
};

/**
 * The mark each engine is known by, drawn in the header beside its name.
 *
 * These are browser marks, not engine marks — no set draws Blink or Gecko — so
 * each stands in for the engine its browser is built on. The marks belong to
 * their owners; they identify what is rendering, nothing more.
 */
const ENGINE_GLYPHS: Record<Engine, IconDefinition> = {
  chromium: faChrome,
  firefox: faFirefoxBrowser,
  webkit: faSafari,
};

/** The two modes a running pane alternates between. */
const RUNNING: ViewStatus[] = ['stream', 'settled'];

export function isRunning(status: ViewStatus): boolean {
  return RUNNING.includes(status);
}

export function statusLabel(status: ViewStatus): string {
  return STATUS[status].label;
}

export function statusColour(status: ViewStatus): string {
  return STATUS[status].colour;
}

/** The engine's mark, sized and coloured by the title it sits in. */
export function renderEngineGlyph(engine: Engine): TemplateResult {
  const [width, height, , , path] = ENGINE_GLYPHS[engine].icon;
  return html`
    <svg class="engine" viewBox="0 0 ${width} ${height}" aria-hidden="true">
      ${svg`<path d=${String(path)} />`}
    </svg>
  `;
}
