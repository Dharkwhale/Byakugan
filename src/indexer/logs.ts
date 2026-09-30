import { RangeExhaustedError } from '../errors.js';
import type { RawLog } from './decode.js';

/**
 * Phrases providers use when a getLogs range or result set is too large.
 * Matched against the FULL error text, not just `message` — see `errorText`.
 * An entry is listed only if no other entry is a substring of it (a
 * 'block range too large' entry would be dead weight next to 'block range').
 */
const RANGE_PATTERNS = [
  'block range',
  'more than 10000 results',
  'max results',
  'response size exceeded',
  'query timeout exceeded',
];

/**
 * Codes that mean "too much" on their own, unless the text says the provider is
 * rate limiting (see `RATE_LIMIT`). `-32600` is deliberately absent: it is
 * JSON-RPC's generic "Invalid Request", and treating it as a range error would
 * make the chunker halve forever against a malformed request that halving
 * cannot fix.
 */
const RANGE_CODES = new Set([-32005]);

/**
 * Some providers reuse -32005 for rate limiting. Halving cannot fix that and
 * would end in a misleading RangeExhaustedError; the rate limiter and retry
 * layer own it instead.
 */
const RATE_LIMIT = /rate[\s-]?limit|too many requests|\b429\b/;

/** `[0x…, 0x…]` — the range a provider says would have worked. */
const SUGGESTED_RANGE = /\[\s*(0x[0-9a-fA-F]+)\s*,\s*(0x[0-9a-fA-F]+)\s*\]/;

interface ErrorNode {
  message?: unknown; details?: unknown; shortMessage?: unknown; data?: unknown;
  metaMessages?: unknown; code?: unknown; cause?: unknown; error?: unknown;
}

/**
 * The error and everything reachable through `cause` and a nested `error`
 * object, each node once. `seen` stops a cycle from repeating text; `depth`
 * bounds pathological chains. They are not redundant: the depth limit alone
 * terminates a cycle but would emit its text once per lap.
 */
function errorNodes(err: unknown, seen = new Set<unknown>(), depth = 0): ErrorNode[] {
  if (!err || typeof err !== 'object' || seen.has(err) || depth > 5) return [];
  seen.add(err);
  const e = err as ErrorNode;
  return [e, ...errorNodes(e.cause, seen, depth + 1), ...errorNodes(e.error, seen, depth + 1)];
}

/**
 * Every string a provider error carries, including down the cause chain.
 *
 * Measured against Alchemy: the top-level `message` is
 * "JSON is not a valid request object." and says nothing about ranges, while
 * `details` carries "…up to a 10 block range…". Matching only `message` would
 * miss it entirely and the backfill would die on its first call. `data`, a
 * nested `error.message` and viem's `metaMessages` are read for the same reason.
 * Total for any input.
 */
export function errorText(err: unknown): string {
  return errorNodes(err)
    .map((e) => {
      const meta = Array.isArray(e.metaMessages)
        ? e.metaMessages.filter((m): m is string => typeof m === 'string')
        : [];
      return [e.details, e.shortMessage, e.message, e.data, ...meta]
        .filter((p): p is string => typeof p === 'string')
        .join(' | ');
    })
    .join(' ');
}

export function isRangeError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;

  const text = errorText(err).toLowerCase();

  const hasRangeCode = errorNodes(err).some(
    (e) => typeof e.code === 'number' && RANGE_CODES.has(e.code),
  );
  if (hasRangeCode && !RATE_LIMIT.test(text)) return true;

  return RANGE_PATTERNS.some((p) => text.includes(p));
}

/**
 * The range a provider suggested, when it offers one.
 *
 * Measured: Alchemy returns "this block range should work: [0x17ec57d,
 * 0x17ec586]", and re-requesting exactly that span succeeds on the first retry.
 * Blind halving from an optimistic 2000 takes eight failed round trips to reach
 * the same place.
 *
 * Accepted limitation: this takes the FIRST `[0x…, 0x…]` pair in the text, which
 * could in principle be an echoed parameter array rather than a suggestion. It
 * only runs after `isRangeError` is true, and `iterateLogs` rejects an
 * implausible width (one not smaller than the span that failed). Only the WIDTH
 * is used — the suggested start is never compared against the cursor.
 */
export function suggestedRange(
  err: unknown,
): { fromBlock: bigint; toBlock: bigint } | undefined {
  const match = SUGGESTED_RANGE.exec(errorText(err));
  if (!match?.[1] || !match[2]) return undefined;
  try {
    const fromBlock = BigInt(match[1]);
    const toBlock = BigInt(match[2]);
    if (toBlock < fromBlock) return undefined;
    return { fromBlock, toBlock };
  } catch {
    return undefined;
  }
}

