import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { manualClock } from '../../src/clock.js';
import {
  advanceWatermark, claimCollection, deleteUnbootstrapped,
  finishBootstrap, getCollection, releaseCollection,
} from '../../src/db/repositories/collections.js';

const CHAIN = 1;
const CONTRACT = '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d';
const STALE_MS = 300_000;
const T0 = 1_774_000_000_000;   // fixed epoch ms; no wall clock in these tests

let db: Database.Database;
beforeEach(() => {
  db = openDb(':memory:');
  runMigrations(db);
});

// One injected clock drives both the timestamp written and the staleness cutoff,
// so these tests set the time instead of sleeping.
const claim = (jobId: string, atMs = T0) =>
  claimCollection(db, {
    chainId: CHAIN, contract: CONTRACT, jobId,
    clock: manualClock(atMs), staleMs: STALE_MS,
  });

describe('claimCollection', () => {
  it('creates the row and acquires the lock when no row exists', () => {
    expect(claim('job-a')).toBe(true);
  });

  it('resolves two claims on a never-seen collection to exactly one winner', () => {
    const results = [claim('job-a'), claim('job-b')];
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('refuses a claim while another job holds a fresh lock', () => {
    claim('job-a');
    expect(claim('job-b')).toBe(false);
  });

  it('grants a claim over a stale lock', () => {
    claim('job-a', T0);
    expect(claim('job-b', T0 + 600_000)).toBe(true);   // 10 min later: stale
  });

  // Two jobs must not both steal the same stale lock. This passes only because
  // the staleness test lives inside the claim statement's WHERE: a SELECT-then-
  // UPDATE would let both observe the stale lock and both take it.
  it('resolves two racing steals of one stale lock to exactly one winner', () => {
    claim('job-a', T0);
    const steals = [claim('job-b', T0 + 600_000), claim('job-c', T0 + 600_000)];
    expect(steals.filter(Boolean)).toHaveLength(1);
    const row = db.prepare('SELECT locked_by FROM collections').get() as { locked_by: string };
    expect(['job-b', 'job-c']).toContain(row.locked_by);
  });

  it('lets a new job claim after release', () => {
    claim('job-a');
    releaseCollection(db, { chainId: CHAIN, contract: CONTRACT, jobId: 'job-a' });
    expect(claim('job-b')).toBe(true);
  });
});

describe('releaseCollection', () => {
  // If A's lock went stale and B stole it, A finishing late must not unlock the
  // collection underneath B — which would leave B writing to an unlocked row.
  it('does not let a job whose lock was stolen release the new holder', () => {
    claim('job-a', T0);
    expect(claim('job-b', T0 + 600_000)).toBe(true);

    releaseCollection(db, { chainId: CHAIN, contract: CONTRACT, jobId: 'job-a' });

    const row = db.prepare('SELECT locked_by FROM collections').get() as { locked_by: string | null };
    expect(row.locked_by).toBe('job-b');
    // B's lock is still effective against a newcomer.
    expect(claim('job-c', T0 + 600_001)).toBe(false);
  });

  it('is a no-op for a job that never held the lock', () => {
    claim('job-a', T0);
    releaseCollection(db, { chainId: CHAIN, contract: CONTRACT, jobId: 'never-held' });
    const row = db.prepare('SELECT locked_by FROM collections').get() as { locked_by: string };
    expect(row.locked_by).toBe('job-a');
  });
});

describe('getCollection', () => {
  it('reports not_indexed when no row exists', () => {
    expect(getCollection(db, CHAIN, CONTRACT)).toEqual({ state: 'not_indexed' });
  });

  // The core guard: a claimed-but-unbootstrapped row must not read as indexed,
  // or callers get silently empty results instead of an error.
  it('reports not_indexed for a claimed but unbootstrapped row', () => {
    claim('job-a');
    expect(getCollection(db, CHAIN, CONTRACT)).toEqual({ state: 'not_indexed' });
  });

  // Deliberate: no third "in progress" state reaches callers. M2's analysis
  // paths must see an unbootstrapped row as un-indexed whether or not a job
  // currently holds the lock.
  it('still reports not_indexed while the lock is actively held', () => {
    expect(claim('job-a', T0)).toBe(true);
    const held = db.prepare('SELECT locked_by FROM collections').get() as { locked_by: string };
    expect(held.locked_by).toBe('job-a');
    expect(getCollection(db, CHAIN, CONTRACT)).toEqual({ state: 'not_indexed' });
  });

  it('reports indexed once bootstrap has completed', () => {
    claim('job-a');
    finishBootstrap(db, {
      chainId: CHAIN, contract: CONTRACT, standard: '721',
      deployBlock: 12287507, deployBlockSource: 'binary_search', name: 'BAYC',
    });
    expect(getCollection(db, CHAIN, CONTRACT)).toEqual({
      state: 'indexed', standard: '721', deployBlock: 12287507,
      lastIndexedBlock: 12287506, name: 'BAYC',
    });
  });
});

describe('deleteUnbootstrapped', () => {
  // transfers has ON DELETE CASCADE to collections, so an unguarded
  // DELETE FROM collections silently destroys every transfer for that
  // collection with no recovery path. These two tests pin the guards.
  it('does not cascade away transfers of a bootstrapped collection', () => {
    claim('job-a');
    finishBootstrap(db, {
      chainId: CHAIN, contract: CONTRACT, standard: '721',
      deployBlock: 100, deployBlockSource: 'override', name: null,
    });
    db.prepare(`
      INSERT INTO transfers
        (chain_id, contract, token_id, amount, from_addr, to_addr, tx_hash,
         block_number, log_index, batch_index, tx_from, tx_value_wei, kind)
      VALUES (@chainId, @contract, '1', '1', '0x0', '0xaaa', '0xtx',
              1, 0, 0, '0xaaa', '0', 'mint')
    `).run({ chainId: CHAIN, contract: CONTRACT });

    deleteUnbootstrapped(db, { chainId: CHAIN, contract: CONTRACT, jobId: 'job-a' });

    const n = db.prepare('SELECT COUNT(*) AS n FROM transfers').get() as { n: number };
    expect(n.n).toBe(1);
  });

  it('removes the row a failed bootstrap created', () => {
    claim('job-a');
    deleteUnbootstrapped(db, { chainId: CHAIN, contract: CONTRACT, jobId: 'job-a' });
    expect(getCollection(db, CHAIN, CONTRACT)).toEqual({ state: 'not_indexed' });
    expect(claim('job-b')).toBe(true);
  });

  it('never removes a bootstrapped collection', () => {
    claim('job-a');
    finishBootstrap(db, {
      chainId: CHAIN, contract: CONTRACT, standard: '721',
      deployBlock: 100, deployBlockSource: 'override', name: null,
    });
    deleteUnbootstrapped(db, { chainId: CHAIN, contract: CONTRACT, jobId: 'job-a' });
    expect(getCollection(db, CHAIN, CONTRACT).state).toBe('indexed');
  });

  it('never removes a row another job holds', () => {
    claim('job-a');
    deleteUnbootstrapped(db, { chainId: CHAIN, contract: CONTRACT, jobId: 'job-b' });
    const row = db.prepare('SELECT locked_by FROM collections').get() as { locked_by: string };
    expect(row.locked_by).toBe('job-a');
  });
});

describe('advanceWatermark', () => {
  it('moves the watermark and refreshes the lock together', () => {
    claim('job-a', T0);
    finishBootstrap(db, {
      chainId: CHAIN, contract: CONTRACT, standard: '721',
      deployBlock: 100, deployBlockSource: 'override', name: null,
    });
    advanceWatermark(db, {
      chainId: CHAIN, contract: CONTRACT, jobId: 'job-a',
      toBlock: 500, clock: manualClock(T0 + 240_000),   // 4 min later
    });
    const state = getCollection(db, CHAIN, CONTRACT);
    expect(state).toMatchObject({ state: 'indexed', lastIndexedBlock: 500 });
    // The refreshed lock means a competing claim still fails at 12:06.
    expect(claim('job-b', T0 + 360_000)).toBe(false);   // 6 min: heartbeat kept it fresh
  });
});
