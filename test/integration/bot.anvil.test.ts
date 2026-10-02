/**
 * `/index` end to end on anvil: the real handler, the real `makePrepare`, the real
 * `makeBackfillPorts` and the real orchestrator against a local chain. Nothing between the
 * Telegram replier and the chain is stubbed.
 *
 * WHAT THIS PROVES THAT NO UNIT TEST CAN: the property the whole "a cosmetic edit must
 * never abort a backfill" decision rests on. Until this file it had only ever been shown
 * against a mock `runBackfill`. Here every progress edit fails, in both shapes the reporter
 * distinguishes, and the collection must still end fully indexed.
 *
 * WHAT IT CANNOT PROVE. Anvil does not serve `alchemy_getAssetTransfers`, so the real
 * capability probe correctly answers "unsupported" and every run here takes the getLogs
 * path. The getAssetTransfers branch of `makeBackfillPorts` is pinned by
 * test/unit/ports.test.ts against a stubbed endpoint instead. No Telegram API is involved:
 * the replier is a fake whose `edit` rejects with the two error shapes.
 *
 * Skips with a reason when Foundry is absent. See test/helpers/anvil.ts. The notice goes to
 * process.stderr directly: vitest discards console.* from a file whose every test is skipped.
 */
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { Writable } from 'node:stream';
import { createPublicClient, http } from 'viem';
import {
  anvilAvailability, call, deploy, readArtifact, startAnvil, type AnvilChain,
} from '../helpers/anvil.js';
import { resetChainClients } from '../../src/chain/client.js';
import type { Config } from '../../src/config.js';
import { manualClock } from '../../src/clock.js';
import { openDb } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { getCollection } from '../../src/db/repositories/collections.js';
import { createLogger } from '../../src/logger.js';
import { createJobRegistry, type JobRegistry } from '../../src/bot/jobs.js';
import { handleIndex } from '../../src/bot/commands/index.js';
import { makePrepare } from '../../src/bot/indexRun.js';
import type { Address } from '../../src/types.js';

const availability = anvilAvailability();
if (!availability.ok) {
  process.stderr.write(`\n[bot.anvil] SKIPPED — ${availability.reason}\n\n`);
}

const CHAIN_ID = 31337;
const MINTS = 5;
const STALE_MS = 900_000;

