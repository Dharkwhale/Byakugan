import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { backfill, type BackfillPorts, type BackfillOptions } from '../../src/indexer/backfill.js';
import { makeLogsSource } from '../../src/indexer/transferSource.js';
import { upgradeEnrichment } from '../../src/indexer/upgrade.js';
import type { FetchCosts } from '../../src/chain/fetchStrategy.js';
import type { TxSource } from '../../src/chain/tx.js';
import { INTERFACE_IDS } from '../../src/chain/standard.js';
import { manualClock } from '../../src/clock.js';
import { openDb } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { TRANSFER_TOPICS, type RawLog } from '../../src/indexer/decode.js';
import { getEnrichmentLevel } from '../../src/db/repositories/enrichment.js';
import { firstMinters } from '../../src/db/repositories/analytics.js';
import {
  CollectionLockedError, DeployBlockUnavailableError, EnrichmentLevelError,
  UnsupportedStandardError,
} from '../../src/errors.js';
import { ZERO_ADDRESS, type Address, type Hash } from '../../src/types.js';

const CONTRACT = '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d' as Address;
const MINTER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address;
const DEPLOY_BLOCK = 1;
const COSTS: FetchCosts = { perBlock: 20, perTx: 15 };

/** 32-byte left-padded hex, as a topic. */
const topic = (value: string): Hash =>
  `0x${value.replace(/^0x/, '').padStart(64, '0')}` as Hash;

/**
 * One ERC-721 mint log. All three parameters are indexed, so `data` is empty and
 * every value lives in the topics — built here rather than hand-authored as a hex
 * blob, so there are no offsets to get wrong.
 */
function mintLog(a: { block: number; tokenId: number; logIndex?: number }): RawLog {
  return {
    topics: [
      TRANSFER_TOPICS['721'][0]!,
      topic(ZERO_ADDRESS),
      topic(MINTER),
      topic(a.tokenId.toString(16)),
    ],
    data: '0x',
    transactionHash: `0x${a.tokenId.toString(16).padStart(64, '0')}` as Hash,
    blockNumber: BigInt(a.block),
    logIndex: a.logIndex ?? 0,
  };
}

/**
 * EIGHT logs spread across FOUR chunks of ten blocks.
 *
 * Spread deliberately: with every fixture inside the first chunk, a fault injected
 * after chunk 0 fires once everything is already committed, and a resume test then
 * asserts the final state while proving nothing about resumption. That failure is
 * recorded in CLAUDE.md as this test's specific risk, so the fixtures are laid out
 * to make it impossible — each chunk carries rows, and a fault in chunk 1 leaves
 * rows from chunk 0 only.
 */
const FIXTURE_BLOCKS = [3, 7, 12, 18, 22, 27, 33, 34];
const TOTAL_ROWS = FIXTURE_BLOCKS.length;
const TARGET_BLOCK = 35n;
/** Chunks are [1,10] [11,20] [21,30] [31,35] at initialChunk = maxChunk = 10. */
const FIRST_CHUNK_END = 10;
const ROWS_IN_FIRST_CHUNK = 2;

function allLogs(): RawLog[] {
  return FIXTURE_BLOCKS.map((block, i) => mintLog({ block, tokenId: i + 1 }));
}

function makePorts(over: Partial<BackfillPorts> = {}) {
  const fetchLogs = vi.fn(async (r: { fromBlock: bigint; toBlock: bigint }) =>
    allLogs().filter((l) => l.blockNumber >= r.fromBlock && l.blockNumber <= r.toBlock));
  const getTransaction = vi.fn(async (_h: Hash) => ({ from: MINTER, value: 0n }));
  const getBlockWithTransactions = vi.fn(async (blockNumber: bigint) =>
    allLogs()
      .filter((l) => l.blockNumber === blockNumber)
      .map((l) => ({ hash: l.transactionHash, from: MINTER, value: 0n })));
  const txSource: TxSource = { getTransaction, getBlockWithTransactions };
  const makeTransferSource = (standard: '721' | '1155') => makeLogsSource({
    fetchLogs, standard, initialChunk: 10, maxChunk: 10,
  });
  const supports = vi.fn(async (id: `0x${string}`) => id === INTERFACE_IDS.erc721);
  const resolveDeployBlock = vi.fn(async () => ({
    block: DEPLOY_BLOCK, source: 'binary_search' as const, validated: true,
  }));
  const safeHead = vi.fn(async () => 100n);
  const ports: BackfillPorts = {
    makeTransferSource, txSource, supports, resolveDeployBlock, safeHead, ...over,
  };
  return { ports, fetchLogs, getTransaction, getBlockWithTransactions, supports,
           resolveDeployBlock, safeHead };
}

