import type Database from 'better-sqlite3';
import { EnrichmentLevelError } from '../../errors.js';
// classify() is imported rather than reimplemented in SQL on purpose. The buy
// rule (`tx.value > 0 AND tx.from = to_addr`) is expressible as a SQL UPDATE,
// and that was the first shape this took — but it would be a SECOND
// implementation of the rule, free to drift from the one in classify.ts, and the
// two would disagree about exactly the case they exist to decide. One rule, one
// place, even at the cost of a row-by-row loop inside the transaction.
import { classify } from '../../indexer/classify.js';
import type { EnrichmentLevel, TxInfo } from '../../types.js';
import { chunked } from '../chunked.js';

/** What the collection was ASKED to produce. See `requireFullEnrichment` for why this is not the gate. */
export function getEnrichmentLevel(
  db: Database.Database,
  chainId: number,
  contract: string,
): EnrichmentLevel | null {
  const row = db
    .prepare('SELECT enrichment_level FROM collections WHERE chain_id = ? AND contract = ?')
    .get(chainId, contract) as { enrichment_level: EnrichmentLevel } | undefined;
  return row?.enrichment_level ?? null;
}

export function setEnrichmentLevel(
  db: Database.Database,
  a: { chainId: number; contract: string; level: EnrichmentLevel },
): void {
  db.prepare(`
    UPDATE collections SET enrichment_level = @level
     WHERE chain_id = @chainId AND contract = @contract
  `).run(a);
}

/** How many rows still have no classification, because their transaction was never fetched. */
export function countUnclassified(
  db: Database.Database,
  chainId: number,
  contract: string,
): number {
  const row = db
    .prepare(`
      SELECT COUNT(*) AS n FROM transfers
       WHERE chain_id = ? AND contract = ? AND kind = 'unclassified'
    `)
    .get(chainId, contract) as { n: number };
  return row.n;
}

/**
 * Refuses to let a query that needs `buy` data run against an index that cannot
 * supply it.
 *
 * WHY THIS DERIVES THE ANSWER FROM THE ROWS rather than reading
 * `collections.enrichment_level`: the column is a claim about the data, the rows
 * are the data. If the column ever said 'full' while unclassified rows remained
 * — an interrupted upgrade, a range extended at a different level, a bug — a
 * column check would wave the query through and `overlap` would return an
 * undercount indistinguishable from a real result. Deriving it cannot drift,
 * because there is nothing to drift from.
 *
 * It is also more precise than the column in the honest direction: a
 * `mints_only` collection whose every transfer happens to be a mint or a burn
 * has nothing unclassified, so its `overlap` answer IS complete, and this
 * correctly permits it rather than demanding a pointless re-index.
 *
 * THROWS rather than returning partial results. An undercount here is not a
 * degraded answer, it is a wrong one wearing the shape of a right one: a wallet
 * that bought seven of fifteen collections scores zero, and nothing in the
 * output says why.
 */
export function requireFullEnrichment(
  db: Database.Database,
  a: { chainId: number; contracts: string[]; queryName: string },
): void {
  const offenders: Array<{ contract: string; unclassified: number }> = [];
  for (const group of chunked(a.contracts)) {
    const placeholders = group.map(() => '?').join(',');
    const rows = db
      .prepare(`
        SELECT contract, COUNT(*) AS n FROM transfers
         WHERE chain_id = ? AND kind = 'unclassified' AND contract IN (${placeholders})
         GROUP BY contract
      `)
      .all(a.chainId, ...group) as Array<{ contract: string; n: number }>;
    for (const row of rows) offenders.push({ contract: row.contract, unclassified: row.n });
  }
  if (offenders.length === 0) return;

  const detail = offenders
    .map((o) => {
      const level = getEnrichmentLevel(db, a.chainId, o.contract) ?? 'unknown';
      return `  ${o.contract}  (indexed ${level}, ${o.unclassified} unclassified transfers)`;
    })
    .join('\n');

  throw new EnrichmentLevelError(
    `${a.queryName} needs fully enriched data, but ${offenders.length} of ` +
    `${a.contracts.length} requested collection(s) on chain ${a.chainId} still ` +
    `hold transfers whose transaction was never fetched:\n${detail}\n\n` +
    'Without the transaction, a buy cannot be told from a plain transfer, so ' +
    `${a.queryName} would silently undercount rather than fail — a wallet that ` +
    'bought most of these collections could score zero. Re-index the ' +
    'collections above at full enrichment; the upgrade fetches only the missing ' +
    'transactions, not the logs again.',
  );
}

