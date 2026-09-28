import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  countByKind, findKnownTxs, insertTransfers,
} from '../../src/db/repositories/transfers.js';
import type { TransferRow } from '../../src/types.js';

const CONTRACT = '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d';
const MINTER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ZERO = '0x0000000000000000000000000000000000000000';

function row(over: Partial<TransferRow> = {}): TransferRow {
  return {
    chainId: 1, contract: CONTRACT, tokenId: '1', amount: '1',
    fromAddr: ZERO, toAddr: MINTER, txHash: '0xtx1', blockNumber: 100,
    logIndex: 0, batchIndex: 0, txFrom: MINTER, txValueWei: '0',
    kind: 'mint', ...over,
  };
}

/** Every row of one ERC-1155 TransferBatch log: same tx, same log index. */
function batchRows(count = 5, over: Partial<TransferRow> = {}): TransferRow[] {
  return Array.from({ length: count }, (_, i) =>
    row({
      txHash: '0xbatchtx', logIndex: 7, batchIndex: i,
      tokenId: String(100 + i), amount: String(i + 1), ...over,
    }),
  );
}

/** Full contents, deterministically ordered, for identity comparisons. */
function dump(db: Database.Database): unknown[] {
  return db.prepare(`
    SELECT * FROM transfers
     ORDER BY chain_id, tx_hash, log_index, batch_index
  `).all();
}

let db: Database.Database;
beforeEach(() => {
  db = openDb(':memory:');
  runMigrations(db);
  // transfers has a composite FK to collections (chain_id, contract) with
  // foreign_keys enforcement ON, so a parent row must exist before any insert.
  // Without this every test here fails on FOREIGN KEY constraint.
  db.prepare('INSERT INTO collections (chain_id, contract) VALUES (1, ?)').run(CONTRACT);
});

describe('insertTransfers', () => {
  it('inserts rows and reports the count', () => {
    expect(insertTransfers(db, [row(), row({ txHash: '0xtx2', tokenId: '2' })])).toBe(2);
  });

  it('returns 0 and touches nothing for an empty batch', () => {
    expect(insertTransfers(db, [])).toBe(0);
    expect(dump(db)).toEqual([]);
  });

  it('stores a uint256 token id without precision loss', () => {
    const big = (2n ** 255n).toString();
    insertTransfers(db, [row({ tokenId: big, txHash: '0xbig' })]);
    const got = db.prepare('SELECT token_id FROM transfers WHERE tx_hash = ?')
      .get('0xbig') as { token_id: string };
    expect(got.token_id).toBe(big);
  });

  it('stores a uint256 wei value without precision loss', () => {
    const big = (2n ** 200n).toString();
    insertTransfers(db, [row({ txValueWei: big, txHash: '0xwei', kind: 'buy' })]);
    const got = db.prepare('SELECT tx_value_wei FROM transfers WHERE tx_hash = ?')
      .get('0xwei') as { tx_value_wei: string };
    expect(got.tx_value_wei).toBe(big);
  });
});

// The composite primary key exists for exactly this shape. An ERC-1155
// TransferBatch is ONE log carrying ids[], so all its rows share tx_hash AND
// log_index; without batch_index in the key, four of these five would be
// absorbed as duplicate-key conflicts and batch mints would undercount
// silently. Pinned here at the repository layer, not only at decode.
describe('insertTransfers — ERC-1155 TransferBatch', () => {
  it('keeps all five rows of one batch log', () => {
    expect(insertTransfers(db, batchRows(5))).toBe(5);
    const n = db.prepare('SELECT COUNT(*) AS n FROM transfers').get() as { n: number };
    expect(n.n).toBe(5);
  });

  it('stores them sharing tx_hash and log_index, differing only by batch_index', () => {
    insertTransfers(db, batchRows(5));
    const rows = db.prepare(`
      SELECT tx_hash, log_index, batch_index, token_id, amount
        FROM transfers ORDER BY batch_index
    `).all() as Array<{
      tx_hash: string; log_index: number; batch_index: number;
      token_id: string; amount: string;
    }>;
    expect(new Set(rows.map((r) => r.tx_hash)).size).toBe(1);
    expect(new Set(rows.map((r) => r.log_index)).size).toBe(1);
    expect(rows.map((r) => r.batch_index)).toEqual([0, 1, 2, 3, 4]);
    expect(rows.map((r) => r.token_id)).toEqual(['100', '101', '102', '103', '104']);
    expect(rows.map((r) => r.amount)).toEqual(['1', '2', '3', '4', '5']);
  });

  it('re-inserting the same batch adds nothing and changes nothing', () => {
    insertTransfers(db, batchRows(5));
    const before = dump(db);
    expect(insertTransfers(db, batchRows(5))).toBe(0);
    expect(dump(db)).toEqual(before);
  });

  it('extends a batch with a later index without disturbing the first five', () => {
    insertTransfers(db, batchRows(5));
    expect(insertTransfers(db, [batchRows(6)[5]!])).toBe(1);
    const n = db.prepare('SELECT COUNT(*) AS n FROM transfers').get() as { n: number };
    expect(n.n).toBe(6);
  });
});

