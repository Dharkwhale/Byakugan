import type Database from 'better-sqlite3';
import type { Clock } from '../clock.js';
import type { FetchCosts } from '../chain/fetchStrategy.js';
import type { SupportsInterface } from '../chain/standard.js';
import { detectStandard } from '../chain/standard.js';
import { enrichTxs, selectNeeded, type TxSource } from '../chain/tx.js';
import {
  advanceWatermark, claimCollection, deleteUnbootstrapped, finishBootstrap,
  getCollection, releaseCollection,
} from '../db/repositories/collections.js';
import { getEnrichmentLevel, setEnrichmentLevel } from '../db/repositories/enrichment.js';
import { findKnownTxs, insertTransfers } from '../db/repositories/transfers.js';
import { CollectionLockedError, EnrichmentLevelError } from '../errors.js';
import { classify } from './classify.js';
import { decodeLogs } from './decode.js';
import { iterateLogs, type LogFetcher } from './logs.js';
import type {
  Address, DeployBlockSource, EnrichmentLevel, Standard, TransferRow,
} from '../types.js';

/**
 * Everything the orchestrator needs from the outside world, injected so the whole
 * backfill is testable without a chain — and so the anvil end-to-end test drives the
 * SAME code path as production rather than a parallel one.
 */
export interface BackfillPorts {
  fetchLogs: LogFetcher;
  txSource: TxSource;
  supports: SupportsInterface;
  /** Already wired with its own chain dependencies; called only during bootstrap. */
  resolveDeployBlock(a: { safeHead: bigint }): Promise<{
    block: number; source: DeployBlockSource; validated: boolean;
  }>;
  /** head - confirmations[chainId]. Never the head itself. */
  safeHead(): Promise<bigint>;
}

/**
 * TEST-ONLY fault injection.
 *
 * Specified deliberately instead of killing a process: a resume test needs the fault
 * to land at a known point, and `SIGKILL` lands wherever it lands. `beforeWatermark`
 * fires INSIDE the per-chunk transaction, between the insert and the watermark
 * advance, which is the one window where a partial write would be possible if the two
 * were not atomic — so it is the only place a fault can prove they are.
 */
export interface BackfillFaults {
  beforeWatermark?(ctx: ChunkContext & { inserted: number }): void;
  afterChunk?(ctx: ChunkContext & { inserted: number }): void | Promise<void>;
}

export interface ChunkContext {
  chunkIndex: number;
  fromBlock: bigint;
  toBlock: bigint;
}

export interface BackfillOptions {
  chainId: number;
  contract: Address;
  level: EnrichmentLevel;
  /** Clamped to safeHead. Absent means "as far as is safe". */
  toBlock?: bigint;
  initialChunk: number;
  maxChunk: number;
  /** Null when compute-unit prices are unmeasured; see enrichTxs. */
  costs: FetchCosts | null;
  staleLockMs: number;
  faults?: BackfillFaults;
  onProgress?(ctx: ChunkContext & { inserted: number }): void;
}

export type BackfillResult =
  | {
      status: 'indexed';
      standard: Standard;
      deployBlock: number;
      fromBlock: number;
      toBlock: number;
      chunks: number;
      rowsInserted: number;
      lastIndexedBlock: number;
    }
  | {
      status: 'up_to_date';
      standard: Standard;
      lastIndexedBlock: number;
      /** The bound that was asked for, after clamping. */
      requestedToBlock: number;
      reason: string;
    };

