import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { Writable } from 'node:stream';
import { handleIndex } from '../../src/bot/commands/index.js';
import { ASSET_TRANSFERS_SPEEDUP_UNVERIFIED, makePrepare } from '../../src/bot/indexRun.js';
import { createJobRegistry } from '../../src/bot/jobs.js';
import type { makeBackfillPorts } from '../../src/chain/ports.js';
import { manualClock } from '../../src/clock.js';
import type { ChainConfig, Config } from '../../src/config.js';
import { openDb } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import type { BackfillPorts, backfill } from '../../src/indexer/backfill.js';
import { createLogger } from '../../src/logger.js';
import type { Address } from '../../src/types.js';

const ADDR = '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d' as Address;
const flush = () => new Promise<void>((r) => setImmediate(r));

let db: Database.Database;
beforeEach(() => { db = openDb(':memory:'); runMigrations(db); });

const chain: ChainConfig = {
  chainId: 1, name: 'stub', rpcUrl: 'http://stub.invalid/rpc', initialChunk: 10, maxChunk: 10,
  confirmations: 2, archiveProbe: { address: ADDR, block: 1 },
};
const config: Config = {
  chains: new Map([[1, chain]]), defaultChainId: 1, dbPath: ':memory:',
  etherscanApiKey: undefined, computeUnitsPerSecond: 300,
  telegramBotToken: undefined, telegramAllowedUserIds: [], secrets: [],
};

type Path = 'getAssetTransfers' | 'getLogs';

/**
 * A port factory standing in for an endpoint that ANSWERS THE PROBE DIFFERENTLY EACH TIME
 * it is asked: the first build says getAssetTransfers, the second says getLogs. Each build's
 * ports carry a `tag` naming the path THAT build would run, so the test can tell which build
 * the run was handed.
 *
 * One build per command makes the flakiness invisible. A label taken from a second build is
 * exactly what this exposes, because the two builds disagree.
 */
function flakyEndpoint() {
  const order: Path[] = ['getAssetTransfers', 'getLogs'];
  let builds = 0;
  const makePorts = vi.fn(async () => {
    const path = order[builds++ % order.length]!;
    const ports = {
      tag: path,
      supports: async (id: string) => id === '0x80ac58cd',
      resolveDeployBlock: async () => ({ block: 1, source: 'binary_search' as const, validated: true }),
      safeHead: async () => 100n,
    } as unknown as BackfillPorts;
    return {
      ports, safeHead: 100n, fetchPath: path,
      fetchLogs: async () => [],
    };
  }) as unknown as typeof makeBackfillPorts;
  return { makePorts, builds: () => builds };
}

/** A backfill that reports the path of the ports it was handed, as the real one reports its source. */
function spyBackfill() {
  const handedTags: string[] = [];
  const run = vi.fn(async (_db: unknown, a: {
    ports: BackfillPorts;
    options: { onProgress?(c: { fromBlock: bigint; toBlock: bigint; inserted: number }): void };
  }) => {
    const tag = (a.ports as unknown as { tag: Path }).tag;
    handedTags.push(tag);
    a.options.onProgress?.({ fromBlock: 1n, toBlock: 50n, inserted: 3 });
    return {
      status: 'indexed' as const, source: tag, standard: '721' as const, deployBlock: 1,
      fromBlock: 1, toBlock: 100, chunks: 1, rowsInserted: 3, lastIndexedBlock: 100,
    };
  }) as unknown as typeof backfill;
  return { run, handedTags };
}

function harness(prepareOver: Parameters<typeof makePrepare>[0]) {
  const clock = manualClock(0);
  const sent: string[] = [];
  const edits: string[] = [];
  const replier = {
    reply: vi.fn(async (t: string) => { sent.push(t); return { messageId: 1 }; }),
    edit: vi.fn(async (_id: number, t: string) => { edits.push(t); }),
    sendDocument: vi.fn(),
  };
  const registry = createJobRegistry({ clock, staleMs: 900_000 });
  const logger = createLogger([], new Writable({ write(_c, _e, cb) { cb(); } }));
  const go = (text: string) => handleIndex({
    text, replier: replier as never, db, clock, registry, logger,
    defaultChainId: 1, chainName: () => 'stub', confirmThresholdSeconds: 100_000,
    prepare: makePrepare(prepareOver),
  });
  return { go, sent, edits, registry, clock };
}

