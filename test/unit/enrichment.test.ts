import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { firstMinters, overlap } from '../../src/db/repositories/analytics.js';
import {
  applyEnrichment, countUnclassified, findTxHashesNeedingEnrichment,
  getEnrichmentLevel, requireFullEnrichment, requireMintEnrichment, setEnrichmentLevel,
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
const BOT = '0xbbbb0000000000000000000000000000000000b0' as Address;
const FRESH = [
  '0xf0000000000000000000000000000000000000f1',
  '0xf0000000000000000000000000000000000000f2',
  '0xf0000000000000000000000000000000000000f3',
] as Address[];
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

function base(over: Partial<TransferRow> = {}): TransferRow {
  return {
    chainId: 1, contract: COLL_A, tokenId: '1', amount: '1',
    fromAddr: ZERO, toAddr: WALLET, txHash: '0xtx1', blockNumber: 100,
    logIndex: 0, batchIndex: 0, txFrom: null, txValueWei: null,
    kind: 'mint', ...over,
  };
}

/**
 * A row whose transaction was NOT fetched — what every level writes for the rows
 * it does not enrich, and what `logs_only` writes for all of them.
 *
 * Built through `classify(..., null)` rather than by hard-coding a kind, because
 * the point of these tests is that the level is expressed in the ROWS. Hard-coding
 * would let the fixture disagree with the function under test.
 */
function unenrichedRow(
  over: Partial<TransferRow> & { fromAddr: string; toAddr: string },
): TransferRow {
  return base({
    ...over,
    txFrom: null,
    txValueWei: null,
    kind: classify({ from: over.fromAddr as Address, to: over.toAddr as Address }, null),
  });
}

/** A row whose transaction WAS fetched, classified with it. */
function enrichedRow(
  over: Partial<TransferRow> & { fromAddr: string; toAddr: string },
  tx: TxInfo,
): TransferRow {
  return base({
    ...over,
    txFrom: tx.from,
    txValueWei: tx.value.toString(),
    kind: classify({ from: over.fromAddr as Address, to: over.toAddr as Address }, tx),
  });
}

/**
 * The scenario the acting wallet exists for: one bot mints three tokens to three
 * fresh addresses, and one ordinary collector mints one to itself. Grouped by
 * recipient that reads as four minters; grouped by acting wallet, as two.
 */
function indexBotMints(level: 'logs_only' | 'mints_only'): void {
  setEnrichmentLevel(db, { chainId: 1, contract: COLL_A, level });
  const mints = FRESH.map((to, i) => ({
    fromAddr: ZERO, toAddr: to, txHash: `0xbot${i}`,
    blockNumber: 10 + i, tokenId: String(i + 1),
  }));
  const collector = {
    fromAddr: ZERO, toAddr: WALLET, txHash: '0xcol', blockNumber: 20, tokenId: '9',
  };
  insertTransfers(db, level === 'logs_only'
    ? [...mints, collector].map(unenrichedRow)
    : [
        ...mints.map((m) => enrichedRow(m, { from: BOT, value: 1n })),
        enrichedRow(collector, { from: WALLET, value: 1n }),
      ]);
}

describe('classify without a transaction', () => {
  it('returns unclassified, NOT transfer, for a movement needing the tx', () => {
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
  const insert = (over: Partial<TransferRow>) => () => insertTransfers(db, [base(over)]);

  it("rejects kind 'transfer' with no transaction — the silent downgrade", () => {
    expect(insert({ fromAddr: SELLER, toAddr: WALLET, kind: 'transfer' }))
      .toThrow(/CHECK constraint failed/);
  });

  it("rejects kind 'buy' with no transaction", () => {
    expect(insert({ fromAddr: SELLER, toAddr: WALLET, kind: 'buy' }))
      .toThrow(/CHECK constraint failed/);
  });

  it("rejects kind 'unclassified' when the transaction IS present", () => {
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
      base({ fromAddr: ZERO, toAddr: WALLET, kind: 'mint', txHash: '0xm' }),
      base({ fromAddr: SELLER, toAddr: ZERO, kind: 'burn', txHash: '0xb' }),
    ])).toBe(2);
  });

  it('rejects an unknown enrichment level', () => {
    expect(() => db.prepare(
      "INSERT INTO collections (chain_id, contract, enrichment_level) VALUES (1, ?, 'partial')",
    ).run('0x0000000000000000000000000000000000000009'))
      .toThrow(/CHECK constraint failed/);
  });
});

