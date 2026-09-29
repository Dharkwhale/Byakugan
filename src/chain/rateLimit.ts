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
 * The 30s figure below is client.ts's explicit `timeout` override, not a
 * viem default. Measured directly (a local server that never responds):
 * viem's own default is 10s. Task 3 measured a cold archive `getCode` read
 * exceeding that default and failing as a spurious timeout, which is why
 * client.ts (and scripts/verify-archive-probes.ts before it) overrides to
 * 30s — `getLogs` over a wide range has the same profile.
 *
 * This limiter wraps the whole viem call, so those retries happen inside a
 * single token and consume no extra tokens — they cannot compound into an
 * unbounded wait. Two consequences worth knowing:
 *
 *   worst case = bucket wait + (retryCount + 1) x request timeout + backoff
 *              = (1 / refillPerSec) s + 4 x 30 s + 1.75 s
 *              ~= 122 s for one request, at client.ts's 30s override
 *
 * and a single retrying request's own attempts exceed the configured rate by
 * at most a factor of `retryCount + 1` — exactly, since viem never makes more
 * than retryCount + 1 attempts per call. That bound is on ATTEMPTS PER TOKEN,
 * not on attempts-per-second-in-time: the 4 attempts land close together
 * (~2s apart, per the measurement above) when the endpoint fails fast with an
 * HTTP error, but can be spread across the full ~122s worst case when it
 * fails by hanging instead. Either way, one token buys at most 4 attempts.
 *
 * The more serious version of this is NOT per-request, and is NOT bounded:
 * during a provider outage, up to `capacity` calls can be in flight
 * concurrently, each holding one token while it independently retries up to
 * `retryCount + 1` times. Since retries are not individually rate-limited,
 * that is a burst of up to `capacity x (retryCount + 1)` real HTTP attempts
 * against an already-failing endpoint — and it persists for the duration of
 * the outage, not briefly, because a fresh set of callers keeps acquiring
 * fresh tokens and retrying the same way. This is a documented limitation of
 * Milestone 1, not a bounded guarantee: properly bounding it needs a circuit
 * breaker (stop issuing new calls to a chain once it's clearly down), which
 * is out of scope here. Both worst-case numbers above are bounded per token;
 * this aggregate risk is not, and is the shape that gets a backfill rate-
 * limited or banned by a provider during an outage.
 *
 * Both single-request numbers are bounded. The dominant term in the
 * single-request worst case is the request timeout, not the backoff, so
 * lowering `timeout` matters far more than lowering `retryDelay` if a stuck
 * backfill needs to fail faster — it does nothing for the aggregate risk
 * above, which only a circuit breaker addresses.
 */
export function createRateLimiter(opts: RateLimiterOptions): RateLimiter {
  const clock = opts.clock ?? systemClock;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const { capacity, refillPerSec } = opts;

  if (capacity < 1) throw new Error('rate limiter capacity must be at least 1');
  if (refillPerSec <= 0) throw new Error('rate limiter refillPerSec must be positive');

  let tokens = capacity;
  let lastRefillMs = clock.now();
  // Acquisition is serialised. The fast path below (refill, check, decrement)
  // has no `await` in it, so JS run-to-completion already prevents two
  // callers from interleaving there — with only one token short, there is no
  // race to lose. The real race is on the SLOW path: when several callers
  // are all short of a token, they all `await sleep(...)`, and without this
  // `tail` chain they would all wake, all `refill()`, and all fall through to
  // `Math.max(0, tokens - 1)` below — which *clamps* rather than going
  // negative, so an over-grant of N simultaneous waiters is silent instead of
  // throwing or producing a visibly wrong token count. Serialising acquire()
  // through `tail` makes that clamp unreachable: each waiter's refill and
  // decrement happens only after the previous one has fully completed.
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
