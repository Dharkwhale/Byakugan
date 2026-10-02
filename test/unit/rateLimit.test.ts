import { describe, expect, it } from 'vitest';
import { createRateLimiter } from '../../src/chain/rateLimit.js';
import { CU_COSTS, DEFAULT_CU } from '../../src/chain/cuCosts.js';
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
    for (let i = 0; i < 5; i++) await limit(async () => i, 1);
    expect(slept).toEqual([]);
  });

  it('makes the request past capacity wait', async () => {
    const { slept, limit } = harness(5, 5);
    for (let i = 0; i < 5; i++) await limit(async () => i, 1);
    await limit(async () => 'sixth', 1);
    expect(slept).toHaveLength(1);
    expect(slept[0]).toBe(200);   // one token at 5/s
  });

  it('returns the function result unchanged', async () => {
    const { limit } = harness(2, 2);
    await expect(limit(async () => 'value', 1)).resolves.toBe('value');
  });

  it('propagates a rejection', async () => {
    const { limit } = harness(2, 2);
    await expect(limit(async () => { throw new Error('boom'); }, 1)).rejects.toThrow('boom');
  });

  it('consumes a token even when the call fails, so a failing burst is still limited', async () => {
    const { slept, limit } = harness(2, 2);
    await expect(limit(async () => { throw new Error('a'); }, 1)).rejects.toThrow();
    await expect(limit(async () => { throw new Error('b'); }, 1)).rejects.toThrow();
    await limit(async () => 'third', 1);
    expect(slept).toHaveLength(1);
  });
});

describe('createRateLimiter — refill is proportional to elapsed time', () => {
  // A fixed-tick refill would either over-grant here or under-grant during a
  // burst. These assert the elapsed-time behaviour, not an internal counter.
  it('refills to exactly capacity after a long idle, and not beyond', async () => {
    const { clock, slept, limit } = harness(5, 5);
    for (let i = 0; i < 5; i++) await limit(async () => i, 1);   // drain
    expect(slept).toEqual([]);

    clock.advance(10_000);   // 10s idle at 5/s would be 50 tokens, uncapped

    // Exactly `capacity` more run free...
    for (let i = 0; i < 5; i++) await limit(async () => i, 1);
    expect(slept).toEqual([]);

    // ...and the next one waits, proving the refill capped at capacity rather
    // than accumulating 50 tokens.
    await limit(async () => 'over', 1);
    expect(slept).toEqual([200]);
  });

  it('grants a partial refill proportional to a short idle', async () => {
    const { clock, slept, limit } = harness(5, 5);
    for (let i = 0; i < 5; i++) await limit(async () => i, 1);   // drain

    clock.advance(600);   // 0.6s at 5/s = 3 tokens

    for (let i = 0; i < 3; i++) await limit(async () => i, 1);
    expect(slept).toEqual([]);

    await limit(async () => 'fourth', 1);
    expect(slept).toHaveLength(1);
  });

  it('waits proportionally less when partially refilled', async () => {
    const { clock, slept, limit } = harness(1, 5);
    await limit(async () => 'first', 1);       // drains the only token
    clock.advance(100);                      // 0.5 of a token at 5/s
    await limit(async () => 'second', 1);
    expect(slept[0]).toBe(100);              // needs the other 0.5 = 100ms
  });

  it('does not accumulate tokens beyond capacity across several idles', async () => {
    const { clock, slept, limit } = harness(3, 10);
    clock.advance(60_000);                   // a minute idle
    for (let i = 0; i < 3; i++) await limit(async () => i, 1);
    expect(slept).toEqual([]);
    await limit(async () => 'over', 1);
    expect(slept).toHaveLength(1);
  });

  it('never grants a negative wait when the clock does not move', async () => {
    const { slept, limit } = harness(1, 10);
    await limit(async () => 'a', 1);
    await limit(async () => 'b', 1);
    expect(slept[0]).toBeGreaterThan(0);
  });
});

describe('createRateLimiter — concurrent callers', () => {
  // NOTE (mutation-verified): this test does NOT prove serialised
  // acquisition. With only one token, the fast path of `acquire()` (refill,
  // check, decrement) has no `await` in it, so JS run-to-completion already
  // guarantees the first caller finishes before the second one starts, with
  // or without the `tail` chain — there is no race to lose over a single
  // available token. Removing serialisation entirely still produces
  // `slept = [200]` here, identical to the correct implementation. What this
  // test actually pins is that one caller runs free and the other waits for
  // exactly one token — a real property, just not the concurrency one its
  // old name claimed. The test below, `serialises a concurrent burst past
  // capacity`, is the one that fails under a no-serialisation mutant, because
  // it forces two callers to simultaneously be on the SLOW (waiting) path,
  // which is where the race actually lives.
  it('serves one waiter per token when only one token is short', async () => {
    const { slept, limit } = harness(1, 5);
    await Promise.all([limit(async () => 'a', 1), limit(async () => 'b', 1)]);
    expect(slept).toHaveLength(1);
  });

  it('serialises a concurrent burst past capacity', async () => {
    const { slept, limit } = harness(2, 5);
    await Promise.all([
      limit(async () => 'a', 1), limit(async () => 'b', 1),
      limit(async () => 'c', 1), limit(async () => 'd', 1),
    ]);
    expect(slept).toHaveLength(2);   // two over capacity
  });

  // A second, larger case: more simultaneous waiters makes the mutant's
  // over-grant harder to hide behind a small sample. Capacity 2, 6 callers:
  // 2 run free, 4 must each wait for a token.
  it('serialises a larger concurrent burst past capacity', async () => {
    const { slept, limit } = harness(2, 5);
    await Promise.all([
      limit(async () => 'a', 1), limit(async () => 'b', 1),
      limit(async () => 'c', 1), limit(async () => 'd', 1),
      limit(async () => 'e', 1), limit(async () => 'f', 1),
    ]);
    expect(slept).toHaveLength(4);   // four over capacity
  });

  it('keeps limiting after a concurrent caller rejects', async () => {
    const { limit } = harness(2, 5);
    const results = await Promise.allSettled([
      limit(async () => { throw new Error('x'); }, 1),
      limit(async () => 'ok', 1),
    ]);
    expect(results[0]?.status).toBe('rejected');
    expect(results[1]?.status).toBe('fulfilled');
  });
});