describe('a logs_only index (no transactions at all)', () => {
  it('cannot answer firstMinters, and refuses instead of reporting recipients', () => {
    // THE HEADLINE CASE for this level. tx_from is NULL on every mint, so there is
    // no acting wallet: the bot's three mints and the collector's one would read as
    // four unrelated minters.
    indexBotMints('logs_only');
    expect(() => firstMinters(db, { chainId: 1, contract: COLL_A, limit: 10 }))
      .toThrow(EnrichmentLevelError);
  });

  it('says how many mints are affected, the level, and the fix', () => {
    indexBotMints('logs_only');
    let message = '';
    try {
      firstMinters(db, { chainId: 1, contract: COLL_A, limit: 10 });
    } catch (err) { message = (err as Error).message; }
    expect(message).toContain('4 mint(s)');
    expect(message).toContain('logs_only');
    expect(message).toMatch(/only the RECIPIENT/);
    expect(message).toMatch(/re-index/i);
  });

  it('is never what an unconfigured collection gets', () => {
    expect(getEnrichmentLevel(db, 1, COLL_B)).toBe('full');
  });

  it('owes no fetches when it is itself the target', () => {
    indexBotMints('logs_only');
    expect(findTxHashesNeedingEnrichment(db, 1, COLL_A, 'logs_only')).toEqual([]);
  });
});

describe('a mints_only index (mints enriched, non-mints not)', () => {
  /** Wallet mints in A and BUYS in B; only the mint side is enriched. */
  function indexMintsOnly(): void {
    for (const contract of [COLL_A, COLL_B]) {
      setEnrichmentLevel(db, { chainId: 1, contract, level: 'mints_only' });
    }
    insertTransfers(db, [
      enrichedRow(
        { contract: COLL_A, fromAddr: ZERO, toAddr: WALLET, txHash: '0xa1', blockNumber: 10 },
        { from: WALLET, value: 1n },
      ),
      unenrichedRow(
        { contract: COLL_B, fromAddr: SELLER, toAddr: WALLET, txHash: '0xb1', blockNumber: 20 },
      ),
    ]);
  }

  it('answers firstMinters with tx_from POPULATED, not null', () => {
    // The requirement this level exists to satisfy.
    indexMintsOnly();
    const [first] = firstMinters(db, { chainId: 1, contract: COLL_A, limit: 10 });
    expect(first?.minter).toBe(WALLET);
    expect(first?.minter).not.toBeNull();
  });

  it('surfaces a mint whose sender differs from the receiver', () => {
    indexBotMints('mints_only');
    expect(firstMinters(db, { chainId: 1, contract: COLL_A, limit: 10 })).toEqual([
      {
        minter: BOT, firstRecipient: FRESH[0], recipients: 3, minted: 3,
        mintedToOthers: true, blockNumber: 10, logIndex: 0, batchIndex: 0, tokenId: '1',
      },
      {
        minter: WALLET, firstRecipient: WALLET, recipients: 1, minted: 1,
        mintedToOthers: false, blockNumber: 20, logIndex: 0, batchIndex: 0, tokenId: '9',
      },
    ]);
  });

  it('collapses one wallet minting to many addresses into ONE minter', () => {
    // Grouped by recipient this would be four rows and the bot would look like
    // three separate collectors.
    indexBotMints('mints_only');
    const rows = firstMinters(db, { chainId: 1, contract: COLL_A, limit: 10 });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.minter)).toEqual([BOT, WALLET]);
  });

  it('still REFUSES overlap, because non-mints are unclassified', () => {
    indexMintsOnly();
    expect(() => overlap(db, { chainId: 1, contracts: [COLL_A, COLL_B], minCollections: 2 }))
      .toThrow(EnrichmentLevelError);
  });

  it('blames only the collection actually holding unclassified rows', () => {
    indexMintsOnly();
    let message = '';
    try {
      overlap(db, { chainId: 1, contracts: [COLL_A, COLL_B], minCollections: 2 });
    } catch (err) { message = (err as Error).message; }
    expect(message).toContain(COLL_B);
    expect(message).not.toContain(COLL_A);
  });

  it('reports unclassified as its own count, never folded into transfer', () => {
    indexMintsOnly();
    expect(countByKind(db, 1, COLL_B)).toEqual({
      mint: 0, buy: 0, transfer: 0, burn: 0, unclassified: 1,
    });
  });

  it('owes only its mint transactions when it is the target', () => {
    indexBotMints('logs_only');
    insertTransfers(db, [unenrichedRow({
      contract: COLL_A, fromAddr: SELLER, toAddr: OTHER, txHash: '0xsale', blockNumber: 30,
    })]);
    expect(findTxHashesNeedingEnrichment(db, 1, COLL_A, 'mints_only').map((r) => r.txHash))
      .toEqual(['0xbot0', '0xbot1', '0xbot2', '0xcol']);
    // 'full' additionally owes the sale.
    expect(findTxHashesNeedingEnrichment(db, 1, COLL_A, 'full').map((r) => r.txHash))
      .toEqual(['0xbot0', '0xbot1', '0xbot2', '0xcol', '0xsale']);
  });

  it('never returns an unenriched row from findKnownTxs', () => {
    indexMintsOnly();
    expect(findKnownTxs(db, 1, ['0xb1']).size).toBe(0);
    expect(findKnownTxs(db, 1, ['0xa1']).size).toBe(1);
  });
});

