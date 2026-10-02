import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import {
  handleIndex as handleIndexWithPrepare, nextCommand, type HandleIndexDeps, type IndexRun,
} from '../../src/bot/commands/index.js';
import { createJobRegistry } from '../../src/bot/jobs.js';
import { manualClock } from '../../src/clock.js';
import { openDb } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  DeployBlockUnavailableError, EnrichmentLevelError, UsageError,
} from '../../src/errors.js';
import type { Replier } from '../../src/bot/replier.js';
import { createLogger } from '../../src/logger.js';
import { Writable } from 'node:stream';

const ADDR = '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d';
const SUMMARY = 'DRY RUN REPORT: 4200 blocks, 12 chunks, about 30s';
const flush = () => new Promise<void>((r) => setImmediate(r));

/**
 * The handler takes ONE `prepare` (the label, estimate and run come from a single build),
 * but most of these tests are about what the handler does with an estimate or a run. This
 * adapter lets each test keep supplying them separately: it builds the `IndexRun` from the
 * three loose fields, so `prepare` is still the only path the handler can take them by.
 * The one test that is about `prepare` itself (the label) lives in botIndexRun.test.ts.
 */
type LooseDeps = Omit<HandleIndexDeps, 'prepare'> & Pick<IndexRun, 'fetchPath' | 'estimate' | 'runBackfill'>;
function handleIndex(d: LooseDeps): Promise<void> {
  const { fetchPath, estimate, runBackfill, ...rest } = d;
  return handleIndexWithPrepare({
    ...rest,
    prepare: async () => ({ fetchPath, estimate, runBackfill }),
  });
}

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
  // A REAL logger over a capturing stream, so a test reads what would have been written
  // (scrubbed, serialized) rather than that a mock was called.
  const logs: Array<{ level: number; msg: string; err?: { message?: string } }> = [];
  const logger = createLogger([], new Writable({
    write(chunk, _enc, cb) {
      for (const l of String(chunk).split('\n')) if (l) logs.push(JSON.parse(l));
      cb();
    },
  }));
  return {
    sent, edits, replier, clock, logs,
    base: {
      replier, db, clock, logger,
      registry: createJobRegistry({ clock, staleMs: 900_000 }),
      defaultChainId: 1,
      chainName: (id: number) => (id === 8453 ? 'base' : 'ethereum'),
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

  it('names the chain it PARSED, not the default chain', async () => {
    const { base, sent } = deps();
    await handleIndex({ ...base, text: `/index ${ADDR} --chain 8453` });
    expect(sent[0]).toContain('on chain 8453 (base)');
    expect(sent[0]).not.toContain('ethereum');
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

  it('still refuses an orphan at EXACTLY its expiry, where the claim would also refuse', async () => {
    // The boundary is pinned rather than chosen, because the two predicates have to agree.
    // claimCollection steals on `locked_at < now - staleMs` — strict — so at now == expiresAt
    // it would refuse, and falling through here would start a job that cannot claim the lock.
    const { base, sent, clock } = deps();
    db.prepare('INSERT INTO collections (chain_id, contract, standard, locked_by, locked_at) VALUES (1, ?, ?, ?, ?)')
      .run(ADDR, '721', 'dead-job', 0);
    clock.advance(900_000);
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

describe('handleIndex atomic claim', () => {
  /**
   * An `estimate` that resolves only when the test says so, one gate per call. This is what
   * pins the interleaving: both handlers pass `inspect` (the map is empty), both park here,
   * and only then are they let through. The interleaving comes from an `await` in OUR OWN
   * code, which is why a single-process test can really produce it — unlike CLAUDE.md's
   * stale-lock race, where the interleaving needed two processes writing after both had read.
   * This proves the property for one process's handlers only; it says nothing about two
   * processes, which the database lock is for.
   */
  function gatedEstimate() {
    const gates: Array<() => void> = [];
    const estimate = vi.fn(() => new Promise<{ seconds: number; summary: string }>((resolve) => {
      gates.push(() => resolve({ seconds: 30, summary: SUMMARY }));
    }));
    return { estimate, openAll: () => gates.forEach((g) => g()), parked: () => gates.length };
  }

  it('lets exactly one of two racing /index for the same collection start', async () => {
    const gate = gatedEstimate();
    // Never resolves: the winner must still be running when the loser claims, or the
    // loser could win a freed slot and the test would prove nothing about the race.
    const { base, sent } = deps({
      estimate: gate.estimate,
      runBackfill: vi.fn(() => new Promise(() => undefined)),
    });
    const first = handleIndex({ ...base, text: `/index ${ADDR}` });
    const second = handleIndex({ ...base, text: `/index ${ADDR}` });
    await flush();
    expect(gate.parked()).toBe(2);              // both passed inspect and are parked on estimate
    expect(base.registry.size()).toBe(0);       // and neither has claimed yet
    gate.openAll();
    await Promise.all([first, second]);
    await flush();

    expect(base.runBackfill).toHaveBeenCalledOnce();
    expect(sent.filter((t) => t.includes('progress follows in this message'))).toHaveLength(1);
    const loser = sent.filter((t) => !t.includes('progress follows in this message'));
    expect(loser).toHaveLength(1);
    expect(loser[0]).toContain(`Already indexing ${ADDR} on chain 1.`);
    expect(base.registry.size()).toBe(1);
  });

  it('does not let a dry run or an unconfirmed run claim the slot', async () => {
    const dry = deps();
    await handleIndex({ ...dry.base, text: `/index ${ADDR} --dry-run` });
    expect(dry.base.registry.size()).toBe(0);

    const gated = deps({ estimate: vi.fn(async () => ({ seconds: 7_200, summary: SUMMARY })) });
    await handleIndex({ ...gated.base, text: `/index ${ADDR}` });
    expect(gated.base.registry.size()).toBe(0);
  });

  it('releases the claim when the reply fails, so the collection is not wedged', async () => {
    const { base, replier } = deps();
    (replier.reply as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('chat not found'));
    await expect(handleIndex({ ...base, text: `/index ${ADDR}` })).rejects.toThrow('chat not found');
    expect(base.registry.size()).toBe(0);
    expect(base.runBackfill).not.toHaveBeenCalled();

    // And it is genuinely free, not merely uncounted: the next /index starts.
    await handleIndex({ ...base, text: `/index ${ADDR}` });
    await flush();
    expect(base.runBackfill).toHaveBeenCalledOnce();
  });
});

describe('handleIndex progress-edit failures never abort the backfill', () => {
  /** A backfill that reports N chunks, each past the throttle, and records that it finished. */
  function ticking(clock: { advance(ms: number): void }, ticks: number) {
    const state = { completed: false };
    const runBackfill = vi.fn(async (a: { onProgress(c: { fromBlock: bigint; toBlock: bigint; inserted: number }): void }) => {
      for (let i = 1; i <= ticks; i++) {
        a.onProgress({ fromBlock: BigInt(i), toBlock: BigInt(i + 9), inserted: 1 });
        clock.advance(5_000);   // past the 4s interval: only the reporter's own state can stop a tick
        await flush();
      }
      state.completed = true;
      return indexedResult;
    });
    return { runBackfill, state };
  }

  it('on a 403 on every edit: the job completes, ONE edit is attempted, and it is logged', async () => {
    const calls: string[] = [];
    const { clock, base, logs } = deps({}, async (_id, t) => {
      calls.push(t);
      throw Object.assign(new Error('Forbidden: bot was blocked by the user'), {
        error_code: 403, description: 'Forbidden: bot was blocked by the user',
      });
    });
    const { runBackfill, state } = ticking(clock, 6);
    await handleIndex({ ...base, runBackfill, text: `/index ${ADDR}` });
    for (let i = 0; i < 10; i++) await flush();

    expect(state.completed).toBe(true);                 // ran to the end, past the first failure
    expect(base.registry.size()).toBe(0);               // and finished cleanly
    expect(calls).toHaveLength(1);                      // one attempt, not one per tick (6 + final)
    const quiet = logs.filter((l) => l.msg.includes('can no longer be delivered'));
    expect(quiet).toHaveLength(1);
    expect(quiet[0]?.err?.message).toContain('Forbidden: bot was blocked by the user');
    expect(logs.some((l) => l.msg.includes('could not deliver the job failure report'))).toBe(false);
  });

  it('a SUCCEEDED job whose result message cannot be delivered is not logged as a failure', async () => {
    // The two are different events and must not share a log line. `finish` rejects after
    // the rows are committed and the watermark advanced, so routing it to `onError` would
    // report a failure for a collection that is fully indexed — and an operator reading
    // logs would go hunting for something that never happened.
    let call = 0;
    const { clock, base, logs } = deps({}, async () => {
      call += 1;
      // Every progress tick lands; only the FINAL edit fails, and transiently, so the
      // reporter never goes quiet and the job itself never fails.
      if (call > 1) throw new Error('socket hang up');
    });
    const { runBackfill, state } = ticking(clock, 2);
    await handleIndex({ ...base, runBackfill, text: `/index ${ADDR}` });
    for (let i = 0; i < 10; i++) await flush();

    expect(state.completed).toBe(true);
    expect(base.registry.size()).toBe(0);
    const delivered = logs.filter((l) => l.msg.includes('COMPLETED but its result message'));
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.err?.message).toContain('socket hang up');
    // The job did NOT fail, so neither failure line may appear.
    expect(logs.some((l) => l.msg.includes('could not deliver the job failure report')))
      .toBe(false);
  });

  it('on a TRANSIENT failure: keeps trying each tick, and logs each failed tick', async () => {
    const calls: string[] = [];
    const { clock, base, logs } = deps({}, async (_id, t) => {
      calls.push(t);
      if (t.startsWith('Indexed')) return;    // the final result lands
      throw new Error('socket hang up');
    });
    const { runBackfill, state } = ticking(clock, 4);
    await handleIndex({ ...base, runBackfill, text: `/index ${ADDR}` });
    for (let i = 0; i < 10; i++) await flush();

    expect(state.completed).toBe(true);
    expect(calls.filter((t) => t.includes('blocks'))).toHaveLength(4);   // every tick tried
    expect(calls.at(-1)).toContain('Indexed');
    const failed = logs.filter((l) => l.msg.includes('progress edit failed'));
    expect(failed).toHaveLength(4);
    expect(failed[0]?.err?.message).toBe('socket hang up');
    expect(base.registry.size()).toBe(0);
  });

  it('logs a failure report that could not be delivered, rather than swallowing it silently', async () => {
    const { base, logs } = deps({
      runBackfill: vi.fn(async () => { throw new Error('backfill exploded'); }),
    }, async () => { throw new Error('socket hang up'); });
    await handleIndex({ ...base, text: `/index ${ADDR}` });
    for (let i = 0; i < 5; i++) await flush();
    const lost = logs.filter((l) => l.msg.includes('could not deliver the job failure report'));
    expect(lost).toHaveLength(1);
    expect(lost[0]?.err?.message).toBe('socket hang up');
  });
});