/**
 * Indexes one collection from its deploy block (or its watermark) up to a bound.
 *
 * FOUR PROPERTIES THIS IS BUILT AROUND, each with its own test:
 *
 * 1. THE WATERMARK NEVER LEADS THE DATA. Rows and the watermark advance in ONE
 *    transaction per chunk, so a failure anywhere leaves both untouched. Enrichment
 *    happens BEFORE that transaction opens — deliberately, because it is async and a
 *    better-sqlite3 transaction is synchronous, so there is no way to await inside
 *    one. That ordering is the mechanism: if enrichment throws, no write has been
 *    attempted at all. A watermark ahead of its rows would be permanent data loss —
 *    a rerun starts after the gap and never looks back.
 *
 * 2. RESUMPTION IS FROM THE WATERMARK, so a partial run continues rather than
 *    restarting, and inserts are idempotent anyway if a chunk is replayed.
 *
 * 3. THE LEVEL CANNOT CHANGE UNDER A RESUME. A request whose level differs from what
 *    the collection was indexed at is REFUSED, both upward and downward, and told to
 *    use `upgradeEnrichment`. Upgrading implicitly could mean tens of thousands of
 *    extra fetches on a collection whose level was chosen precisely to avoid them —
 *    a surprise with a real bill. Refusing in both directions is also the only rule
 *    that cannot leave one index holding two levels in different block ranges, which
 *    no query could then interpret.
 *
 * 4. A FAILED BOOTSTRAP LEAVES NOTHING BEHIND. The row a claim created is deleted,
 *    guarded on `standard IS NULL` so a racing job's real row is never touched, and
 *    the lock is released in a `finally` whatever happened.
 *
 * The bound is CLAMPED to `safeHead()`, never the chain head, so confirmations are
 * respected even if a caller asks for more. A bound below the current watermark is a
 * no-op that says so: rewinding would delete nothing but would re-fetch ground
 * already held, and silently moving the watermark backwards would invite a later run
 * to believe a gap had been filled.
 */
export async function backfill(
  db: Database.Database,
  a: { clock: Clock; jobId: string; ports: BackfillPorts; options: BackfillOptions },
): Promise<BackfillResult> {
  const { options: o, ports, clock, jobId } = a;
  const contract = o.contract.toLowerCase() as Address;

  if (!claimCollection(db, {
    chainId: o.chainId, contract, jobId, clock, staleMs: o.staleLockMs,
  })) {
    throw new CollectionLockedError(
      `${contract} on chain ${o.chainId} is locked by another job and its lock is not ` +
      `yet stale (${o.staleLockMs}ms). Wait, or let the stale timeout expire.`,
    );
  }

  try {
    const existing = getCollection(db, o.chainId, contract);
    let standard: Standard;
    let deployBlock: number;

    if (existing.state === 'not_indexed') {
      ({ standard, deployBlock } = await bootstrap(db, {
        chainId: o.chainId, contract, jobId, level: o.level, ports,
      }));
    } else {
      standard = existing.standard;
      deployBlock = existing.deployBlock;
      // Property 3. Checked before a single log is fetched, so a refused run costs
      // nothing.
      requireLevelUnchanged(db, { chainId: o.chainId, contract, requested: o.level });
    }

    const safeHead = await ports.safeHead();
    const bound = o.toBlock === undefined ? safeHead
      : o.toBlock < safeHead ? o.toBlock : safeHead;

    const watermark = getCollection(db, o.chainId, contract);
    const lastIndexed = watermark.state === 'indexed'
      ? watermark.lastIndexedBlock
      : deployBlock - 1;
    const fromBlock = BigInt(lastIndexed + 1);

    if (fromBlock > bound) {
      return {
        status: 'up_to_date',
        standard,
        lastIndexedBlock: lastIndexed,
        requestedToBlock: Number(bound),
        reason:
          `already indexed to block ${lastIndexed}, which is at or past the requested ` +
          `bound ${bound}. Nothing was fetched and the watermark was NOT moved ` +
          'backwards — rewinding it would invite a later run to treat re-fetched ' +
          'ground as a filled gap.',
      };
    }

    let chunks = 0;
    let rowsInserted = 0;
    let reached = lastIndexed;

    for await (const chunk of iterateLogs({
      fetch: ports.fetchLogs,
      fromBlock,
      toBlock: bound,
      initialChunk: o.initialChunk,
      maxChunk: o.maxChunk,
    })) {
      const ctx: ChunkContext = {
        chunkIndex: chunks, fromBlock: chunk.fromBlock, toBlock: chunk.toBlock,
      };

      // ---- async, BEFORE any write. A throw here leaves the database untouched.
      const decoded = decodeLogs(chunk.logs, standard);
      const needed = selectNeeded(decoded, o.level);
      const known = findKnownTxs(db, o.chainId, needed.map((n) => n.txHash));
      const txs = await enrichTxs({
        source: ports.txSource, needed, costs: o.costs, known,
      });

      const rows: TransferRow[] = decoded.map((d) => {
        // null when this level did not fetch it — classify then yields
        // 'unclassified' rather than guessing 'transfer'.
        const tx = txs.get(d.txHash) ?? null;
        return {
          chainId: o.chainId,
          contract,
          tokenId: d.tokenId.toString(),
          amount: d.amount.toString(),
          fromAddr: d.from,
          toAddr: d.to,
          txHash: d.txHash,
          blockNumber: Number(d.blockNumber),
          logIndex: d.logIndex,
          batchIndex: d.batchIndex,
          txFrom: tx?.from ?? null,
          txValueWei: tx === null ? null : tx.value.toString(),
          kind: classify({ from: d.from, to: d.to }, tx),
        };
      });

      // ---- sync and atomic. Property 1.
      const inserted = db.transaction(() => {
        const n = insertTransfers(db, rows);
        // TEST-ONLY. A throw here must roll the insert back with it.
        o.faults?.beforeWatermark?.({ ...ctx, inserted: n });
        advanceWatermark(db, {
          chainId: o.chainId, contract, jobId,
          toBlock: Number(chunk.toBlock), clock,
        });
        return n;
      })();

      chunks += 1;
      rowsInserted += inserted;
      reached = Number(chunk.toBlock);
      o.onProgress?.({ ...ctx, inserted });
      await o.faults?.afterChunk?.({ ...ctx, inserted });
    }

    return {
      status: 'indexed',
      standard,
      deployBlock,
      fromBlock: Number(fromBlock),
      toBlock: Number(bound),
      chunks,
      rowsInserted,
      lastIndexedBlock: reached,
    };
  } finally {
    // Property 4: released whatever happened, including a bootstrap that threw and
    // deleted its own row — releasing a row that no longer exists is a harmless
    // no-op, and not releasing would strand the collection for a full stale timeout.
    releaseCollection(db, { chainId: o.chainId, contract, jobId });
  }
}