// IDEMPOTENCY. Mutation-verify before calling this done (see CLAUDE.md): drop the
// ON CONFLICT clause in a scratch copy and confirm every test in this block
// fails. Row counts alone are not enough — contents must be identical too, or a
// re-insert that overwrote a column would pass.
describe('insertTransfers — idempotency', () => {
  const batch = () => [
    row({ txHash: '0xa', tokenId: '1' }),
    row({ txHash: '0xb', tokenId: '2', kind: 'transfer', fromAddr: MINTER, toAddr: ZERO }),
    ...batchRows(3),
  ];

  it('leaves identical counts and identical contents when the same batch is inserted twice', () => {
    expect(insertTransfers(db, batch())).toBe(5);
    const first = dump(db);

    expect(insertTransfers(db, batch())).toBe(0);
    expect(dump(db)).toEqual(first);
    expect(dump(db)).toHaveLength(5);
  });

  it('is idempotent across overlapping batches', () => {
    const a = [row({ txHash: '0x1' }), row({ txHash: '0x2' }), row({ txHash: '0x3' })];
    const b = [row({ txHash: '0x3' }), row({ txHash: '0x4' })];   // 0x3 overlaps

    expect(insertTransfers(db, a)).toBe(3);
    expect(insertTransfers(db, b)).toBe(1);                       // only 0x4 is new
    expect(dump(db)).toHaveLength(4);

    // Replaying both in the other order must reach the same state.
    const state = dump(db);
    insertTransfers(db, b);
    insertTransfers(db, a);
    expect(dump(db)).toEqual(state);
  });

  it('does not let a re-insert overwrite an existing row', () => {
    insertTransfers(db, [row({ txHash: '0xz', tokenId: '1', kind: 'mint' })]);
    const before = dump(db);
    // Same key, different payload: DO NOTHING must keep the original.
    insertTransfers(db, [row({ txHash: '0xz', tokenId: '999', kind: 'burn' })]);
    expect(dump(db)).toEqual(before);
  });

  it('tolerates a duplicate appearing twice within one batch', () => {
    expect(insertTransfers(db, [row({ txHash: '0xdup' }), row({ txHash: '0xdup' })])).toBe(1);
    expect(dump(db)).toHaveLength(1);
  });
});

// A mid-batch failure must roll back the WHOLE batch. Task 13 commits rows and
// the watermark in one transaction, so a partially-inserted chunk under an
// advanced watermark would mean permanently missing transfers that a rerun
// never re-fetches.
describe('insertTransfers — all-or-nothing', () => {
  it('rolls the whole batch back when a later row violates the foreign key', () => {
    const rows = [
      row({ txHash: '0xok1' }),
      row({ txHash: '0xok2' }),
      row({ txHash: '0xbad', contract: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }),
      row({ txHash: '0xok3' }),
    ];
    expect(() => insertTransfers(db, rows)).toThrow(/FOREIGN KEY/i);
    expect(dump(db)).toEqual([]);   // not 3 rows — zero
  });

  it('leaves an earlier successful batch intact when a later batch fails', () => {
    expect(insertTransfers(db, [row({ txHash: '0xfirst' })])).toBe(1);
    expect(() =>
      insertTransfers(db, [
        row({ txHash: '0xsecond' }),
        row({ txHash: '0xorphan', contract: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }),
      ]),
    ).toThrow();
    const rows = dump(db) as Array<{ tx_hash: string }>;
    expect(rows.map((r) => r.tx_hash)).toEqual(['0xfirst']);
  });
});

