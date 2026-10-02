import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { handleIndex, nextCommand } from '../../src/bot/commands/index.js';
import { createJobRegistry } from '../../src/bot/jobs.js';
import { manualClock } from '../../src/clock.js';
import { openDb } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  DeployBlockUnavailableError, EnrichmentLevelError, UsageError,
} from '../../src/errors.js';
import type { Replier } from '../../src/bot/replier.js';

const ADDR = '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d';
const SUMMARY = 'DRY RUN REPORT: 4200 blocks, 12 chunks, about 30s';
const flush = () => new Promise<void>((r) => setImmediate(r));

let db: Database.Database;
beforeEach(() => { db = openDb(':memory:'); runMigrations(db); });

const indexedResult = {
  status: 'indexed' as const, source: 'getAssetTransfers' as const, standard: '721' as const,
  deployBlock: 1, fromBlock: 1, toBlock: 100, chunks: 1, rowsInserted: 5,
  lastIndexedBlock: 100,
};

function deps(over: Record<string, unknown> = {}, editImpl?: (id: number, t: string) => Promise<void>) {
  const sent: string[] = [];
  const edits: string[] = [];
  const replier = {
    reply: vi.fn(async (t: string) => { sent.push(t); return { messageId: 1 }; }),
    edit: vi.fn(editImpl ?? (async (_id: number, t: string) => { edits.push(t); })),
    sendDocument: vi.fn(),
  } as unknown as Replier;
  const clock = manualClock(0);
  return {
    sent, edits, replier, clock,
    base: {
      replier, db, clock,
      registry: createJobRegistry({ clock, staleMs: 900_000 }),
      defaultChainId: 1,
      chainConfig: { name: 'ethereum' },
      runBackfill: vi.fn(async (_a: unknown) => indexedResult),
      estimate: vi.fn(async (_a: unknown) => ({ seconds: 30, summary: SUMMARY })),
      confirmThresholdSeconds: 300,
      fetchPath: 'getAssetTransfers',
      ...over,
    },
  };
}

describe('nextCommand', () => {
  it('offers a re-index for an enrichment-level refusal', () => {
    expect(nextCommand(new EnrichmentLevelError('x'), { contract: ADDR, chainId: 8453 }))
      .toBe(`/index ${ADDR} --chain 8453`);
  });

  it('offers a deploy-block override when the block cannot be resolved', () => {
    expect(nextCommand(new DeployBlockUnavailableError('x'), { contract: ADDR, chainId: 1 }))
      .toContain('--deploy-block');
  });

  it('offers /help for a usage error', () => {
    expect(nextCommand(new UsageError('x'), { contract: ADDR, chainId: 1 })).toBe('/help');
  });

  it('is undefined when no command would help', () => {
    expect(nextCommand(new Error('internal'), { contract: ADDR, chainId: 1 })).toBeUndefined();
  });
});