function options(over: Partial<BackfillOptions> = {}): BackfillOptions {
  return {
    chainId: 1, contract: CONTRACT, level: 'full',
    toBlock: TARGET_BLOCK, costs: COSTS, staleLockMs: 60_000, ...over,
  };
}

let db: Database.Database;
const clock = manualClock(1_000);
beforeEach(() => {
  db = openDb(':memory:');
  runMigrations(db);
});

const rowCount = (): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM transfers').get() as { n: number }).n;
const watermark = (): number | null =>
  (db.prepare('SELECT last_indexed_block AS b FROM collections').get() as
    { b: number | null } | undefined)?.b ?? null;
const lockHolder = (): string | null =>
  (db.prepare('SELECT locked_by AS l FROM collections').get() as
    { l: string | null } | undefined)?.l ?? null;

describe('the happy path', () => {
  it('bootstraps, indexes every chunk and lands the watermark on the bound', async () => {
    const { ports } = makePorts();
    const result = await backfill(db, { clock, jobId: 'job-1', ports, options: options() });
    expect(result.status).toBe('indexed');
    if (result.status !== 'indexed') return;
    expect(result.standard).toBe('721');
    expect(result.chunks).toBe(4);
    expect(result.rowsInserted).toBe(TOTAL_ROWS);
    expect(result.lastIndexedBlock).toBe(Number(TARGET_BLOCK));
    expect(rowCount()).toBe(TOTAL_ROWS);
    expect(watermark()).toBe(Number(TARGET_BLOCK));
  });

  it('releases the lock', async () => {
    const { ports } = makePorts();
    await backfill(db, { clock, jobId: 'job-1', ports, options: options() });
    expect(lockHolder()).toBeNull();
  });

  it('records the requested level as part of bootstrap', async () => {
    const { ports } = makePorts();
    await backfill(db, {
      clock, jobId: 'job-1', ports, options: options({ level: 'mints_only' }),
    });
    expect(getEnrichmentLevel(db, 1, CONTRACT)).toBe('mints_only');
  });

  it('clamps the bound to safeHead, never indexing to the head', async () => {
    const { ports } = makePorts({ safeHead: async () => 15n });
    const result = await backfill(db, {
      clock, jobId: 'job-1', ports, options: options({ toBlock: 1_000n }),
    });
    if (result.status !== 'indexed') throw new Error('expected indexed');
    expect(result.toBlock).toBe(15);
    expect(watermark()).toBe(15);
  });
});

describe('requirement 1: the watermark never leads the data', () => {
  it('rolls the insert back with the watermark when the chunk fails between them', async () => {
    // The fault fires INSIDE the per-chunk transaction, after the insert and before
    // the watermark advance — the one window in which a partial write is even
    // expressible. Chunk 0 must commit whole; chunk 1 must leave nothing at all.
    const { ports } = makePorts();
    await expect(backfill(db, {
      clock, jobId: 'job-1', ports,
      options: options({
        faults: {
          beforeWatermark: (ctx) => {
            if (ctx.chunkIndex === 1) throw new Error('injected mid-chunk fault');
          },
        },
      }),
    })).rejects.toThrow('injected mid-chunk fault');

    // Chunk 0's rows AND watermark are both there; chunk 1's are both absent.
    expect(rowCount()).toBe(ROWS_IN_FIRST_CHUNK);
    expect(watermark()).toBe(FIRST_CHUNK_END);
  });

  it('never leaves rows beyond the watermark', async () => {
    const { ports } = makePorts();
    await backfill(db, {
      clock, jobId: 'job-1', ports,
      options: options({
        faults: {
          beforeWatermark: (ctx) => {
            if (ctx.chunkIndex === 2) throw new Error('boom');
          },
        },
      }),
    }).catch(() => undefined);

    const beyond = db.prepare(
      'SELECT COUNT(*) AS n FROM transfers WHERE block_number > ?',
    ).get(watermark()) as { n: number };
    // A row past the watermark is permanent loss: a rerun starts after the gap.
    expect(beyond.n).toBe(0);
  });

  it('writes nothing at all when ENRICHMENT fails, before any transaction opens', async () => {
    const { ports } = makePorts({
      txSource: {
        getTransaction: async () => { throw new Error('rpc exploded'); },
        getBlockWithTransactions: async () => { throw new Error('rpc exploded'); },
      },
    });
    await expect(backfill(db, { clock, jobId: 'job-1', ports, options: options() }))
      .rejects.toThrow('rpc exploded');
    expect(rowCount()).toBe(0);
    expect(watermark()).toBe(DEPLOY_BLOCK - 1);
  });

  it('releases the lock even when a chunk throws', async () => {
    const { ports } = makePorts();
    await backfill(db, {
      clock, jobId: 'job-1', ports,
      options: options({ faults: { beforeWatermark: () => { throw new Error('x'); } } }),
    }).catch(() => undefined);
    expect(lockHolder()).toBeNull();
  });
});

