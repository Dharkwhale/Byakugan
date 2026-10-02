import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { handleStatus } from '../../src/bot/commands/status.js';
import { createJobRegistry } from '../../src/bot/jobs.js';
import { manualClock } from '../../src/clock.js';
import { openDb } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { insertTransfers } from '../../src/db/repositories/transfers.js';
import type { Replier } from '../../src/bot/replier.js';

const ADDR = '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d';
const MINTER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ZERO = '0x0000000000000000000000000000000000000000';
const STALE = 900_000;
/** U+202E RIGHT-TO-LEFT OVERRIDE, written as an escape so it cannot be lost in an editor. */
const RLO = '‮';

let db: Database.Database;
beforeEach(() => { db = openDb(':memory:'); runMigrations(db); });

function setup() {
  const sent: string[] = [];
  const replier = {
    reply: vi.fn(async (t: string) => { sent.push(t); return { messageId: 1 }; }),
    edit: vi.fn(), sendDocument: vi.fn(),
  } as unknown as Replier;
  const clock = manualClock(600_000);
  return {
    sent, clock,
    base: {
      replier, db, clock, defaultChainId: 1, staleMs: STALE,
      registry: createJobRegistry({ clock, staleMs: STALE }),
    },
  };
}

function indexed(name: string | null = 'Test Collection', level = 'full') {
  db.prepare(`
    INSERT INTO collections
      (chain_id, contract, standard, name, deploy_block, deploy_block_source,
       deploy_block_validated, enrichment_level, last_indexed_block)
    VALUES (1, ?, '721', ?, 100, 'binary_search', 1, ?, 500)
  `).run(ADDR, name, level);
  insertTransfers(db, [{
    chainId: 1, contract: ADDR, tokenId: '1', amount: '1', fromAddr: ZERO, toAddr: MINTER,
    txHash: '0xtx', blockNumber: 200, logIndex: 0, batchIndex: 0,
    txFrom: MINTER, txValueWei: '0', kind: 'mint',
  }]);
}

/** Locks the row as a dead process would have, at epoch ms `lockedAt`. */
function lock(lockedAt: number) {
  db.prepare('UPDATE collections SET locked_by = ?, locked_at = ? WHERE contract = ?')
    .run('dead', lockedAt, ADDR);
}

