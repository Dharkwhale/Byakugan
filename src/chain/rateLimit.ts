import { systemClock, type Clock } from '../clock.js';

export type RateLimiter = <T>(fn: () => Promise<T>) => Promise<T>;

export interface RateLimiterOptions {
  /** Maximum burst. Tokens never accumulate beyond this. */
  capacity: number;
  /** Tokens added per second, applied proportionally to elapsed time. */
  refillPerSec: number;
  clock?: Clock;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * A token bucket.
 *
 * Refill is computed from ELAPSED TIME rather than a fixed tick: a tick-based
 * refill either over-grants after an idle period or under-grants during a
 * burst. Tokens are capped at `capacity`, so a bucket idle for a minute does
 * not then allow a minute's worth of requests at once.
 *
 * The clock and sleep are injected so tests can drive time explicitly. A
 * limiter tested against the wall clock is slow and flaky, and flaky tests get
 * deleted.
 *
 * WORST-CASE DELAY FOR ONE FAILING REQUEST — measured, not estimated.
 * Against a server that always returns 500, viem's http transport with
 * `retryCount: 3, retryDelay: 250` made 4 HTTP attempts with gaps of roughly
 * 250/500/1000ms: it DOUBLES the delay each retry rather than treating
 * retryDelay as a fixed interval. Backoff therefore totals ~1750ms.
 *
 * This limiter wraps the whole viem call, so those retries happen inside a
 * single token and consume no extra tokens — they cannot compound into an
 * unbounded wait. Two consequences worth knowing:
 *
 *   worst case = bucket wait + (retryCount + 1) x request timeout + backoff
 *              = (1 / refillPerSec) s + 4 x 30 s + 1.75 s
 *              ~= 122 s for one request, at 30s timeout
 *
 * and a retrying request briefly exceeds the configured rate by at most a
 * factor of `retryCount + 1`, because its retries are not individually
 * rate-limited. Both are bounded. The dominant term is the request timeout,
 * not the backoff, so lowering `timeout` matters far more than lowering
 * `retryDelay` if a stuck backfill needs to fail faster.
 */
export function createRateLimiter(opts: RateLimiterOptions): RateLimiter {
  const clock = opts.clock ?? systemClock;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const { capacity, refillPerSec } = opts;

  if (capacity < 1) throw new Error('rate limiter capacity must be at least 1');
  if (refillPerSec <= 0) throw new Error('rate limiter refillPerSec must be positive');

  let tokens = capacity;
  let lastRefillMs = clock.now();
  // Acquisition is serialised: without this, two concurrent callers can both
  // observe the same last token and both proceed, silently doubling the rate.
  let tail: Promise<unknown> = Promise.resolve();

  function refill(): void {
    const now = clock.now();
    const elapsedMs = now - lastRefillMs;
    if (elapsedMs <= 0) return;
    lastRefillMs = now;
    tokens = Math.min(capacity, tokens + (elapsedMs / 1000) * refillPerSec);
  }

  async function acquire(): Promise<void> {
    refill();
    if (tokens < 1) {
      const waitMs = Math.ceil(((1 - tokens) / refillPerSec) * 1000);
      await sleep(waitMs);
      refill();
    }
    tokens = Math.max(0, tokens - 1);
  }

  return async function limited<T>(fn: () => Promise<T>): Promise<T> {
    const mine = tail.then(() => acquire());
    // Swallow on the chain only, so one caller's failure cannot break the queue
    // for everyone behind it. The caller still sees its own rejection below.
    tail = mine.catch(() => undefined);
    await mine;
    return fn();
  };
}