describe('requirement 2: resumption proves partial state', () => {
  it('leaves state STRICTLY partial after the fault', async () => {
    const { ports } = makePorts();
    await backfill(db, {
      clock, jobId: 'job-1', ports,
      options: options({
        faults: {
          beforeWatermark: (ctx) => {
            if (ctx.chunkIndex === 2) throw new Error('fault in chunk 2');
          },
        },
      }),
    }).catch(() => undefined);

    // Strictly between nothing and everything. Both bounds matter: zero would mean
    // the fault fired before any work and resumption is untested, and TOTAL_ROWS
    // would mean it fired after all of it and resumption is equally untested.
    const partial = rowCount();
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(TOTAL_ROWS);
    expect(partial).toBe(4); // chunks 0 and 1: blocks 3, 7, 12, 18

    // The watermark sits on a CHUNK BOUNDARY, below the target.
    const mark = watermark();
    expect(mark).toBe(20);
    expect(mark).toBeLessThan(Number(TARGET_BLOCK));
    expect((mark! - FIRST_CHUNK_END) % 10).toBe(0);
  });

  it('resumes from the watermark, refetching nothing below it', async () => {
    const { ports } = makePorts();
    const faults = {
      beforeWatermark: (ctx: { chunkIndex: number }) => {
        if (ctx.chunkIndex === 2) throw new Error('fault');
      },
    };
    await backfill(db, { clock, jobId: 'job-1', ports, options: options({ faults }) })
      .catch(() => undefined);
    expect(watermark()).toBe(20);

    const { ports: ports2, fetchLogs } = makePorts();
    const result = await backfill(db, {
      clock, jobId: 'job-2', ports: ports2, options: options(),
    });
    if (result.status !== 'indexed') throw new Error('expected indexed');

    // Resumed from 21, not from the deploy block.
    expect(result.fromBlock).toBe(21);
    for (const callArgs of fetchLogs.mock.calls) {
      expect(callArgs[0].fromBlock).toBeGreaterThan(20n);
    }
    expect(rowCount()).toBe(TOTAL_ROWS);
    expect(watermark()).toBe(Number(TARGET_BLOCK));
  });

  it('spreads its fixtures across at least three chunks', async () => {
    // Guards the fixture itself. If a future edit collapsed the blocks into one
    // chunk, every test above would still pass while proving nothing, which is
    // exactly the failure mode CLAUDE.md flags for this test.
    const { ports } = makePorts();
    const seen: number[] = [];
    await backfill(db, {
      clock, jobId: 'job-1', ports,
      options: options({ onProgress: (ctx) => seen.push(ctx.inserted) }),
    });
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(seen.filter((n) => n > 0).length).toBeGreaterThanOrEqual(3);
  });
});

