import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { firstMinters, overlap } from '../../src/db/repositories/analytics.js';
import {
  applyEnrichment, countUnclassified, findTxHashesNeedingEnrichment,
  getEnrichmentLevel, requireFullEnrichment, setEnrichmentLevel,
} from '../../src/db/repositories/enrichment.js';
import { countByKind, findKnownTxs, insertTransfers } from '../../src/db/repositories/transfers.js';
import { EnrichmentLevelError } from '../../src/errors.js';
import { classify } from '../../src/indexer/classify.js';
import type { Address, TransferRow, TxInfo } from '../../src/types.js';

const COLL_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1';
const COLL_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2';
const WALLET = '0xcccccccccccccccccccccccccccccccccccccce1' as Address;
const OTHER = '0xdddddddddddddddddddddddddddddddddddddde2' as Address;
const SELLER = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee3' as Address;
const ZERO = '0x0000000000000000000000000000000000000000' as Address;

let db: Database.Database;
beforeEach(() => {
  db = openDb(':memory:');
  runMigrations(db);
  for (const contract of [COLL_A, COLL_B]) {
    db.prepare('INSERT INTO collections (chain_id, contract, standard) VALUES (1, ?, ?)')
      .run(contract, '721');
  }
});

function row(over: Partial<TransferRow> = {}): TransferRow {
  return {
    chainId: 1, contract: COLL_A, tokenId: '1', amount: '1',
    fromAddr: ZERO, toAddr: WALLET, txHash: '0xtx1', blockNumber: 100,
    logIndex: 0, batchIndex: 0, txFrom: null, txValueWei: null,
    kind: 'mint', ...over,
  };
}

/**
 * What a `mints_only` run writes for one transfer: no transaction fetched, so
 * `classify` is handed null and the kind is whatever the log alone supports.
 * This is the production path, not a shortcut — the point of these tests is that
 * the level is expressed in the ROWS, so the rows have to be built the way the
 * indexer builds them.
 */
function mintsOnlyRow(
  over: Partial<TransferRow> & { fromAddr: string; toAddr: string },
): TransferRow {
  return row({
    ...over,
    txFrom: null,
    txValueWei: null,
    kind: classify({ from: over.fromAddr as Address, to: over.toAddr as Address }, null),
  });
}

/** What a `full` run writes: the transaction was fetched, so the kind is decided. */
function fullRow(
  over: Partial<TransferRow> & { fromAddr: string; toAddr: string },
  tx: TxInfo,
): TransferRow {
  return row({
    ...over,
    txFrom: tx.from,
    txValueWei: tx.value.toString(),
    kind: classify({ from: over.fromAddr as Address, to: over.toAddr as Address }, tx),
  });
}

describe('classify without a transaction', () => {
  it('returns unclassified, NOT transfer, for a movement needing the tx', () => {
    // THE HEADLINE CASE. 'transfer' is the answer you get by failing to look; it
    // is indistinguishable from a real transfer once stored, and it loses every
    // buy in the range.
    expect(classify({ from: SELLER, to: WALLET }, null)).toBe('unclassified');
  });

  it('decides a mint from the log alone', () => {
    expect(classify({ from: ZERO, to: WALLET }, null)).toBe('mint');
  });

  it('decides a burn from the log alone', () => {
    expect(classify({ from: SELLER, to: ZERO }, null)).toBe('burn');
  });

  it('keeps mint ahead of burn for the degenerate 0x0 -> 0x0 case', () => {
    expect(classify({ from: ZERO, to: ZERO }, null)).toBe('mint');
  });

  it('still validates a transaction it WAS given, even for a mint', () => {
    // The bigint guard runs before the log-decidable shortcut. A caller passing
    // raw DB rows is broken for every row; catching it only on the first sale
    // would let a mint-heavy backfill through and surface the fault much later.
    expect(() => classify(
      { from: ZERO, to: WALLET },
      { from: WALLET, value: '10' as unknown as bigint },
    )).toThrow(/tx\.value must be a bigint/);
  });

  it('still asserts tx.from case when a transaction is given', () => {
    expect(() => classify(
      { from: SELLER, to: WALLET },
      { from: WALLET.toUpperCase().replace('0X', '0x') as Address, value: 1n },
    )).toThrow(/must already be lowercase/);
  });
});