/**
 * Refuses a query that needs the ACTING wallet against an index that never
 * fetched it.
 *
 * `firstMinters` reports `tx_from` — who sent the mint — alongside the recipient,
 * because that is how one wallet minting to many fresh addresses is told apart
 * from many wallets each minting once. On a `logs_only` index `tx_from` is NULL
 * on every mint, so the query could only report recipients, and the bot pattern
 * it exists to surface would read as unrelated collectors. That is a wrong answer
 * of the same kind as an undercounted `overlap`, so it gets the same treatment: a
 * throw naming the fix, not a partial result.
 *
 * Derived from the rows, like `requireFullEnrichment` and for the same reasons —
 * and precise in the honest direction: a collection with no mints, or one whose
 * mints were all enriched, has nothing missing and is allowed through whatever
 * `enrichment_level` claims.
 */
export function requireMintEnrichment(
  db: Database.Database,
  a: { chainId: number; contract: string; queryName: string },
): void {
  const row = db
    .prepare(`
      SELECT COUNT(*) AS n FROM transfers
       WHERE chain_id = ? AND contract = ? AND kind = 'mint' AND tx_from IS NULL
    `)
    .get(a.chainId, a.contract) as { n: number };
  if (row.n === 0) return;

  const level = getEnrichmentLevel(db, a.chainId, a.contract) ?? 'unknown';
  throw new EnrichmentLevelError(
    `${a.queryName} needs the minting wallet, but ${row.n} mint(s) of ` +
    `${a.contract} on chain ${a.chainId} were indexed without their transaction ` +
    `(level '${level}'). tx_from is NULL on those rows, so only the RECIPIENT of ` +
    'each mint is known, not the wallet that sent it — one wallet minting to many ' +
    'fresh addresses would be reported as many unrelated minters. Re-index this ' +
    "collection at 'mints_only' or 'full'; the upgrade fetches only the missing " +
    'transactions, not the logs again.',
  );
}

/**
 * The transaction hashes an upgrade to `target` still has to fetch.
 *
 * Keyed on `tx_from IS NULL`, NOT on `kind = 'unclassified'`. The two differ and
 * both are right for their own job: the `overlap` gate cares only about rows
 * whose KIND is unknown, while enrichment completeness means a row carries its
 * transaction at all — including mints, whose kind was already decidable from the
 * log but whose `tx_from` (the acting wallet) and `tx_value_wei` (the mint price)
 * are the reason to fetch them. Keying on `kind` here would leave a 'full' index
 * full of NULL minters.
 *
 * Narrowed by `target` so each upgrade fetches only what that level owes:
 * `'mints_only'` collects mint rows alone, `'full'` collects everything still
 * missing, and `'logs_only'` owes nothing. This is what makes logs_only ->
 * mints_only -> full a staircase rather than three separate backfills.
 *
 * Reads hashes off disk rather than re-scanning the chain's logs, which is the
 * whole reason every level below 'full' stores all rows and not just the mints.
 */
