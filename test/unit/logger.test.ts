import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import pino, { type Logger } from 'pino';
import { createLogger } from '../../src/logger.js';

/**
 * `createLogger`'s public surface only returns a `Logger`, so the internal
 * scrubbing Writable that wraps the caller's target stream isn't otherwise
 * reachable. Pino stores its destination under this documented internal
 * symbol; using it here is the only way to observe that the wrapper's own
 * write-completion callback actually received the target's error (rather
 * than just observing Node's separate, unrelated auto-emission of 'error' on
 * the target stream itself, which happens regardless of this fix).
 */
const streamSym = pino.symbols.streamSym;
function internalStream(log: Logger): Writable {
  const value = (log as unknown as Record<symbol, unknown>)[streamSym];
  if (!(value instanceof Writable)) {
    throw new Error('expected pino to expose its destination stream internally');
  }
  return value;
}

// A bare token, not a URL: the fallback patterns must not match it, or the
// control assertions below could pass for the wrong reason.
const SECRET = 'ESKEY9876543210ABCDEF';

function capture(): { stream: Writable; output: () => string } {
  let buf = '';
  const stream = new Writable({
    write(chunk, _enc, cb) { buf += String(chunk); cb(); },
  });
  return { stream, output: () => buf };
}

interface Shape {
  name: string;
  marker: string;
  emit(log: Logger): void;
}

const shapes: Shape[] = [
  {
    name: 'top-level field',
    marker: 'marker-toplevel',
    emit: (log) => log.info({ endpoint: SECRET, note: 'marker-toplevel' }, 'call'),
  },
  {
    name: 'error message',
    marker: 'marker-errmsg',
    emit: (log) => log.error(new Error(`request failed for ${SECRET} marker-errmsg`)),
  },
  {
    name: 'stack trace',
    marker: 'marker-stack',
    emit: (log) => {
      const err = new Error('boom');
      err.stack = `Error: boom\n    at post (${SECRET}:1:1)\n    at marker-stack (x.ts:2:2)`;
      log.error(err);
    },
  },
  {
    name: 'nested cause, three levels deep',
    marker: 'marker-cause',
    emit: (log) => {
      const deepest = new Error(`deepest ${SECRET} marker-cause`);
      const middle = new Error('middle', { cause: deepest });
      log.error(new Error('outer', { cause: middle }));
    },
  },
  {
    name: 'array element',
    marker: 'marker-array',
    emit: (log) => log.info({ endpoints: ['first', SECRET, 'marker-array'] }, 'call'),
  },
  {
    name: 'object key name',
    marker: 'marker-keyname',
    emit: (log) => log.info({ [SECRET]: 'marker-keyname' }, 'call'),
  },
  {
    name: 'percent-encoded form',
    marker: 'marker-encoded',
    emit: (log) =>
      log.info(
        { encoded: encodeURIComponent(`https://x.example/v2/${SECRET}`), note: 'marker-encoded' },
        'call',
      ),
  },
];

describe.each(shapes)('secret in $name', ({ marker, emit }) => {
  it('is absent from the serialized output', () => {
    const { stream, output } = capture();
    emit(createLogger([SECRET], stream));
    expect(output()).not.toContain(SECRET);
    // Proves the shape actually reached the output, so the assertion above is
    // about scrubbing rather than about pino dropping the field.
    expect(output()).toContain(marker);
  });

  it('control: appears unredacted when no secret is configured', () => {
    const { stream, output } = capture();
    emit(createLogger([], stream));
    expect(output()).toContain(SECRET);
    expect(output()).toContain(marker);
  });
});

describe('createLogger', () => {
  it('derives tokens from a raw URL, so the bare key is scrubbed too', () => {
    const key = 'aBcD1234efGh5678ijKl9012mnOp3456';
    const { stream, output } = capture();
    const log = createLogger([`https://eth-mainnet.g.alchemy.com/v2/${key}`], stream);
    log.info({ note: `bare key ${key} here` }, 'call');
    expect(output()).not.toContain(key);
  });

  it('still logs the message and level', () => {
    const { stream, output } = capture();
    createLogger([SECRET], stream).info('hello world');
    expect(output()).toContain('hello world');
  });
});

// Important 5: a failing destination must not vanish silently, and must not
// turn into an exception in business code (e.g. EPIPE on a closed stdout).
describe('createLogger — write failure handling', () => {
  it('surfaces a write callback error instead of dropping it silently', () => {
    const failing = new Writable({
      write(_chunk, _enc, cb) {
        cb(new Error('boom-write'));
      },
    });
    // Node auto-emits 'error' on the target itself whenever its own write
    // callback receives one; that is unrelated to the wrapper under test.
    failing.on('error', () => {});

    const log = createLogger([], failing);
    let scrubbingSawError = false;
    internalStream(log).on('error', () => {
      scrubbingSawError = true;
    });

    log.info('hello');

    return new Promise<void>((resolve) => {
      setImmediate(() => {
        expect(scrubbingSawError).toBe(true);
        resolve();
      });
    });
  });

  it('does not throw out of the log call when the target write throws synchronously', () => {
    const throwing = new Writable({
      write() {
        throw new Error('sync-boom');
      },
    });
    const log = createLogger([], throwing);
    expect(() => log.info('hello')).not.toThrow();
  });
});
