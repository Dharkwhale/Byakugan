import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
afterEach(() => {
  db.close();
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
  // single-statement atomicity test below is the one that pins the property.
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

// THE DISCRIMINATOR for the atomicity property.
//
// The property is "the staleness predicate is evaluated in the same statement
// that writes the lock". That is a statement-count property, so test it directly
// instead of trying to manufacture an interleaving a synchronous driver cannot
// produce.
//
// WHY statement count is a valid proxy, not just a smell test: better-sqlite3's
// `db.prepare()` rejects multi-statement SQL outright, so one call to `prepare`
// can only ever correspond to one SQL statement, which SQLite runs as one
// implicit transaction. One `prepare` therefore *is* one atomic unit of work —
// there is no way for `claimCollection` to prepare once and still have split
// its check and its write across two transactions.
//
// A counting Proxy over the Database records every prepared statement: the
// real claim prepares exactly ONE, a check-then-claim prepares two.
// Mutation-verified: real implementation 1 statement, check-then-claim 2.
//
// HONEST SCOPE — what this actually pins, and what it doesn't:
// - It pins "`claimCollection` calls `db.prepare` exactly once", which is not
//   literally the same claim as "the claim is atomic" — it is a proxy for it,
//   justified by the `prepare`-is-one-statement fact above. A contrived mutant
//   using `db.exec()` for the write plus a read from a statement *prepared
//   outside* `claimCollection` (so the count seen by this Proxy is 0 or 1
//   depending on where you place the boundary) can pass all three tests here;
//   this was built and confirmed during review. It is not a plausible accident
//   — it requires a hoisted statement AND string-interpolated `exec` — but the
//   tests do not rule it out, so this comment should not claim they do.
// - A future refactor that caches a prepared statement across calls (a common,
//   legitimate perf pattern for a hot path) would make the count seen here 0
//   and fail test 3 (`still prepares one statement when stealing a stale
//   lock`), even though such a refactor could be perfectly atomic. That is a
//   false alarm, not a false pass — but whoever hits it should know why this
//   test is objecting rather than assume the refactor broke locking.
// - The SQL-text regexes in the second test are the only thing here that would
//   catch a single-`prepare` mutant built around a bare `UPDATE` with no
//   staleness `WHERE` at all — they are load-bearing, not decorative. They are
//   also brittle: a correct reordering like `SET locked_at = ..., locked_by =
//   ...` would fail `/SET\s+locked_by/i`, and staleness-related text sitting
//   inside a SQL comment would satisfy the same regex without being a real
//   predicate.
// - Genuine concurrent detection (two OS processes racing real writes against
//   one WAL-mode file) is out of scope for this suite, not impossible — it was
//   previously described here as something a synchronous driver "cannot
//   produce", which overstated the case: multi-process concurrency against a
//   shared file WOULD be able to detect the interleaving this property
//   protects against; it is simply not exercised by this unit test suite.
describe('claimCollection — single-statement atomicity', () => {
  function countingDb(target: Database.Database): {
    proxy: Database.Database; statements: string[];
  } {
    const statements: string[] = [];
    const proxy = new Proxy(target, {
      get(obj, prop, receiver) {
        const value = Reflect.get(obj, prop, receiver);
        if (prop === 'prepare') {
          return (sql: string) => {
            statements.push(sql);
            return (value as Database.Database['prepare']).call(obj, sql);
          };
        }
        return typeof value === 'function' ? value.bind(obj) : value;
      },
    }) as Database.Database;
    return { proxy, statements };
  }

  it('prepares exactly one statement, so staleness cannot be tested separately', () => {
    const { proxy, statements } = countingDb(db);
    claimCollection(proxy, {
      chainId: CHAIN, contract: CONTRACT, jobId: 'job-a',
      clock: manualClock(T0), staleMs: STALE_MS,
    });
    // Two or more means the staleness check and the write are separable, which
    // is exactly the check-then-claim bug.
    expect(statements).toHaveLength(1);
  });

  it('that one statement both tests staleness and writes the lock', () => {
    const { proxy, statements } = countingDb(db);
    claimCollection(proxy, {
      chainId: CHAIN, contract: CONTRACT, jobId: 'job-a',
      clock: manualClock(T0), staleMs: STALE_MS,
    });
    const sql = statements[0] ?? '';
    expect(sql).toMatch(/ON CONFLICT/i);       // creates or takes over in one go
    expect(sql).toMatch(/locked_by IS NULL/i); // the staleness predicate...
    expect(sql).toMatch(/locked_at\s*</i);     // ...lives in the same statement
    expect(sql).toMatch(/SET\s+locked_by/i);   // and so does the write
  });

  it('still prepares one statement when stealing a stale lock', () => {
    claim('job-a', T0);
    const { proxy, statements } = countingDb(db);
    const won = claimCollection(proxy, {
      chainId: CHAIN, contract: CONTRACT, jobId: 'job-b',
      clock: manualClock(T0 + 600_000), staleMs: STALE_MS,
    });
    expect(won).toBe(true);
    expect(statements).toHaveLength(1);
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
      deployBlock: 12287507, deployBlockSource: 'binary_search', validated: true, name: 'BAYC',
    });
    expect(getCollection(db, CHAIN, CONTRACT)).toEqual({
      state: 'indexed', standard: '721', deployBlock: 12287507,
      lastIndexedBlock: 12287506, name: 'BAYC',
    });
  });
});

describe('finishBootstrap — validation state', () => {
  const stored = () => (db.prepare(
    'SELECT deploy_block_validated AS v FROM collections',
  ).get() as { v: number }).v;

  it('stores 1 for a validated deploy block, read back from the row', () => {
    claim('job-a');
    finishBootstrap(db, {
      chainId: CHAIN, contract: CONTRACT, standard: '721',
      deployBlock: 100, deployBlockSource: 'explorer', validated: true, name: null,
    });
    expect(stored()).toBe(1);
  });

  it('stores 0 for an unvalidated deploy block, read back from the row', () => {
    claim('job-a');
    finishBootstrap(db, {
      chainId: CHAIN, contract: CONTRACT, standard: '721',
      deployBlock: 55, deployBlockSource: 'explorer', validated: false, name: null,
    });
    expect(stored()).toBe(0);
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
      deployBlock: 100, deployBlockSource: 'override', validated: true, name: null,
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
      deployBlock: 100, deployBlockSource: 'override', validated: true, name: null,
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
      deployBlock: 100, deployBlockSource: 'override', validated: true, name: null,
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
