import type Database from 'better-sqlite3';
import type { Clock } from '../../clock.js';
import type { DeployBlockSource, Standard } from '../../types.js';

export type CollectionState =
  | { state: 'not_indexed' }
  | {
      state: 'indexed';
      standard: Standard;
      deployBlock: number;
      lastIndexedBlock: number;
      name: string | null;
    };

/**
 * Claims a collection, creating the row if this is its first sighting.
 *
 * An UPDATE would be a no-op when no row exists yet, which would let two
 * concurrent first-runs both bootstrap and both binary-search the deploy
 * block. The upsert makes creation and claiming one atomic statement.
 *
 * @returns true when this job now holds the lock.
 */
export function claimCollection(
  db: Database.Database,
  a: { chainId: number; contract: string; jobId: string; clock: Clock; staleMs: number },
): boolean {
  // Both values come from ONE clock read, so the write and the cutoff cannot
  // disagree. Epoch ms INTEGER throughout — SQLite's datetime() is never used.
  const nowMs = a.clock.now();
  const staleCutoff = nowMs - a.staleMs;
  const result = db
    .prepare(`
      INSERT INTO collections (chain_id, contract, locked_by, locked_at)
      VALUES (@chainId, @contract, @jobId, @nowMs)
      ON CONFLICT (chain_id, contract) DO UPDATE
         SET locked_by = excluded.locked_by,
             locked_at = excluded.locked_at
       WHERE collections.locked_by IS NULL
          OR collections.locked_at < @staleCutoff
    `)
    .run({ chainId: a.chainId, contract: a.contract, jobId: a.jobId, nowMs, staleCutoff });
  return result.changes === 1;
}

export function releaseCollection(
  db: Database.Database,
  a: { chainId: number; contract: string; jobId: string },
): void {
  db.prepare(`
    UPDATE collections SET locked_by = NULL, locked_at = NULL
     WHERE chain_id = @chainId AND contract = @contract AND locked_by = @jobId
  `).run(a);
}

/**
 * Removes the row a failed bootstrap created.
 *
 * Both guards matter: `standard IS NULL` means a retry racing a now-succeeding
 * job can never delete a real collection, and `locked_by = @jobId` means a job
 * cannot delete a row another job owns.
 */
export function deleteUnbootstrapped(
  db: Database.Database,
  a: { chainId: number; contract: string; jobId: string },
): void {
  db.prepare(`
    DELETE FROM collections
     WHERE chain_id = @chainId AND contract = @contract
       AND standard IS NULL
       AND locked_by = @jobId
  `).run(a);
}

export function finishBootstrap(
  db: Database.Database,
  a: {
    chainId: number; contract: string; standard: Standard;
    deployBlock: number; deployBlockSource: DeployBlockSource; name: string | null;
  },
): void {
  db.prepare(`
    UPDATE collections
       SET standard = @standard,
           name = @name,
           deploy_block = @deployBlock,
           deploy_block_source = @deployBlockSource,
           last_indexed_block = COALESCE(last_indexed_block, @deployBlock - 1)
     WHERE chain_id = @chainId AND contract = @contract
  `).run(a);
}

/**
 * The only collection lookup. Returns a tagged union rather than a raw row so
 * callers cannot forget the `standard IS NOT NULL` filter — an unbootstrapped
 * row surfacing as "indexed" would produce silently empty results instead of
 * an error.
 */
export function getCollection(
  db: Database.Database,
  chainId: number,
  contract: string,
): CollectionState {
  const row = db
    .prepare(`
      SELECT standard, name, deploy_block, last_indexed_block
        FROM collections
       WHERE chain_id = ? AND contract = ? AND standard IS NOT NULL
    `)
    .get(chainId, contract) as
    | { standard: Standard; name: string | null; deploy_block: number; last_indexed_block: number }
    | undefined;

  if (!row) return { state: 'not_indexed' };
  return {
    state: 'indexed',
    standard: row.standard,
    deployBlock: row.deploy_block,
    lastIndexedBlock: row.last_indexed_block,
    name: row.name,
  };
}

export function advanceWatermark(
  db: Database.Database,
  a: { chainId: number; contract: string; jobId: string; toBlock: number; clock: Clock },
): void {
  const nowMs = a.clock.now();
  db.prepare(`
    UPDATE collections
       SET last_indexed_block = @toBlock,
           indexed_at = @nowMs,
           locked_at = @nowMs
     WHERE chain_id = @chainId AND contract = @contract AND locked_by = @jobId
  `).run({ chainId: a.chainId, contract: a.contract, jobId: a.jobId, toBlock: a.toBlock, nowMs });
}