describe('the progress label names the path the run actually used', () => {
  it('takes the label, the estimate and the run from ONE build of the ports', async () => {
    const endpoint = flakyEndpoint();
    const spy = spyBackfill();
    const h = harness({
      config, db, clock: manualClock(0), staleLockMs: 900_000,
      makePorts: endpoint.makePorts, runBackfill: spy.run, onWarn: () => undefined,
    });
    await h.go(`/index ${ADDR}`);
    await flush();

    // One command, one build: a second probe is the defect, whatever it answered.
    expect(endpoint.builds()).toBe(1);

    // The run was handed build #1's ports, which run getAssetTransfers. Every place the
    // path is NAMED must say the same thing: the first progress line, and the
    // final report (which the real backfill derives from the source that ran).
    expect(spy.handedTags).toEqual(['getAssetTransfers']);
    const progress = h.edits.find((t) => t.includes('blocks 1-50'));
    expect(progress).toContain('via getAssetTransfers');
    expect(h.edits.at(-1)).toContain('via getAssetTransfers');
    expect(progress).not.toContain('via getLogs');
  });

  it('a failing build tells the user and starts nothing', async () => {
    const h = harness({
      config, db, clock: manualClock(0), staleLockMs: 900_000,
      makePorts: (async () => { throw new Error('the endpoint is unreachable'); }) as unknown as typeof makeBackfillPorts,
      runBackfill: spyBackfill().run, onWarn: () => undefined,
    });
    await h.go(`/index ${ADDR}`);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatch(/unreachable/);
    expect(h.sent[0]).not.toMatch(/^Indexing /);
    expect(h.registry.size()).toBe(0);
  });

  it('refuses a chain the bot is not configured for, naming it', async () => {
    const h = harness({
      config, db, clock: manualClock(0), staleLockMs: 900_000,
      makePorts: flakyEndpoint().makePorts, runBackfill: spyBackfill().run,
    });
    await h.go(`/index ${ADDR} --chain 8453`);
    expect(h.sent[0]).toMatch(/chain 8453/);
    expect(h.registry.size()).toBe(0);
  });
});

describe('the estimate', () => {
  async function estimateFor(path: Path) {
    const prepare = makePrepare({
      config, db, clock: manualClock(0), staleLockMs: 900_000,
      makePorts: (async () => ({
        ports: {
          supports: async (id: string) => id === '0x80ac58cd',
          resolveDeployBlock: async () => ({ block: 1, source: 'binary_search', validated: true }),
        },
        safeHead: 100n, fetchPath: path,
        ...(path === 'getLogs' ? { fetchPathReason: 'Method not found' } : {}),
        fetchLogs: async () => [],
      })) as unknown as typeof makeBackfillPorts,
    });
    const run = await prepare({ chainId: 1, contract: ADDR });
    return run.estimate({ chainId: 1, contract: ADDR, level: 'full' });
  }

  it('divides by the UNVERIFIED factor on the getAssetTransfers path only', async () => {
    const logs = await estimateFor('getLogs');
    const assets = await estimateFor('getAssetTransfers');
    expect(logs.seconds).toBeGreaterThan(0);
    expect(assets.seconds).toBeCloseTo(logs.seconds / ASSET_TRANSFERS_SPEEDUP_UNVERIFIED, 10);
  });

  it('says which path it is estimating, and why when it is the fallback', async () => {
    expect((await estimateFor('getLogs')).summary).toMatch(/eth_getLogs only[\s\S]*Method not found/);
    expect((await estimateFor('getAssetTransfers')).summary).toMatch(/CEILING/);
  });
});