// ON CONFLICT DO NOTHING absorbs only the primary-key conflict. INSERT OR IGNORE
// would swallow these two as well, dropping the rows silently — which would make
// the lowercase CHECK added in Task 3 unable to report anything.
describe('insertTransfers — malformed rows are loud, not dropped', () => {
  it('throws on a mixed-case address instead of silently skipping it', () => {
    expect(() => insertTransfers(db, [row({ toAddr: MINTER.toUpperCase() })]))
      .toThrow(/CHECK constraint failed/i);
  });

  it('throws on an invalid kind instead of silently skipping it', () => {
    expect(() => insertTransfers(db, [row({ kind: 'nonsense' as TransferRow['kind'] })]))
      .toThrow(/CHECK constraint failed/i);
  });
});

describe('findKnownTxs', () => {
  it('returns tx info already stored, so a resume re-fetches nothing', () => {
    insertTransfers(db, [row({ txHash: '0xknown', txFrom: MINTER, txValueWei: '1000' })]);
    const found = findKnownTxs(db, 1, ['0xknown', '0xmissing']);
    expect(found.get('0xknown')).toEqual({ from: MINTER, value: 1000n });
    expect(found.has('0xmissing')).toBe(false);
  });

  it('returns an empty map for no hashes', () => {
    expect(findKnownTxs(db, 1, []).size).toBe(0);
  });

  it('does not return rows from another chain', () => {
    insertTransfers(db, [row({ txHash: '0xsame' })]);
    expect(findKnownTxs(db, 999, ['0xsame']).size).toBe(0);
  });

  // Crossing the bound-variable chunk boundary. A count-only assertion would
  // pass while an off-by-one dropped the first or last hash of a chunk, so these
  // name specific hashes on both sides of the split.
  it('finds hashes in every chunk, including the boundary elements', () => {
    const rows = Array.from({ length: 1001 }, (_, i) =>
      row({ txHash: `0x${i}`, tokenId: String(i) }),
    );
    insertTransfers(db, rows);

    const found = findKnownTxs(db, 1, rows.map((r) => r.txHash));
    expect(found.size).toBe(1001);
    for (const hash of ['0x0', '0x499', '0x500', '0x999', '0x1000']) {
      expect(found.has(hash)).toBe(true);
    }
  });

  it('dedupes a hash that appears in more than one chunk', () => {
    insertTransfers(db, [row({ txHash: '0xrepeat', txFrom: MINTER, txValueWei: '77' })]);
    // Same hash at index 0 and index 500 — different chunks after the split.
    const hashes = Array.from({ length: 501 }, (_, i) =>
      i === 0 || i === 500 ? '0xrepeat' : `0xfiller${i}`,
    );
    const found = findKnownTxs(db, 1, hashes);
    expect(found.size).toBe(1);
    expect(found.get('0xrepeat')).toEqual({ from: MINTER, value: 77n });
  });

  it('returns each stored hash once even when asked for it many times', () => {
    insertTransfers(db, [row({ txHash: '0xone' })]);
    const found = findKnownTxs(db, 1, Array.from({ length: 1200 }, () => '0xone'));
    expect(found.size).toBe(1);
  });
});

describe('countByKind', () => {
  it('counts each kind, defaulting missing kinds to zero', () => {
    insertTransfers(db, [
      row({ txHash: '0x1', kind: 'mint' }),
      row({ txHash: '0x2', kind: 'mint' }),
      row({ txHash: '0x3', kind: 'burn', fromAddr: MINTER, toAddr: ZERO }),
    ]);
    expect(countByKind(db, 1, CONTRACT)).toEqual({ mint: 2, buy: 0, transfer: 0, burn: 1 });
  });

  it('counts every row of a batch log separately', () => {
    insertTransfers(db, batchRows(5));
    expect(countByKind(db, 1, CONTRACT).mint).toBe(5);
  });

  it('returns all zeros for an unknown contract', () => {
    expect(countByKind(db, 1, '0x0000000000000000000000000000000000000000'))
      .toEqual({ mint: 0, buy: 0, transfer: 0, burn: 0 });
  });
});