describe('requirement 3: the level cannot change under a resume', () => {
  async function indexAt(level: 'logs_only' | 'mints_only' | 'full', toBlock = 20n) {
    const { ports } = makePorts();
    await backfill(db, {
      clock, jobId: 'job-1', ports, options: options({ level, toBlock }),
    });
  }

  it('refuses an UPGRADE on resume and names the explicit path', async () => {
    await indexAt('mints_only');
    const { ports } = makePorts();
    await expect(backfill(db, {
      clock, jobId: 'job-2', ports, options: options({ level: 'full' }),
    })).rejects.toThrow(EnrichmentLevelError);
  });

  it('refuses a DOWNGRADE on resume too', async () => {
    // The less obvious half: continuing a full index at mints_only writes
    // unclassified rows into later ranges while earlier ones are complete.
    await indexAt('full');
    const { ports } = makePorts();
    await expect(backfill(db, {
      clock, jobId: 'job-2', ports, options: options({ level: 'mints_only' }),
    })).rejects.toThrow(/two levels in different block ranges/);
  });

  it('refuses before fetching anything, so a refused run is free', async () => {
    await indexAt('mints_only');
    const { ports, fetchLogs, getTransaction } = makePorts();
    await backfill(db, {
      clock, jobId: 'job-2', ports, options: options({ level: 'full' }),
    }).catch(() => undefined);
    expect(fetchLogs).not.toHaveBeenCalled();
    expect(getTransaction).not.toHaveBeenCalled();
  });

  it('leaves no mixed-level index behind after the refusal', async () => {
    await indexAt('mints_only');
    const before = rowCount();
    const { ports } = makePorts();
    await backfill(db, {
      clock, jobId: 'job-2', ports, options: options({ level: 'full' }),
    }).catch(() => undefined);
    expect(rowCount()).toBe(before);
    expect(getEnrichmentLevel(db, 1, CONTRACT)).toBe('mints_only');
    expect(lockHolder()).toBeNull();
  });

  it('allows a resume at the SAME level', async () => {
    await indexAt('mints_only');
    const { ports } = makePorts();
    const result = await backfill(db, {
      clock, jobId: 'job-2', ports, options: options({ level: 'mints_only' }),
    });
    expect(result.status).toBe('indexed');
    expect(watermark()).toBe(Number(TARGET_BLOCK));
  });

  it('lets an explicit upgrade unblock the resume', async () => {
    await indexAt('mints_only');
    const { ports } = makePorts();
    const up = await upgradeEnrichment({
      db, chainId: 1, contract: CONTRACT, target: 'full',
      txSource: ports.txSource, costs: COSTS,
    });
    expect(up).toMatchObject({ from: 'mints_only', to: 'full' });
    expect(getEnrichmentLevel(db, 1, CONTRACT)).toBe('full');
    const result = await backfill(db, {
      clock, jobId: 'job-3', ports, options: options({ level: 'full' }),
    });
    expect(result.status).toBe('indexed');
  });

  it('refuses a downgrade through upgradeEnrichment as well', async () => {
    await indexAt('full');
    const { ports } = makePorts();
    await expect(upgradeEnrichment({
      db, chainId: 1, contract: CONTRACT, target: 'logs_only',
      txSource: ports.txSource, costs: COSTS,
    })).rejects.toThrow(/already holds more than/);
  });
});

describe('requirement 4: a failed bootstrap leaves nothing behind', () => {
  it('deletes the row it created when the standard is unsupported', async () => {
    const { ports } = makePorts({ supports: async () => false });
    await expect(backfill(db, { clock, jobId: 'job-1', ports, options: options() }))
      .rejects.toThrow(UnsupportedStandardError);
    expect(db.prepare('SELECT COUNT(*) AS n FROM collections').get()).toEqual({ n: 0 });
  });

  it('deletes the row it created when the deploy block cannot be resolved', async () => {
    const { ports } = makePorts({
      resolveDeployBlock: async () => {
        throw new DeployBlockUnavailableError('no archive data for this range');
      },
    });
    await expect(backfill(db, { clock, jobId: 'job-1', ports, options: options() }))
      .rejects.toThrow(DeployBlockUnavailableError);
    expect(db.prepare('SELECT COUNT(*) AS n FROM collections').get()).toEqual({ n: 0 });
  });

  it('releases the lock on a failed bootstrap', async () => {
    const { ports } = makePorts({ supports: async () => false });
    await backfill(db, { clock, jobId: 'job-1', ports, options: options() })
      .catch(() => undefined);
    expect(lockHolder()).toBeNull();
  });

  it('never deletes a row another job has already bootstrapped', async () => {
    // The guard is `standard IS NULL AND locked_by = jobId`. A row belonging to a
    // job that succeeded must survive a different job's failed bootstrap.
    const { ports } = makePorts();
    await backfill(db, { clock, jobId: 'job-1', ports, options: options() });
    expect(db.prepare('SELECT COUNT(*) AS n FROM collections').get()).toEqual({ n: 1 });

    const { ports: bad } = makePorts({ supports: async () => false });
    await backfill(db, { clock, jobId: 'job-2', ports: bad, options: options() })
      .catch(() => undefined);
    // Still there: it has a standard, so deleteUnbootstrapped cannot touch it.
    expect(db.prepare('SELECT COUNT(*) AS n FROM collections').get()).toEqual({ n: 1 });
  });

  it('leaves a bootstrapped collection readable, not a claimed-but-empty ghost', async () => {
    const { ports } = makePorts({ supports: async () => false });
    await backfill(db, { clock, jobId: 'job-1', ports, options: options() })
      .catch(() => undefined);
    // An undeleted standard-IS-NULL row would be invisible to getCollection and
    // would sit forever looking claimed while indexing nothing.
    const { ports: good } = makePorts();
    const result = await backfill(db, { clock, jobId: 'job-2', ports: good, options: options() });
    expect(result.status).toBe('indexed');
  });
});

