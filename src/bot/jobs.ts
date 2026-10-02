import type Database from 'better-sqlite3';
import type { Clock } from '../clock.js';
import { inspectLock } from '../db/repositories/collections.js';

export type JobState =
  | { kind: 'running'; startedAt: number; lastBlock?: number; source: string }
  | { kind: 'orphaned'; lockedBy: string; lockedAt: number; expiresAt: number }
  | { kind: 'idle' };

interface Entry { startedAt: number; source: string; lastBlock?: number }

export interface JobRegistry {
  inspect(db: Database.Database, a: { chainId: number; contract: string }): JobState;
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

    start({ chainId, contract, source, run, onError }) {
      const k = key(chainId, contract);
      if (running.has(k)) {
        throw new Error(`a job for ${k} is already running in this process`);
      }
      running.set(k, { startedAt: a.clock.now(), source });

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
          running.delete(k);
        }
      })();
    },

    note({ chainId, contract, lastBlock }) {
      const entry = running.get(key(chainId, contract));
      if (entry) entry.lastBlock = lastBlock;
    },

    size() { return running.size; },
  };
}
