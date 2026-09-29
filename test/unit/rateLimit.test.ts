import { describe, expect, it } from 'vitest';
import { createRateLimiter } from '../../src/chain/rateLimit.js';
import { manualClock } from '../../src/clock.js';

/**
 * A sleep that advances the manual clock instead of waiting. Every test here is
 * instant and deterministic; no setTimeout, no real elapsed time. A limiter
 * tested against the wall clock is flaky, and flaky tests get deleted.
 */
function fakeSleep(clock: ReturnType<typeof manualClock>) {
  const slept: number[] = [];
  return {
    slept,
    sleep: async (ms: number) => {
      slept.push(ms);
      clock.advance(ms);
    },
  };
}

function harness(capacity: number, refillPerSec: number, startMs = 0) {
  const clock = manualClock(startMs);
  const { slept, sleep } = fakeSleep(clock);
  const limit = createRateLimiter({ capacity, refillPerSec, clock, sleep });
  return { clock, slept, limit };
}

describe('createRateLimiter — burst up to capacity', () => {
  it('runs a full burst without sleeping', async () => {
    const { slept, limit } = harness(5, 5);
    for (let i = 0; i < 5; i++) await limit(async () => i);
    expect(slept).toEqual([]);
  });

  it('makes the request past capacity wait', async () => {
    const { slept, limit } = harness(5, 5);
    for (let i = 0; i < 5; i++) await limit(async () => i);
    await limit(async () => 'sixth');
    expect(slept).toHaveLength(1);
    expect(slept[0]).toBe(200);   // one token at 5/s
  });

  it('returns the function result unchanged', async () => {
    const { limit } = harness(2, 2);
    await expect(limit(async () => 'value')).resolves.toBe('value');
  });

  it('propagates a rejection', async () => {
    const { limit } = harness(2, 2);
    await expect(limit(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
  });

  it('consumes a token even when the call fails, so a failing burst is still limited', async () => {
    const { slept, limit } = harness(2, 2);
    await expect(limit(async () => { throw new Error('a'); })).rejects.toThrow();
    await expect(limit(async () => { throw new Error('b'); })).rejects.toThrow();
    await limit(async () => 'third');
    expect(slept).toHaveLength(1);
  });
});

describe('createRateLimiter — refill is proportional to elapsed time', () => {
  // A fixed-tick refill would either over-grant here or under-grant during a
  // burst. These assert the elapsed-time behaviour, not an internal counter.
  it('refills to exactly capacity after a long idle, and not beyond', async () => {
    const { clock, slept, limit } = harness(5, 5);
    for (let i = 0; i < 5; i++) await limit(async () => i);   // drain
    expect(slept).toEqual([]);

    clock.advance(10_000);   // 10s idle at 5/s would be 50 tokens, uncapped

    // Exactly `capacity` more run free...
    for (let i = 0; i < 5; i++) await limit(async () => i);
    expect(slept).toEqual([]);

    // ...and the next one waits, proving the refill capped at capacity rather
    // than accumulating 50 tokens.
    await limit(async () => 'over');
    expect(slept).toEqual([200]);
  });

  it('grants a partial refill proportional to a short idle', async () => {
    const { clock, slept, limit } = harness(5, 5);
    for (let i = 0; i < 5; i++) await limit(async () => i);   // drain

    clock.advance(600);   // 0.6s at 5/s = 3 tokens

    for (let i = 0; i < 3; i++) await limit(async () => i);
    expect(slept).toEqual([]);

    await limit(async () => 'fourth');
    expect(slept).toHaveLength(1);
  });

  it('waits proportionally less when partially refilled', async () => {
    const { clock, slept, limit } = harness(1, 5);
    await limit(async () => 'first');       // drains the only token
    clock.advance(100);                      // 0.5 of a token at 5/s
    await limit(async () => 'second');
    expect(slept[0]).toBe(100);              // needs the other 0.5 = 100ms
  });

  it('does not accumulate tokens beyond capacity across several idles', async () => {
    const { clock, slept, limit } = harness(3, 10);
    clock.advance(60_000);                   // a minute idle
    for (let i = 0; i < 3; i++) await limit(async () => i);
    expect(slept).toEqual([]);
    await limit(async () => 'over');
    expect(slept).toHaveLength(1);
  });

  it('never grants a negative wait when the clock does not move', async () => {
    const { slept, limit } = harness(1, 10);
    await limit(async () => 'a');
    await limit(async () => 'b');
    expect(slept[0]).toBeGreaterThan(0);
  });
});

describe('createRateLimiter — concurrent callers', () => {
  // Without serialised acquisition, two concurrent callers can both observe the
  // same last token and both proceed, silently exceeding the rate.
  it('does not let two concurrent callers share one token', async () => {
    const { slept, limit } = harness(1, 5);
    await Promise.all([limit(async () => 'a'), limit(async () => 'b')]);
    expect(slept).toHaveLength(1);
  });

  it('serialises a concurrent burst past capacity', async () => {
    const { slept, limit } = harness(2, 5);
    await Promise.all([
      limit(async () => 'a'), limit(async () => 'b'),
      limit(async () => 'c'), limit(async () => 'd'),
    ]);
    expect(slept).toHaveLength(2);   // two over capacity
  });

  it('keeps limiting after a concurrent caller rejects', async () => {
    const { limit } = harness(2, 5);
    const results = await Promise.allSettled([
      limit(async () => { throw new Error('x'); }),
      limit(async () => 'ok'),
    ]);
    expect(results[0]?.status).toBe('rejected');
    expect(results[1]?.status).toBe('fulfilled');
  });
});

describe('createRateLimiter — independent buckets', () => {
  it('gives two limiters separate token pools', async () => {
    const a = harness(1, 5);
    const b = harness(1, 5);
    await a.limit(async () => 'a1');
    await a.limit(async () => 'a2');    // a must wait
    await b.limit(async () => 'b1');    // b is untouched
    expect(a.slept).toHaveLength(1);
    expect(b.slept).toEqual([]);
  });
});