/**
 * First sighting: detect the standard, resolve the deploy block, record both.
 *
 * Either step can fail legitimately — a contract that is neither 721 nor 1155, or a
 * provider that cannot serve the history needed to locate the deploy block. In both
 * cases the row created by the claim is DELETED before rethrowing, because a row with
 * `standard IS NULL` is invisible to `getCollection` and would sit there forever
 * looking like a claimed-but-empty collection, blocking nothing and indexing nothing.
 *
 * `deleteUnbootstrapped` is guarded on `standard IS NULL` AND `locked_by = jobId`, so
 * a retry racing a now-succeeding job cannot delete that job's real row.
 */
async function bootstrap(
  db: Database.Database,
  a: {
    chainId: number; contract: Address; jobId: string;
    level: EnrichmentLevel; ports: BackfillPorts;
  },
): Promise<{ standard: Standard; deployBlock: number }> {
  try {
    const standard = await detectStandard(a.ports.supports, a.contract);
    const safeHead = await a.ports.safeHead();
    const resolved = await a.ports.resolveDeployBlock({ safeHead });

    finishBootstrap(db, {
      chainId: a.chainId, contract: a.contract, standard,
      deployBlock: resolved.block, deployBlockSource: resolved.source,
      validated: resolved.validated, name: null,
    });
    // Recorded as part of bootstrap, so no collection ever exists without a level.
    setEnrichmentLevel(db, {
      chainId: a.chainId, contract: a.contract, level: a.level,
    });
    return { standard, deployBlock: resolved.block };
  } catch (err) {
    deleteUnbootstrapped(db, {
      chainId: a.chainId, contract: a.contract, jobId: a.jobId,
    });
    throw err;
  }
}

/**
 * Refuses a resume whose level differs from what the collection holds.
 *
 * Refuses DOWNWARD too, which is the less obvious half: continuing a `full` index at
 * `mints_only` writes unclassified rows into later block ranges while earlier ones are
 * complete, and the result is one collection holding two levels in different ranges.
 * Nothing can interpret that — `overlap`'s gate would refuse the whole collection on
 * account of the tail, and no query can say which ranges are trustworthy.
 */
function requireLevelUnchanged(
  db: Database.Database,
  a: { chainId: number; contract: string; requested: EnrichmentLevel },
): void {
  const current = getEnrichmentLevel(db, a.chainId, a.contract);
  if (current === null || current === a.requested) return;
  throw new EnrichmentLevelError(
    `${a.contract} on chain ${a.chainId} was indexed at enrichment level ` +
    `'${current}', and this run asked for '${a.requested}'. Continuing would leave ` +
    'one collection holding two levels in different block ranges, which no query ' +
    `can interpret. Run upgradeEnrichment to move the WHOLE range to ` +
    `'${a.requested}' first, then resume — it fetches only the transactions that are ` +
    'missing, not the logs again.',
  );
}
