import { describe, expect, it, vi } from 'vitest';
import { errorText, isRangeError, iterateLogs, suggestedRange } from '../../src/indexer/logs.js';
import { RangeExhaustedError } from '../../src/errors.js';
import type { RawLog } from '../../src/indexer/decode.js';

/** The real Alchemy free-tier shape, captured from a live request. */
const ALCHEMY_DETAILS =
  'Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block ' +
  'range. Based on your parameters, this block range should work: [0x17ec57d, 0x17ec586]. ' +
  'Upgrade to PAYG for expanded block range limits.';

function alchemyRangeError(): Error {
  const err = new Error('JSON is not a valid request object.') as Error & {
    code: number; details: string; shortMessage: string;
  };
  err.name = 'InvalidRequestRpcError';
  err.code = -32600;
  err.details = ALCHEMY_DETAILS;
  err.shortMessage = 'JSON is not a valid request object.';
  return err;
}

describe('errorText', () => {
  it('gathers details, shortMessage and message', () => {
    const text = errorText(alchemyRangeError());
    expect(text).toContain('10 block range');
    expect(text).toContain('JSON is not a valid request object');
  });

  it('walks the cause chain', () => {
    const outer = new Error('request failed');
    (outer as Error & { cause?: unknown }).cause = alchemyRangeError();
    expect(errorText(outer)).toContain('10 block range');
  });

  it('is total for null, undefined, a string and a cyclic cause', () => {
    expect(() => errorText(null)).not.toThrow();
    expect(() => errorText(undefined)).not.toThrow();
    expect(() => errorText('plain')).not.toThrow();
    const a = new Error('a') as Error & { cause?: unknown };
    a.cause = a;
    expect(() => errorText(a)).not.toThrow();
  });
});

describe('isRangeError — the real provider shape', () => {
  // This is the case the original predicate got wrong: the top-level message
  // says nothing about ranges, so matching only `message` returns false and the
  // backfill dies on its first call.
  it('recognises the Alchemy free-tier error whose message is unhelpful', () => {
    expect(isRangeError(alchemyRangeError())).toBe(true);
  });

  it('recognises it when wrapped in a cause chain', () => {
    const outer = new Error('RPC Request failed.');
    (outer as Error & { cause?: unknown }).cause = alchemyRangeError();
    expect(isRangeError(outer)).toBe(true);
  });

  it.each([
    'query returned more than 10000 results',
    'Log response size exceeded. You can make eth_getLogs requests with up to a 2K block range',
    'block range is too wide',
    'exceed maximum block range: 5000',
    'query exceeds max results 10000',
  ])('recognises other providers: %s', (message) => {
    expect(isRangeError(new Error(message))).toBe(true);
  });

  it('recognises the -32005 limit-exceeded code without matching text', () => {
    expect(isRangeError(Object.assign(new Error('limit exceeded'), { code: -32005 }))).toBe(true);
  });

  // -32600 is JSON-RPC's generic "Invalid Request". Treating the code alone as a
  // range error would make the chunker halve forever against a malformed request
  // that halving cannot fix.
  it('does NOT treat a bare -32600 as a range error', () => {
    const err = Object.assign(new Error('JSON is not a valid request object.'), { code: -32600 });
    expect(isRangeError(err)).toBe(false);
  });

  it('does not treat an unrelated error as a range error', () => {
    expect(isRangeError(new Error('ECONNRESET'))).toBe(false);
  });

  it('does not treat a non-error as a range error', () => {
    expect(isRangeError(null)).toBe(false);
    expect(isRangeError('block range is too wide')).toBe(false);
  });
});