export interface LogFetcher {
  (a: { fromBlock: bigint; toBlock: bigint }): Promise<RawLog[]>;
}

const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const max = (a: bigint, b: bigint): bigint => (a > b ? a : b);

/**
 * Walks [fromBlock, toBlock] in inclusive, non-overlapping chunks, shrinking the
 * range when the provider complains and growing it when it does not.
 *
 * Three behaviours matter, all driven by measurements against the real provider:
 *
 * - When the provider names a range that would work, adopt it rather than
 *   halving. Measured: one retry instead of eight.
 * - Remember the largest range known to fail and never grow back to it.
 *   Without that ceiling, growing 1.25x after each success walks straight back
 *   over the cap and fails again, forever — one wasted call every few chunks
 *   for the whole backfill.
 *   The ceiling DECAYS: after `successesBeforeProbe` consecutive successful
 *   chunks it doubles (clamped to `maxChunk`) so the run can find out whether the
 *   limit has lifted. If that probe fails, the ceiling drops again through the
 *   normal path and `successesBeforeProbe` DOUBLES (capped at 1024x its start),
 *   so probing backs off instead of wasting one call every N chunks forever.
 *   Cost: O(log n) while the interval is still doubling, then O(n / cap) once
 *   it reaches its ceiling — about 60 wasted calls per million chunks, against
 *   50,000 for a fixed interval. It is NOT strictly O(log n) over an unbounded
 *   run; an earlier version of this comment claimed that and was wrong.
 *   Why it exists: on paid tiers the limit is
 *   result-size driven, and density varies enormously — a ceiling learned in a
 *   mint window holding thousands of logs per block would otherwise throttle the
 *   quiet years that follow, for the whole run. The MEASURED free-tier cap is
 *   FLAT (10 blocks even for an address that never emitted), so there the probe
 *   simply keeps failing and backing off: a handful of calls per run.
 * - Never fall below one block, and give up after `maxHalvings`, so a provider
 *   that refuses everything cannot spin.
 *
 * The configured account's measured cap is 10 blocks, which is a plan-tier
 * limit rather than a chain property — hence discovered at runtime instead of
 * configured. At that size a full mainnet backfill from a 2021 deploy block is
 * on the order of a million requests; `initialChunk` stays optimistic because
 * being wrong now costs exactly one failed call per chain per run.
 */
export async function* iterateLogs(a: {
  fetch: LogFetcher;
  fromBlock: bigint;
  toBlock: bigint;
  initialChunk: number;
  maxChunk: number;
  maxHalvings?: number;
  /** Consecutive successes before the ceiling is probed upward. Default 20. */
  successesBeforeProbe?: number;
}): AsyncGenerator<{ fromBlock: bigint; toBlock: bigint; logs: RawLog[] }> {
  const maxHalvings = a.maxHalvings ?? 12;
  const hardMax = BigInt(Math.max(1, a.maxChunk));
  let range = min(BigInt(Math.max(1, a.initialChunk)), hardMax);
  /** Largest range not yet known to fail. Shrinks on failure, decays back up on sustained success. */
  let ceiling = hardMax;
  const baseProbeAfter = Math.max(1, Math.floor(a.successesBeforeProbe ?? 20));
  const maxProbeAfter = baseProbeAfter * 1024;
  let probeAfter = baseProbeAfter;
  let streak = 0;
  /** The ceiling in force before the latest raise; set while that probe is unresolved. */
  let probeFloor: bigint | undefined;
  let cursor = a.fromBlock;

  while (cursor <= a.toBlock) {
    let halvings = 0;

    for (;;) {
      const end = min(cursor + range - 1n, a.toBlock);
      // The span actually requested. When `toBlock` clamps the request this is
      // smaller than `range`; every reduction must be derived from IT, or the
      // same request is re-sent while `range` shrinks to no effect.
      const span = end - cursor + 1n;
      try {
        const logs = await a.fetch({ fromBlock: cursor, toBlock: end });
        yield { fromBlock: cursor, toBlock: end, logs };
        cursor = end + 1n;
        streak += 1;
        if (probeFloor !== undefined && span > probeFloor) probeFloor = undefined;
        if (streak >= probeAfter && ceiling < hardMax) {
          probeFloor = ceiling;
          ceiling = min(ceiling * 2n, hardMax);
          streak = 0;
        }
        // Integer 1.25x is a no-op at 1..3, so always advance by at least one.
        range = min(min(max(range + 1n, (range * 5n) / 4n), ceiling), hardMax);
        break;
      } catch (err) {
        if (!isRangeError(err)) throw err;

        streak = 0;
        // A failure wider than the pre-raise ceiling means the probe failed:
        // back off the next one.
        if (probeFloor !== undefined && span > probeFloor) {
          probeAfter = Math.min(probeAfter * 2, maxProbeAfter);
        }
        probeFloor = undefined;

        const suggestion = suggestedRange(err);
        const suggestedWidth = suggestion
          ? suggestion.toBlock - suggestion.fromBlock + 1n
          : undefined;

        // Only trust a suggestion that is smaller than the span that failed —
        // a wider one cannot be a fix and would loop.
        const usable =
          suggestedWidth !== undefined && suggestedWidth < span ? suggestedWidth : undefined;

        // The ceiling must be the provider's STATED cap when it gives one, not
        // merely `span - 1`. Using `span - 1` leaves the ceiling far above the
        // real limit, so the next 1.25x growth sails straight back over it and
        // fails again — the exact oscillation the ceiling exists to prevent.
        // Without a suggestion, all we know is that this width is too big.
        ceiling = min(ceiling, max(usable ?? span - 1n, 1n));

        const next = usable ?? max(span / 2n, 1n);

        if (span === 1n || halvings >= maxHalvings) {
          throw new RangeExhaustedError(
            `getLogs still failing at span ${span} block(s) from ${cursor} after ` +
            `${halvings} reduction(s): ${String((err as Error).message)}`,
          );
        }

        range = max(min(next, ceiling), 1n);
        halvings += 1;
      }
    }
  }
}