describe('a full index', () => {
  function indexFull(): void {
    insertTransfers(db, [
      enrichedRow({ contract: COLL_A, fromAddr: ZERO, toAddr: WALLET, txHash: '0xa1', blockNumber: 10 },
        { from: WALLET, value: 1n }),
      enrichedRow({ contract: COLL_B, fromAddr: SELLER, toAddr: WALLET, txHash: '0xb1', blockNumber: 20 },
        { from: WALLET, value: 5n }),
    ]);
  }

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
      enrichedRow({ contract: COLL_A, fromAddr: ZERO, toAddr: ZERO, txHash: '0xa1' },
        { from: WALLET, value: 0n }),
    ]);
    expect(overlap(db, { chainId: 1, contracts: [COLL_A], minCollections: 1 })).toEqual([]);
  });

  it('rejects a checksummed contract argument rather than matching nothing', () => {
    expect(() => overlap(db, {
      chainId: 1, contracts: [COLL_A.toUpperCase().replace('0X', '0x')], minCollections: 1,
    })).toThrow(/must be lowercase/);
    expect(() => firstMinters(db, {
      chainId: 1, contract: COLL_A.toUpperCase().replace('0X', '0x'), limit: 1,
    })).toThrow(/must be lowercase/);
  });
});

describe('climbing the levels', () => {
  beforeEach(() => {
    setEnrichmentLevel(db, { chainId: 1, contract: COLL_B, level: 'logs_only' });
    insertTransfers(db, [
      unenrichedRow({ contract: COLL_B, fromAddr: ZERO, toAddr: FRESH[0]!, txHash: '0xb1', blockNumber: 10 }),
      unenrichedRow({ contract: COLL_B, fromAddr: SELLER, toAddr: WALLET, txHash: '0xb2', blockNumber: 20 }),
    ]);
  });

  it('logs_only -> mints_only fetches the mint and unblocks firstMinters', () => {
    expect(() => firstMinters(db, { chainId: 1, contract: COLL_B, limit: 5 }))
      .toThrow(EnrichmentLevelError);

    const owed = findTxHashesNeedingEnrichment(db, 1, COLL_B, 'mints_only');
    expect(owed.map((r) => r.txHash)).toEqual(['0xb1']);

    applyEnrichment(db, { chainId: 1, txs: new Map([['0xb1', { from: BOT, value: 2n }]]) });
    setEnrichmentLevel(db, { chainId: 1, contract: COLL_B, level: 'mints_only' });

    const [row] = firstMinters(db, { chainId: 1, contract: COLL_B, limit: 5 });
    expect(row?.minter).toBe(BOT);
    expect(row?.firstRecipient).toBe(FRESH[0]);
    expect(row?.mintedToOthers).toBe(true);

    // The sale is still unclassified, so overlap stays refused.
    expect(() => overlap(db, { chainId: 1, contracts: [COLL_B], minCollections: 1 }))
      .toThrow(EnrichmentLevelError);
  });

  it('mints_only -> full fetches ONLY what is still missing', () => {
    applyEnrichment(db, { chainId: 1, txs: new Map([['0xb1', { from: BOT, value: 2n }]]) });
    expect(findTxHashesNeedingEnrichment(db, 1, COLL_B, 'full').map((r) => r.txHash))
      .toEqual(['0xb2']);

    // Re-offering the already-enriched hash changes nothing.
    expect(applyEnrichment(db, {
      chainId: 1, txs: new Map([['0xb1', { from: OTHER, value: 999n }]]),
    })).toBe(0);
    expect(db.prepare("SELECT tx_from FROM transfers WHERE tx_hash = '0xb1'").get())
      .toEqual({ tx_from: BOT });
  });

  it('reaches a state where both queries answer', () => {
    applyEnrichment(db, {
      chainId: 1,
      txs: new Map([
        ['0xb1', { from: BOT, value: 2n }],
        ['0xb2', { from: WALLET, value: 7n }],
      ]),
    });
    setEnrichmentLevel(db, { chainId: 1, contract: COLL_B, level: 'full' });

    expect(countUnclassified(db, 1, COLL_B)).toBe(0);
    expect(countByKind(db, 1, COLL_B)).toEqual({
      mint: 1, buy: 1, transfer: 0, burn: 0, unclassified: 0,
    });
    expect(firstMinters(db, { chainId: 1, contract: COLL_B, limit: 5 })).toHaveLength(1);
    expect(overlap(db, { chainId: 1, contracts: [COLL_B], minCollections: 1 }))
      .toEqual([
        { address: WALLET, collections: 1 },
        { address: FRESH[0], collections: 1 },
      ]);
  });

  it('leaves a hash it was not given untouched, so the gates still refuse', () => {
    applyEnrichment(db, { chainId: 1, txs: new Map([['0xb1', { from: BOT, value: 1n }]]) });
    expect(countUnclassified(db, 1, COLL_B)).toBe(1);
    expect(() => overlap(db, { chainId: 1, contracts: [COLL_B], minCollections: 1 }))
      .toThrow(EnrichmentLevelError);
  });

  it('classifies a WETH sale as transfer once enriched, not as unclassified', () => {
    // A DECIDED zero is different from never having looked; the two must not
    // collapse into one state.
    applyEnrichment(db, { chainId: 1, txs: new Map([['0xb2', { from: WALLET, value: 0n }]]) });
    expect(db.prepare("SELECT kind FROM transfers WHERE tx_hash = '0xb2'").get())
      .toEqual({ kind: 'transfer' });
  });
});

