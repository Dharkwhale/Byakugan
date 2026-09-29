import { RangeExhaustedError } from '../errors.js';
import type { RawLog } from './decode.js';

/**
 * Phrases providers use when a getLogs range or result set is too large.
 * Matched against the FULL error text, not just `message` — see `errorText`.
 */
const RANGE_PATTERNS = [
  'block range',
  'more than 10000 results',
  'max results',
  'block range too large',
  'exceed maximum block range',
  'response size exceeded',
  'query timeout exceeded',
  'log response size exceeded',
];

/**
 * Codes that mean "too much" on their own. `-32600` is deliberately absent: it
 * is JSON-RPC's generic "Invalid Request", and treating it as a range error
 * would make the chunker halve forever against a malformed request that halving
 * cannot fix.
 */
const RANGE_CODES = new Set([-32005]);

/** `[0x…, 0x…]` — the range a provider says would have worked. */
const SUGGESTED_RANGE = /\[\s*(0x[0-9a-fA-F]+)\s*,\s*(0x[0-9a-fA-F]+)\s*\]/;

/**
 * Every string a provider error carries, including down the cause chain.
 *
 * Measured against Alchemy: the top-level `message` is
 * "JSON is not a valid request object." and says nothing about ranges, while
 * `details` carries "…up to a 10 block range…". Matching only `message` would
 * miss it entirely and the backfill would die on its first call.
 */
export function errorText(err: unknown, seen = new Set<unknown>(), depth = 0): string {
  if (!err || typeof err !== 'object' || seen.has(err) || depth > 5) return '';
  seen.add(err);
  const e = err as {
    message?: unknown; details?: unknown; shortMessage?: unknown; cause?: unknown;
  };
  const parts = [e.details, e.shortMessage, e.message]
    .filter((p): p is string => typeof p === 'string');
  return `${parts.join(' | ')} ${errorText(e.cause, seen, depth + 1)}`;
}

export function isRangeError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;

  const code = (err as { code?: unknown }).code;
  if (typeof code === 'number' && RANGE_CODES.has(code)) return true;

  const text = errorText(err).toLowerCase();
  return RANGE_PATTERNS.some((p) => text.includes(p));
}

/**
 * The range a provider suggested, when it offers one.
 *
 * Measured: Alchemy returns "this block range should work: [0x17ec57d,
 * 0x17ec586]", and re-requesting exactly that span succeeds on the first retry.
 * Blind halving from an optimistic 2000 takes eight failed round trips to reach
 * the same place.
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
}): AsyncGenerator<{ fromBlock: bigint; toBlock: bigint; logs: RawLog[] }> {
  const maxHalvings = a.maxHalvings ?? 12;
  const hardMax = BigInt(Math.max(1, a.maxChunk));
  let range = min(BigInt(Math.max(1, a.initialChunk)), hardMax);
  /** Largest range not yet known to fail. Only ever shrinks within a run. */
  let ceiling = hardMax;
  let cursor = a.fromBlock;

  while (cursor <= a.toBlock) {
    let halvings = 0;

    for (;;) {
      const end = min(cursor + range - 1n, a.toBlock);
      try {
        const logs = await a.fetch({ fromBlock: cursor, toBlock: end });
        yield { fromBlock: cursor, toBlock: end, logs };
        cursor = end + 1n;
        range = min(min((range * 5n) / 4n, ceiling), hardMax);
        break;
      } catch (err) {
        if (!isRangeError(err)) throw err;

        const suggestion = suggestedRange(err);
        const suggestedWidth = suggestion
          ? suggestion.toBlock - suggestion.fromBlock + 1n
          : undefined;

        // Only trust a suggestion that is actually smaller than what failed —
        // a wider one cannot be a fix and would loop.
        const usable =
          suggestedWidth !== undefined && suggestedWidth < range ? suggestedWidth : undefined;

        // The ceiling must be the provider's STATED cap when it gives one, not
        // merely `range - 1`. Using `range - 1` leaves the ceiling far above the
        // real limit, so the next 1.25x growth sails straight back over it and
        // fails again — the exact oscillation the ceiling exists to prevent.
        // Without a suggestion, all we know is that this width is too big.
        ceiling = max(usable ?? range - 1n, 1n);

        const next = usable ?? max(range / 2n, 1n);

        if (range === 1n || halvings >= maxHalvings) {
          throw new RangeExhaustedError(
            `getLogs still failing at range ${range} block(s) from ${cursor} after ` +
            `${halvings} reduction(s): ${String((err as Error).message)}`,
          );
        }

        range = max(min(next, ceiling), 1n);
        halvings += 1;
      }
    }
  }
}
