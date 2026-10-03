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
/**
 * U+202E RIGHT-TO-LEFT OVERRIDE, written as an ESCAPE and not as the character itself.
 *
 * The character is invisible, so a literal here is a Trojan-source hazard in the very file
 * that tests the defence against it, and an editor or formatter that strips it would turn
 * `RLO` into the empty string — at which point `not.toContain(RLO)` fails on every input.
 */
const RLO = '\u202e';

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

  it('offers BOTH readings of a live lock, because the table cannot tell them apart', async () => {
    // It used to say "nothing is indexing it", which the data does not support: a lock held
    // by a live CLI run against the same database is indistinguishable from one a crashed
    // process left. The false half is the costly one — advanceWatermark refreshes locked_at
    // every chunk, so a live run's lock never goes stale and "wait N minutes" never comes true.
    const { base, sent } = setup();
    indexed();
    lock(0); // expiresAt 900000, now 600000
    await handleStatus({ ...base, text: `/status ${ADDR}` });
    expect(sent[0]).toContain('a lock is held and this process is not the holder');
    expect(sent[0]).toContain('job dead');            // names the holder from the lock row
    expect(sent[0]).toMatch(/another process/i);      // the reading that used to be missing
    expect(sent[0]).toContain('goes stale in 5 minutes');
    expect(sent[0]).not.toContain('nothing is indexing it');
    expect(sent[0]).not.toContain('indexing now');
  });

  it('treats now == expiresAt as still live, as /index does', async () => {
    const { base, sent, clock } = setup();
    indexed();
    lock(0);
    clock.set(STALE);
    await handleStatus({ ...base, text: `/status ${ADDR}` });
    expect(sent[0]).toContain('goes stale in 0 minutes');
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

  it('IGNORES a typed --chain on the list, and says the list spans every chain', async () => {
    // The whole reason the heading reads "(all chains)" is that this branch never reads the
    // options. Without this test an implementation that filtered by `--chain` and printed
    // "(chain 1)" would pass the suite, so the stated reason would be unasserted.
    const { base, sent } = setup();
    indexed();
    db.prepare(`
      INSERT INTO collections
        (chain_id, contract, standard, name, deploy_block, deploy_block_source,
         deploy_block_validated, enrichment_level, last_indexed_block)
      VALUES (137, ?, '721', 'Polygon One', 7, 'binary_search', 1, 'full', 9)
    `).run(OTHER);
    await handleStatus({ ...base, text: '/status --chain 1' });
    expect(sent[0]).toContain('(all chains)');
    expect(sent[0]).toContain(ADDR);
    expect(sent[0]).toContain(OTHER);
    expect(sent[0]).toContain('chain 137');
  });

  it('SAYS SO when the list is truncated, rather than showing a subset as the whole set', async () => {
    // A capped list under a heading that reads as everything is an undercount wearing the
    // shape of a right answer. The total has to be visible.
    const { base, sent } = setup();
    for (let i = 0; i < 23; i++) {
      const addr = `0x${i.toString(16).padStart(40, 'c')}`;
      db.prepare(`
        INSERT INTO collections
          (chain_id, contract, standard, name, deploy_block, deploy_block_source,
           deploy_block_validated, enrichment_level, last_indexed_block)
        VALUES (1, ?, '721', 'C', 1, 'binary_search', 1, 'full', 2)
      `).run(addr);
    }
    await handleStatus({ ...base, text: '/status' });
    expect(sent[0]).toContain('most recent 20 of 23');
    expect(sent[0]!.split('\n').filter((l) => l.startsWith('chain '))).toHaveLength(20);
  });

  it('REPORTS a running job on a collection that has not bootstrapped yet', async () => {
    // getCollection reads not_indexed until `standard` is set, and the deploy-block search
    // runs before that — the longest part of a first index. Reporting only "not indexed"
    // there hides the live job and invites a second /index for work already under way.
    const { base, sent, clock } = setup();
    base.registry.start({
      chainId: 1, contract: ADDR, source: 'getAssetTransfers',
      run: () => new Promise(() => undefined),
    });
    clock.advance(180_000);
    await handleStatus({ ...base, text: `/status ${ADDR}` });
    expect(sent[0]).toMatch(/indexing now/i);
    expect(sent[0]).toContain('3 minutes ago');
    expect(sent[0]).toContain('via getAssetTransfers');
    // The pointer to /index must NOT appear: following it is the one wrong move here.
    expect(sent[0]).not.toContain(`/index ${ADDR}`);
  });

  /*
   * The no-address branch has its own states, and they went unenumerated while the
   * address branch's seven were all covered. This is the fourth appearance of the defect
   * CLAUDE.md records three times: a live first index writes no `collections` row until its
   * deploy-block search ends, so a registry-blind list reported "Nothing indexed yet. Start
   * with /index" to someone whose job was already running.
   */
  describe('the list branch, in every state it can occupy', () => {
    function startJob(contract: string, source = 'getAssetTransfers') {
      const { base, sent, clock } = setup();
      base.registry.claim({ chainId: 1, contract, source })!.run({
        run: () => new Promise(() => undefined),
      });
      return { base, sent, clock };
    }

    it('EMPTY and idle: says nothing is indexed and points at /index', async () => {
      const { base, sent } = setup();
      await handleStatus({ ...base, text: '/status' });
      expect(sent[0]).toMatch(/nothing indexed yet/i);
      expect(sent[0]).toContain('/index');
    });

    it('EMPTY while a first index runs: names the job, and does NOT say to start one', async () => {
      const { base, sent, clock } = startJob(ADDR);
      clock.advance(240_000);
      await handleStatus({ ...base, text: '/status' });
      expect(sent[0]).toMatch(/1 job\(s\) are running/);
      expect(sent[0]).toContain(ADDR);
      expect(sent[0]).toContain('4 minutes ago');
      expect(sent[0]).toContain('via getAssetTransfers');
      expect(sent[0]).toContain('no blocks indexed yet');
      // The whole point: the old reply told the user to start the job they had started.
      expect(sent[0]).not.toMatch(/nothing indexed yet/i);
      expect(sent[0]).not.toMatch(/Start with \/index/);
    });

    it('POPULATED while another collection bootstraps: shows both', async () => {
      const { base, sent, clock } = startJob(OTHER);
      indexed();
      clock.advance(60_000);
      await handleStatus({ ...base, text: '/status' });
      expect(sent[0]).toContain('Indexed collections');
      expect(sent[0]).toContain(ADDR);          // the finished one
      expect(sent[0]).toContain('Running now:');
      expect(sent[0]).toContain(OTHER);         // the one still bootstrapping
    });

    it('POPULATED and idle: no running section at all', async () => {
      const { base, sent } = setup();
      indexed();
      await handleStatus({ ...base, text: '/status' });
      expect(sent[0]).toContain(ADDR);
      expect(sent[0]).not.toContain('Running now:');
    });
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

  it('refuses more than one address, now from the SHARED parse path', async () => {
    // The refusal moved out of this handler and into `parseQueryCommand`, so the two
    // single-address queries get it too instead of each needing to remember. It names both
    // addresses, because "you sent two" is less useful than showing which two.
    const { base, sent } = setup();
    await handleStatus({ ...base, text: `/status ${ADDR} ${MINTER}` });
    expect(sent[0]).toContain('takes ONE address and you sent 2');
    expect(sent[0]).toContain(ADDR);
    expect(sent[0]).toContain(MINTER);
    expect(sent[0]).toContain('usage: /status 0x…');
  });

  it('refuses an option it does not use, rather than ignoring it', async () => {
    // /status reads neither --limit nor --min, and used to accept both and discard them.
    const { base, sent } = setup();
    await handleStatus({ ...base, text: `/status ${ADDR} --limit 50` });
    expect(sent[0]).toContain('--limit does not apply to this command');
    expect(sent[0]).toMatch(/refused rather than ignored/);
  });
});