describe('the database refuses an unenriched classification', () => {
  // Behaviour, not configuration: each case asserts the INSERT is rejected, not
  // that the schema text contains a CHECK.
  const insert = (over: Partial<TransferRow>) => () => insertTransfers(db, [row(over)]);

  it("rejects kind 'transfer' with no transaction — the silent downgrade", () => {
    expect(insert({ fromAddr: SELLER, toAddr: WALLET, kind: 'transfer' }))
      .toThrow(/CHECK constraint failed/);
  });

  it("rejects kind 'buy' with no transaction", () => {
    expect(insert({ fromAddr: SELLER, toAddr: WALLET, kind: 'buy' }))
      .toThrow(/CHECK constraint failed/);
  });

  it("rejects kind 'unclassified' when the transaction IS present", () => {
    // The work was done; discarding its result is as wrong as inventing one.
    expect(insert({
      fromAddr: SELLER, toAddr: WALLET, kind: 'unclassified',
      txFrom: WALLET, txValueWei: '5',
    })).toThrow(/CHECK constraint failed/);
  });

  it('rejects half a transaction (sender without value)', () => {
    expect(insert({ kind: 'mint', txFrom: WALLET, txValueWei: null }))
      .toThrow(/CHECK constraint failed/);
  });

  it('rejects half a transaction (value without sender)', () => {
    expect(insert({ kind: 'mint', txFrom: null, txValueWei: '5' }))
      .toThrow(/CHECK constraint failed/);
  });

  it('accepts a mint or burn with no transaction', () => {
    expect(insertTransfers(db, [
      row({ fromAddr: ZERO, toAddr: WALLET, kind: 'mint', txHash: '0xm' }),
      row({ fromAddr: SELLER, toAddr: ZERO, kind: 'burn', txHash: '0xb' }),
    ])).toBe(2);
  });

  it('accepts an unclassified row with no transaction', () => {
    expect(insertTransfers(db, [
      row({ fromAddr: SELLER, toAddr: WALLET, kind: 'unclassified' }),
    ])).toBe(1);
  });
});

