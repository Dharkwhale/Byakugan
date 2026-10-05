import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import {
  handleFirstMinters, handleFirstRecipients, handleOverlap, leastIndexedThrough,
} from '../../src/bot/commands/queries.js';
import { createJobRegistry } from '../../src/bot/jobs.js';
import { manualClock } from '../../src/clock.js';
import { openDb } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { insertTransfers } from '../../src/db/repositories/transfers.js';
import { setEnrichmentLevel } from '../../src/db/repositories/enrichment.js';
import type { Replier } from '../../src/bot/replier.js';
import type { TransferRow } from '../../src/types.js';

/** 40 hex digits after 0x, built rather than typed so a miscount cannot slip in. */
const addr = (digit: string, tail: string) =>
  `0x${digit.repeat(40 - tail.length)}${tail}`;
const A = addr('a', '1');
const B = addr('b', '2');
const C = addr('d', '3');
const WALLET = addr('c', 'e1');
const OTHER_WALLET = addr('e', 'f2');
const BOT = addr('f', '0b');
const ZERO = '0x0000000000000000000000000000000000000000';
const CLOCK_MS = 1_700_000_000_000;

let db: Database.Database;
beforeEach(() => {
  db = openDb(':memory:');
  runMigrations(db);
});

function setup() {
  const sent: string[] = [];
  const docs: Array<{ filename: string; contents: string; caption: string }> = [];
  const replier = {
    reply: vi.fn(async (t: string) => { sent.push(t); return { messageId: 1 }; }),
    edit: vi.fn(),
    sendDocument: vi.fn(async (d: { filename: string; contents: string; caption: string }) => {
      docs.push(d);
    }),
  } as unknown as Replier;
  const clock = manualClock(CLOCK_MS);
  const registry = createJobRegistry({ clock, staleMs: 900_000 });
  return {
    sent, docs, registry,
    base: { replier, db, clock, defaultChainId: 1, registry },
  };
}

function collection(contract: string, watermark = 100) {
  db.prepare(`
    INSERT INTO collections (chain_id, contract, standard, deploy_block, last_indexed_block)
    VALUES (1, ?, '721', 1, ?)
  `).run(contract, watermark);
}

let nextTx = 1;
function mint(contract: string, to: string, token: number, block: number): TransferRow {
  return {
    chainId: 1, contract, tokenId: String(token), amount: '1', fromAddr: ZERO, toAddr: to,
    txHash: `0x${String(nextTx++).padStart(64, '0')}`, blockNumber: block, logIndex: 0,
    batchIndex: 0, txFrom: to, txValueWei: '0', kind: 'mint',
  };
}

/** A non-mint whose transaction was never fetched, as a mints_only index leaves it. */
function unclassified(contract: string, to: string, token: number, block: number): TransferRow {
  return {
    ...mint(contract, to, token, block), fromAddr: BOT, txFrom: null, txValueWei: null,
    kind: 'unclassified',
  };
}

/** The rendered line for one row, exactly as `renderTable` writes it. */
/**
 * Builds the expected MESSAGE form of one row: rank, then each shown cell with its short
 * label. Pass the cells exactly as the renderer should emit them, label included, because the
 * labels are part of what is being asserted — a row that reads `received: 1  block: …` is the
 * old wide form and should fail here.
 *
 * Addresses are left as the caller writes them: short above five rows, full at or below, which
 * is the rule under test rather than something this helper should hide.
 */
function line(rank: number, cells: string[], rankWidth = 1): string {
  return `${String(rank).padStart(rankWidth)}  ${cells.join('   ')}`;
}