describe('handleStatus', () => {
  it('says a collection is not indexed, and names /index', async () => {
    const { base, sent } = setup();
    await handleStatus({ ...base, text: `/status ${ADDR}` });
    expect(sent[0]).toMatch(/not indexed/i);
    expect(sent[0]).toContain(`/index ${ADDR}`);
  });

  it('reports standard, deploy block, watermark, recorded level and counts', async () => {
    const { base, sent } = setup();
    indexed();
    await handleStatus({ ...base, text: `/status ${ADDR}` });
    expect(sent[0]).toContain('Test Collection');
    expect(sent[0]).toContain('chain 1, ERC-721');
    expect(sent[0]).toContain('deploy block 100 (binary_search, validated)');
    expect(sent[0]).toContain('indexed through 500, recorded level full');
    expect(sent[0]).toContain('mint 1  buy 0  transfer 0  burn 0  unclassified 0');
    // The level column records an intent; with no unclassified rows nothing may claim more.
    expect(sent[0]).not.toMatch(/complete/i);
  });

  it('SANITISES the collection name: one line, no bidi override', async () => {
    const { base, sent } = setup();
    indexed(`Evil\nCollection${RLO}`);
    await handleStatus({ ...base, text: `/status ${ADDR}` });
    // A newline surviving inside the name would split this first line.
    expect(sent[0]!.split('\n')[0]).toBe(`Evil Collection  ${ADDR}`);
    expect(sent[0]).not.toContain(RLO);
  });

  it('shows unclassified rows as unclassified, and says the other counts are incomplete', async () => {
    const { base, sent } = setup();
    indexed('Test Collection', 'mints_only');
    insertTransfers(db, [3, 4].map((n) => ({
      chainId: 1, contract: ADDR, tokenId: String(n), amount: '1', fromAddr: MINTER,
      toAddr: OTHER, txHash: `0xu${n}`, blockNumber: 300 + n, logIndex: 0,
      batchIndex: 0, txFrom: null, txValueWei: null, kind: 'unclassified' as const,
    })));
    await handleStatus({ ...base, text: `/status ${ADDR}` });
    expect(sent[0]).toContain('mint 1  buy 0  transfer 0  burn 0  unclassified 2');
    expect(sent[0]).toContain('2 transfers are not yet classified');
    expect(sent[0]).toContain('recorded level mints_only');
  });

  it('reports a running job with its elapsed time and fetch path', async () => {
    const { base, sent, clock } = setup();
    indexed();
    base.registry.start({
      chainId: 1, contract: ADDR, source: 'getAssetTransfers',
      run: () => new Promise(() => undefined),
    });
    clock.advance(3 * 60_000);
    await handleStatus({ ...base, text: `/status ${ADDR}` });
    expect(sent[0]).toContain('indexing now, started 3 minutes ago, via getAssetTransfers');
  });

  it('reports a live orphaned lock as nothing running, with minutes to expiry', async () => {
    const { base, sent } = setup();
    indexed();
    lock(0); // expiresAt 900000, now 600000
    await handleStatus({ ...base, text: `/status ${ADDR}` });
    expect(sent[0]).toContain('nothing is indexing it');
    expect(sent[0]).toContain('expires in 5 minutes');
    expect(sent[0]).not.toContain('indexing now');
  });

  it('treats now == expiresAt as still live, as /index does', async () => {
    const { base, sent, clock } = setup();
    indexed();
    lock(0);
    clock.set(STALE);
    await handleStatus({ ...base, text: `/status ${ADDR}` });
    expect(sent[0]).toContain('expires in 0 minutes');
  });

  it('reports an EXPIRED lock as expired, not as expiring in 0 minutes', async () => {
    const { base, sent, clock } = setup();
    indexed();
    lock(0);
    clock.set(STALE + 1);
    await handleStatus({ ...base, text: `/status ${ADDR}` });
    expect(sent[0]).toContain('the lock has expired; the next /index will clear it');
    expect(sent[0]).not.toMatch(/expires in/);
  });

  it('reports an expired lock on a collection that never finished bootstrapping', async () => {
    const { base, sent, clock } = setup();
    db.prepare('INSERT INTO collections (chain_id, contract, locked_by, locked_at) VALUES (1, ?, ?, 0)')
      .run(ADDR, 'dead');
    clock.set(STALE + 1);
    await handleStatus({ ...base, text: `/status ${ADDR}` });
    expect(sent[0]).toMatch(/not indexed/i);
    expect(sent[0]).toContain('the lock has expired; the next /index will clear it');
  });

  it('lists indexed collections when given no address', async () => {
    const { base, sent } = setup();
    indexed();
    await handleStatus({ ...base, text: '/status' });
    expect(sent[0]).toContain(`chain 1  ${ADDR}  recorded level full  through 500`);
  });

  it('treats `/status --chain 1` as the list, not as a malformed address query', async () => {
    const { base, sent } = setup();
    indexed();
    await handleStatus({ ...base, text: '/status --chain 1' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('Indexed collections');
    expect(sent[0]).toContain(ADDR);
  });

  it('says so when nothing has been indexed at all', async () => {
    const { base, sent } = setup();
    await handleStatus({ ...base, text: '/status' });
    expect(sent[0]).toMatch(/nothing indexed yet/i);
  });

  it('replies to an invalid address rather than throwing', async () => {
    const { base, sent } = setup();
    await handleStatus({ ...base, text: '/status 0xnope' });
    expect(sent[0]).toContain('"0xnope" is not a valid address');
  });

  it('refuses more than one address', async () => {
    const { base, sent } = setup();
    await handleStatus({ ...base, text: `/status ${ADDR} ${MINTER}` });
    expect(sent[0]).toContain('/status takes one address');
  });
});