describe('a mints_only index', () => {
  /**
   * Wallet mints in collection A and BUYS in collection B. Under mints_only the
   * buy is unclassified, so an ungated `overlap` sees the wallet in one
   * collection instead of two.
   */
  function indexMintsOnly(): void {
    setEnrichmentLevel(db, { chainId: 1, contract: COLL_A, level: 'mints_only' });
    setEnrichmentLevel(db, { chainId: 1, contract: COLL_B, level: 'mints_only' });
    insertTransfers(db, [
      mintsOnlyRow({ contract: COLL_A, fromAddr: ZERO, toAddr: WALLET, txHash: '0xa1', blockNumber: 10 }),
      mintsOnlyRow({ contract: COLL_B, fromAddr: SELLER, toAddr: WALLET, txHash: '0xb1', blockNumber: 20 }),
      mintsOnlyRow({ contract: COLL_B, fromAddr: ZERO, toAddr: OTHER, txHash: '0xb2', blockNumber: 21 }),
    ]);
  }

  it('stores non-mint rows as unclassified rather than omitting them', () => {
    // Load-bearing invariant. If mints_only stored ONLY the mints there would be
    // nothing for the gate to detect, overlap would undercount against an
    // apparently clean index, and an upgrade would have to re-read chain logs
    // instead of the tx_hashes already on disk.
    indexMintsOnly();
    expect(countUnclassified(db, 1, COLL_B)).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM transfers').get()).toEqual({ n: 3 });
  });

  it('leaves mint rows classified but with no transaction fetched', () => {
    indexMintsOnly();
    expect(db.prepare(
      "SELECT kind, tx_from FROM transfers WHERE tx_hash = '0xa1'",
    ).get()).toEqual({ kind: 'mint', tx_from: null });
  });

  it('reports unclassified as its own count, never folded into transfer', () => {
    indexMintsOnly();
    expect(countByKind(db, 1, COLL_B)).toEqual({
      mint: 1, buy: 0, transfer: 0, burn: 0, unclassified: 1,
    });
  });

  it('answers firstMinters completely, with no gate and no transactions', () => {
    indexMintsOnly();
    expect(firstMinters(db, { chainId: 1, contract: COLL_B, limit: 10 }))
      .toEqual([{ address: OTHER, blockNumber: 21, logIndex: 0, batchIndex: 0, tokenId: '1' }]);
  });

  it('REFUSES overlap loudly instead of returning zeros', () => {
    indexMintsOnly();
    expect(() => overlap(db, { chainId: 1, contracts: [COLL_A, COLL_B], minCollections: 2 }))
      .toThrow(EnrichmentLevelError);
  });

  it('names the offending collections and how to fix them', () => {
    indexMintsOnly();
    let message = '';
    try {
      overlap(db, { chainId: 1, contracts: [COLL_A, COLL_B], minCollections: 2 });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain(COLL_B);
    expect(message).toContain('mints_only');
    expect(message).toMatch(/1 unclassified transfers/);
    expect(message).toMatch(/re-index/i);
    // COLL_A is fully classified (its only row is a mint), so it is not blamed.
    expect(message).not.toContain(COLL_A);
  });

  it('does NOT refuse when every transfer happened to be log-decidable', () => {
    // Precision in the honest direction: a mints_only collection holding only
    // mints and burns has nothing unclassified, so its overlap answer really is
    // complete. Refusing on the declared level alone would force a pointless
    // re-index. This is why the gate reads the rows, not the column.
    setEnrichmentLevel(db, { chainId: 1, contract: COLL_A, level: 'mints_only' });
    insertTransfers(db, [
      mintsOnlyRow({ contract: COLL_A, fromAddr: ZERO, toAddr: WALLET, txHash: '0xa1' }),
      mintsOnlyRow({ contract: COLL_A, fromAddr: SELLER, toAddr: ZERO, txHash: '0xa2', logIndex: 1 }),
    ]);
    expect(getEnrichmentLevel(db, 1, COLL_A)).toBe('mints_only');
    expect(overlap(db, { chainId: 1, contracts: [COLL_A], minCollections: 1 }))
      .toEqual([{ address: WALLET, collections: 1 }]);
  });

  it('never returns an unenriched row from findKnownTxs', () => {
    // Otherwise the backfill would treat a row with no transaction as already
    // known, skip fetching it, and BigInt(null) would throw downstream.
    indexMintsOnly();
    expect(findKnownTxs(db, 1, ['0xa1', '0xb1']).size).toBe(0);
  });
});

describe('a full index', () => {
  function indexFull(): void {
    insertTransfers(db, [
      fullRow({ contract: COLL_A, fromAddr: ZERO, toAddr: WALLET, txHash: '0xa1', blockNumber: 10 },
        { from: WALLET, value: 1n }),
      fullRow({ contract: COLL_B, fromAddr: SELLER, toAddr: WALLET, txHash: '0xb1', blockNumber: 20 },
        { from: WALLET, value: 5n }),
    ]);
  }

  it('defaults to full when nothing asked for otherwise', () => {
    expect(getEnrichmentLevel(db, 1, COLL_A)).toBe('full');
  });

  it('classifies the purchase as a buy', () => {
    indexFull();
    expect(countByKind(db, 1, COLL_B)).toEqual({
      mint: 0, buy: 1, transfer: 0, burn: 0, unclassified: 0,
    });
  });

  it('answers overlap, counting the mint and the buy together', () => {
    indexFull();
    expect(overlap(db, { chainId: 1, contracts: [COLL_A, COLL_B], minCollections: 2 }))
      .toEqual([{ address: WALLET, collections: 2 }]);
  });

  it('excludes the zero address, since a burn recipient is not an acquirer', () => {
    insertTransfers(db, [
      fullRow({ contract: COLL_A, fromAddr: ZERO, toAddr: ZERO, txHash: '0xa1' },
        { from: WALLET, value: 0n }),
    ]);
    expect(overlap(db, { chainId: 1, contracts: [COLL_A], minCollections: 1 })).toEqual([]);
  });

  it('rejects a checksummed contract argument rather than matching nothing', () => {
    expect(() => overlap(db, {
      chainId: 1, contracts: [COLL_A.toUpperCase().replace('0X', '0x')], minCollections: 1,
    })).toThrow(/must be lowercase/);
  });
});

describe('upgrading mints_only to full', () => {
  beforeEach(() => {
    setEnrichmentLevel(db, { chainId: 1, contract: COLL_B, level: 'mints_only' });
    insertTransfers(db, [
      mintsOnlyRow({ contract: COLL_B, fromAddr: ZERO, toAddr: OTHER, txHash: '0xb1', blockNumber: 10 }),
      mintsOnlyRow({ contract: COLL_B, fromAddr: SELLER, toAddr: WALLET, txHash: '0xb2', blockNumber: 20 }),
    ]);
  });

  it('lists every transaction still missing, mints included', () => {
    // Keyed on tx_from IS NULL, not on kind: the mint's kind was already known,
    // but a 'full' index must still carry its transaction or mint price is NULL
    // with no explanation.
    expect(findTxHashesNeedingEnrichment(db, 1, COLL_B)).toEqual([
      { txHash: '0xb1', blockNumber: 10 },
      { txHash: '0xb2', blockNumber: 20 },
    ]);
  });

  it('enriches ONLY the missing transactions on a second pass', () => {
    // Requirement: upgrading enriches what is missing, not everything.
    expect(applyEnrichment(db, {
      chainId: 1, txs: new Map([['0xb1', { from: OTHER, value: 3n }]]),
    })).toBe(1);

    expect(findTxHashesNeedingEnrichment(db, 1, COLL_B))
      .toEqual([{ txHash: '0xb2', blockNumber: 20 }]);

    // Re-offering the already-enriched hash updates nothing.
    expect(applyEnrichment(db, {
      chainId: 1, txs: new Map([['0xb1', { from: OTHER, value: 999n }]]),
    })).toBe(0);
    expect(db.prepare("SELECT tx_value_wei FROM transfers WHERE tx_hash = '0xb1'").get())
      .toEqual({ tx_value_wei: '3' });
  });

  it('reclassifies the unclassified row into a buy and unblocks overlap', () => {
    expect(() => overlap(db, { chainId: 1, contracts: [COLL_B], minCollections: 1 }))
      .toThrow(EnrichmentLevelError);

    applyEnrichment(db, {
      chainId: 1,
      txs: new Map([
        ['0xb1', { from: OTHER, value: 1n }],
        ['0xb2', { from: WALLET, value: 7n }],
      ]),
    });
    setEnrichmentLevel(db, { chainId: 1, contract: COLL_B, level: 'full' });

    expect(countUnclassified(db, 1, COLL_B)).toBe(0);
    expect(countByKind(db, 1, COLL_B)).toEqual({
      mint: 1, buy: 1, transfer: 0, burn: 0, unclassified: 0,
    });
    // Equal counts tie-break on address ascending: WALLET is 0xccc…, OTHER 0xddd….
    expect(overlap(db, { chainId: 1, contracts: [COLL_B], minCollections: 1 }))
      .toEqual([
        { address: WALLET, collections: 1 },
        { address: OTHER, collections: 1 },
      ]);
  });

  it('leaves a hash it was not given untouched, so the gate still refuses', () => {
    // A partial fetch must leave a partial index that is still refused, not a
    // complete-looking one that is wrong.
    applyEnrichment(db, { chainId: 1, txs: new Map([['0xb1', { from: OTHER, value: 1n }]]) });
    expect(countUnclassified(db, 1, COLL_B)).toBe(1);
    expect(() => overlap(db, { chainId: 1, contracts: [COLL_B], minCollections: 1 }))
      .toThrow(EnrichmentLevelError);
  });

  it('classifies a WETH sale as transfer once enriched, not as unclassified', () => {
    // tx.value === 0n is a known limitation, but it is a DECIDED answer: the
    // transaction was fetched and said zero. That is different from never having
    // looked, and the two must not collapse into one state.
    applyEnrichment(db, { chainId: 1, txs: new Map([['0xb2', { from: WALLET, value: 0n }]]) });
    expect(db.prepare("SELECT kind FROM transfers WHERE tx_hash = '0xb2'").get())
      .toEqual({ kind: 'transfer' });
  });
});

describe('requireFullEnrichment', () => {
  it('passes on an empty contract list', () => {
    expect(() => requireFullEnrichment(db, { chainId: 1, contracts: [], queryName: 'q' }))
      .not.toThrow();
  });

  it('ignores unclassified rows belonging to a collection not asked about', () => {
    insertTransfers(db, [
      mintsOnlyRow({ contract: COLL_B, fromAddr: SELLER, toAddr: WALLET, txHash: '0xb1' }),
    ]);
    expect(() => requireFullEnrichment(db, {
      chainId: 1, contracts: [COLL_A], queryName: 'overlap',
    })).not.toThrow();
  });

  it('ignores unclassified rows on a different chain', () => {
    db.prepare('INSERT INTO collections (chain_id, contract, standard) VALUES (8453, ?, ?)')
      .run(COLL_A, '721');
    insertTransfers(db, [
      mintsOnlyRow({ chainId: 8453, contract: COLL_A, fromAddr: SELLER, toAddr: WALLET, txHash: '0xz1' }),
    ]);
    expect(() => requireFullEnrichment(db, {
      chainId: 1, contracts: [COLL_A], queryName: 'overlap',
    })).not.toThrow();
  });
});