/**
 * Measures the provider's real `eth_getLogs` range cap, with at most a few calls.
 *
 * WHY THIS EXISTS: the dry-run cost estimate was reading its chunk size from
 * `config.maxChunk`, which on Base is 20,000 — while the MEASURED cap on the
 * configured account is 10. That made a 38-million-block backfill report as "76
 * seconds" when the honest figure is days. An estimate exists to be trusted before
 * committing to a long run, so one that is optimistic by three orders of magnitude is
 * worse than none: it actively invites the accident it was built to prevent.
 *
 * The cap is a PLAN-TIER property, not a chain property, so it cannot be configured
 * honestly — it has to be asked. Measured, not assumed, which is the same rule applied
 * everywhere else in this project.
 *
 * Costs one call when the requested range is allowed, and typically two when it is not:
 * providers that cap usually name a workable range in the error, and `suggestedRange`
 * reads it rather than halving blindly. Falls back to halving, bounded, and reports
 * `measured: false` rather than inventing a number if nothing is ever accepted.
 *
 * Queried against a range ENDING at `nearBlock` so it probes real recent history; a
 * zero-result window still caps, which is measured and is why any range will do.
 */
export async function probeEffectiveChunk(a: {
  fetch: LogFetcher;
  nearBlock: bigint;
  requested: number;
  maxAttempts?: number;
}): Promise<{ blocks: number; measured: boolean; note: string }> {
  const maxAttempts = a.maxAttempts ?? 8;
  let range = BigInt(Math.max(1, a.requested));

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const from = a.nearBlock - range + 1n;
    try {
      await a.fetch({ fromBlock: from < 0n ? 0n : from, toBlock: a.nearBlock });
      return {
        blocks: Number(range),
        measured: true,
        note: attempt === 0
          ? `the requested ${range}-block range was accepted`
          : `measured by probing: ${range} blocks accepted after ${attempt + 1} attempts`,
      };
    } catch (err) {
      if (!isRangeError(err)) {
        // Not a range complaint — a transport failure, or an endpoint refusing the
        // request itself. Narrowing cannot help and pretending otherwise would report
        // a cap that was never established.
        return {
          blocks: Number(range),
          measured: false,
          note: 'could not be measured: the endpoint failed for a reason unrelated to ' +
            'range, so this figure is the requested size and not a verified cap',
        };
      }
      const suggestion = suggestedRange(err);
      const suggestedWidth = suggestion
        ? suggestion.toBlock - suggestion.fromBlock + 1n
        : undefined;
      // Only adopt a suggestion that is actually narrower, matching iterateLogs.
      range = suggestedWidth !== undefined && suggestedWidth < range
        ? suggestedWidth
        : range / 2n;
      if (range < 1n) range = 1n;
    }
  }

  return {
    blocks: Number(range),
    measured: false,
    note: `gave up after ${maxAttempts} probes; the endpoint refused every range down ` +
      `to ${range} blocks`,
  };
}
