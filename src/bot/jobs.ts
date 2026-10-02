import type Database from 'better-sqlite3';
import type { Clock } from '../clock.js';
import { inspectLock } from '../db/repositories/collections.js';

export type JobState =
  | { kind: 'running'; startedAt: number; lastBlock?: number; source: string }
  | { kind: 'orphaned'; lockedBy: string; lockedAt: number; expiresAt: number }
  | { kind: 'idle' };

interface Entry { startedAt: number; source: string; lastBlock?: number }

/**
 * A slot held in the registry by a caller that has WON the claim.
 *
 * The holder must call `run` or `release`. `release` after `run` is a no-op (the runner
 * clears its own slot when the job ends), so a caller can put `release` in a `finally`
 * without caring which of the two paths it took.
 */
export interface JobHandle {
  run(a: { run: () => Promise<void>; onError?: (err: unknown) => void }): void;
  release(): void;
}

export interface JobRegistry {
  inspect(db: Database.Database, a: { chainId: number; contract: string }): JobState;
  /**
   * Insert-if-absent: takes the slot for this collection and returns a handle, or returns
   * null when the slot is already taken. SYNCHRONOUS ON PURPOSE — there is no `await`
   * between the existence test and the insertion, so two callers cannot both win. A caller
   * learns it lost from the return value, not from catching a throw after it has already
   * told the user something.
   */
  claim(a: { chainId: number; contract: string; source: string }): JobHandle | null;
  /** Claim and run in one step; throws if the slot is taken. Prefer `claim` when work must happen between. */
  start(a: {
    chainId: number; contract: string; source: string;
    run: () => Promise<void>;
    onError?: (err: unknown) => void;
  }): void;
  note(a: { chainId: number; contract: string; lastBlock: number }): void;
  size(): number;
}

const key = (chainId: number, contract: string): string => `${chainId}:${contract}`;

/**
 * Tracks jobs running in THIS process, over the database lock that tracks them globally.
 *
 * Two sources of truth on purpose, because each answers a question the other cannot. The
 * map knows elapsed time, the fetch path and the current block for a job here and now;
 * the lock knows that SOME process holds this collection, including one that has since
 * died. They disagree after a crash — the map is empty on restart while a stale lock row
 * survives until its timeout — and `inspect` exists to tell those apart rather than
 * reporting "already indexing" for a job that does not exist.
 *
 * The registry owns its map rather than keeping it in module scope, so a test gets a
 * fresh one without resetting global state.
 */
export function createJobRegistry(a: { clock: Clock; staleMs: number }): JobRegistry {
  const running = new Map<string, Entry>();

  return {
    inspect(db, { chainId, contract }) {
      const entry = running.get(key(chainId, contract));
      // The map wins when both are present: it is the more specific fact, and it is this
      // process's own job.
      if (entry) {
        return {
          kind: 'running',
          startedAt: entry.startedAt,
          source: entry.source,
          ...(entry.lastBlock === undefined ? {} : { lastBlock: entry.lastBlock }),
        };
      }
      const lock = inspectLock(db, chainId, contract);
      if (lock) {
        return {
          kind: 'orphaned',
          lockedBy: lock.lockedBy,
          lockedAt: lock.lockedAt,
          expiresAt: lock.lockedAt + a.staleMs,
        };
      }
      return { kind: 'idle' };
    },

    claim({ chainId, contract, source }) {
      const k = key(chainId, contract);
      // The test and the insertion share one synchronous block. That is the whole property:
      // the interleavings that matter here come from `await` points in OUR OWN callers
      // (an estimate, a reply), so a single-process test can genuinely produce them — unlike
      // a lock contended by two OS processes, which it cannot.
      if (running.has(k)) return null;
      const entry: Entry = { startedAt: a.clock.now(), source };
      running.set(k, entry);

      let spent = false;
      /**
       * Deletes only if the slot is still THIS claim's.
       *
       * ARGUED, NOT TESTED, and the honest account is that `spent` is the real guard: it is
       * set by the first `release` or `run`, so a late second `release` returns before
       * reaching here, and `run`'s own cleanup fires once while the slot is still its own.
       * There is therefore no reachable path on which the identity check changes the
       * outcome — delete it and every test still passes. It stays as defence in depth
       * because it is the check that would matter if `spent` were ever removed or a handle
       * were shared, and because freeing another claim's slot is the failure that lets two
       * jobs run on one collection. It is NOT load-bearing today, and an earlier version of
       * this comment claimed it was.
       */
      const free = (): void => { if (running.get(k) === entry) running.delete(k); };

      return {
        release() {
          if (!spent) free();
          spent = true;
        },

        run({ run, onError }) {
          if (spent) throw new Error(`the claim for ${k} has already been run or released`);
          spent = true;
          // CLEANUP IS IN A `finally` AND THE RUNNER NEVER REJECTS. If cleanup sat in the
          // happy path, a throwing job would leak its map entry — and the map has no expiry,
          // so that collection would report "already indexing" until the process restarted,
          // with nothing in the database to indicate a problem. The DB lock recovers on its
          // own; the map does not. An unhandled rejection from a detached promise should be
          // structurally impossible, not something to remember.
          void (async () => {
            try {
              await run();
            } catch (err) {
              try { onError?.(err); } catch { /* a failing reporter must not break cleanup */ }
            } finally {
              free();
            }
          })();
        },
      };
    },

    start({ chainId, contract, source, run, onError }) {
      const handle = this.claim({ chainId, contract, source });
      if (handle === null) {
        throw new Error(`a job for ${key(chainId, contract)} is already running in this process`);
      }
      handle.run({ run, ...(onError ? { onError } : {}) });
    },

    note({ chainId, contract, lastBlock }) {
      const entry = running.get(key(chainId, contract));
      if (entry) entry.lastBlock = lastBlock;
    },

    size() { return running.size; },
  };
}
