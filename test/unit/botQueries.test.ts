import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import {
  handleFirstMinters, handleFirstRecipients, handleOverlap,
} from '../../src/bot/commands/queries.js';
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
  return {
    sent, docs,
    base: { replier, db, clock: manualClock(CLOCK_MS), defaultChainId: 1 },
  };
}

function collection(contract: string) {
  db.prepare(`
    INSERT INTO collections (chain_id, contract, standard, deploy_block, last_indexed_block)
    VALUES (1, ?, '721', 1, 100)
  `).run(contract);
}

let nextTx = 1;
function mint(contract: string, to: string, token: number, block: number): TransferRow {
  return {
    chainId: 1, contract, tokenId: String(token), amount: '1', fromAddr: ZERO, toAddr: to,
    txHash: `0x${String(nextTx++).padStart(64, '0')}`, blockNumber: block, logIndex: 0,
    batchIndex: 0, txFrom: to, txValueWei: '0', kind: 'mint',
  };
}

/** The rendered line for one row, exactly as `renderTable` writes it. */
function line(cells: Array<[string, string]>): string {
  return cells.map(([h, v]) => `${h}: ${v}`).join('  ');
}

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
    expect(sent[0]).toContain(line([
      ['minter', BOT], ['first recipient', WALLET], ['minted', '2'], ['recipients', '2'],
      ['to others', 'yes'], ['block', '10'], ['log', '0'],
    ]));
    expect(sent[0]).toContain(line([
      ['minter', WALLET], ['first recipient', WALLET], ['minted', '1'], ['recipients', '1'],
      ['to others', 'no'], ['block', '12'], ['log', '0'],
    ]));
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
    expect(sent[0]).toContain(`recipient: ${WALLET}`);

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
    expect(sent[0]).toContain(line([
      ['recipient', WALLET], ['minter', 'unknown (not enriched)'], ['received', '1'],
      ['block', '10'], ['log', '0'],
    ]));
  });

  it('names the minter once it IS enriched', async () => {
    const { base, sent } = setup();
    collection(A);
    insertTransfers(db, [{ ...mint(A, WALLET, 1, 10), txFrom: BOT }]);
    await handleFirstRecipients({ ...base, text: `/firstrecipients ${A}` });
    expect(sent[0]).toContain(line([
      ['recipient', WALLET], ['minter', BOT], ['received', '1'], ['block', '10'], ['log', '0'],
    ]));
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

  it('replies with the usage line when no address is given', async () => {
    const { base, sent } = setup();
    await handleFirstRecipients({ ...base, text: '/firstrecipients --chain 1' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('usage: /firstrecipients 0x… [--chain N] [--limit N]');
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
    expect(sent[0]).toContain(line([['wallet', WALLET], ['collections', '3']]));
    expect(sent[0]).toContain(line([['wallet', OTHER_WALLET], ['collections', '2']]));
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
