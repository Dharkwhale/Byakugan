import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { MigrationError } from '../errors.js';
import { systemClock, type Clock } from '../clock.js';
import { migrationsDir } from './paths.js';

export interface AppliedMigration {
  filename: string;
  checksum: string;
}

const checksum = (sql: string): string =>
  createHash('sha256').update(sql, 'utf8').digest('hex');

/**
 * Applies pending migrations, each in its own transaction.
 *
 * The ledger stores a content checksum, not just a filename, because skipping
 * by filename alone lets an edited migration silently diverge the database from
 * the repo — a drift bug that surfaces much later as an inexplicably missing
 * column. A changed or missing file is therefore a hard failure, never a skip.
 */
export function runMigrations(
  db: Database.Database,
  clock: Clock = systemClock,
): AppliedMigration[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT    PRIMARY KEY,
      checksum   TEXT    NOT NULL,
      applied_at INTEGER NOT NULL   -- epoch ms, from the injected Clock
    )
  `);

  const dir = migrationsDir();
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const onDisk = new Map(files.map((f) => [f, readFileSync(join(dir, f), 'utf8')]));

  const recorded = new Map(
    (db.prepare('SELECT filename, checksum FROM schema_migrations').all() as Array<{
      filename: string; checksum: string;
    }>).map((r) => [r.filename, r.checksum]),
  );

  // Verify every already-applied migration before applying anything new, so a
  // drifted repo fails before it can layer more schema on top.
  for (const [filename, recordedChecksum] of recorded) {
    const sql = onDisk.get(filename);
    if (sql === undefined) {
      throw new MigrationError(
        `migration ${filename} is recorded as applied but is missing from ${dir}. ` +
        'The database and the repo have diverged; restore the file or reset the database.',
      );
    }
    const actual = checksum(sql);
    if (actual !== recordedChecksum) {
      throw new MigrationError(
        `migration ${filename} has changed since it was applied ` +
        `(recorded ${recordedChecksum.slice(0, 12)}…, found ${actual.slice(0, 12)}…). ` +
        'Applied migrations are immutable: add a new migration instead of editing this one.',
      );
    }
  }

  const record = db.prepare(
    'INSERT INTO schema_migrations (filename, checksum, applied_at) VALUES (?, ?, ?)',
  );

  const applied: AppliedMigration[] = [];
  for (const filename of files) {
    if (recorded.has(filename)) continue;
    const sql = onDisk.get(filename);
    if (sql === undefined) continue;
    const sum = checksum(sql);

    try {
      // One transaction per file: a failure halfway leaves no partial schema
      // and no ledger row, so a fixed file applies cleanly on the next run.
      db.transaction(() => {
        db.exec(sql);
        record.run(filename, sum, clock.now());
      })();
    } catch (err) {
      throw new MigrationError(
        `migration ${filename} failed and was rolled back: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    applied.push({ filename, checksum: sum });
  }

  return applied;
}