describe('createRateLimiter — independent buckets', () => {
  it('gives two limiters separate token pools', async () => {
    const a = harness(1, 5);
    const b = harness(1, 5);
    await a.limit(async () => 'a1', 1);
    await a.limit(async () => 'a2', 1);    // a must wait
    await b.limit(async () => 'b1', 1);    // b is untouched
    expect(a.slept).toHaveLength(1);
    expect(b.slept).toEqual([]);
  });
});

describe('compute-unit weighting', () => {
  /**
   * The limiter used to charge exactly one token per call, and config carried a flat
   * `requestsPerSecond: 25`. Both were wrong together: eth_getLogs costs 60 CU against a
   * 300 CU/s ceiling, so 5 calls per second is the real allowance and 25 would have
   * earned a 429 on every backfill. A flat rate cannot be right for every method either —
   * at the same ceiling eth_getTransactionByHash sustains 20.
   */
  const bucket = (clock: ReturnType<typeof manualClock>, slept: number[]) =>
    createRateLimiter({
      capacity: 300, refillPerSec: 300, clock,
      sleep: async (ms) => { slept.push(ms); clock.advance(ms); },
    });

  it('spends the cost it is given, not one token per call', async () => {
    const clock = manualClock(0);
    const slept: number[] = [];
    const limit = bucket(clock, slept);
    // 300 CU of capacity buys five 60-CU calls and no more.
    for (let i = 0; i < 5; i++) await limit(async () => i, 60);
    expect(slept).toEqual([]);
    await limit(async () => 'sixth', 60);
    expect(slept).toHaveLength(1);
  });

  it('lets cheap methods through faster than expensive ones', async () => {
    // The whole reason for weighting. At 300 CU/s a 15-CU method sustains 20 calls in
    // the same budget that allows five 60-CU calls.
    const clock = manualClock(0);
    const slept: number[] = [];
    const limit = bucket(clock, slept);
    for (let i = 0; i < 20; i++) await limit(async () => i, 15);
    expect(slept).toEqual([]);
  });

  it('charges DEFAULT_CU when no cost is given, erring expensive', async () => {
    // Fail-safe direction: a forgotten cost must make the run slower, never faster than
    // the provider allows. DEFAULT_CU is the most expensive known method (120), so a
    // 300-CU bucket affords two such calls and must sleep before a third.
    const clock = manualClock(0);
    const slept: number[] = [];
    const limit = bucket(clock, slept);
    expect(DEFAULT_CU).toBe(120);
    await limit(async () => 'a');
    await limit(async () => 'b');
    expect(slept).toEqual([]);
    await limit(async () => 'c');
    expect(slept).toHaveLength(1);
  });

  it('a forgotten cost is never cheaper than the cheapest real method', () => {
    // Pins the direction rather than the number, so adding a pricier method to the table
    // cannot quietly turn the default into an under-charge.
    expect(DEFAULT_CU).toBeGreaterThanOrEqual(Math.max(...Object.values(CU_COSTS)));
  });

  it('waits proportionally to the cost, not a fixed tick', async () => {
    const clock = manualClock(0);
    const slept: number[] = [];
    const limit = bucket(clock, slept);
    await limit(async () => 'drain', 300);          // empties the bucket
    await limit(async () => 'cheap', 30);           // 30/300 of a second
    expect(slept).toEqual([100]);
  });

  it('does not deadlock on a cost larger than capacity', async () => {
    // A cost above capacity could never be satisfied, so it is clamped: the call takes a
    // full bucket instead of waiting forever. Spinning here would hang a backfill with no
    // error to explain it.
    const clock = manualClock(0);
    const slept: number[] = [];
    const limit = bucket(clock, slept);
    await expect(limit(async () => 'huge', 10_000)).resolves.toBe('huge');
  });

  it('treats a zero cost as free, for calls that are not RPC at all', async () => {
    // The Etherscan lookup goes through the limiter for serialisation but draws nothing
    // from the provider's budget.
    const clock = manualClock(0);
    const slept: number[] = [];
    const limit = bucket(clock, slept);
    for (let i = 0; i < 50; i++) await limit(async () => i, 0);
    expect(slept).toEqual([]);
  });
});
