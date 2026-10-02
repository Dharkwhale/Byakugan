import { breakEvenTxsPerBlock, type FetchCosts } from '../chain/fetchStrategy.js';

/**
 * Compute-unit prices, including the one `FetchCosts` does not carry.
 *
 * `eth_getLogs` has no place in `FetchCosts` because that type exists to choose
 * between the two ENRICHMENT paths, and `getLogs` is not one of them. Estimation needs
 * it, so it is added here rather than widening a type used for a different decision.
 */
export interface CuPrices extends FetchCosts {
  perLogsCall: number;
}

export interface BackfillEstimate {
  fromBlock: bigint;
  toBlock: bigint;
  blocks: bigint;
  chunkBlocks: number;
  /** Exact, not approximate: the chunk size is a hard provider cap. */
  logsCalls: number;
  /** Null when no prices are configured — never a guessed number. */
  logsCu: number | null;
  /** Wall clock for the log fetching alone, from the configured request rate. */
  logsSeconds: number;
  /** Enrichment cannot be estimated ahead of reading the logs. Stated, not guessed. */
  enrichment: {
    reason: string;
    breakEvenTxsPerBlock: number | null;
    perTxCu: number | null;
    perBlockCu: number | null;
  };
}

/**
 * What a backfill will cost before committing to it.
 *
 * THE POINT OF THIS IS ONE NUMBER: hours. At the measured 10-block cap and 5 sustained
 * `getLogs` per second, a million-block span is 200,000 calls and about eleven hours.
 * Discovering that eleven hours in is the failure this guards against, and it is a
 * failure this project already walked into once by reasoning from an assumed 25 rps
 * and being five times optimistic.
 *
 * WHAT IT WILL NOT DO IS GUESS THE ENRICHMENT COST. That depends on transactions per
 * block, which is not knowable until the logs have been read — and it is the dominant
 * term, measured at 142x the fetch cost on a real collection. Returning a confident
 * total that omitted it would be worse than returning nothing: it would read as an
 * upper bound while being a small fraction of the real bill. So the enrichment field
 * carries the unit prices and the break-even instead, and says why.
 *
 * CU FIGURES ARE NULL WHEN NO PRICES ARE CONFIGURED, rather than defaulted. A zero or
 * assumed price would make a path look free, and these are measured provider facts,
 * not tunables.
 */
export function estimateBackfill(a: {
  fromBlock: bigint;
  toBlock: bigint;
  chunkBlocks: number;
  requestsPerSecond: number;
  prices?: CuPrices;
}): BackfillEstimate {
  if (a.toBlock < a.fromBlock) {
    throw new RangeError(
      `toBlock ${a.toBlock} is below fromBlock ${a.fromBlock}; there is nothing to estimate.`,
    );
  }
  if (!Number.isInteger(a.chunkBlocks) || a.chunkBlocks < 1) {
    throw new RangeError(`chunkBlocks must be a positive integer, got ${a.chunkBlocks}`);
  }
  if (!Number.isFinite(a.requestsPerSecond) || a.requestsPerSecond <= 0) {
    throw new RangeError(
      `requestsPerSecond must be positive, got ${a.requestsPerSecond}`,
    );
  }

  const blocks = a.toBlock - a.fromBlock + 1n;
  const chunk = BigInt(a.chunkBlocks);
  // Ceiling division in bigint, so a span beyond Number.MAX_SAFE_INTEGER stays exact.
  const callsBig = (blocks + chunk - 1n) / chunk;
  const logsCalls = Number(callsBig);

  return {
    fromBlock: a.fromBlock,
    toBlock: a.toBlock,
    blocks,
    chunkBlocks: a.chunkBlocks,
    logsCalls,
    logsCu: a.prices ? logsCalls * a.prices.perLogsCall : null,
    logsSeconds: logsCalls / a.requestsPerSecond,
    enrichment: {
      reason:
        'not estimable before the logs are read: it scales with unique transactions, ' +
        'and which fetch path is cheaper depends on transactions per block. Measured ' +
        'at roughly 142x the fetch cost on a real collection, so it dominates.',
      breakEvenTxsPerBlock: a.prices ? breakEvenTxsPerBlock(a.prices) : null,
      perTxCu: a.prices?.perTx ?? null,
      perBlockCu: a.prices?.perBlock ?? null,
    },
  };
}

