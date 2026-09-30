import type Database from 'better-sqlite3';
import { ByakuganError } from '../../errors.js';
import { ZERO_ADDRESS } from '../../types.js';
import { chunked } from '../chunked.js';
import { requireFullEnrichment, requireMintEnrichment } from './enrichment.js';

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
  /** The wallet that SENT the mint transaction — the acting wallet. */
  minter: string;
  /** Who received this wallet's earliest mint. Equal to `minter` in the ordinary case. */
  firstRecipient: string;
  /** Distinct addresses this wallet minted to in this collection. */
  recipients: number;
  /** Token movements this wallet minted in this collection. */
  minted: number;
  /** True when any of them went somewhere other than the minter itself. */
  mintedToOthers: boolean;
  blockNumber: number;
  logIndex: number;
  batchIndex: number;
  tokenId: string;
}

/**
 * The wallets that minted earliest, one row per ACTING wallet, in chain order.
 *
 * GROUPED BY `tx_from`, NOT by recipient. The acting wallet is the unit the
 * product cares about: a bot minting 200 tokens to 200 fresh addresses is one
 * minter, and grouping by recipient would report it as 200 — filling a top-10
 * with a single actor and hiding the genuine minters behind it. `recipients`,
 * `minted` and `mintedToOthers` carry the pattern out to the caller instead of
 * discarding it, so mint-to-others is visible rather than merely not wrong.
 *
 * GATED by `requireMintEnrichment`. An earlier revision of this function had no
 * gate, on the reasoning that `mint` is decidable from the log alone and so a
 * zero-fetch index could answer it exactly. That was true of the CLASSIFICATION
 * and false of the query: with no transaction, `tx_from` is NULL on every mint,
 * there is no acting wallet to group by, and the answer collapses back to a list
 * of recipients — the exact failure above. Deciding `kind` is not the only thing
 * a transaction is needed for.
 *
 * The gate is also what makes `tx_from` safe to group by here: it guarantees no
 * mint row for this collection has a null one.
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
  requireMintEnrichment(db, {
    chainId: a.chainId,
    contract: a.contract,
    queryName: 'firstMinters',
  });

  const rows = db
    .prepare(`
      WITH mints AS (
        SELECT tx_from, to_addr, block_number, log_index, batch_index, token_id
          FROM transfers
         WHERE chain_id = @chainId AND contract = @contract AND kind = 'mint'
      ),
      firsts AS (
        SELECT *, ROW_NUMBER() OVER (
                    PARTITION BY tx_from ORDER BY block_number, log_index, batch_index
                  ) AS rn
          FROM mints
      ),
      totals AS (
        SELECT tx_from,
               COUNT(*) AS minted,
               COUNT(DISTINCT to_addr) AS recipients,
               MAX(CASE WHEN to_addr <> tx_from THEN 1 ELSE 0 END) AS toOthers
          FROM mints
         GROUP BY tx_from
      )
      SELECT f.tx_from AS minter, f.to_addr AS firstRecipient,
             f.block_number AS blockNumber, f.log_index AS logIndex,
             f.batch_index AS batchIndex, f.token_id AS tokenId,
             t.minted, t.recipients, t.toOthers
        FROM firsts f JOIN totals t ON t.tx_from = f.tx_from
       WHERE f.rn = 1
       ORDER BY f.block_number, f.log_index, f.batch_index
       LIMIT @limit
    `)
    .all(a) as Array<Omit<FirstMinter, 'mintedToOthers'> & { toOthers: number }>;

  return rows.map(({ toOthers, ...rest }) => ({ ...rest, mintedToOthers: toOthers === 1 }));
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