describe('the gates are derived from rows, not from the level column', () => {
  it('lets overlap through when every transfer happened to be log-decidable', () => {
    // A mints_only collection holding only mints and burns has nothing
    // unclassified, so its overlap answer really is complete. Refusing on the
    // declared level alone would force a pointless re-index.
    setEnrichmentLevel(db, { chainId: 1, contract: COLL_A, level: 'mints_only' });
    insertTransfers(db, [
      enrichedRow({ contract: COLL_A, fromAddr: ZERO, toAddr: WALLET, txHash: '0xa1' },
        { from: WALLET, value: 1n }),
      enrichedRow({ contract: COLL_A, fromAddr: SELLER, toAddr: ZERO, txHash: '0xa2', logIndex: 1 },
        { from: SELLER, value: 0n }),
    ]);
    expect(getEnrichmentLevel(db, 1, COLL_A)).toBe('mints_only');
    expect(overlap(db, { chainId: 1, contracts: [COLL_A], minCollections: 1 }))
      .toEqual([{ address: WALLET, collections: 1 }]);
  });

  it('lets firstMinters through on a logs_only collection that has no mints', () => {
    setEnrichmentLevel(db, { chainId: 1, contract: COLL_A, level: 'logs_only' });
    insertTransfers(db, [
      unenrichedRow({ contract: COLL_A, fromAddr: SELLER, toAddr: WALLET, txHash: '0xa1' }),
    ]);
    expect(firstMinters(db, { chainId: 1, contract: COLL_A, limit: 5 })).toEqual([]);
  });

  it('passes requireFullEnrichment on an empty contract list', () => {
    expect(() => requireFullEnrichment(db, { chainId: 1, contracts: [], queryName: 'q' }))
      .not.toThrow();
  });

  it('ignores unclassified rows belonging to a collection not asked about', () => {
    insertTransfers(db, [
      unenrichedRow({ contract: COLL_B, fromAddr: SELLER, toAddr: WALLET, txHash: '0xb1' }),
    ]);
    expect(() => requireFullEnrichment(db, {
      chainId: 1, contracts: [COLL_A], queryName: 'overlap',
    })).not.toThrow();
  });

  it('ignores rows on a different chain', () => {
    db.prepare('INSERT INTO collections (chain_id, contract, standard) VALUES (8453, ?, ?)')
      .run(COLL_A, '721');
    insertTransfers(db, [
      unenrichedRow({ chainId: 8453, contract: COLL_A, fromAddr: SELLER, toAddr: WALLET, txHash: '0xz1' }),
      unenrichedRow({ chainId: 8453, contract: COLL_A, fromAddr: ZERO, toAddr: WALLET, txHash: '0xz2', logIndex: 1 }),
    ]);
    expect(() => requireFullEnrichment(db, {
      chainId: 1, contracts: [COLL_A], queryName: 'overlap',
    })).not.toThrow();
    expect(() => requireMintEnrichment(db, {
      chainId: 1, contract: COLL_A, queryName: 'firstMinters',
    })).not.toThrow();
  });
});