/** Whole units, so "11.1 hours" rather than "40086 seconds". */
export function humanizeSeconds(seconds: number): string {
  if (!Number.isFinite(seconds)) return 'unknown';
  if (seconds < 90) return `${seconds.toFixed(1)}s`;
  const minutes = seconds / 60;
  if (minutes < 90) return `${minutes.toFixed(1)} minutes`;
  const hours = minutes / 60;
  if (hours < 48) return `${hours.toFixed(1)} hours`;
  return `${(hours / 24).toFixed(1)} days`;
}

/** The dry-run report, as printed. */
export function formatEstimate(a: {
  estimate: BackfillEstimate;
  chainId: number;
  chainName: string;
  contract: string;
  standard: string;
  deployBlock: number;
  deployBlockSource: string;
  deployBlockValidated: boolean;
  level: string;
  safeHead: bigint;
  /** Printed beside the time, because a rate taken on trust deserves saying so. */
  requestsPerSecond: number;
  /** Whether the compute-unit prices the rate is derived from have been measured. */
  ratesVerified?: boolean;
  /** How the chunk size was established. See probeEffectiveChunk. */
  chunkNote?: string;
  chunkMeasured?: boolean;
}): string {
  const e = a.estimate;
  const lines = [
    '',
    `dry run — nothing was indexed and nothing was written.`,
    '',
    `  collection        ${a.contract}`,
    `  chain             ${a.chainId} (${a.chainName})`,
    `  standard          ERC-${a.standard}`,
    `  deploy block      ${a.deployBlock}  (${a.deployBlockSource}` +
      `${a.deployBlockValidated ? ', validated' : ', NOT validated against the chain'})`,
    `  safe head         ${a.safeHead}  (head minus this chain's confirmations)`,
    `  enrichment level  ${a.level}`,
    '',
    `  blocks to index   ${e.fromBlock} to ${e.toBlock}  (${e.blocks} blocks)`,
    `  chunk size        ${e.chunkBlocks} blocks` +
      (a.chunkMeasured === false ? '  (NOT VERIFIED)' : '  (measured against the endpoint)'),
    ...(a.chunkNote ? [`                    ${a.chunkNote}`] : []),
    `  getLogs calls     ${e.logsCalls.toLocaleString()}`,
    `  estimated time    ${humanizeSeconds(e.logsSeconds)}  for log fetching alone`,
    `                    at ${a.requestsPerSecond.toFixed(1)} getLogs/s, derived from the`,
    '                    compute-unit ceiling rather than from a flat configured rate',
    ...(a.ratesVerified === false
      ? ['                    (the CU prices behind it come from the published table and',
         '                     are NOT yet confirmed against a dashboard reading)']
      : []),
  ];

  if (e.logsCu !== null) {
    lines.push(`  getLogs cost      ${e.logsCu.toLocaleString()} CU`);
  } else {
    lines.push(
      '  getLogs cost      not computed — no compute-unit prices are configured,',
      '                    and a guessed price would make this look cheaper than it is',
    );
  }

  lines.push(
    '',
    '  enrichment        NOT included in the figures above.',
    `                    ${e.enrichment.reason}`,
  );
  if (e.enrichment.perTxCu !== null && e.enrichment.perBlockCu !== null) {
    lines.push(
      `                    ${e.enrichment.perTxCu} CU per transaction, ` +
      `${e.enrichment.perBlockCu} CU per block,`,
      `                    break-even at ${e.enrichment.breakEvenTxsPerBlock?.toFixed(2)} ` +
      'transactions per block',
    );
  }
  lines.push('', '  rerun without --dry-run to index.', '');
  return lines.join('\n');
}
