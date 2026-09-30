import type Database from 'better-sqlite3';
import { ByakuganError } from '../../errors.js';
import { ZERO_ADDRESS } from '../../types.js';
import { chunked } from '../chunked.js';
import { requireFullEnrichment } from './enrichment.js';

/**
 * Query inputs are asserted lowercase rather than normalised, for the same
 * reason `classify` asserts its addresses: these arrive from Telegram command
 * arguments, where a pasted checksummed address is the normal case. Addresses are
 * stored lowercase, so a mixed-case argument compares equal to nothing and the
 * query returns a confident empty answer. Normalising here would work but would
 * hide that the command layer forgot to, leaving the next query to rediscover it.
 */
function assertLowercaseAddress(label: string, value: string): void {
  if (value !== value.toLowerCase()) {
    throw new ByakuganError(
      `${label} must be lowercase, received "${value}". Addresses are stored ` +
      'lowercase, so a checksummed argument would match no rows and return an ' +
      'empty result that looks like a real answer. Normalise at the command ' +
      'boundary.',
    );
  }
}

export interface FirstMinter {
  address: string;
  blockNumber: number;
  logIndex: number;
  batchIndex: number;
  tokenId: string;
}

/**
 * The wallets that minted earliest, one row per wallet, in chain order.
 *
 * NO ENRICHMENT GATE, deliberately — this is the query that makes `mints_only`
 * worth having. `mint` is `from == 0x0`, decidable from the log alone, so a
 * `mints_only` index answers this completely and exactly while having fetched no
 * transactions at all. The gate belongs on `overlap`, which needs `buy`.
 *
 * Ordered by (block_number, log_index, batch_index). `batch_index` is in the key
 * because an ERC-1155 `TransferBatch` is a single log: without it, mints inside
 * one batch have no defined order among themselves, and that is exactly the
 * dense mint window where ordering is being asked about.
 */
export function firstMinters(
  db: Database.Database,
  a: { chainId: number; contract: string; limit: number },
): FirstMinter[] {
  assertLowercaseAddress('contract', a.contract);
  return db
    .prepare(`
      SELECT to_addr AS address, block_number AS blockNumber,
             log_index AS logIndex, batch_index AS batchIndex, token_id AS tokenId
        FROM (
          SELECT to_addr, block_number, log_index, batch_index, token_id,
                 ROW_NUMBER() OVER (
                   PARTITION BY to_addr ORDER BY block_number, log_index, batch_index
                 ) AS rn
            FROM transfers
           WHERE chain_id = @chainId AND contract = @contract AND kind = 'mint'
        )
       WHERE rn = 1
       ORDER BY blockNumber, logIndex, batchIndex
       LIMIT @limit
    `)
    .all(a) as FirstMinter[];
}

export interface OverlapRow {
  address: string;
  collections: number;
}

/**
 * Wallets that ACQUIRED — minted or bought — across several of the given
 * collections, most overlapping first.
 *
 * REFUSES on an under-enriched index, via `requireFullEnrichment`, before
 * reading a single row. `buy` needs `tx.value` and `tx.from`, so on a
 * `mints_only` index every purchase sits `unclassified` and this query would
 * count mints only: a wallet that bought seven of fifteen collections comes back
 * as zero overlap. That is not a partial answer, it is a wrong one, and nothing
 * in the shape of the output distinguishes it from a real result — hence a throw
 * rather than a caveat.
 *
 * The zero address is excluded because a burn's `to_addr` is not an acquirer.
 */
export function overlap(
  db: Database.Database,
  a: { chainId: number; contracts: string[]; minCollections: number },
): OverlapRow[] {
  for (const contract of a.contracts) assertLowercaseAddress('contract', contract);
  requireFullEnrichment(db, {
    chainId: a.chainId,
    contracts: a.contracts,
    queryName: 'overlap',
  });

  // Counts are summed across chunks rather than merged: each chunk holds a
  // disjoint set of contracts, so a wallet's per-chunk DISTINCT contract counts
  // add up to its total without double counting. `minCollections` is therefore
  // applied here and not as a per-chunk HAVING, which would drop a wallet that
  // only reaches the threshold once its chunks are combined.
  const totals = new Map<string, number>();
  for (const group of chunked(a.contracts)) {
    const placeholders = group.map(() => '?').join(',');
    const rows = db
      .prepare(`
        SELECT to_addr, COUNT(DISTINCT contract) AS n
          FROM transfers
         WHERE chain_id = ?
           AND kind IN ('mint', 'buy')
           AND to_addr <> ?
           AND contract IN (${placeholders})
         GROUP BY to_addr
      `)
      .all(a.chainId, ZERO_ADDRESS, ...group) as Array<{ to_addr: string; n: number }>;
    for (const row of rows) {
      totals.set(row.to_addr, (totals.get(row.to_addr) ?? 0) + row.n);
    }
  }

  return [...totals]
    .filter(([, n]) => n >= a.minCollections)
    .map(([address, collections]) => ({ address, collections }))
    .sort((x, y) => y.collections - x.collections || x.address.localeCompare(y.address));
}
