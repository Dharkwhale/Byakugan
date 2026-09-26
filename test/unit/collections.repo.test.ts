import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
// Push the mkdtemp ROOT, never a nested path: pushing the leaf leaked an empty
// tree per run in Task 3.
const tempRoots: string[] = [];
afterEach(() => {
  while (tempRoots.length) rmSync(tempRoots.pop()!, { recursive: true, force: true });
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

  // Two sequential steal attempts against one stale lock leave exactly one
  // holder, because the winning claim writes locked_at in the same statement
  // that tests it, so the second attempt sees a fresh lock.
  //
  // This does NOT prove atomicity. It was mutation-tested and passes
  // identically against a check-then-claim implementation: better-sqlite3 is
  // synchronous and single-process, so the first attempt's write always
  // commits before the second attempt's read, and the interleaving that
  // breaks check-then-claim is unreachable on one connection. The
  // cross-connection test below is the one that pins the property.
  it('leaves exactly one holder after two sequential steal attempts', () => {
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

// Cross-connection contention. The sequential test above cannot distinguish a
// single-statement claim from a check-then-claim, so this is the one that does.
//
// JOURNAL MODE: WAL, which `openDb` sets for any file path. That matters and is
// not incidental — under WAL a reader does not block a writer, so a read issued
// while another connection holds an open write transaction sees the last
// COMMITTED snapshot rather than blocking. That is what makes a stale read
// reachable, and therefore what makes the check-then-claim bug demonstrable.
// Under `journal_mode = DELETE` the reader would block instead, and the test
// would pass for a reason unrelated to atomicity.
//
// `:memory:` cannot be used here: separate connections cannot share it.
describe('claimCollection — cross-connection atomicity', () => {
  let connB: Database.Database;
  let connC: Database.Database;

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), 'byakugan-lock-'));
    tempRoots.push(root);
    const dbPath = join(root, 'lock.db');

    const setup = openDb(dbPath);
    runMigrations(setup);
    setup.close();

    connB = openDb(dbPath);
    connC = openDb(dbPath);
    // Generous and explicit: a blocked statement must wait for the other
    // connection rather than returning SQLITE_BUSY, or the result becomes a
    // timing coin-flip instead of a verdict.
    for (const conn of [connB, connC]) conn.pragma('busy_timeout = 30000');

    expect((connB.prepare('PRAGMA journal_mode').get() as { journal_mode: string })
      .journal_mode).toBe('wal');
  });

  afterEach(() => {
    connB.close();
    connC.close();
  });

  const claimOn = (conn: Database.Database, jobId: string, atMs: number) =>
    claimCollection(conn, {
      chainId: CHAIN, contract: CONTRACT, jobId,
      clock: manualClock(atMs), staleMs: STALE_MS,
    });

  it('does not let a stale read on one connection steal a lock another just took', () => {
    // job-a holds a lock that will go stale.
    expect(claimOn(connB, 'job-a', T0)).toBe(true);
    const stale = T0 + 600_000;

    // C reads the world at `stale`: the lock IS stale here, so a
    // check-then-claim implementation would decide to steal from this read.
    const seenByC = connC
      .prepare('SELECT locked_by, locked_at FROM collections WHERE chain_id = ? AND contract = ?')
      .get(CHAIN, CONTRACT) as { locked_by: string; locked_at: number };
    expect(seenByC.locked_by).toBe('job-a');
    expect(seenByC.locked_at).toBeLessThan(stale - STALE_MS);

    // B steals it first and commits.
    expect(claimOn(connB, 'job-b', stale)).toBe(true);

    // C now acts on the decision implied by its earlier read. The real claim
    // re-evaluates staleness inside the same statement that writes, so it sees
    // job-b's fresh lock and loses. A check-then-claim would blindly UPDATE and
    // steal from job-b.
    expect(claimOn(connC, 'job-c', stale)).toBe(false);

    const holder = connB
      .prepare('SELECT locked_by FROM collections WHERE chain_id = ? AND contract = ?')
      .get(CHAIN, CONTRACT) as { locked_by: string };
    expect(holder.locked_by).toBe('job-b');
  });

  it('makes a claim on one connection immediately visible to the other', () => {
    expect(claimOn(connB, 'job-a', T0)).toBe(true);
    expect(claimOn(connC, 'job-b', T0 + 1)).toBe(false);
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