describe('the bound, and a request below the watermark', () => {
  it('is a no-op that says so rather than rewinding', async () => {
    const { ports } = makePorts();
    await backfill(db, { clock, jobId: 'job-1', ports, options: options() });
    expect(watermark()).toBe(35);

    const { ports: p2, fetchLogs } = makePorts();
    const result = await backfill(db, {
      clock, jobId: 'job-2', ports: p2, options: options({ toBlock: 20n }),
    });
    expect(result.status).toBe('up_to_date');
    if (result.status !== 'up_to_date') return;
    expect(result.reason).toMatch(/NOT moved backwards/);
    expect(watermark()).toBe(35);
    expect(fetchLogs).not.toHaveBeenCalled();
  });

  it('resumes past a previous bound when the next run is unbounded', async () => {
    const { ports } = makePorts();
    await backfill(db, {
      clock, jobId: 'job-1', ports, options: options({ toBlock: 20n }),
    });
    expect(watermark()).toBe(20);

    const { ports: p2 } = makePorts({ safeHead: async () => 40n });
    const result = await backfill(db, {
      clock, jobId: 'job-2', ports: p2, options: options({ toBlock: undefined }),
    });
    if (result.status !== 'indexed') throw new Error('expected indexed');
    expect(result.fromBlock).toBe(21);
    expect(result.toBlock).toBe(40);
    expect(rowCount()).toBe(TOTAL_ROWS);
  });
});

describe('locking', () => {
  it('refuses to run while another job holds a fresh lock', async () => {
    const { ports } = makePorts();
    db.prepare(
      'INSERT INTO collections (chain_id, contract, locked_by, locked_at) VALUES (1, ?, ?, ?)',
    ).run(CONTRACT, 'other-job', clock.now());
    await expect(backfill(db, { clock, jobId: 'job-1', ports, options: options() }))
      .rejects.toThrow(CollectionLockedError);
  });
});

describe('the level actually changes what is fetched', () => {
  it('fetches no transactions at logs_only, and firstMinters then refuses', async () => {
    const { ports, getTransaction, getBlockWithTransactions } = makePorts();
    await backfill(db, {
      clock, jobId: 'job-1', ports, options: options({ level: 'logs_only' }),
    });
    expect(getTransaction).not.toHaveBeenCalled();
    expect(getBlockWithTransactions).not.toHaveBeenCalled();
    expect(rowCount()).toBe(TOTAL_ROWS);
    expect(() => firstMinters(db, { chainId: 1, contract: CONTRACT, limit: 5 }))
      .toThrow(EnrichmentLevelError);
  });

  it('fetches mint transactions at mints_only, and firstMinters then answers', async () => {
    const { ports, getTransaction } = makePorts();
    await backfill(db, {
      clock, jobId: 'job-1', ports, options: options({ level: 'mints_only' }),
    });
    expect(getTransaction).toHaveBeenCalled();
    const rows = firstMinters(db, { chainId: 1, contract: CONTRACT, limit: 5 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.minter).toBe(MINTER);
    expect(rows[0]?.minted).toBe(TOTAL_ROWS);
  });
});