describe.skipIf(!availability.ok)('/index end to end on anvil', () => {
  let chain: AnvilChain;
  let contract: Address;
  let config: Config;
  /** The chain head once the fixture is built; the safe head is this minus CONFIRMATIONS. */
  let head: bigint;
  const CONFIRMATIONS = 1;
  let db: Database.Database;
  const clock = manualClock(0);

  beforeAll(async () => {
    const artifact = readArtifact('FixtureERC721');
    chain = await startAnvil({ accounts: MINTS + 2 });
    const deployer = chain.accounts[0]!;
    for (let i = 0; i < 3; i++) await chain.mine();
    contract = (await deploy(chain, { from: deployer, bytecode: artifact.bytecode }))
      .toLowerCase() as Address;

    // MINTS mints, each alone in its own block, so a chunk size of 2 makes the walk
    // multi-chunk and progress is reported more than once.
    for (let i = 0; i < MINTS; i++) {
      const wallet = chain.accounts[i + 1]!;
      await chain.send({
        from: wallet, to: contract, data: call(artifact.abi, 'mint', [wallet]),
      });
      await chain.mine();
    }
    await chain.mine();

    const client = createPublicClient({ transport: http(chain.url) });
    head = await client.getBlockNumber();

    config = {
      chains: new Map([[CHAIN_ID, {
        chainId: CHAIN_ID, name: 'anvil', rpcUrl: chain.url,
        initialChunk: 2, maxChunk: 2, confirmations: CONFIRMATIONS,
        // The archive probe needs an address with code at a block that exists: the fixture
        // contract itself, at the current head. Anvil keeps full history.
        archiveProbe: { address: contract, block: Number(head) },
      }]]),
      defaultChainId: CHAIN_ID,
      dbPath: ':memory:',
      etherscanApiKey: undefined,
      // High enough that the rate limiter never paces a local chain.
      computeUnitsPerSecond: 1_000_000,
      telegramBotToken: undefined,
      telegramAllowedUserIds: [],
      secrets: [],
    };
    resetChainClients();
  }, 180_000);

  afterAll(() => { chain?.stop(); resetChainClients(); });
  afterEach(() => { db?.close(); });

  function freshDb(): Database.Database {
    db = openDb(':memory:');
    runMigrations(db);
    return db;
  }

  /** Waits for the detached job by polling the registry rather than sleeping a guess. */
  async function settle(registry: JobRegistry): Promise<void> {
    const deadline = Date.now() + 120_000;
    while (registry.size() > 0) {
      if (Date.now() > deadline) throw new Error('the job never finished');
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** A real logger over a capturing stream: tests read what would have been written. */
  function capturingLogger() {
    const logs: Array<{ level: number; msg: string }> = [];
    const logger = createLogger([], new Writable({
      write(chunk, _enc, cb) {
        for (const l of String(chunk).split('\n')) if (l) logs.push(JSON.parse(l));
        cb();
      },
    }));
    return { logs, logger };
  }

  function harness(editImpl: (id: number, text: string) => Promise<void>) {
    const sent: string[] = [];
    const edit = vi.fn(editImpl);
    const replier = {
      reply: vi.fn(async (t: string) => { sent.push(t); return { messageId: 7 }; }),
      edit,
      sendDocument: vi.fn(),
    };
    const registry = createJobRegistry({ clock, staleMs: STALE_MS });
    const { logs, logger } = capturingLogger();
    const deps = (text: string, over: Partial<Parameters<typeof handleIndex>[0]> = {}) => ({
      text, replier: replier as never, db, clock, registry, logger,
      defaultChainId: CHAIN_ID, chainName: () => 'anvil',
      confirmThresholdSeconds: 100_000,
      prepare: makePrepare({ config, db, clock, staleLockMs: STALE_MS, onWarn: () => undefined }),
      ...over,
    });
    return { sent, edit, registry, logs, deps };
  }

  const INDEX = () => `/index ${contract} --chain ${CHAIN_ID}`;

  /** What the chain says the collection should look like, derived from the fixture, not read back. */
  function expectFullyIndexed(): void {
    const rows = db.prepare('SELECT COUNT(*) AS n FROM transfers WHERE contract = ?')
      .get(contract) as { n: number };
    expect(rows.n).toBe(MINTS);
    const mints = db.prepare(
      "SELECT COUNT(*) AS n FROM transfers WHERE contract = ? AND kind = 'mint'",
    ).get(contract) as { n: number };
    expect(mints.n).toBe(MINTS);
    // The watermark sits at the safe head, not the head: never index to head.
    expect(getCollection(db, CHAIN_ID, contract)).toMatchObject({
      state: 'indexed', standard: '721', lastIndexedBlock: Number(head) - CONFIRMATIONS,
    });
  }

  it('replies immediately, edits progress, and the label names the path the run used', async () => {
    freshDb();
    const h = harness(async () => undefined);
    await handleIndex(h.deps(INDEX()));

    // The handler returned before the job did: exactly one reply, no result yet.
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toContain('level full');

    await settle(h.registry);
    const texts = h.edit.mock.calls.map((c) => c[1]);
    expect(texts.length).toBeGreaterThan(0);
    // Anvil serves no getAssetTransfers, so the real probe says getLogs. The progress line
    // and the run's own report (which comes from the source that actually ran) must agree.
    expect(texts[0]).toContain('via getLogs');
    expect(texts.at(-1)).toContain('Indexed');
    expect(texts.at(-1)).toContain('via getLogs');
    expect(texts.at(-1)).toContain(`indexed through block ${Number(head) - CONFIRMATIONS}`);
    expectFullyIndexed();
  }, 300_000);

  // THE OWNER'S PROPERTY. Every edit fails; the collection must still end fully indexed.
  //
  // The two shapes are not interchangeable and the difference is observable here. A 403
  // is permanent: the reporter makes ONE attempt, logs that it is going quiet, and never
  // edits again. A generic failure is transient: the reporter tries again on every tick
  // (a failed edit never sets lastSentAt, so the throttle does not hold it back) and each
  // failure is logged and swallowed. Asserting the attempt counts is what makes the 403
  // case a test of the permanent-failure branch rather than a second copy of the other.
  describe('rows are written although every progress edit fails', () => {
    const forbidden = Object.assign(new Error('Forbidden: bot was blocked by the user'), {
      error_code: 403, description: 'Forbidden: bot was blocked by the user',
    });

    it('403: indexes fully, makes exactly one attempt, and goes quiet once', async () => {
      freshDb();
      const h = harness(async () => { throw forbidden; });
      await handleIndex(h.deps(INDEX()));
      await settle(h.registry);

      expectFullyIndexed();
      expect(h.edit).toHaveBeenCalledTimes(1);
      const quiet = h.logs.filter((l) => /can no longer be delivered/.test(l.msg));
      expect(quiet).toHaveLength(1);
      // Permanent failures never reach the per-tick swallow, and never fail the job.
      expect(h.logs.filter((l) => /progress edit failed/.test(l.msg))).toHaveLength(0);
      expect(h.logs.filter((l) => /could not deliver the job failure report/.test(l.msg)))
        .toHaveLength(0);
    }, 300_000);

    it('generic error: indexes fully, keeps retrying through every tick', async () => {
      freshDb();
      const h = harness(async () => { throw new Error('socket hang up'); });
      await handleIndex(h.deps(INDEX()));
      await settle(h.registry);

      expectFullyIndexed();
      // Retried, unlike the 403: more than one attempt, and each tick's failure was swallowed
      // and logged rather than propagated into the backfill.
      expect(h.edit.mock.calls.length).toBeGreaterThan(1);
      const swallowed = h.logs.filter((l) => /progress edit failed; the job continues/.test(l.msg));
      expect(swallowed.length).toBeGreaterThan(1);
      expect(h.logs.filter((l) => /can no longer be delivered/.test(l.msg))).toHaveLength(0);
    }, 300_000);
  });

  it('reports a second /index as RUNNING, not orphaned, while the first is in flight', async () => {
    freshDb();
    const h = harness(async () => undefined);
    const realPrepare = makePrepare({
      config, db, clock, staleLockMs: STALE_MS, onWarn: () => undefined,
    });
    let release: () => void = () => undefined;
    const held = h.deps(INDEX(), {
      // Real build, real estimate; only the run is held, so the claim stays live.
      prepare: async (a) => {
        const run = await realPrepare(a);
        return {
          ...run,
          runBackfill: () => new Promise((resolve) => {
            release = () => resolve({
              status: 'indexed', source: 'getLogs', standard: '721', deployBlock: 1,
              fromBlock: 1, toBlock: 2, chunks: 1, rowsInserted: 0, lastIndexedBlock: 2,
            });
          }),
        };
      },
    });
    await handleIndex(held);

    clock.advance(120_000);
    const second = harness(async () => undefined);
    await handleIndex({ ...second.deps(INDEX()), registry: h.registry });
    expect(second.sent.at(-1)).toMatch(/already indexing/i);
    // The distinction that matters: a live job is not an orphaned lock.
    expect(second.sent.at(-1)).not.toMatch(/previous run/i);
    expect(second.sent.at(-1)).toContain('2 minutes');

    release();
    await settle(h.registry);
  }, 300_000);
});