describe('the /firstminters header, per collection shape', () => {
  /*
   * The header carries the counts, the hoisted constant columns AND the one-sender
   * explanation, so it is its own code path with its own states. Enumerated: many senders,
   * one sender (which has two opposite causes the index cannot separate), and the counts
   * themselves.
   */
  it('MANY senders: counts, no explanation, minters per-row', async () => {
    const { base, sent } = setup();
    collection(A);
    insertTransfers(db, [
      { ...mint(A, WALLET, 1, 10), txFrom: BOT },
      { ...mint(A, OTHER_WALLET, 2, 11), txFrom: OTHER_WALLET },
    ]);
    await handleFirstMinters({ ...base, text: `/firstminters ${A}` });
    expect(sent[0]).toContain('2 mints');
    expect(sent[0]).toContain('2 sending wallets');
    expect(sent[0]).not.toMatch(/sent by one wallet/i);
    expect(sent[0]).toContain(BOT);
    expect(sent[0]).toContain(OTHER_WALLET);
  });

  it('ONE sender: names it, and states BOTH causes without choosing between them', async () => {
    // A deployer distributing and a relayer paying for real collectors both produce one
    // sender, and the index cannot tell them apart — so asserting "no meaningful answer"
    // would be true in only one of the two cases.
    const { base, sent } = setup();
    collection(A);
    insertTransfers(db, [
      { ...mint(A, WALLET, 1, 10), txFrom: BOT },
      { ...mint(A, OTHER_WALLET, 2, 11), txFrom: BOT },
    ]);
    await handleFirstMinters({ ...base, text: `/firstminters ${A}` });
    expect(sent[0]).toContain('1 sending wallet');
    expect(sent[0]).not.toContain('1 sending wallets');
    expect(sent[0]).toContain(`sent by one wallet, ${BOT}`);
    expect(sent[0]).toMatch(/deployer/);
    expect(sent[0]).toMatch(/relayer/);
    expect(sent[0]).toMatch(/cannot tell which/);
    expect(sent[0]).toContain('/firstrecipients');
    // The claim that is only sometimes true must NOT appear.
    expect(sent[0]).not.toMatch(/no meaningful answer/i);
  });

  it('reports mints and recipients as COUNTS, replacing the to-others boolean', async () => {
    const { base, sent } = setup();
    collection(A);
    insertTransfers(db, [
      { ...mint(A, WALLET, 1, 10), txFrom: BOT },
      { ...mint(A, OTHER_WALLET, 2, 11), txFrom: BOT },
    ]);
    await handleFirstMinters({ ...base, text: `/firstminters ${A}` });
    expect(sent[0]).toContain('2 mints → 2 wallets');
    expect(sent[0]).not.toContain('to others');
  });
});

