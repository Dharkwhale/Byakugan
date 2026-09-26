import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

/**
 * Opens the database with the pragmas this project depends on.
 *
 * `foreign_keys` is set HERE and not in a migration because SQLite defaults it
 * OFF on every new connection: a migration would set it once and every later
 * process would run unenforced. WAL and busy_timeout are likewise per-connection.
 */
export function openDb(path: string): Database.Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  if (path !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  return db;
}
