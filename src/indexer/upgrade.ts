import type Database from 'better-sqlite3';
import type { FetchCosts } from '../chain/fetchStrategy.js';
import { enrichTxs, type TxSource } from '../chain/tx.js';
import {
  applyEnrichment, findTxHashesNeedingEnrichment, getEnrichmentLevel, setEnrichmentLevel,
} from '../db/repositories/enrichment.js';
import { EnrichmentLevelError } from '../errors.js';
import type { EnrichmentLevel } from '../types.js';

/** Levels ordered by how much they fetch. Only upward moves are possible. */
const RANK: Record<EnrichmentLevel, number> = {
  logs_only: 0,
  mints_only: 1,
  full: 2,
};

export interface UpgradeResult {
  from: EnrichmentLevel;
  to: EnrichmentLevel;
  /** Distinct transactions fetched. Zero when nothing was missing. */
  fetched: number;
  rowsUpdated: number;
}

/**
 * Moves a collection's WHOLE indexed range up to a higher enrichment level.
 *
 * This is the explicit step `backfill` refuses in favour of. It exists so that
 * refusal points somewhere real rather than simply blocking: the cost of upgrading a
 * long history is exactly the thing the caller should be choosing deliberately, and
 * this is where they choose it.
 *
 * WHOLE RANGE, not the tail. Enriching only from the watermark onward would produce
 * the two-levels-in-one-collection state the refusal exists to prevent.
 *
 * ONLY THE MISSING TRANSACTIONS ARE FETCHED, read off disk by `tx_hash` rather than
 * re-derived from the chain's logs. That is what makes the staircase affordable and
 * why every level below `full` stores all its rows instead of just the mints.
 *
 * DOWNGRADES ARE REFUSED rather than performed. There is nothing to do — the data is
 * already on disk and deleting it to satisfy a label would be pure loss — but
 * silently relabelling a `full` index as `mints_only` would be a lie about it, and
 * `firstMinters` and `overlap` read the rows, so the label would disagree with what
 * they are able to answer.
 *
 * The level is recorded LAST, after the enrichment it claims has actually landed. If
 * the fetch fails partway, the level still reads as the old one and the gates still
 * refuse what they should — a resumed upgrade simply finds fewer transactions
 * missing.
 */
export async function upgradeEnrichment(a: {
  db: Database.Database;
  chainId: number;
  contract: string;
  target: EnrichmentLevel;
  txSource: TxSource;
  costs: FetchCosts | null;
}): Promise<UpgradeResult> {
  const contract = a.contract.toLowerCase();
  const current = getEnrichmentLevel(a.db, a.chainId, contract);
  if (current === null) {
    throw new EnrichmentLevelError(
      `${contract} on chain ${a.chainId} is not indexed, so there is nothing to ` +
      'upgrade. Run a backfill at the level you want instead.',
    );
  }

  if (RANK[a.target] < RANK[current]) {
    throw new EnrichmentLevelError(
      `${contract} on chain ${a.chainId} is indexed at '${current}', which already ` +
      `holds more than '${a.target}'. Downgrading would either discard data or ` +
      'relabel the index as carrying less than it does, and the query gates read the ' +
      'rows rather than the label, so the label would simply be wrong.',
    );
  }

  if (a.target === current) {
    return { from: current, to: a.target, fetched: 0, rowsUpdated: 0 };
  }

  const needed = findTxHashesNeedingEnrichment(a.db, a.chainId, contract, a.target)
    .map((row) => ({
      txHash: row.txHash as `0x${string}`,
      blockNumber: BigInt(row.blockNumber),
    }));

  const txs = await enrichTxs({ source: a.txSource, needed, costs: a.costs });
  const rowsUpdated = applyEnrichment(a.db, { chainId: a.chainId, txs });

  // Last, so a failed fetch leaves the old level standing and the gates correct.
  setEnrichmentLevel(a.db, { chainId: a.chainId, contract, level: a.target });
  return { from: current, to: a.target, fetched: txs.size, rowsUpdated };
}
