import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { createJobRegistry } from '../../src/bot/jobs.js';
import { inspectLock } from '../../src/db/repositories/collections.js';
import { manualClock } from '../../src/clock.js';
import { openDb } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';

const CONTRACT = '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d';
const STALE_MS = 900_000;

let db: Database.Database;
beforeEach(() => {
  db = openDb(':memory:');
  runMigrations(db);
  db.prepare('INSERT INTO collections (chain_id, contract, standard) VALUES (1, ?, ?)')
    .run(CONTRACT, '721');
});

const flush = () => new Promise<void>((r) => setImmediate(r));

describe('inspectLock', () => {
  it('is null when nothing holds the lock', () => {
    expect(inspectLock(db, 1, CONTRACT)).toBeNull();
  });

  it('reports the holder and when it was taken', () => {
    db.prepare('UPDATE collections SET locked_by = ?, locked_at = ? WHERE contract = ?')
      .run('job-7', 5_000, CONTRACT);
    expect(inspectLock(db, 1, CONTRACT)).toEqual({ lockedBy: 'job-7', lockedAt: 5_000 });
  });
});

describe('the three states', () => {
  it('is idle with no job and no lock', () => {
    const registry = createJobRegistry({ clock: manualClock(0), staleMs: STALE_MS });
    expect(registry.inspect(db, { chainId: 1, contract: CONTRACT }))
      .toEqual({ kind: 'idle' });
  });

  it('is running for a job in this process, and reports elapsed time', async () => {
    const clock = manualClock(1_000);
    const registry = createJobRegistry({ clock, staleMs: STALE_MS });
    let release: () => void = () => undefined;
    registry.start({
      chainId: 1, contract: CONTRACT, source: 'getAssetTransfers',
      run: () => new Promise<void>((r) => { release = r; }),
    });
    const state = registry.inspect(db, { chainId: 1, contract: CONTRACT });
    expect(state).toMatchObject({ kind: 'running', startedAt: 1_000, source: 'getAssetTransfers' });
    release();
    await flush();
  });

  it('is ORPHANED when the lock is held but no job is in the map', () => {
    // The state that only exists after a crash: the map is empty on restart while a stale
    // lock row survives until its timeout. Without this, /index reports "already
    // indexing" for a job that does not exist.
    const clock = manualClock(10_000);
    const registry = createJobRegistry({ clock, staleMs: STALE_MS });
    db.prepare('UPDATE collections SET locked_by = ?, locked_at = ? WHERE contract = ?')
      .run('job-from-a-dead-process', 4_000, CONTRACT);
    expect(registry.inspect(db, { chainId: 1, contract: CONTRACT })).toEqual({
      kind: 'orphaned',
      lockedBy: 'job-from-a-dead-process',
      lockedAt: 4_000,
      expiresAt: 4_000 + STALE_MS,
    });
  });

  it('prefers RUNNING when both the map and the lock are present', async () => {
    const registry = createJobRegistry({ clock: manualClock(2_000), staleMs: STALE_MS });
    db.prepare('UPDATE collections SET locked_by = ?, locked_at = ? WHERE contract = ?')
      .run('job-9', 1_000, CONTRACT);
    let release: () => void = () => undefined;
    registry.start({
      chainId: 1, contract: CONTRACT, source: 'getLogs',
      run: () => new Promise<void>((r) => { release = r; }),
    });
    expect(registry.inspect(db, { chainId: 1, contract: CONTRACT }).kind).toBe('running');
    release();
    await flush();
  });

  it('keys on chain AND contract, so the same address on two chains cannot collide', async () => {
    // The same contract address deployed on two chains is ordinary. A map keyed on the
    // address alone would let one job's progress and state overwrite the other's.
    db.prepare('INSERT INTO collections (chain_id, contract, standard) VALUES (8453, ?, ?)')
      .run(CONTRACT, '721');
    const registry = createJobRegistry({ clock: manualClock(0), staleMs: STALE_MS });
    let release: () => void = () => undefined;
    registry.start({
      chainId: 1, contract: CONTRACT, source: 'getLogs',
      run: () => new Promise<void>((r) => { release = r; }),
    });
    expect(registry.inspect(db, { chainId: 1, contract: CONTRACT }).kind).toBe('running');
    expect(registry.inspect(db, { chainId: 8453, contract: CONTRACT }).kind).toBe('idle');
    release();
    await flush();
  });
});

describe('the detached runner', () => {
  it('clears the map when the job succeeds', async () => {
    const registry = createJobRegistry({ clock: manualClock(0), staleMs: STALE_MS });
    registry.start({ chainId: 1, contract: CONTRACT, source: 'getLogs', run: async () => undefined });
    await flush();
    expect(registry.size()).toBe(0);
    expect(registry.inspect(db, { chainId: 1, contract: CONTRACT }).kind).toBe('idle');
  });

  it('clears the map when the job THROWS, and reports it', async () => {
    // The leak this prevents has no recovery. backfill releases the DB lock in its own
    // finally, so the lock is always correct — but the map has NO expiry, so a leaked
    // entry reports "already indexing" for the life of the process with nothing in the
    // database to show a problem. Strictly worse than the orphan case it impersonates.
    const onError = vi.fn();
    const registry = createJobRegistry({ clock: manualClock(0), staleMs: STALE_MS });
    registry.start({
      chainId: 1, contract: CONTRACT, source: 'getLogs',
      run: async () => { throw new Error('backfill exploded'); },
      onError,
    });
    await flush();
    expect(registry.size()).toBe(0);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'backfill exploded' }));
  });

  it('never produces an unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.once('unhandledRejection', unhandled);
    const registry = createJobRegistry({ clock: manualClock(0), staleMs: STALE_MS });
    registry.start({
      chainId: 1, contract: CONTRACT, source: 'getLogs',
      run: async () => { throw new Error('boom'); },
      onError: () => undefined,
    });
    await flush();
    await flush();
    expect(unhandled).not.toHaveBeenCalled();
    process.off('unhandledRejection', unhandled);
  });

  it('survives an onError that itself throws, for async and synchronous runners', async () => {
    // The inner catch around onError is part of "never rejects": without it the detached
    // IIFE rejects when a caller's reporter throws, and nothing awaits it.
    const unhandled = vi.fn();
    process.once('unhandledRejection', unhandled);
    const registry = createJobRegistry({ clock: manualClock(0), staleMs: STALE_MS });
    const onError = vi.fn(() => { throw new Error('reporter exploded'); });
    registry.start({
      chainId: 1, contract: CONTRACT, source: 'getLogs',
      run: async () => { throw new Error('async boom'); },
      onError,
    });
    // A non-async function throws before returning a promise; the IIFE must absorb it too.
    registry.start({
      chainId: 8453, contract: CONTRACT, source: 'getLogs',
      run: (() => { throw new Error('sync boom'); }) as () => Promise<void>,
      onError,
    });
    await flush();
    await flush();
    expect(onError).toHaveBeenCalledTimes(2);
    expect(registry.size()).toBe(0);
    expect(unhandled).not.toHaveBeenCalled();
    process.off('unhandledRejection', unhandled);
  });

  it('refuses to start a second job for the same collection', () => {
    const registry = createJobRegistry({ clock: manualClock(0), staleMs: STALE_MS });
    registry.start({
      chainId: 1, contract: CONTRACT, source: 'getLogs',
      run: () => new Promise<void>(() => undefined),
    });
    expect(() => registry.start({
      chainId: 1, contract: CONTRACT, source: 'getLogs', run: async () => undefined,
    })).toThrow(/already running/i);
  });
});