describe('suggestedRange', () => {
  it('parses the range the provider says would work', () => {
    expect(suggestedRange(alchemyRangeError())).toEqual({
      fromBlock: 0x17ec57dn,
      toBlock: 0x17ec586n,
    });
  });

  it('yields a span matching the stated limit', () => {
    const r = suggestedRange(alchemyRangeError())!;
    expect(r.toBlock - r.fromBlock + 1n).toBe(10n);
  });

  it('finds it through a cause chain', () => {
    const outer = new Error('wrapped');
    (outer as Error & { cause?: unknown }).cause = alchemyRangeError();
    expect(suggestedRange(outer)).toBeDefined();
  });

  it('returns undefined when no suggestion is present', () => {
    expect(suggestedRange(new Error('block range is too wide'))).toBeUndefined();
  });

  it('returns undefined for a reversed or malformed pair', () => {
    const err = Object.assign(new Error('x'), { details: 'try [0x20, 0x10]' });
    expect(suggestedRange(err)).toBeUndefined();
  });

  it('is total for junk input', () => {
    expect(() => suggestedRange(null)).not.toThrow();
    expect(suggestedRange(null)).toBeUndefined();
  });
});

describe('iterateLogs — walking the span', () => {
  it('covers the whole span with inclusive, non-overlapping chunks', async () => {
    const seen: Array<[bigint, bigint]> = [];
    for await (const chunk of iterateLogs({
      fetch: async ({ fromBlock, toBlock }) => { seen.push([fromBlock, toBlock]); return []; },
      fromBlock: 0n, toBlock: 250n, initialChunk: 100, maxChunk: 100,
    })) {
      expect(chunk.logs).toEqual([]);
    }
    expect(seen).toEqual([[0n, 99n], [100n, 199n], [200n, 250n]]);
  });

  it('yields nothing when the span is empty', async () => {
    const chunks = [];
    for await (const c of iterateLogs({
      fetch: async () => [], fromBlock: 100n, toBlock: 99n, initialChunk: 10, maxChunk: 10,
    })) chunks.push(c);
    expect(chunks).toEqual([]);
  });

  it('passes logs through', async () => {
    const log = { logIndex: 0 } as RawLog;
    const chunks = [];
    for await (const c of iterateLogs({
      fetch: async () => [log], fromBlock: 0n, toBlock: 5n, initialChunk: 10, maxChunk: 10,
    })) chunks.push(c);
    expect(chunks[0]?.logs).toEqual([log]);
  });

  it('grows by 1.25x on success, capped at maxChunk', async () => {
    const sizes: number[] = [];
    for await (const _ of iterateLogs({
      fetch: async ({ fromBlock, toBlock }) => { sizes.push(Number(toBlock - fromBlock) + 1); return []; },
      fromBlock: 0n, toBlock: 10_000n, initialChunk: 100, maxChunk: 160,
    })) { /* drain */ }
    expect(sizes[0]).toBe(100);
    expect(sizes[1]).toBe(125);
    expect(sizes[2]).toBe(156);
    expect(Math.max(...sizes)).toBe(160);   // capped
  });
});

