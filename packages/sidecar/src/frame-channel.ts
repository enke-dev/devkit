import type { Socket } from 'node:net';
import { connect } from 'node:net';

import type { Engine } from '@devkit/protocol';
import { ENGINES, FRAME_HEADER_BYTES, FRAME_PORT_ENV, FRAME_TOKEN_ENV } from '@devkit/protocol';

import { log } from './emit.js';

/**
 * Sends frames to the backend over a loopback socket.
 *
 * Not over stdout: that carries newline-delimited JSON, so the image would have
 * to be base64 — a third larger, plus a JSON parse of a few hundred kilobytes
 * per frame at the other end. Here the bytes go as they are, behind a 16-byte
 * header. The format is described in `packages/protocol/src/index.ts`.
 *
 * Frames are dropped when the socket is backed up, keeping only the newest per
 * engine, for the same reason stdout does: a stale frame is worth nothing when a
 * newer one is already on its way.
 */

/**
 * Frame accounting, behind `DEVKIT_DEBUG_FRAMES=1`.
 *
 * The rate a pane shows is not the rate the sidecar produces: a frame superseded
 * while the socket is backed up is dropped here and never arrives. When those
 * two numbers disagree, this says by how much.
 */
const debugFrames = process.env['DEVKIT_DEBUG_FRAMES'] === '1';
const produced = new Map<Engine, number>();
const dropped = new Map<Engine, number>();

function bump(counter: Map<Engine, number>, engine: Engine): void {
  counter.set(engine, (counter.get(engine) ?? 0) + 1);
}

if (debugFrames) {
  setInterval(() => {
    const engines = new Set([...produced.keys(), ...dropped.keys()]);
    if (engines.size === 0) {
      return;
    }
    const line = [...engines]
      .sort()
      .map(
        engine => `${engine} ${produced.get(engine) ?? 0}/s (dropped ${dropped.get(engine) ?? 0})`
      )
      .join('  ');
    process.stderr.write(`frames: ${line}\n`);
    produced.clear();
    dropped.clear();
  }, 1000).unref();
}

let socket: Socket | null = null;
let ready = false;
let draining = false;
const pending = new Map<Engine, Buffer>();

export function connectFrameChannel(): void {
  const port = Number(process.env[FRAME_PORT_ENV]);
  const token = process.env[FRAME_TOKEN_ENV];

  if (!port || !token) {
    log('error', 'no frame channel was offered; panes will stay blank');
    return;
  }

  const client = connect({ port, host: '127.0.0.1' }, () => {
    // The token goes first, so the backend knows this is its own sidecar.
    client.write(token, 'ascii');
    ready = true;
    flush();
  });

  client.setNoDelay(true);
  client.on('drain', () => {
    draining = false;
    flush();
  });
  client.on('error', error => {
    ready = false;
    log('error', `frame channel failed: ${error.message}`);
  });
  client.on('close', () => {
    ready = false;
  });

  socket = client;
}

function write(message: Buffer): void {
  if (!socket) {
    return;
  }
  if (!socket.write(message)) {
    draining = true;
  }
}

function flush(): void {
  if (!ready || draining) {
    return;
  }
  const queued = [...pending.entries()];
  pending.clear();
  queued.forEach(([engine, message]) => {
    // Backing up again mid-flush puts the rest back rather than discarding
    // them: dropping is a decision for `sendFrame`, where a newer frame is
    // known to exist, not an accident of write ordering.
    if (draining) {
      pending.set(engine, message);
    } else {
      write(message);
    }
  });
}

export function sendFrame(frame: {
  engine: Engine;
  seq: number;
  width: number;
  height: number;
  sharp: boolean;
  png?: boolean;
  payload: Buffer;
}): void {
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  header.writeUInt32LE(frame.payload.length, 0);
  header.writeUInt32LE(frame.seq >>> 0, 4);
  header.writeUInt16LE(Math.min(frame.width, 0xffff), 8);
  header.writeUInt16LE(Math.min(frame.height, 0xffff), 10);
  header.writeUInt8(ENGINES.indexOf(frame.engine), 12);
  header.writeUInt8(frame.sharp ? 1 : 0, 13);
  header.writeUInt8(frame.png ? 1 : 0, 14);

  const message = Buffer.concat([header, frame.payload]);
  if (debugFrames) {
    bump(produced, frame.engine);
  }

  if (!ready || draining) {
    if (debugFrames && pending.has(frame.engine)) {
      bump(dropped, frame.engine);
    }
    // Newest only: an older frame has no value once a newer one exists.
    pending.set(frame.engine, message);
    return;
  }
  write(message);
}

export function closeFrameChannel(): void {
  socket?.end();
  socket = null;
  ready = false;
}
