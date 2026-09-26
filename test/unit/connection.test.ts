import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';

const temps: string[] = [];
function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'byakugan-'));
  temps.push(dir);
  return join(dir, 'test.db');
}
afterEach(() => {
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

describe('openDb', () => {
  it('enables WAL on a file database', () => {
    const db = openDb(tempDbPath());
    const mode = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    expect(mode.journal_mode).toBe('wal');
    db.close();
  });

  it('sets a busy timeout', () => {
    const db = openDb(':memory:');
    const timeout = db.prepare('PRAGMA busy_timeout').get() as { timeout: number };
    expect(timeout.timeout).toBeGreaterThan(0);
  });

  it('turns foreign key enforcement on', () => {
    const db = openDb(':memory:');
    const fk = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
    expect(fk.foreign_keys).toBe(1);
  });

  // The assertion that matters. A pragma reading 1 only proves a pragma was set;
  // this proves the constraint is actually enforced, and fails if either the
  // pragma or the FOREIGN KEY clause disappears.
  it('rejects a transfer whose collection does not exist', () => {
    const db = openDb(':memory:');
    runMigrations(db);
    expect(() =>
      db.prepare(`
        INSERT INTO transfers
          (chain_id, contract, token_id, amount, from_addr, to_addr, tx_hash,
           block_number, log_index, batch_index, tx_from, tx_value_wei, kind)
        VALUES (1, '0xdoesnotexist', '1', '1', '0x0', '0xaaa', '0xtx',
                1, 0, 0, '0xaaa', '0', 'mint')
      `).run(),
    ).toThrow(/FOREIGN KEY/i);
  });

  it('accepts a transfer once its collection exists', () => {
    const db = openDb(':memory:');
    runMigrations(db);
    db.prepare('INSERT INTO collections (chain_id, contract) VALUES (1, ?)').run('0xabc');
    expect(() =>
      db.prepare(`
        INSERT INTO transfers
          (chain_id, contract, token_id, amount, from_addr, to_addr, tx_hash,
           block_number, log_index, batch_index, tx_from, tx_value_wei, kind)
        VALUES (1, '0xabc', '1', '1', '0x0', '0xaaa', '0xtx',
                1, 0, 0, '0xaaa', '0', 'mint')
      `).run(),
    ).not.toThrow();
  });

  it('cascades a collection delete to its transfers', () => {
    const db = openDb(':memory:');
    runMigrations(db);
    db.prepare('INSERT INTO collections (chain_id, contract) VALUES (1, ?)').run('0xabc');
    db.prepare(`
      INSERT INTO transfers
        (chain_id, contract, token_id, amount, from_addr, to_addr, tx_hash,
         block_number, log_index, batch_index, tx_from, tx_value_wei, kind)
      VALUES (1, '0xabc', '1', '1', '0x0', '0xaaa', '0xtx', 1, 0, 0, '0xaaa', '0', 'mint')
    `).run();
    db.prepare('DELETE FROM collections WHERE chain_id = 1 AND contract = ?').run('0xabc');
    const left = db.prepare('SELECT COUNT(*) AS n FROM transfers').get() as { n: number };
    expect(left.n).toBe(0);
  });

  it('creates the parent directory for a nested path', () => {
    const root = mkdtempSync(join(tmpdir(), 'byakugan-'));
    temps.push(root);
    const nested = join(root, 'a', 'b', 'test.db');
    expect(() => openDb(nested).close()).not.toThrow();
  });
});

// A mixed-case address stored once makes Milestone 2's `overlap` and
// `firstMinters` queries silently miss matches (they compare addresses as
// text), producing a plausible-looking wrong answer instead of an error. The
// CHECK constraints below turn that into a loud INSERT failure. Asserting on
// rejection, not on the constraint's presence in sqlite_master: a schema-text
// grep would pass even if the constraint were unenforced.
describe('lowercase address enforcement', () => {
  it('rejects a collection with a mixed-case contract', () => {
    const db = openDb(':memory:');
    runMigrations(db);
    expect(() =>
      db.prepare('INSERT INTO collections (chain_id, contract) VALUES (1, ?)').run('0xABC'),
    ).toThrow(/CHECK constraint failed/i);
  });

  it('accepts a collection with an all-lowercase contract', () => {
    const db = openDb(':memory:');
    runMigrations(db);
    expect(() =>
      db.prepare('INSERT INTO collections (chain_id, contract) VALUES (1, ?)').run('0xabc'),
    ).not.toThrow();
  });

  interface TransferRow {
    chainId: number;
    contract: string;
    tokenId: string;
    amount: string;
    fromAddr: string;
    toAddr: string;
    txHash: string;
    blockNumber: number;
    logIndex: number;
    batchIndex: number;
    txFrom: string;
    txValueWei: string;
    kind: string;
  }

  const baseTransfer: TransferRow = {
    chainId: 1,
    contract: '0xabc',
    tokenId: '1',
    amount: '1',
    fromAddr: '0xfrom',
    toAddr: '0xto',
    txHash: '0xtx',
    blockNumber: 1,
    logIndex: 0,
    batchIndex: 0,
    txFrom: '0xfrom',
    txValueWei: '0',
    kind: 'mint',
  };

  function insertTransfer(db: Database.Database, overrides: Partial<TransferRow>): void {
    const row = { ...baseTransfer, ...overrides };
    db.prepare(`
      INSERT INTO transfers
        (chain_id, contract, token_id, amount, from_addr, to_addr, tx_hash,
         block_number, log_index, batch_index, tx_from, tx_value_wei, kind)
      VALUES (@chainId, @contract, @tokenId, @amount, @fromAddr, @toAddr, @txHash,
              @blockNumber, @logIndex, @batchIndex, @txFrom, @txValueWei, @kind)
    `).run(row);
  }

  it.each<[string, Partial<TransferRow>]>([
    ['contract', { contract: '0xABC' }],
    ['from_addr', { fromAddr: '0xFROM' }],
    ['to_addr', { toAddr: '0xTO' }],
    ['tx_from', { txFrom: '0xFROM' }],
  ])('rejects a transfer with a mixed-case %s', (_column, overrides) => {
    const db = openDb(':memory:');
    runMigrations(db);
    db.prepare('INSERT INTO collections (chain_id, contract) VALUES (1, ?)').run('0xabc');
    expect(() => insertTransfer(db, overrides)).toThrow(/CHECK constraint failed/i);
  });

  it('accepts a transfer whose contract, from_addr, to_addr and tx_from are all lowercase', () => {
    const db = openDb(':memory:');
    runMigrations(db);
    db.prepare('INSERT INTO collections (chain_id, contract) VALUES (1, ?)').run('0xabc');
    expect(() => insertTransfer(db, {})).not.toThrow();
  });
});
