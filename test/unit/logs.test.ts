import { describe, expect, it, vi } from 'vitest';
import { errorText, isRangeError, iterateLogs, suggestedRange, probeEffectiveChunk
} from '../../src/indexer/logs.js';
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

  it('is total for null, undefined, a string and other junk', () => {
    expect(errorText(null)).toBe('');
    expect(errorText(undefined)).toBe('');
    expect(errorText('plain')).toBe('');
    expect(errorText(42)).toBe('');
    expect(errorText({ message: 7, details: {}, data: null, metaMessages: 'nope' }).trim()).toBe('');
  });

  // The depth limit alone would terminate a cycle, but it would emit the text
  // once per lap. `seen` is what makes each error contribute exactly once, so
  // the assertion is on the returned text, not on "did not throw".
  it('visits a cyclic cause exactly once', () => {
    const a = new Error('cyc') as Error & { cause?: unknown };
    a.cause = a;
    expect(errorText(a).trim()).toBe('cyc');
  });

  it('reads `data`, a nested error.message and viem metaMessages', () => {
    expect(errorText({ data: 'in-data' })).toContain('in-data');
    expect(errorText({ error: { message: 'in-nested-error' } })).toContain('in-nested-error');
    const text = errorText({ metaMessages: ['meta one', 'meta two', 5] });
    expect(text).toContain('meta one');
    expect(text).toContain('meta two');
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

  it('treats -32005 with range wording as a range error', () => {
    const err = Object.assign(new Error('query returned too many blocks'), { code: -32005 });
    expect(isRangeError(err)).toBe(true);
  });

  // Some providers reuse -32005 for rate limiting. Halving cannot fix that; it
  // would end in a misleading RangeExhaustedError instead of the retry layer.
  it.each([
    'rate limit exceeded',
    'Too Many Requests',
    'HTTP 429: slow down',
  ])('does NOT treat -32005 as a range error when it looks like rate limiting: %s', (msg) => {
    expect(isRangeError(Object.assign(new Error(msg), { code: -32005 }))).toBe(false);
  });

  it('finds a -32005 code down the cause chain', () => {
    const outer = new Error('RPC Request failed.');
    (outer as Error & { cause?: unknown }).cause =
      Object.assign(new Error('limit exceeded'), { code: -32005 });
    expect(isRangeError(outer)).toBe(true);
  });

  it('does NOT treat a chained -32005 as a range error when the text is rate limiting', () => {
    const outer = new Error('RPC Request failed.');
    (outer as Error & { cause?: unknown }).cause =
      Object.assign(new Error('rate limit exceeded'), { code: -32005 });
    expect(isRangeError(outer)).toBe(false);
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

describe('iterateLogs — recovering after a reduction', () => {
  /** Records every requested span; fails any span >= `failAt` with a range error. */
  async function run(o: { failAt: bigint; to: bigint; initialChunk: number }): Promise<number[]> {
    const spans: number[] = [];
    for await (const _ of iterateLogs({
      fetch: async ({ fromBlock, toBlock }) => {
        spans.push(Number(toBlock - fromBlock) + 1);
        if (toBlock - fromBlock + 1n >= o.failAt) throw new Error('block range is too wide');
        return [];
      },
      fromBlock: 0n, toBlock: o.to, initialChunk: o.initialChunk, maxChunk: 100,
    })) { /* drain */ }
    return spans;
  }

  // 3 fails -> ceiling 2, range 1. Integer 1.25x leaves 1 at 1 forever; growth
  // must advance by at least one block to reach the ceiling.
  it('a range reduced to 1 recovers on subsequent successes', async () => {
    expect(await run({ failAt: 3n, to: 8n, initialChunk: 3 })).toEqual([3, 1, 2, 2, 2, 2]);
  });

  // 4 fails -> ceiling 3, range 2. 2 * 5 / 4 is still 2 in integers.
  it('a range of 2 grows on to the ceiling rather than stalling', async () => {
    expect(await run({ failAt: 4n, to: 13n, initialChunk: 4 })).toEqual([4, 2, 3, 3, 3, 3]);
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
    // 100 fails; the wider suggestion is rejected, so halve: 50. Then one 1.25x
    // growth step is clamped by the ceiling (99) and by the 50 blocks left.
    // A `range - 1` fallback would give [100, 99, ...] instead.
    expect(attempts).toEqual([100, 50, 50]);
  });

  // The usability check compares against the span that ACTUALLY failed (30), not
  // `range` (2000): a suggestion of 35 is wider than what failed, so it cannot
  // be a fix and must not become the ceiling.
  it('ignores a suggestion wider than the clamped span that failed', async () => {
    const spans: number[] = [];
    for await (const _ of iterateLogs({
      fetch: async ({ fromBlock, toBlock }) => {
        const span = toBlock - fromBlock + 1n;
        spans.push(Number(span));
        if (span > 20n) {
          throw Object.assign(new Error('x'), {
            details: 'block range too wide, should work: [0x0, 0x22]',   // width 35
          });
        }
        return [];
      },
      fromBlock: 0n, toBlock: 29n, initialChunk: 2000, maxChunk: 2000,
    })) { /* drain */ }
    expect(spans).toEqual([30, 15, 15]);
  });
});

describe('iterateLogs — the ceiling decays on sustained success', () => {
  type Call = { span: number; ok: boolean; from: bigint };

  /** Fails any span above `capAt(fromBlock)` with the Alchemy shape, suggesting exactly the cap. */
  async function drive(o: {
    to: bigint; capAt: (from: bigint) => bigint; probe: number; maxChunk?: number;
  }): Promise<Call[]> {
    const calls: Call[] = [];
    for await (const _ of iterateLogs({
      fetch: async ({ fromBlock, toBlock }) => {
        const span = toBlock - fromBlock + 1n;
        const cap = o.capAt(fromBlock);
        const ok = span <= cap;
        calls.push({ span: Number(span), ok, from: fromBlock });
        if (!ok) {
          const err = alchemyRangeError();
          (err as Error & { details: string }).details =
            `up to a ${cap} block range. should work: [0x${fromBlock.toString(16)}, ` +
            `0x${(fromBlock + cap - 1n).toString(16)}]`;
          throw err;
        }
        return [];
      },
      fromBlock: 0n, toBlock: o.to, initialChunk: 100, maxChunk: o.maxChunk ?? 100,
      successesBeforeProbe: o.probe,
    })) { /* drain */ }
    return calls;
  }

  // Headline property: a limit learned in a dense region must not throttle the
  // quiet region after it.
  it('climbs back to maxChunk after a temporary cap lifts', async () => {
    const calls = await drive({ to: 200_000n, capAt: (f) => (f < 300n ? 10n : 1_000_000n), probe: 4 });
    const ok = calls.filter((c) => c.ok);
    expect(Math.max(...ok.filter((c) => c.from < 300n).map((c) => c.span))).toBeLessThanOrEqual(10);
    expect(Math.max(...ok.filter((c) => c.from > 100_000n).map((c) => c.span))).toBe(100);
  });

  // The measured free-tier shape: a flat cap. Probing must back off, not fire
  // every few chunks for the whole run.
  it('wastes only a handful of calls against a permanent flat cap', async () => {
    const calls = await drive({ to: 4_000n, capAt: () => 10n, probe: 4, maxChunk: 2000 });
    const failures = calls.filter((c) => !c.ok).length;
    const successes = calls.length - failures;
    expect(successes).toBeGreaterThanOrEqual(390);
    expect(failures).toBeLessThan(10);
    expect(failures).toBeGreaterThan(1);   // it does probe
  });

  it('grows sub-linearly: 8x the chunks adds only a few failures', async () => {
    const short = (await drive({ to: 4_000n, capAt: () => 10n, probe: 4, maxChunk: 2000 })).filter((c) => !c.ok).length;
    const long = (await drive({ to: 32_000n, capAt: () => 10n, probe: 4, maxChunk: 2000 })).filter((c) => !c.ok).length;
    expect(long - short).toBeLessThanOrEqual(4);
  });

  it('never sends a known-bad width immediately after a failure', async () => {
    const calls = await drive({ to: 4_000n, capAt: () => 10n, probe: 4, maxChunk: 2000 });
    calls.forEach((c, i) => {
      if (c.ok) return;
      const next = calls[i + 1];
      if (next) expect(next.span).toBeLessThanOrEqual(10);
    });
  });

  it('doubles the probe interval after each failed probe', async () => {
    const calls = await drive({ to: 4_000n, capAt: () => 10n, probe: 4, maxChunk: 2000 });
    const gaps: number[] = [];
    let run = 0;
    let seenFirstFailure = false;
    for (const c of calls) {
      if (c.ok) { run += 1; continue; }
      if (seenFirstFailure) gaps.push(run);
      seenFirstFailure = true;
      run = 0;
    }
    expect(gaps.length).toBeGreaterThanOrEqual(4);
    expect(gaps.slice(0, 4)).toEqual([4, 8, 16, 32]);
  });
});

describe('iterateLogs — bounded failure', () => {
  async function failAlways(o: {
    to: bigint; initialChunk: number; maxHalvings?: number; message?: string;
  }): Promise<{ spans: number[]; error: unknown }> {
    const spans: number[] = [];
    const gen = iterateLogs({
      fetch: async ({ fromBlock, toBlock }) => {
        spans.push(Number(toBlock - fromBlock) + 1);
        throw new Error(o.message ?? 'query returned more than 10000 results');
      },
      fromBlock: 0n, toBlock: o.to, initialChunk: o.initialChunk, maxChunk: 1000,
      ...(o.maxHalvings !== undefined ? { maxHalvings: o.maxHalvings } : {}),
    });
    let error: unknown;
    try { await gen.next(); } catch (e) { error = e; }
    return { spans, error };
  }

  // Generous maxHalvings, so only the one-block floor can stop it. Without the
  // floor guard it would keep re-sending 1-block requests until maxHalvings.
  it('never halves below a single block', async () => {
    const { spans, error } = await failAlways({ to: 10n, initialChunk: 4, maxHalvings: 10 });
    expect(error).toBeInstanceOf(RangeExhaustedError);
    expect(spans).toEqual([4, 2, 1]);
  });

  // The range would reach one block after nine reductions; maxHalvings: 2 must
  // stop it after two. Without the cap it gives up only at the one-block floor.
  it('gives up after maxHalvings rather than looping unbounded', async () => {
    const { spans, error } = await failAlways({
      to: 10_000n, initialChunk: 1000, maxHalvings: 2, message: 'block range is too wide',
    });
    expect(error).toBeInstanceOf(RangeExhaustedError);
    expect(spans).toEqual([1000, 500, 250]);
  });

  // A span shorter than initialChunk (clamped by toBlock) must not re-send the
  // identical request while `range` shrinks to no effect.
  it('never re-sends the same span when toBlock clamps the request', async () => {
    const { spans, error } = await failAlways({
      to: 29n, initialChunk: 2000, message: 'block range is too wide',
    });
    expect(error).toBeInstanceOf(RangeExhaustedError);
    expect(spans).toEqual([30, 15, 7, 3, 1]);
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

describe('probeEffectiveChunk', () => {
  /**
   * This exists because the dry-run estimate read its chunk size from config.maxChunk
   * (20,000 on Base) while the measured cap on the configured account is 10 — reporting
   * a 38-million-block backfill as "76 seconds" when the honest answer is 42 hours. An
   * estimate three orders of magnitude optimistic invites the very accident it guards.
   */
  const rangeError = (suggestion?: string) =>
    Object.assign(new Error('query failed'), {
      details: suggestion
        ? `Log response size exceeded. You can make eth_getLogs requests with up to a 10 block range. Based on your parameters and the response size limit, this block range should work: [${suggestion}]`
        : 'query returned more than 10000 results',
    });

  it('reports the requested size when the endpoint accepts it', async () => {
    const fetch = vi.fn(async () => []);
    const result = await probeEffectiveChunk({
      fetch, nearBlock: 1_000n, requested: 5_000,
    });
    expect(result).toMatchObject({ blocks: 5_000, measured: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('adopts the range the provider names, rather than halving blindly', async () => {
    // Measured behaviour: Alchemy names a workable range in the error. Halving from
    // 20,000 to 10 takes eleven calls; reading the suggestion takes one.
    let call = 0;
    const fetch = vi.fn(async () => {
      call += 1;
      if (call === 1) throw rangeError('0x1, 0xa');
      return [];
    });
    const result = await probeEffectiveChunk({
      fetch, nearBlock: 1_000n, requested: 20_000,
    });
    expect(result).toMatchObject({ blocks: 10, measured: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('halves when the provider suggests nothing', async () => {
    let call = 0;
    const fetch = vi.fn(async () => {
      call += 1;
      if (call === 1) throw rangeError();
      return [];
    });
    const result = await probeEffectiveChunk({ fetch, nearBlock: 1_000n, requested: 100 });
    expect(result).toMatchObject({ blocks: 50, measured: true });
  });

  it('ignores a suggestion that is not narrower than what already failed', async () => {
    let call = 0;
    const fetch = vi.fn(async () => {
      call += 1;
      if (call === 1) throw rangeError('0x0, 0xffffff'); // wider than requested
      return [];
    });
    const result = await probeEffectiveChunk({ fetch, nearBlock: 1_000n, requested: 100 });
    expect(result.blocks).toBe(50); // halved, not widened
  });

  it('says NOT MEASURED rather than inventing a cap when every range is refused', async () => {
    const fetch = vi.fn(async () => { throw rangeError(); });
    const result = await probeEffectiveChunk({
      fetch, nearBlock: 1_000n, requested: 64, maxAttempts: 4,
    });
    expect(result.measured).toBe(false);
    expect(result.note).toMatch(/gave up after 4 probes/);
  });

  it('does not claim a measurement when the failure is unrelated to range', async () => {
    // A refused socket tells us nothing about the cap. Reporting the requested size as
    // "measured" would be a fabricated fact in the one output meant to be trusted.
    const fetch = vi.fn(async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:1'); });
    const result = await probeEffectiveChunk({ fetch, nearBlock: 1_000n, requested: 5_000 });
    expect(result.measured).toBe(false);
    expect(result.note).toMatch(/unrelated to range/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('never probes below a single block', async () => {
    const fetch = vi.fn(async () => { throw rangeError(); });
    const result = await probeEffectiveChunk({
      fetch, nearBlock: 1_000n, requested: 2, maxAttempts: 10,
    });
    expect(result.blocks).toBeGreaterThanOrEqual(1);
  });

  it('never asks for a negative fromBlock near the start of a chain', async () => {
    const seen: Array<{ fromBlock: bigint; toBlock: bigint }> = [];
    const fetch = vi.fn(async (r: { fromBlock: bigint; toBlock: bigint }) => {
      seen.push(r);
      return [];
    });
    await probeEffectiveChunk({ fetch, nearBlock: 5n, requested: 1_000 });
    expect(seen[0]!.fromBlock).toBe(0n);
  });
});