describe('iterateLogs — adopting the provider suggestion', () => {
  // Measured: blind halving from 2000 needs EIGHT failed round trips to reach a
  // 10-block range. Adopting the suggestion needs one.
  it('drops straight to the suggested size after one failure', async () => {
    const attempts: number[] = [];
    const fetch = vi.fn(async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      const span = Number(toBlock - fromBlock) + 1;
      attempts.push(span);
      if (span > 10) {
        const err = alchemyRangeError();
        (err as Error & { details: string }).details =
          `up to a 10 block range. this block range should work: ` +
          `[0x${fromBlock.toString(16)}, 0x${(fromBlock + 9n).toString(16)}]`;
        throw err;
      }
      return [];
    });

    for await (const _ of iterateLogs({
      fetch, fromBlock: 0n, toBlock: 29n, initialChunk: 2000, maxChunk: 2000,
    })) { /* drain */ }

    expect(attempts[0]).toBe(30);    // first try, whole span
    expect(attempts[1]).toBe(10);    // straight to the suggestion, not 1000
    expect(attempts.filter((a) => a > 10)).toHaveLength(1);   // exactly one failure
  });

  // Without a remembered ceiling, growth walks the range back above the cap and
  // it fails again, forever — one wasted call every few chunks for the whole
  // backfill.
  it('never grows back above a range that failed', async () => {
    const attempts: number[] = [];
    const fetch = async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      const span = Number(toBlock - fromBlock) + 1;
      attempts.push(span);
      if (span > 10) {
        const err = alchemyRangeError();
        (err as Error & { details: string }).details =
          `up to a 10 block range. should work: [0x${fromBlock.toString(16)}, ` +
          `0x${(fromBlock + 9n).toString(16)}]`;
        throw err;
      }
      return [];
    };

    for await (const _ of iterateLogs({
      fetch, fromBlock: 0n, toBlock: 199n, initialChunk: 2000, maxChunk: 2000,
    })) { /* drain */ }

    expect(attempts.filter((a) => a > 10)).toHaveLength(1);
    expect(Math.max(...attempts.slice(1))).toBeLessThanOrEqual(10);
  });

  it('falls back to halving when the provider suggests nothing', async () => {
    const attempts: number[] = [];
    let failures = 2;
    for await (const _ of iterateLogs({
      fetch: async ({ fromBlock, toBlock }) => {
        attempts.push(Number(toBlock - fromBlock) + 1);
        if (failures-- > 0) throw new Error('query returned more than 10000 results');
        return [];
      },
      fromBlock: 0n, toBlock: 99n, initialChunk: 100, maxChunk: 100,
    })) { /* drain */ }
    expect(attempts.slice(0, 3)).toEqual([100, 50, 25]);
  });

  it('ignores a suggestion larger than the range that just failed', async () => {
    const attempts: number[] = [];
    let first = true;
    for await (const _ of iterateLogs({
      fetch: async ({ fromBlock, toBlock }) => {
        attempts.push(Number(toBlock - fromBlock) + 1);
        if (first) {
          first = false;
          const err = alchemyRangeError();
          // A nonsensical suggestion WIDER than what just failed. The text must
          // still identify this as a range error — an earlier version of this
          // fixture replaced `details` wholesale, which stripped every range
          // phrase, so isRangeError correctly returned false and the error was
          // rethrown. The test passed through none of the code it names.
          (err as Error & { details: string }).details =
            'up to a 10 block range. this block range should work: [0x0, 0xffff]';
          throw err;
        }
        return [];
      },
      fromBlock: 0n, toBlock: 99n, initialChunk: 100, maxChunk: 100,
    })) { /* drain */ }
    expect(attempts[1]).toBeLessThan(attempts[0]!);
  });
});

describe('iterateLogs — bounded failure', () => {
  it('never halves below a single block', async () => {
    let calls = 0;
    const gen = iterateLogs({
      fetch: async () => { calls += 1; throw new Error('query returned more than 10000 results'); },
      fromBlock: 0n, toBlock: 10n, initialChunk: 4, maxChunk: 4, maxHalvings: 10,
    });
    await expect(gen.next()).rejects.toThrow(RangeExhaustedError);
    expect(calls).toBeLessThanOrEqual(11);
  });

  it('gives up after maxHalvings rather than looping unbounded', async () => {
    const gen = iterateLogs({
      fetch: async () => { throw new Error('block range is too wide'); },
      fromBlock: 0n, toBlock: 10_000n, initialChunk: 1000, maxChunk: 1000, maxHalvings: 2,
    });
    await expect(gen.next()).rejects.toThrow(RangeExhaustedError);
  });

  it('rethrows an error that is not a range error', async () => {
    const gen = iterateLogs({
      fetch: async () => { throw new Error('ECONNRESET'); },
      fromBlock: 0n, toBlock: 10n, initialChunk: 10, maxChunk: 10,
    });
    await expect(gen.next()).rejects.toThrow('ECONNRESET');
  });

  it('rethrows a malformed-request error instead of halving against it', async () => {
    const gen = iterateLogs({
      fetch: async () => {
        throw Object.assign(new Error('JSON is not a valid request object.'), { code: -32600 });
      },
      fromBlock: 0n, toBlock: 10n, initialChunk: 10, maxChunk: 10,
    });
    await expect(gen.next()).rejects.toThrow(/JSON is not a valid request object/);
  });
});
