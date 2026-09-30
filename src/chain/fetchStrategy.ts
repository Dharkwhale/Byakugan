/**
 * Choosing between per-transaction and whole-block enrichment.
 *
 * Enrichment needs `(from, value)` for each unique transaction, and there are two
 * ways to get it:
 *
 *   per-tx       one `eth_getTransactionByHash` per unique TRANSACTION
 *   block-fetch  one `eth_getBlockByNumber{includeTransactions:true}` per unique
 *                BLOCK, which returns every transaction in it at once
 *
 * So the comparison is `uniqueTxs * perTx` against `uniqueBlocks * perBlock`, and
 * block-fetch wins exactly when transactions-per-block exceeds `perBlock / perTx`.
 *
 * THERE IS NO `blockFetchThreshold` CONSTANT ANY MORE, deliberately. It used to be
 * a config number (3) that nothing justified. What config should carry instead is
 * the two compute-unit costs, which are facts about the provider rather than knobs
 * to tune, and the threshold falls out of them. A number someone can nudge invites
 * nudging; a measured price does not.
 *
 * WHY COST AND NOT LATENCY: an earlier version of this decision was made on
 * timing, which said per-tx wins below ~100 transactions because viem batches 50
 * per round trip. That was measured correctly and used wrongly — the binding
 * constraint on the free tier is compute units per second, not round trips, and
 * the two point in opposite directions. Latency only decides ties here.
 *
 * MEASURED DENSITIES this rule has to sit between, both real:
 *
 *   1.04 tx/block   Base 0x8279…5b72, 12,000 transfers over 167,494 blocks. A
 *                   Uniswap V3 Positions-style contract, where every mint is an
 *                   independent LP action and so is structurally unclustered.
 *                   Per-tx wins for anything but a near-1.0 cost ratio.
 *   high            a genuine drop, where many separate wallets mint in the same
 *                   few blocks. Block-fetch wins comfortably.
 *
 * The two differ by more than an order of magnitude, which is why this is computed
 * per window from observed density rather than chosen once.
 */

/** Provider compute-unit prices. Facts to be measured, not parameters to tune. */
export interface FetchCosts {
  /** CU for one `eth_getBlockByNumber` with `includeTransactions: true`. */
  perBlock: number;
  /** CU for one `eth_getTransactionByHash`. */
  perTx: number;
}

export type FetchStrategy = 'per-tx' | 'block-fetch';

/**
 * The transactions-per-block density at which the two paths cost the same.
 *
 * Above it block-fetch is cheaper, below it per-tx is. Exposed separately because
 * it is the number worth printing in a report or a log line — "this window ran
 * 8.2 tx/block against a break-even of 1.33" explains a decision that a bare
 * strategy name does not.
 */
export function breakEvenTxsPerBlock(costs: FetchCosts): number {
  assertCosts(costs);
  return costs.perBlock / costs.perTx;
}

/**
 * Picks the cheaper enrichment path for one window.
 *
 * Compared as two integer products rather than by dividing, so no floating-point
 * rounding can flip a decision that sits exactly on the break-even.
 *
 * TIES GO TO PER-TX. At equal cost the tiebreak is latency, where per-tx wins for
 * the small-to-middling windows this is called on because viem batches about 50
 * requests per round trip. A tie is also the case where a whole block's worth of
 * transaction data is being downloaded to use one transaction of it, so per-tx is
 * the lighter thing to have chosen if the cost figures later turn out slightly off.
 */
export function chooseFetchStrategy(a: {
  uniqueTxs: number;
  uniqueBlocks: number;
  costs: FetchCosts;
}): FetchStrategy {
  assertCosts(a.costs);
  if (!Number.isInteger(a.uniqueTxs) || a.uniqueTxs < 0) {
    throw new RangeError(`uniqueTxs must be a non-negative integer, got ${a.uniqueTxs}`);
  }
  if (!Number.isInteger(a.uniqueBlocks) || a.uniqueBlocks < 0) {
    throw new RangeError(`uniqueBlocks must be a non-negative integer, got ${a.uniqueBlocks}`);
  }
  // No blocks means no transactions to fetch; per-tx does nothing at no cost,
  // whereas block-fetch would be a claim about a window that does not exist.
  if (a.uniqueBlocks === 0 || a.uniqueTxs === 0) return 'per-tx';

  const perTxTotal = a.uniqueTxs * a.costs.perTx;
  const blockTotal = a.uniqueBlocks * a.costs.perBlock;
  return blockTotal < perTxTotal ? 'block-fetch' : 'per-tx';
}

/** Unique transactions and blocks in a set of rows needing enrichment. */
export function measureDensity(
  rows: Array<{ txHash: string; blockNumber: number | bigint }>,
): { uniqueTxs: number; uniqueBlocks: number; txsPerBlock: number } {
  const txs = new Set<string>();
  const blocks = new Set<string>();
  for (const row of rows) {
    txs.add(row.txHash);
    blocks.add(String(row.blockNumber));
  }
  return {
    uniqueTxs: txs.size,
    uniqueBlocks: blocks.size,
    txsPerBlock: blocks.size === 0 ? 0 : txs.size / blocks.size,
  };
}

function assertCosts(costs: FetchCosts): void {
  for (const [name, value] of [['perBlock', costs.perBlock], ['perTx', costs.perTx]] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError(
        `costs.${name} must be a positive finite number, got ${value}. These are ` +
        'provider compute-unit prices and must be measured, not defaulted — a zero ' +
        'or absent cost would silently make one path look free.',
      );
    }
  }
}
