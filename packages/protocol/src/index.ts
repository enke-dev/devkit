/**
 * Wire protocol between the Tauri backend (Rust) and the Playwright sidecar (Node).
 *
 * Transport is newline-delimited JSON over the sidecar's stdin/stdout. The Rust
 * side is a dumb relay: it parses just enough to route, and forwards payloads to
 * the frontend over Tauri events. Keep this file in sync with
 * `src-tauri/src/protocol.rs`.
 */

export const ENGINES = ['chromium', 'firefox', 'webkit'] as const;

export type Engine = (typeof ENGINES)[number];

/** Human-facing engine labels. Gecko/WebKit are the engines, Firefox/Safari the browsers. */
export const ENGINE_LABELS: Record<Engine, string> = {
  chromium: 'Chromium',
  firefox: 'Gecko',
  webkit: 'WebKit',
};

/**
 * The scheme a page is told the user prefers.
 *
 * Playwright emulates `prefers-color-scheme` per context and defaults it to
 * light, whatever the host machine is set to — so it is always stated, never
 * inherited.
 */
export type ColorScheme = 'light' | 'dark';

export interface Viewport {
  width: number;
  height: number;
  /** Device pixel ratio the engine renders at. */
  scale: number;
}

// ---------------------------------------------------------------------------
// Host -> sidecar
// ---------------------------------------------------------------------------

export type Command =
  /** Report whether Playwright's browser binaries are present, per engine. */
  | { type: 'probe' }
  /**
   * Download missing browser binaries, streaming `install-progress` events.
   * Omitting `engines` means every missing engine.
   */
  | { type: 'install'; engines?: Engine[] }
  /** Launch the given engines and start capturing. Idempotent per engine. */
  | { type: 'start'; engines: Engine[]; viewport: Viewport; colorScheme: ColorScheme }
  /**
   * Navigate every running pane to the same URL (lockstep navigation).
   *
   * Back and forward are navigations too. The app keeps the trail — it outlives
   * the engines, which have no history of their own after a restart — so it
   * says where to go rather than asking them to step.
   */
  | { type: 'navigate'; url: string }
  | { type: 'reload' }
  /** Resize every pane's viewport. Frames after this arrive at the new size. */
  | { type: 'resize'; viewport: Viewport }
  /**
   * Tell one pane's page which colour scheme the user prefers.
   *
   * Per pane rather than lockstep: seeing one engine's dark rendering beside
   * another's light one is a comparison worth making. Applied in place, so no
   * relaunch and no frame is lost to it.
   */
  | { type: 'color-scheme'; engine: Engine; scheme: ColorScheme }
  /**
   * Replay a user input event in one pane, or in all of them at once.
   *
   * Mirroring to `'all'` matches lockstep navigation: one click, three engines
   * reacting side by side. Coordinates are viewport pixels, and since every
   * pane shares one viewport they need no per-engine adjustment.
   */
  | {
      type: 'input';
      engine: Engine | 'all';
      event: InputEvent;
      /**
       * The pane the pointer is actually over. Input is mirrored to every pane,
       * but only this one is asked what cursor it would be showing — three
       * round trips per movement to learn the same answer would be wasteful.
       */
      source?: Engine;
    }
  /** Close all contexts and browsers, then exit. */
  | { type: 'shutdown' };

/** Pane-relative input, in viewport pixels with the pane's top-left as the origin. */
export type InputEvent =
  | { kind: 'mousemove'; x: number; y: number }
  | { kind: 'mousedown'; x: number; y: number; button: 'left' | 'middle' | 'right' }
  | { kind: 'mouseup'; x: number; y: number; button: 'left' | 'middle' | 'right' }
  | { kind: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }
  | { kind: 'keydown'; key: string }
  | { kind: 'keyup'; key: string }
  | { kind: 'text'; text: string };

/** A command with the correlation id the sidecar echoes back in its `ack`. */
export type Request = Command & { id: string };

// ---------------------------------------------------------------------------
// Sidecar -> host
// ---------------------------------------------------------------------------

