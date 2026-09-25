import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import type { Logger } from 'pino';
import { createLogger } from '../../src/logger.js';

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
