import { pathToFileURL } from 'node:url';
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

/**
 * `npm run migrate` — applies pending migrations to the configured database.
 *
 * This entry point exists because the npm script pointed at this file and the file had
 * no entry point, so `npm run migrate` printed nothing, created nothing, and exited 0.
 * A declared script that silently does nothing is worse than one that does not exist:
 * the README told people to run it, and they would reasonably have believed it worked.
 *
 * Running it is optional — the CLI applies migrations itself before indexing — but
 * creating the schema up front is a reasonable thing to want, and reporting which files
 * were applied is the only way to see the state of the ledger without opening the file.
 *
 * Guarded on being the entry module so importing `runMigrations` from a test or the CLI
 * does not set a database up as a side effect.
 */
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await import('../outputScrubbing.js');
  const { loadConfig } = await import('../config.js');
  const { openDb } = await import('./connection.js');

  const config = loadConfig();
  const db = openDb(config.dbPath);
  try {
    const applied = runMigrations(db);
    if (applied.length === 0) {
      process.stdout.write(`${config.dbPath} is already up to date; nothing to apply.\n`);
    } else {
      process.stdout.write(
        `applied ${applied.length} migration(s) to ${config.dbPath}:\n` +
        applied.map((m) => `  ${m.filename}  ${m.checksum.slice(0, 12)}…\n`).join(''),
      );
    }
  } finally {
    db.close();
  }
}
