import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/db/connection.js';
import { migrationsDir, repoRoot } from '../../src/db/paths.js';
import { runMigrations } from '../../src/db/migrate.js';
import { MigrationError } from '../../src/errors.js';

const dirs: string[] = [];
function fixtureDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'byakugan-mig-'));
  dirs.push(dir);
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return dir;
}
afterEach(() => {
  delete process.env.MIGRATIONS_DIR;
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('paths', () => {
  it('resolves a repo root containing package.json', () => {
    expect(existsSync(join(repoRoot(), 'package.json'))).toBe(true);
  });

  it('points migrationsDir at repo-root db/migrations by default', () => {
    expect(migrationsDir()).toBe(join(repoRoot(), 'db', 'migrations'));
    expect(existsSync(migrationsDir())).toBe(true);
  });

  it('honours MIGRATIONS_DIR', () => {
    process.env.MIGRATIONS_DIR = '/tmp/elsewhere';
    expect(migrationsDir()).toBe('/tmp/elsewhere');
  });
});

describe('runMigrations — real schema', () => {
  it('creates both tables and reports what it applied', () => {
    const db = openDb(':memory:');
    const applied = runMigrations(db);
    expect(applied.map((a) => a.filename)).toContain('001_init.sql');
    expect(applied[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);

    const names = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all() as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain('collections');
    expect(names).toContain('transfers');
    expect(names).toContain('schema_migrations');
  });

  it('is idempotent — a second run applies nothing', () => {
    const db = openDb(':memory:');
    runMigrations(db);
    expect(runMigrations(db)).toEqual([]);
  });

  it('gives transfers a primary key including batch_index', () => {
    const db = openDb(':memory:');
    runMigrations(db);
    const pk = (db.prepare('PRAGMA table_info(transfers)').all() as Array<{
      name: string; pk: number;
    }>)
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name);
    expect(pk).toEqual(['chain_id', 'tx_hash', 'log_index', 'batch_index']);
  });

  it('accepts two rows differing only by batch_index', () => {
    const db = openDb(':memory:');
    runMigrations(db);
    db.prepare('INSERT INTO collections (chain_id, contract) VALUES (1, ?)').run('0xabc');
    const insert = db.prepare(`
      INSERT OR IGNORE INTO transfers
        (chain_id, contract, token_id, amount, from_addr, to_addr, tx_hash,
         block_number, log_index, batch_index, tx_from, tx_value_wei, kind)
      VALUES (1, '0xabc', @tokenId, '1', '0x0', '0xaaa', '0xbatch',
              1, 4, @batchIndex, '0xaaa', '0', 'mint')
    `);
    insert.run({ tokenId: '10', batchIndex: 0 });
    insert.run({ tokenId: '11', batchIndex: 1 });
    const n = db.prepare('SELECT COUNT(*) AS n FROM transfers').get() as { n: number };
    expect(n.n).toBe(2);
  });

  it('declares the timestamp columns as INTEGER epoch ms', () => {
    const db = openDb(':memory:');
    runMigrations(db);
    const cols = (db.prepare('PRAGMA table_info(collections)').all() as Array<{
      name: string; type: string;
    }>);
    expect(cols.find((c) => c.name === 'locked_at')?.type).toBe('INTEGER');
    expect(cols.find((c) => c.name === 'indexed_at')?.type).toBe('INTEGER');
  });
});

describe('runMigrations — checksum ledger', () => {
  it('records a checksum per applied file', () => {
    process.env.MIGRATIONS_DIR = fixtureDir({ '001_a.sql': 'CREATE TABLE a (x);' });
    const db = openDb(':memory:');
    runMigrations(db);
    const row = db.prepare(
      'SELECT filename, checksum, applied_at FROM schema_migrations',
    ).get() as { filename: string; checksum: string; applied_at: number };
    expect(row.filename).toBe('001_a.sql');
    expect(row.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(Number.isInteger(row.applied_at)).toBe(true);
  });

  // The drift bug this exists to prevent: skipping by filename lets an edited
  // migration diverge the database from the repo, invisibly, for months.
  it('fails loudly when an applied migration has been edited', () => {
    const dir = fixtureDir({ '001_a.sql': 'CREATE TABLE a (x);' });
    process.env.MIGRATIONS_DIR = dir;
    const db = openDb(':memory:');
    runMigrations(db);
    writeFileSync(join(dir, '001_a.sql'), 'CREATE TABLE a (x, y);');
    expect(() => runMigrations(db)).toThrow(MigrationError);
    expect(() => runMigrations(db)).toThrow(/001_a\.sql/);
  });

  it('fails loudly when an applied migration has vanished from disk', () => {
    const dir = fixtureDir({ '001_a.sql': 'CREATE TABLE a (x);' });
    process.env.MIGRATIONS_DIR = dir;
    const db = openDb(':memory:');
    runMigrations(db);
    rmSync(join(dir, '001_a.sql'));
    expect(() => runMigrations(db)).toThrow(MigrationError);
  });

  it('does not flag an unchanged file on re-run', () => {
    process.env.MIGRATIONS_DIR = fixtureDir({ '001_a.sql': 'CREATE TABLE a (x);' });
    const db = openDb(':memory:');
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
  });
});

describe('runMigrations — one transaction per file', () => {
  it('applies files in sorted order', () => {
    process.env.MIGRATIONS_DIR = fixtureDir({
      '002_b.sql': 'CREATE TABLE b (x);',
      '001_a.sql': 'CREATE TABLE a (x);',
    });
    const db = openDb(':memory:');
    expect(runMigrations(db).map((a) => a.filename)).toEqual(['001_a.sql', '002_b.sql']);
  });

  // A failure inside one file must leave no partial schema and no ledger row for
  // it, while earlier files stay applied.
  it('rolls back a failing file completely, keeping earlier files', () => {
    process.env.MIGRATIONS_DIR = fixtureDir({
      '001_a.sql': 'CREATE TABLE a (x);',
      '002_bad.sql': 'CREATE TABLE b (x); THIS IS NOT SQL;',
    });
    const db = openDb(':memory:');
    expect(() => runMigrations(db)).toThrow(MigrationError);

    const names = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).all() as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain('a');
    expect(names).not.toContain('b');

    const recorded = (db.prepare(
      'SELECT filename FROM schema_migrations',
    ).all() as Array<{ filename: string }>).map((r) => r.filename);
    expect(recorded).toEqual(['001_a.sql']);
  });

  it('resumes from where a failure stopped once the file is fixed', () => {
    const dir = fixtureDir({
      '001_a.sql': 'CREATE TABLE a (x);',
      '002_bad.sql': 'THIS IS NOT SQL;',
    });
    process.env.MIGRATIONS_DIR = dir;
    const db = openDb(':memory:');
    expect(() => runMigrations(db)).toThrow(MigrationError);
    writeFileSync(join(dir, '002_bad.sql'), 'CREATE TABLE b (x);');
    expect(runMigrations(db).map((a) => a.filename)).toEqual(['002_bad.sql']);
  });

  it('ignores non-sql files', () => {
    process.env.MIGRATIONS_DIR = fixtureDir({
      '001_a.sql': 'CREATE TABLE a (x);',
      'README.md': 'not a migration',
    });
    const db = openDb(':memory:');
    expect(runMigrations(db).map((a) => a.filename)).toEqual(['001_a.sql']);
  });
});