describe('handleIndex', () => {
  it('replies immediately and runs the job detached', async () => {
    const { base, sent, replier } = deps();
    await handleIndex({ ...base, text: `/index ${ADDR}` });
    expect(replier.reply).toHaveBeenCalledOnce();
    expect(sent[0]).toContain('level full');
    expect(base.registry.inspect(db, { chainId: 1, contract: ADDR }))
      .toMatchObject({ kind: 'running', source: 'getAssetTransfers' });
    await flush();
    expect(base.runBackfill).toHaveBeenCalledOnce();
  });

  it('STATES the level used, so a later refusal is traceable', async () => {
    const { base, sent } = deps();
    await handleIndex({ ...base, text: `/index ${ADDR} --mints-only` });
    expect(sent[0]).toContain('mints_only');
  });

  it('asks for confirmation when the estimate exceeds the threshold', async () => {
    const { base, sent } = deps({ estimate: vi.fn(async () => ({ seconds: 7_200, summary: SUMMARY })) });
    await handleIndex({ ...base, text: `/index ${ADDR}` });
    expect(sent[0]).toMatch(/2\.0 hours/);
    expect(sent[0]).toContain('--yes');
    await flush();
    expect(base.runBackfill).not.toHaveBeenCalled();
  });

  it('runs without asking when --yes is given', async () => {
    const { base } = deps({ estimate: vi.fn(async () => ({ seconds: 7_200, summary: SUMMARY })) });
    await handleIndex({ ...base, text: `/index ${ADDR} --yes` });
    await flush();
    expect(base.runBackfill).toHaveBeenCalledOnce();
  });

  it('reports a RUNNING job with its elapsed time', async () => {
    const { base, sent, clock } = deps({
      runBackfill: vi.fn(() => new Promise(() => undefined)),
    });
    await handleIndex({ ...base, text: `/index ${ADDR}` });
    clock.advance(180_000);
    await handleIndex({ ...base, text: `/index ${ADDR}` });
    expect(sent.at(-1)).toMatch(/already indexing/i);
    expect(sent.at(-1)).toContain('3 minutes');
  });

  it('reports an ORPHANED lock differently, with when it expires', async () => {
    // The distinction matters: "running" means wait for it; "orphaned" means it clears
    // itself. Reporting both as "already indexing" would leave the user waiting for a job
    // that does not exist.
    const { base, sent } = deps();
    db.prepare('INSERT INTO collections (chain_id, contract, standard, locked_by, locked_at) VALUES (1, ?, ?, ?, ?)')
      .run(ADDR, '721', 'dead-job', 0);
    await handleIndex({ ...base, text: `/index ${ADDR}` });
    expect(sent.at(-1)).toMatch(/previous run/i);
    expect(sent.at(-1)).toMatch(/15 minutes/);
    expect(base.runBackfill).not.toHaveBeenCalled();
  });

  it('reports a usage error without starting anything', async () => {
    const { base, sent } = deps();
    await handleIndex({ ...base, text: '/index' });
    expect(sent[0]).toMatch(/Send an address/);
    expect(base.runBackfill).not.toHaveBeenCalled();
  });

  it('edits the message with the failure when the job throws', async () => {
    const { base, edits } = deps({
      runBackfill: vi.fn(async () => { throw new EnrichmentLevelError('indexed at mints_only'); }),
    });
    await handleIndex({ ...base, text: `/index ${ADDR}` });
    await flush();
    await flush();
    expect(edits.at(-1)).toContain('Enrichment level');
    expect(edits.at(-1)).toContain(`/index ${ADDR}`);
    expect(base.registry.size()).toBe(0);
  });
});

describe('handleIndex --dry-run', () => {
  it('replies with the estimate summary and starts nothing', async () => {
    const { base, sent, replier } = deps();
    await handleIndex({ ...base, text: `/index ${ADDR} --dry-run` });
    await flush();
    expect(sent).toEqual([SUMMARY]);
    expect(replier.edit).not.toHaveBeenCalled();
    expect(base.runBackfill).not.toHaveBeenCalled();
    expect(base.registry.size()).toBe(0);
  });

  it('shows the summary, not the confirmation prompt, when the estimate is long', async () => {
    // Without this, a dry run on a big collection would ask the user to confirm a run
    // they explicitly declined to make.
    const { base, sent } = deps({ estimate: vi.fn(async () => ({ seconds: 7_200, summary: SUMMARY })) });
    await handleIndex({ ...base, text: `/index ${ADDR} --dry-run` });
    expect(sent).toEqual([SUMMARY]);
    expect(base.runBackfill).not.toHaveBeenCalled();
  });

  it('does not index when --yes is given alongside', async () => {
    const { base, sent } = deps({ estimate: vi.fn(async () => ({ seconds: 7_200, summary: SUMMARY })) });
    await handleIndex({ ...base, text: `/index ${ADDR} --dry-run --yes` });
    await flush();
    expect(sent).toEqual([SUMMARY]);
    expect(base.runBackfill).not.toHaveBeenCalled();
    expect(base.registry.size()).toBe(0);
  });
});

describe('handleIndex --deploy-block', () => {
  it('forwards the override to runBackfill, and omits it when absent', async () => {
    const { base } = deps();
    await handleIndex({ ...base, text: `/index ${ADDR} --deploy-block 1234` });
    await flush();
    expect(base.runBackfill).toHaveBeenCalledWith(expect.objectContaining({ deployBlock: 1234 }));

    const other = deps();
    await handleIndex({ ...other.base, text: `/index ${ADDR}` });
    await flush();
    expect(other.base.runBackfill.mock.calls[0]?.[0]).not.toHaveProperty('deployBlock');
  });
});