describe('handleFirstMinters', () => {
  it('says NOT INDEXED, and that reply differs from an indexed collection with no mints', async () => {
    // An empty result and an unknown collection are different answers; rendering both as
    // "no rows" hides a missing index behind a plausible result. Both sides are asserted,
    // and that they differ, so collapsing either into the other fails here.
    const unknown = setup();
    await handleFirstMinters({ ...unknown.base, text: `/firstminters ${A}` });
    expect(unknown.sent[0]).toMatch(/not indexed/i);
    expect(unknown.sent[0]).toContain(`/index ${A} --chain 1`);

    const empty = setup();
    collection(A);
    await handleFirstMinters({ ...empty.base, text: `/firstminters ${A}` });
    expect(empty.sent[0]).toContain('(no rows)');
    expect(empty.sent[0]).not.toMatch(/not indexed/i);
    expect(empty.sent[0]).not.toContain('/index');

    expect(empty.sent[0]).not.toBe(unknown.sent[0]);
  });

  it('reports the minter with its first recipient and counts, in one row', async () => {
    const { base, sent } = setup();
    collection(A);
    insertTransfers(db, [
      { ...mint(A, WALLET, 1, 10), txFrom: BOT },
      { ...mint(A, OTHER_WALLET, 2, 11), txFrom: BOT },
      mint(A, WALLET, 3, 12),
    ]);
    await handleFirstMinters({ ...base, text: `/firstminters ${A}` });
    // BOT minted twice, to two recipients, neither of them itself; WALLET minted once for itself.
    // Two rows, so addresses stay FULL and the minter column is per-row because the minters
    // differ — the hoist must not fire here. `log` is absent from the message by design.
    // Two rows, so addresses stay FULL. The minters DIFFER so that column is per-row; the
    // first recipient happens to be the same wallet in both, so it HOISTS to the header —
    // both halves of the hoist rule in one fixture.
    expect(sent[0]).toContain(line(1, [BOT, '×2', 'to 2', 'blk 10']));
    expect(sent[0]).toContain(line(2, [WALLET, '×1', 'to 1', 'blk 12']));
    expect(sent[0]).toContain(`all first recipient: ${WALLET}`);
    // `log` is in the CSV only, and the boolean column is gone.
    expect(sent[0]).not.toContain('log: ');
    expect(sent[0]).not.toContain('to others');
  });

  it('sends a CSV when the output is long, named from the injected clock', async () => {
    const { base, docs } = setup();
    collection(A);
    insertTransfers(db, Array.from({ length: 300 }, (_, i) =>
      mint(A, `0x${String(i).padStart(40, '0')}`, i + 1, 10 + i)));
    await handleFirstMinters({ ...base, text: `/firstminters ${A} --limit 300` });
    expect(docs).toHaveLength(1);
    expect(docs[0]!.filename).toBe(`firstminters-1-${A}-${CLOCK_MS}.csv`);
  });

  it('surfaces the enrichment refusal with a next command', async () => {
    const { base, sent } = setup();
    collection(A);
    setEnrichmentLevel(db, { chainId: 1, contract: A, level: 'logs_only' });
    insertTransfers(db, [{ ...mint(A, WALLET, 1, 10), txFrom: null, txValueWei: null }]);
    await handleFirstMinters({ ...base, text: `/firstminters ${A}` });
    expect(sent[0]).toMatch(/minting wallet/i);
    expect(sent[0]).toContain(`next: /index ${A} --chain 1`);
  });

  it('answers on a mints_only index with an enriched mint and an unclassified non-mint', async () => {
    // mints_only is the level the CLI advertises for firstMinters: mints carry tx_from, and
    // the unclassified transfer is irrelevant to the question.
    const { base, sent } = setup();
    collection(A);
    setEnrichmentLevel(db, { chainId: 1, contract: A, level: 'mints_only' });
    insertTransfers(db, [
      { ...mint(A, WALLET, 1, 10), txFrom: BOT },
      unclassified(A, OTHER_WALLET, 2, 11),
    ]);
    await handleFirstMinters({ ...base, text: `/firstminters ${A}` });
    expect(sent[0]).toContain(line(1, [BOT, `→ ${WALLET}`, '×1', 'to 1', 'blk 10']));
  });

  it('answers on a logs_only index that holds no mints (the gate reads rows, not the level)', async () => {
    // A gate reading enrichment_level would refuse this. requireMintEnrichment derives from
    // the rows: with no mint missing its tx_from there is nothing to refuse over.
    const { base, sent } = setup();
    collection(A);
    setEnrichmentLevel(db, { chainId: 1, contract: A, level: 'logs_only' });
    insertTransfers(db, [unclassified(A, WALLET, 1, 10)]);
    await handleFirstMinters({ ...base, text: `/firstminters ${A}` });
    expect(sent[0]).toContain('(no rows)');
    expect(sent[0]).not.toMatch(/minting wallet/i);
  });

  it('states the block it was answered through', async () => {
    const { base, sent } = setup();
    collection(A, 4321);
    insertTransfers(db, [mint(A, WALLET, 1, 10)]);
    await handleFirstMinters({ ...base, text: `/firstminters ${A}` });
    expect(sent[0]).toContain('(chain 1)');
    expect(sent[0]).toContain('indexed through block 4321');
  });

  it('replies with the usage line when no address is given', async () => {
    const { base, sent } = setup();
    await handleFirstMinters({ ...base, text: '/firstminters --chain 1' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('usage: /firstminters 0x… [--chain N] [--limit N]');
  });
});

describe('handleFirstRecipients', () => {
  // THE ONLY TEST OF THE UNGATED PATH. Every other query refuses something: firstMinters
  // needs the acting wallet, overlap needs buys. This one answers from the log alone, and
  // it is what stops logs_only being a level that can be indexed and never queried.
  it('answers on a logs_only index, where firstMinters refuses', async () => {
    const { base, sent } = setup();
    collection(A);
    setEnrichmentLevel(db, { chainId: 1, contract: A, level: 'logs_only' });
    insertTransfers(db, [{ ...mint(A, WALLET, 1, 10), txFrom: null, txValueWei: null }]);

    await handleFirstRecipients({ ...base, text: `/firstrecipients ${A}` });
    expect(sent[0]).toContain(WALLET);

    await handleFirstMinters({ ...base, text: `/firstminters ${A}` });
    expect(sent[1]).toMatch(/minting wallet/i);
  });

  it('shows the minter as unknown rather than blank on a logs_only index', async () => {
    // tx_from is genuinely null here, and the minter cell must say so rather than render an
    // empty column that reads as an address nobody noticed was missing.
    const { base, sent } = setup();
    collection(A);
    setEnrichmentLevel(db, { chainId: 1, contract: A, level: 'logs_only' });
    insertTransfers(db, [{ ...mint(A, WALLET, 1, 10), txFrom: null, txValueWei: null }]);
    await handleFirstRecipients({ ...base, text: `/firstrecipients ${A}` });
    // One row: the minter is not hoisted (a single row has nothing to repeat) and the
    // address stays full.
    expect(sent[0]).toContain(line(1, [WALLET, 'by unknown (not enriched)', '×1', 'blk 10']));
  });

  it('names the minter once it IS enriched', async () => {
    const { base, sent } = setup();
    collection(A);
    insertTransfers(db, [{ ...mint(A, WALLET, 1, 10), txFrom: BOT }]);
    await handleFirstRecipients({ ...base, text: `/firstrecipients ${A}` });
    expect(sent[0]).toContain(line(1, [WALLET, `by ${BOT}`, '×1', 'blk 10']));
    expect(sent[0]).not.toContain('unknown');
  });

  it('says NOT INDEXED rather than returning an empty list', async () => {
    const { base, sent } = setup();
    await handleFirstRecipients({ ...base, text: `/firstrecipients ${A}` });
    expect(sent[0]).toMatch(/not indexed/i);
    expect(sent[0]).toContain(`/index ${A} --chain 1`);
  });

  it('says there are no recipients on an indexed collection with no mints', async () => {
    const { base, sent } = setup();
    collection(A);
    await handleFirstRecipients({ ...base, text: `/firstrecipients ${A}` });
    expect(sent[0]).toContain('(no rows)');
    expect(sent[0]).not.toMatch(/not indexed/i);
  });

  it('answers on a mints_only index with an enriched mint and an unclassified non-mint', async () => {
    const { base, sent } = setup();
    collection(A);
    setEnrichmentLevel(db, { chainId: 1, contract: A, level: 'mints_only' });
    insertTransfers(db, [
      { ...mint(A, WALLET, 1, 10), txFrom: BOT },
      unclassified(A, OTHER_WALLET, 2, 11),
    ]);
    await handleFirstRecipients({ ...base, text: `/firstrecipients ${A}` });
    expect(sent[0]).toContain(line(1, [WALLET, `by ${BOT}`, '×1', 'blk 10']));
  });

  it('sends a CSV when the output is long, named from the injected clock', async () => {
    const { base, docs } = setup();
    collection(A);
    insertTransfers(db, Array.from({ length: 300 }, (_, i) =>
      mint(A, `0x${String(i).padStart(40, '0')}`, i + 1, 10 + i)));
    await handleFirstRecipients({ ...base, text: `/firstrecipients ${A} --limit 300` });
    expect(docs).toHaveLength(1);
    expect(docs[0]!.filename).toBe(`firstrecipients-1-${A}-${CLOCK_MS}.csv`);
  });

  it('states the block it was answered through', async () => {
    const { base, sent } = setup();
    collection(A, 4321);
    insertTransfers(db, [mint(A, WALLET, 1, 10)]);
    await handleFirstRecipients({ ...base, text: `/firstrecipients ${A}` });
    expect(sent[0]).toContain('(chain 1)');
    expect(sent[0]).toContain('indexed through block 4321');
  });

  it('replies with the usage line when no address is given', async () => {
    const { base, sent } = setup();
    await handleFirstRecipients({ ...base, text: '/firstrecipients --chain 1' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('usage: /firstrecipients 0x… [--chain N] [--limit N]');
  });
});

describe('extra arguments are refused, not silently dropped', () => {
  /*
   * The defect this fixes: /firstminters 0xA 0xB answered about 0xA and said nothing about
   * 0xB, while /status refused the identical shape. Answering a question nobody asked is the
   * same family as the visibility bugs — the reply looks complete and the omission is
   * invisible. The rule now lives in parseQueryCommand, the one path all four commands share,
   * so a command added later cannot forget it.
   */
  for (const [name, handler] of [
    ['firstminters', handleFirstMinters],
    ['firstrecipients', handleFirstRecipients],
  ] as const) {
    it(`/${name} refuses TWO addresses instead of answering about the first`, async () => {
      const { base, sent } = setup();
      collection(A); collection(B);
      insertTransfers(db, [mint(A, WALLET, 1, 10), mint(B, WALLET, 2, 11)]);
      await handler({ ...base, text: `/${name} ${A} ${B}` });
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain('takes ONE address and you sent 2');
      expect(sent[0]).toContain(A);
      expect(sent[0]).toContain(B);
      // The thing that used to happen must not: no answer about either collection. Asserted
      // on the answer's CONTENT — the wallet — because the usage line legitimately contains
      // the words "minter" and "recipients", so a word-level negative would fail on the
      // refusal itself and prove nothing.
      expect(sent[0]).not.toContain(WALLET);
    });

    it(`/${name} refuses --min, which it does not read`, async () => {
      const { base, sent } = setup();
      collection(A);
      await handler({ ...base, text: `/${name} ${A} --min 3` });
      expect(sent[0]).toContain('--min does not apply to this command');
    });
  }

  it('/overlap refuses --limit, which it does not read', async () => {
    // It used to accept it, discard it, and not even list it in the usage line.
    const { base, sent } = setup();
    collection(A); collection(B);
    await handleOverlap({ ...base, text: `/overlap ${A} ${B} --limit 50` });
    expect(sent[0]).toContain('--limit does not apply to this command');
  });

  it('/overlap still takes MANY addresses, which is the point of the arity being per command', async () => {
    const { base, sent } = setup();
    collection(A); collection(B);
    insertTransfers(db, [mint(A, WALLET, 1, 10), mint(B, WALLET, 2, 11)]);
    await handleOverlap({ ...base, text: `/overlap ${A} ${B}` });
    expect(sent[0]).toContain(WALLET);
    expect(sent[0]).not.toContain('takes ONE address');
  });

  it('a repeated address is ONE address, because the dedupe runs first', async () => {
    const { base, sent } = setup();
    collection(A);
    insertTransfers(db, [mint(A, WALLET, 1, 10)]);
    await handleFirstMinters({ ...base, text: `/firstminters ${A} ${A}` });
    // The user named one collection, twice. Refusing that would be pedantry.
    expect(sent[0]).not.toContain('takes ONE address');
    expect(sent[0]).toContain(WALLET);
  });
});

describe('handleOverlap', () => {
  it('requires at least two collections', async () => {
    const { base, sent } = setup();
    await handleOverlap({ ...base, text: `/overlap ${A}` });
    expect(sent[0]).toMatch(/at least two/i);
  });

  it('treats a repeated address as one collection', async () => {
    const { base, sent } = setup();
    await handleOverlap({ ...base, text: `/overlap ${A} ${A}` });
    expect(sent[0]).toMatch(/at least two/i);
  });

  it('replies with the usage line when no address is given', async () => {
    const { base, sent } = setup();
    await handleOverlap({ ...base, text: '/overlap --chain 1' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('usage: /overlap 0x… 0x… [--chain N] [--min N]');
  });

  it('names every collection that is not indexed, and only those', async () => {
    const { base, sent } = setup();
    collection(A);
    await handleOverlap({ ...base, text: `/overlap ${A} ${B}` });
    expect(sent[0]).toContain(`  ${B} — not indexed`);
    expect(sent[0]).not.toContain(`  ${A} — not indexed`);
  });

  it('reports each wallet with its own collection count', async () => {
    const { base, sent } = setup();
    collection(A); collection(B); collection(C);
    insertTransfers(db, [
      mint(A, WALLET, 1, 10), mint(B, WALLET, 2, 11), mint(C, WALLET, 3, 12),
      mint(A, OTHER_WALLET, 4, 13), mint(B, OTHER_WALLET, 5, 14),
    ]);
    await handleOverlap({ ...base, text: `/overlap ${A} ${B} ${C}` });
    expect(sent[0]).toContain(line(1, [WALLET, 'in 3']));
    expect(sent[0]).toContain(line(2, [OTHER_WALLET, 'in 2']));
  });

  it('REFUSES on a mints_only index and names the re-index as the next action', async () => {
    // A mints_only index holds unclassified transfers, so a buy cannot be told from a plain
    // transfer. Answering anyway would score a wallet that bought seven collections as zero;
    // the reply has to be a refusal, not an empty table.
    const { base, sent } = setup();
    collection(A); collection(B);
    setEnrichmentLevel(db, { chainId: 1, contract: A, level: 'mints_only' });
    setEnrichmentLevel(db, { chainId: 1, contract: B, level: 'mints_only' });
    insertTransfers(db, [
      mint(A, WALLET, 1, 10), mint(B, WALLET, 2, 11),
      {
        ...mint(A, OTHER_WALLET, 3, 12), fromAddr: BOT, txFrom: null, txValueWei: null,
        kind: 'unclassified',
      },
    ]);
    await handleOverlap({ ...base, text: `/overlap ${A} ${B}` });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/needs fully enriched data/);
    expect(sent[0]).toContain(`next: /index ${A} --chain 1`);
    expect(sent[0]).not.toContain('(no rows)');
    expect(sent[0]).not.toContain(`wallet: ${WALLET}`);
  });

  it('offers a re-index for the collection that is short of data, and not the others', async () => {
    // A is fully enriched, B is mints_only with an unclassified row. The reply names B, so the
    // tappable action must be B's re-index; offering contracts[0] would re-index A for nothing.
    const { base, sent } = setup();
    collection(A); collection(B);
    setEnrichmentLevel(db, { chainId: 1, contract: B, level: 'mints_only' });
    insertTransfers(db, [
      mint(A, WALLET, 1, 10), mint(B, WALLET, 2, 11), unclassified(B, OTHER_WALLET, 3, 12),
    ]);
    await handleOverlap({ ...base, text: `/overlap ${A} ${B}` });
    const next = sent[0]!.split('\n').find((l) => l.trim().startsWith('next:'));
    expect(next?.trim()).toBe(`next: /index ${B} --chain 1`);
    expect(next).not.toContain(A);
  });

  it('answers on a mints_only index with no unclassified rows (the gate reads rows, not the level)', async () => {
    // A gate reading enrichment_level would refuse this; every transfer here is a mint, so
    // nothing is missing and the answer is complete.
    const { base, sent } = setup();
    collection(A); collection(B);
    setEnrichmentLevel(db, { chainId: 1, contract: A, level: 'mints_only' });
    setEnrichmentLevel(db, { chainId: 1, contract: B, level: 'mints_only' });
    insertTransfers(db, [mint(A, WALLET, 1, 10), mint(B, WALLET, 2, 11)]);
    await handleOverlap({ ...base, text: `/overlap ${A} ${B}` });
    expect(sent[0]).toContain(line(1, [WALLET, 'in 2']));
    expect(sent[0]).not.toMatch(/needs fully enriched/);
  });

  it('sends a CSV when the output is long, named from the injected clock', async () => {
    const { base, docs } = setup();
    collection(A); collection(B);
    const wallets = Array.from({ length: 300 }, (_, i) => `0x${String(i + 1).padStart(40, '0')}`);
    insertTransfers(db, [
      ...wallets.map((w, i) => mint(A, w, i + 1, 10 + i)),
      ...wallets.map((w, i) => mint(B, w, 1000 + i, 10 + i)),
    ]);
    await handleOverlap({ ...base, text: `/overlap ${A} ${B}` });
    expect(docs).toHaveLength(1);
    expect(docs[0]!.filename).toBe(`overlap-1-2-${CLOCK_MS}.csv`);
  });

  it('treats an UNKNOWN watermark as unknown, not as the smallest readable one', () => {
    // Tested directly: every handler pre-checks notIndexed and returns early, so this
    // branch is unreachable through the bot and a mutant that ignored the unknown survived
    // the entire suite. Returning 77 here would overstate the answer's reach using exactly
    // the collection we know least about.
    collection(A, 4321);
    expect(leastIndexedThrough(db, 1, [A])).toBe(4321);
    expect(leastIndexedThrough(db, 1, [A, B])).toBe('unknown');
    expect(leastIndexedThrough(db, 1, [])).toBe('unknown');
  });

  it('states the LEAST-indexed block, since that is the limit on the whole answer', async () => {
    // Not the highest and not a list. A wallet whose acquisition sits above the lowest
    // watermark is undercounted, so the minimum is the binding constraint on an overlap
    // answer. 4321 appearing instead would overstate how complete the answer is.
    const { base, sent } = setup();
    collection(A, 4321); collection(B, 77);
    insertTransfers(db, [mint(A, WALLET, 1, 10), mint(B, WALLET, 2, 11)]);
    await handleOverlap({ ...base, text: `/overlap ${A} ${B}` });
    expect(sent[0]).toContain('indexed through block 77 at the least');
    expect(sent[0]).not.toContain('4321');
  });

  it('keeps the title BOUNDED as collections are added, because it becomes the caption', async () => {
    // The title is the document caption, and Telegram rejects an over-long one — so an
    // answer too big for a message would have become no answer at all. A per-collection
    // watermark list grew with the input; the minimum does not. 30 collections here: well
    // past where a list would have blown the caption limit.
    const { base, sent } = setup();
    const many = Array.from({ length: 30 }, (_, i) => `0x${String(i + 1).padStart(40, 'd')}`);
    for (const c of many) collection(c, 500 + many.indexOf(c));
    insertTransfers(db, many.map((c, i) => mint(c, WALLET, i + 1, 10 + i)));
    await handleOverlap({ ...base, text: `/overlap ${many.join(' ')}` });
    const title = sent[0]!.split('\n')[0]!;
    expect(title.length).toBeLessThan(200);
    expect(title).toContain('30 collections');
    expect(title).toContain('indexed through block 500 at the least');
  });

  it('says so when two fully indexed collections share no wallet', async () => {
    const { base, sent } = setup();
    collection(A); collection(B);
    insertTransfers(db, [mint(A, WALLET, 1, 10), mint(B, OTHER_WALLET, 2, 11)]);
    await handleOverlap({ ...base, text: `/overlap ${A} ${B}` });
    expect(sent[0]).toContain('(no rows)');
    expect(sent[0]).not.toMatch(/not indexed/i);
    expect(sent[0]).not.toContain('wallet:');
  });
});

describe('a query answered mid-backfill says so, and still answers', () => {
  // Three numbers that can only come from where they are claimed to: the WATERMARK (the
  // collection row) is what the answer covers; the registry's `lastBlock` is job progress
  // and the registry's `source` names the fetch path. They are all different, so a notice
  // that read the wrong one fails on the value, not merely on the word "indexing".
  const WATERMARK_A = 7_777;
  const WATERMARK_B = 5_555;
  const JOB_BLOCK = 9_001;

  function running(registry: ReturnType<typeof setup>['registry'], contract: string, lastBlock = JOB_BLOCK) {
    const handle = registry.claim({ chainId: 1, contract, source: 'getAssetTransfers' });
    registry.note({ chainId: 1, contract, lastBlock });
    return handle;
  }

  it('/firstminters: the notice AND the populated rows', async () => {
    const { base, sent, registry } = setup();
    collection(A, WATERMARK_A);
    insertTransfers(db, [{ ...mint(A, WALLET, 1, 10), txFrom: BOT }]);
    running(registry, A);
    await handleFirstMinters({ ...base, text: `/firstminters ${A}` });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(
      'INDEXING IN PROGRESS (via getAssetTransfers, now at block 9001): ' +
      'this answer covers blocks up to 7777 only and may change.',
    );
    expect(sent[0]).toContain(`indexed through block ${WATERMARK_A}`);   // the existing watermark kept
    expect(sent[0]).toContain(BOT);                          // and the answer is given
    expect(sent[0]).not.toContain('(no rows)');
  });

  it('/firstrecipients: the notice AND the populated rows', async () => {
    const { base, sent, registry } = setup();
    collection(A, WATERMARK_A);
    insertTransfers(db, [mint(A, WALLET, 1, 10)]);
    running(registry, A);
    await handleFirstRecipients({ ...base, text: `/firstrecipients ${A}` });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(
      'INDEXING IN PROGRESS (via getAssetTransfers, now at block 9001): ' +
      'this answer covers blocks up to 7777 only and may change.',
    );
    expect(sent[0]).toContain(`indexed through block ${WATERMARK_A}`);
    expect(sent[0]).toContain(WALLET);
  });

  it('/overlap: one running collection of two counts, and the notice names the LEAST block', async () => {
    const { base, sent, registry } = setup();
    collection(A, WATERMARK_A); collection(B, WATERMARK_B);
    insertTransfers(db, [mint(A, WALLET, 1, 10), mint(B, WALLET, 2, 11)]);
    running(registry, A);      // A is running; B (the least-indexed) is not
    await handleOverlap({ ...base, text: `/overlap ${A} ${B}` });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(
      'INDEXING IN PROGRESS on 1 of 2 collections: ' +
      'this answer covers blocks up to 5555 only and may change.',
    );
    expect(sent[0]).toContain('indexed through block 5555 at the least');
    expect(sent[0]).toContain(line(1, [WALLET, 'in 2']));
  });

  it('/overlap: a job on the OTHER collection counts too, and on both says 2 of 2', async () => {
    const other = setup();
    collection(A, WATERMARK_A); collection(B, WATERMARK_B);
    insertTransfers(db, [mint(A, WALLET, 1, 10), mint(B, WALLET, 2, 11)]);
    running(other.registry, B);
    await handleOverlap({ ...other.base, text: `/overlap ${A} ${B}` });
    expect(other.sent[0]).toContain('INDEXING IN PROGRESS on 1 of 2 collections');

    const both = setup();
    running(both.registry, A); running(both.registry, B);
    await handleOverlap({ ...both.base, text: `/overlap ${A} ${B}` });
    expect(both.sent[0]).toContain('INDEXING IN PROGRESS on 2 of 2 collections');
    expect(both.sent[0]).toContain(line(1, [WALLET, 'in 2']));
  });

  it('says nothing about indexing when no job is running, including over an orphaned lock', async () => {
    const { base, sent } = setup();
    collection(A, WATERMARK_A);
    // A lock row with no job in this process: nothing is indexing, so a notice would be false.
    db.prepare('UPDATE collections SET locked_by = ?, locked_at = ? WHERE contract = ?')
      .run('dead-job', 1, A);
    insertTransfers(db, [mint(A, WALLET, 1, 10)]);
    await handleFirstRecipients({ ...base, text: `/firstrecipients ${A}` });
    expect(sent[0]).toContain(WALLET);
    expect(sent[0]).not.toMatch(/INDEXING IN PROGRESS/i);
  });

  it('a running job with no committed blocks yet says so, rather than "not indexed"', async () => {
    // Bootstrap is still resolving the deploy block: no watermark exists, so there is nothing
    // to answer from. That is not "never indexed", and /index would be refused as a duplicate.
    const { base, sent, registry } = setup();
    registry.claim({ chainId: 1, contract: A, source: 'getLogs' });
    await handleFirstMinters({ ...base, text: `/firstminters ${A}` });
    expect(sent[0]).toMatch(/is being indexed, but no blocks are indexed yet/);
    expect(sent[0]).not.toContain(`/index ${A}`);

    const overlapped = setup();
    overlapped.registry.claim({ chainId: 1, contract: A, source: 'getLogs' });
    collection(B);
    await handleOverlap({ ...overlapped.base, text: `/overlap ${A} ${B}` });
    expect(overlapped.sent[0]).toContain(`${A} — indexing, no blocks indexed yet`);
    expect(overlapped.sent[0]).not.toContain(`/index ${A}`);
  });

  it('keeps the notice inside the caption bound on a wide /overlap that goes to a document', async () => {
    const { base, docs, registry } = setup();
    const many = Array.from({ length: 30 }, (_, i) => addr('1', String(i).padStart(2, '0')));
    many.forEach((c) => collection(c, 100));
    insertTransfers(db, many.flatMap((c, i) => [
      mint(c, WALLET, 1000 + i, 10), ...Array.from({ length: 20 }, (_, k) => mint(c, addr('2', `${i}${k}`), k, 11)),
    ]));
    running(registry, many[0]!);
    await handleOverlap({ ...base, text: `/overlap ${many.join(' ')} --min 1` });
    expect(docs).toHaveLength(1);
    expect(docs[0]!.caption.length).toBeLessThanOrEqual(1024);
  });
});