export type Event =
  /**
   * The sidecar's identity. Confirms the process is alive and speaking.
   *
   * Written once at spawn — before the window exists — and again in answer to
   * `probe`, which is how a frontend that reloaded learns it at all.
   */
  | { type: 'hello'; pid: number; playwrightVersion: string; nodeVersion: string }
  /** Terminal response to a `Request`; `id` correlates. */
  | { type: 'ack'; id: string; ok: true }
  | { type: 'ack'; id: string; ok: false; error: string }
  /** Result of `probe`: which engines already have their binaries downloaded. */
  | { type: 'browsers'; installed: Record<Engine, boolean> }
  /**
   * How a download is going.
   *
   * `percent` is filled in when the line it came from carried one, which is
   * most of them while bytes are moving; `engine` says which download it
   * belongs to, read from the downloader's own announcements rather than
   * assumed from what was asked for.
   */
  | {
      type: 'install-progress';
      engine: Engine | null;
      message: string;
      percent?: number;
      done: boolean;
    }
  /**
   * Lifecycle of a single pane.
   *
   * `version` is the browser build behind the engine, reported once it is up.
   * Which build rendered a page is the first thing worth knowing when two panes
   * disagree, so it is stated rather than left to be guessed from the engine name.
   */
  | { type: 'pane'; engine: Engine; status: PaneStatus; detail?: string; version?: string }
  /** Navigation state, mirrored into the address bar and nav buttons. */
  | { type: 'navigation'; engine: Engine; url: string; title: string; loading: boolean }
  /**
   * A frame is available.
   *
   * Carries no pixels: the sidecar sends those to the backend over the frame
   * channel, and the frontend fetches them over `FRAME_SCHEME`. This event only
   * says that a new one exists and what shape it is.
   */
  | {
      type: 'frame';
      engine: Engine;
      seq: number;
      mime: 'image/jpeg' | 'image/png';
      width: number;
      height: number;
      /**
       * A device-resolution screenshot taken after the pane settled, rather than
       * a live screencast frame. Live frames are CSS resolution — the only size
       * every engine agrees to deliver — so this is what makes a still pane
       * sharp on a HiDPI display.
       */
      sharp?: boolean;
    }
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string }
  /**
   * The CSS cursor the engine would be showing under the pointer.
   *
   * Sent only when it changes. The engine's own answer is what makes a link
   * feel like a link: the pane can show a real pointer cursor rather than
   * guessing from the image.
   */
  | { type: 'cursor'; engine: Engine; css: string };

export type PaneStatus =
  | 'idle'
  | 'launching'
  /** Browser up, capture running. */
  | 'live'
  | 'failed'
  | 'closed';

/**
 * How frames travel from the sidecar to the backend.
 *
 * Not over stdout: that carries newline-delimited JSON, so image bytes would
 * have to be base64, which inflates every frame by a third and costs a JSON
 * parse of a few hundred kilobytes each. Instead the backend listens on a
 * loopback port and the sidecar connects to it, announced through these
 * variables. The first thing written is the token, so nothing else on the
 * machine can feed frames to the window.
 *
 * Each frame is a fixed 16-byte header followed by the image:
 *
 * | offset | size | meaning                                  |
 * | ------ | ---- | ---------------------------------------- |
 * | 0      | 4    | payload length, little-endian            |
 * | 4      | 4    | sequence number                          |
 * | 8      | 2    | width in pixels                          |
 * | 10     | 2    | height in pixels                         |
 * | 12     | 1    | engine, as an index into `ENGINES`        |
 * | 13     | 1    | 1 if this is a settled sharp capture     |
 * | 14     | 1    | 0 for JPEG, 1 for PNG                    |
 * | 15     | 1    | unused                                   |
 */
export const FRAME_PORT_ENV = 'DEVKIT_FRAME_PORT';
export const FRAME_TOKEN_ENV = 'DEVKIT_FRAME_TOKEN';
export const FRAME_HEADER_BYTES = 16;

/**
 * URI scheme the backend serves frame bytes on, as `<scheme>://<engine>/<seq>`.
 *
 * The sequence number is part of the path purely to defeat caching: each frame
 * is a new URL, so the webview never serves a stale one.
 */
export const FRAME_SCHEME = 'devkit-frame';

/**
 * Path segment that asks for an engine's newest frame, whatever its sequence.
 *
 * A frame's URL is normally learnt from the event announcing it, which leaves a
 * frontend that just loaded with nothing to show until the next one — and a
 * settled pane may not produce another for as long as nobody touches it. The
 * backend outlives the webview and still holds the picture, so this asks for it
 * by name instead of by sequence.
 */
export const FRAME_LATEST = 'latest';

/** Tauri event channel every sidecar `Event` is re-emitted on. */
/**
 * Asked to look for a newer DevKit, from the menu rather than on the way up.
 *
 * The check at launch answers "is there one?" once; this answers it again when
 * somebody wonders, which is the only way to find out without restarting.
 */
export const CHECK_FOR_UPDATES_EVENT = 'devkit://check-for-updates';

export const SIDECAR_EVENT = 'devkit://sidecar';

/** Tauri event channel for sidecar process-level trouble (spawn failure, crash, exit). */
export const SIDECAR_STATUS_EVENT = 'devkit://sidecar-status';

export type SidecarStatus =
  | { kind: 'spawned'; pid: number }
  | { kind: 'crashed'; reason: string }
  | { kind: 'exited'; code: number | null };
