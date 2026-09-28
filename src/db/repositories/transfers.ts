import type Database from 'better-sqlite3';
import type { Kind, TransferRow, TxInfo } from '../../types.js';
import { chunked } from '../chunked.js';

/**
 * `ON CONFLICT (pk) DO NOTHING` rather than `INSERT OR IGNORE`.
 *
 * Both make a replayed backfill free, but `OR IGNORE` suppresses EVERY
 * constraint class: a mixed-case address or an invalid `kind` would be dropped
 * silently, leaving the Task 3 CHECK constraints unable to report anything.
 * Targeting the primary key alone keeps idempotency and makes a malformed row
 * loud. A foreign-key violation throws under both.
 */
const INSERT_SQL = `
  INSERT INTO transfers
    (chain_id, contract, token_id, amount, from_addr, to_addr, tx_hash,
     block_number, log_index, batch_index, tx_from, tx_value_wei, kind)
  VALUES
    (@chainId, @contract, @tokenId, @amount, @fromAddr, @toAddr, @txHash,
     @blockNumber, @logIndex, @batchIndex, @txFrom, @txValueWei, @kind)
  ON CONFLICT (chain_id, tx_hash, log_index, batch_index) DO NOTHING
`;

/**
 * Inserts a batch in ONE transaction using ONE prepared statement.
 *
 * All-or-nothing matters beyond tidiness: Task 13 commits rows and the
 * watermark together, so a partially-inserted chunk under an advanced watermark
 * would mean permanently missing transfers that a rerun never re-fetches.
 * better-sqlite3 nests transactions via savepoints, so this composes inside
 * Task 13's outer transaction.
 *
 * @returns how many rows were actually inserted; duplicates count 0.
 */
export function insertTransfers(db: Database.Database, rows: TransferRow[]): number {
  if (rows.length === 0) return 0;
  const stmt = db.prepare(INSERT_SQL);
  return db.transaction(() => {
    let inserted = 0;
    for (const row of rows) {
      inserted += stmt.run(row).changes;
    }
    return inserted;
  })();
}

/**
 * Tx data already stored, so a resumed or overlapping backfill re-fetches
 * nothing. The `IN` list is chunked to stay under the bound-variable limit, and
 * the results are unioned into one Map — which also dedupes a hash that appears
 * in more than one chunk.
 */
export function findKnownTxs(
  db: Database.Database,
  chainId: number,
  hashes: string[],
): Map<string, TxInfo> {
  const out = new Map<string, TxInfo>();
  for (const group of chunked(hashes)) {
    const placeholders = group.map(() => '?').join(',');
    const rows = db
      .prepare(`
        SELECT tx_hash, tx_from, tx_value_wei
          FROM transfers
         WHERE chain_id = ? AND tx_hash IN (${placeholders})
      `)
      .all(chainId, ...group) as Array<{
        tx_hash: string; tx_from: string; tx_value_wei: string;
      }>;
    for (const row of rows) {
      out.set(row.tx_hash, {
        from: row.tx_from as TxInfo['from'],
        value: BigInt(row.tx_value_wei),
      });
    }
  }
  return out;
}

export function countByKind(
  db: Database.Database,
  chainId: number,
  contract: string,
): Record<Kind, number> {
  const counts: Record<Kind, number> = { mint: 0, buy: 0, transfer: 0, burn: 0 };
  const rows = db
    .prepare(`
      SELECT kind, COUNT(*) AS n FROM transfers
       WHERE chain_id = ? AND contract = ? GROUP BY kind
    `)
    .all(chainId, contract) as Array<{ kind: Kind; n: number }>;
  for (const row of rows) counts[row.kind] = row.n;
  return counts;
}