export function findTxHashesNeedingEnrichment(
  db: Database.Database,
  chainId: number,
  contract: string,
  target: EnrichmentLevel,
): Array<{ txHash: string; blockNumber: number }> {
  if (target === 'logs_only') return [];
  const onlyMints = target === 'mints_only' ? "AND kind = 'mint'" : '';
  return db
    .prepare(`
      SELECT tx_hash AS txHash, MIN(block_number) AS blockNumber
        FROM transfers
       WHERE chain_id = ? AND contract = ? AND tx_from IS NULL ${onlyMints}
       GROUP BY tx_hash
       ORDER BY blockNumber, tx_hash
    `)
    .all(chainId, contract) as Array<{ txHash: string; blockNumber: number }>;
}

/**
 * Writes fetched transactions onto the rows waiting for them and reclassifies
 * each one.
 *
 * Only touches rows where `tx_from IS NULL`, so it is idempotent and a resumed
 * upgrade repeats no work. A hash absent from `txs` is left untouched rather
 * than guessed at — a partial fetch leaves a partial index that the gate still
 * correctly refuses, instead of a complete-looking one that is wrong.
 *
 * ARGUED, NOT TESTED — the `AND tx_from IS NULL` on the UPDATE below. Idempotency
 * is really enforced by the SELECT, which never hands an already-enriched row to
 * the UPDATE, so removing the UPDATE's copy of the condition passes the whole
 * suite: it was mutation-tested and the mutant SURVIVED (88 passed, 0 failed).
 * It is kept as a statement of the invariant at the point of the write, and it
 * would matter if two processes ever selected the same rows and then both wrote.
 * No single-process test can produce that interleaving — better-sqlite3 is
 * synchronous and this all runs inside one transaction — which is the same
 * limitation recorded for the stale-lock racing test in CLAUDE.md. Treated as
 * defence in depth, not as a tested guarantee.
 *
 * One statement, one transaction: an upgrade that committed half a chunk under a
 * flipped `enrichment_level` would leave the column claiming 'full' over rows
 * that are not.
 *
 * A transaction fetched for a mint also enriches any OTHER row sharing that
 * transaction, because the data is already in hand — free, and strictly better
 * than discarding it. So a `mints_only` run can leave fewer unclassified rows than
 * its level implies. That is not a discrepancy to correct: the gates read the rows,
 * so the extra classifications simply count, and a collection whose sales all
 * shared a transaction with a mint is genuinely complete.
 *
 * @returns how many rows were updated.
 */
export function applyEnrichment(
  db: Database.Database,
  a: { chainId: number; txs: Map<string, TxInfo> },
): number {
  if (a.txs.size === 0) return 0;
  const hashes = [...a.txs.keys()];
  const update = db.prepare(`
    UPDATE transfers
       SET tx_from = @txFrom, tx_value_wei = @txValueWei, kind = @kind
     WHERE chain_id = @chainId AND tx_hash = @txHash
       AND log_index = @logIndex AND batch_index = @batchIndex
       AND tx_from IS NULL
  `);

  return db.transaction(() => {
    let updated = 0;
    for (const group of chunked(hashes)) {
      const placeholders = group.map(() => '?').join(',');
      const rows = db
        .prepare(`
          SELECT tx_hash, log_index, batch_index, from_addr, to_addr
            FROM transfers
           WHERE chain_id = ? AND tx_from IS NULL AND tx_hash IN (${placeholders})
        `)
        .all(a.chainId, ...group) as Array<{
          tx_hash: string; log_index: number; batch_index: number;
          from_addr: string; to_addr: string;
        }>;
      for (const row of rows) {
        const tx = a.txs.get(row.tx_hash);
        if (!tx) continue;
        const kind = classify(
          { from: row.from_addr as `0x${string}`, to: row.to_addr as `0x${string}` },
          tx,
        );
        updated += update.run({
          chainId: a.chainId,
          txHash: row.tx_hash,
          logIndex: row.log_index,
          batchIndex: row.batch_index,
          txFrom: tx.from,
          txValueWei: tx.value.toString(),
          kind,
        }).changes;
      }
    }
    return updated;
  })();
}