describe('handleIndex detached-job rejections', () => {
  it('a progress edit that rejects neither fails the job nor leaves an unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.once('unhandledRejection', unhandled);
    try {
      const edits: string[] = [];
      let calls = 0;
      // Only the FIRST edit (the throttled progress tick) rejects; the result edit lands.
      const { base } = deps({
        runBackfill: vi.fn(async (a: { onProgress(c: { fromBlock: bigint; toBlock: bigint; inserted: number }): void }) => {
          a.onProgress({ fromBlock: 1n, toBlock: 10n, inserted: 1 });
          return indexedResult;
        }),
      }, async (_id, t) => {
        calls += 1;
        if (calls === 1) throw new Error('socket hang up');
        edits.push(t);
      });
      await handleIndex({ ...base, text: `/index ${ADDR}` });
      await flush();
      await flush();
      await flush();
      expect(calls).toBeGreaterThanOrEqual(2);
      expect(edits.at(-1)).toContain('Indexed');   // the job finished; it was not aborted
      expect(base.registry.size()).toBe(0);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('a failure report that rejects leaves no unhandled rejection and no registry entry', async () => {
    const unhandled = vi.fn();
    process.once('unhandledRejection', unhandled);
    try {
      const { base, replier } = deps({
        runBackfill: vi.fn(async () => { throw new Error('backfill exploded'); }),
      }, async () => { throw new Error('socket hang up'); });
      await handleIndex({ ...base, text: `/index ${ADDR}` });
      await flush();
      await flush();
      await flush();
      expect(replier.edit).toHaveBeenCalled();   // fail() really tried and really rejected
      expect(base.registry.size()).toBe(0);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

describe('handleIndex fix round 1', () => {
  it('replies with the next action when estimate rejects, and starts nothing', async () => {
    const { base, sent } = deps({
      estimate: vi.fn(async () => { throw new DeployBlockUnavailableError('cannot resolve deploy block'); }),
    });
    await handleIndex({ ...base, text: `/index ${ADDR}` });
    await flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('--deploy-block');
    expect(sent[0]).toContain(`/index ${ADDR} --chain 1`);
    expect(base.runBackfill).not.toHaveBeenCalled();
    expect(base.registry.size()).toBe(0);
  });

  it('starts over an orphaned lock that has ALREADY expired, so backfill can steal it', async () => {
    // The refusal is only right while the lock is live: only claimCollection (inside
    // backfill) steals a stale lock, so refusing an expired one wedges the collection.
    const { base, clock } = deps();
    db.prepare('INSERT INTO collections (chain_id, contract, standard, locked_by, locked_at) VALUES (1, ?, ?, ?, ?)')
      .run(ADDR, '721', 'dead-job', 0);
    clock.advance(900_001);
    await handleIndex({ ...base, text: `/index ${ADDR}` });
    await flush();
    expect(base.runBackfill).toHaveBeenCalledOnce();
  });

  it('still refuses an orphan one millisecond before it expires', async () => {
    const { base, sent, clock } = deps();
    db.prepare('INSERT INTO collections (chain_id, contract, standard, locked_by, locked_at) VALUES (1, ?, ?, ?, ?)')
      .run(ADDR, '721', 'dead-job', 0);
    clock.advance(899_999);
    await handleIndex({ ...base, text: `/index ${ADDR}` });
    expect(sent.at(-1)).toMatch(/previous run/i);
    expect(base.runBackfill).not.toHaveBeenCalled();
  });

  it('passes deployBlock to estimate as well as to runBackfill', async () => {
    const { base } = deps();
    await handleIndex({ ...base, text: `/index ${ADDR} --deploy-block 1234` });
    await flush();
    expect(base.estimate).toHaveBeenCalledWith(expect.objectContaining({ deployBlock: 1234 }));

    const other = deps();
    await handleIndex({ ...other.base, text: `/index ${ADDR}` });
    await flush();
    expect(other.base.estimate.mock.calls[0]?.[0]).not.toHaveProperty('deployBlock');
  });

  it('points a parse error at /help', async () => {
    const { base, sent } = deps();
    await handleIndex({ ...base, text: '/index' });
    expect(sent[0]).toContain('next: /help');
  });
});
