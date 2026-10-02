/**
 * The whole pipeline, once, as one thing.
 *
 * Every part of this has been tested in isolation against mocks. This is the first
 * place they run together against a real chain through the REAL orchestrator: ERC-165
 * detection, binary-search deploy-block resolution, chunked `getLogs`, decoding,
 * transaction enrichment with the strategy chosen from measured density, classification,
 * the per-chunk atomic write, a bounded run, an unbounded resume, and finally
 * `firstMinters` returning the order the chain actually mined.
 *
 * Nothing here is stubbed except `safeHead`, which has to be a function of the head
 * and the confirmations policy rather than of the chain.
 *
 * Skips with a reason when Foundry is absent. See test/helpers/anvil.ts.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { createPublicClient, http, type Address as ViemAddress } from 'viem';
import {
  anvilAvailability, call, deploy, readArtifact, startAnvil, type AnvilChain,
} from '../helpers/anvil.js';
import type { ChainClient } from '../../src/chain/client.js';
import { binarySearchDeployBlock } from '../../src/chain/deployBlock.js';
import type { FetchCosts } from '../../src/chain/fetchStrategy.js';
import { makeSupportsInterface } from '../../src/chain/standard.js';
import { makeTxSource } from '../../src/chain/tx.js';
import { manualClock } from '../../src/clock.js';
import { openDb } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { firstMinters, firstRecipients } from '../../src/db/repositories/analytics.js';
import { countByKind } from '../../src/db/repositories/transfers.js';
import { backfill, type BackfillPorts } from '../../src/indexer/backfill.js';
import { makeLogsSource } from '../../src/indexer/transferSource.js';
import type { Address, Hash } from '../../src/types.js';
import type Database from 'better-sqlite3';

const availability = anvilAvailability();
if (!availability.ok) {
  process.stderr.write(`\n[backfill.anvil] SKIPPED — ${availability.reason}\n\n`);
}

const CHAIN_ID = 31337;
const COSTS: FetchCosts = { perBlock: 20, perTx: 15 };
/** Wallets that mint together in one block, to make same-block ordering real. */
const CLUSTER = 6;

describe.skipIf(!availability.ok)('the whole pipeline on anvil', () => {
  let chain: AnvilChain;
  let contract: Address;
  let abi: ReturnType<typeof readArtifact>['abi'];
  let ports: BackfillPorts;
  let db: Database.Database;
  const clock = manualClock(1_000);

  /** Blocks of interest, captured as they are mined. */
  let soloBlock1: bigint;
  let soloBlock2: bigint;
  let clusterBlock: bigint;
  let head: bigint;
  /** The mined order of the cluster's senders, which firstMinters must reproduce. */
  let clusterMinedSenders: string[];

  beforeAll(async () => {
    const artifact = readArtifact('FixtureERC721');
    abi = artifact.abi;
    chain = await startAnvil({ accounts: CLUSTER + 4 });
    const deployer = chain.accounts[0]!;

    // Some empty blocks first, so the deploy block is not 0 or 1 and the binary
    // search has somewhere to actually search.
    for (let i = 0; i < 3; i++) await chain.mine();
    contract = await deploy(chain, { from: deployer, bytecode: artifact.bytecode });

    const w1 = chain.accounts[1]!;
    const w2 = chain.accounts[2]!;

    // Two solo mints, each alone in its own block.
    await chain.send({ from: w1, to: contract, data: call(abi, 'mint', [w1]) });
    await chain.mine();
    soloBlock1 = BigInt((await chain.rpc('eth_blockNumber')) as string);

    await chain.send({ from: w2, to: contract, data: call(abi, 'mint', [w2]) });
    await chain.mine();
    soloBlock2 = BigInt((await chain.rpc('eth_blockNumber')) as string);

    // A few empty blocks, so the bounded run below can stop cleanly between the
    // solo mints and the cluster.
    for (let i = 0; i < 4; i++) await chain.mine();

    // Then CLUSTER wallets minting together, gas prices varying so the mined order
    // deliberately differs from the submission order — see the note in
    // density.anvil.test.ts for why that matters.
    for (let i = 0; i < CLUSTER; i++) {
      const w = chain.accounts[i + 3]!;
      await chain.send({
        from: w, to: contract, data: call(abi, 'mint', [w]),
        gasPrice: 1_000_000_000n + BigInt(i) * 1_000_000n,
      });
    }
    await chain.mine();
    clusterBlock = BigInt((await chain.rpc('eth_blockNumber')) as string);

    // One trailing block so safeHead can sit below the head and still include
    // everything above.
    await chain.mine();
    head = BigInt((await chain.rpc('eth_blockNumber')) as string);

    const clusterLogs = (await chain.rpc('eth_getLogs', [{
      fromBlock: `0x${clusterBlock.toString(16)}`,
      toBlock: `0x${clusterBlock.toString(16)}`,
      address: contract,
    }])) as Array<{ transactionHash: string; logIndex: string }>;
    const block = (await chain.rpc('eth_getBlockByNumber', [
      `0x${clusterBlock.toString(16)}`, true,
    ])) as { transactions: Array<{ hash: string; from: string }> };
    const senderByTx = new Map(
      block.transactions.map((t) => [t.hash.toLowerCase(), t.from.toLowerCase()]),
    );
    clusterMinedSenders = [...clusterLogs]
      .sort((x, y) => Number(x.logIndex) - Number(y.logIndex))
      .map((l) => senderByTx.get(l.transactionHash.toLowerCase())!);

    // Real adapters, not stubs: viem client, the production ERC-165 probe and the
    // production TxSource. The limiter is a pass-through here because anvil has no
    // rate limit to respect and a bucket would only slow the test down.
    const client = createPublicClient({ transport: http(chain.url) });
    const chainClient: ChainClient = {
      chainId: CHAIN_ID,
      client,
      limit: <T>(fn: () => Promise<T>) => fn(),
    };

    const fetchLogs = async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
        const logs = await client.getLogs({
          address: contract as ViemAddress, fromBlock, toBlock,
        });
        return logs.map((l) => ({
          topics: l.topics as Hash[],
          data: l.data as Hash,
          transactionHash: l.transactionHash as Hash,
          blockNumber: l.blockNumber!,
          logIndex: l.logIndex!,
        }));
    };

    ports = {
      // The anvil chain has no range cap, so the logs source is configured with a modest
      // chunk purely to make the walk multi-chunk and exercise the orchestrator's
      // per-chunk commit.
      makeTransferSource: (standard) => makeLogsSource({
        fetchLogs, standard, initialChunk: 4, maxChunk: 4,
      }),
      txSource: makeTxSource(chainClient),
      supports: makeSupportsInterface(client, contract),
      resolveDeployBlock: async ({ safeHead }) => ({
        // The real binary search, against real getCode.
        block: Number(await binarySearchDeployBlock(
          async ({ address, blockNumber }) =>
            client.getBytecode({ address: address as ViemAddress, blockNumber }) as Promise<string>,
          contract,
          safeHead,
        )),
        source: 'binary_search',
        validated: true,
      }),
      // The one stub: a policy, not a chain fact. One confirmation behind the head.
      safeHead: async () => head - 1n,
    };

    db = openDb(':memory:');
    runMigrations(db);
  }, 180_000);

  afterAll(() => { chain?.stop(); db?.close(); });

  it('bootstraps: detects ERC-721 and binary-searches the real deploy block', async () => {
    // Bounded to end AFTER the solo mints but BEFORE the cluster, so the first run
    // is deliberately incomplete and the resume below has real work to do.
    const bound = soloBlock2 + 2n;
    const result = await backfill(db, {
      clock, jobId: 'e2e-1', ports,
      options: {
        chainId: CHAIN_ID, contract, level: 'full', toBlock: bound, costs: COSTS, staleLockMs: 60_000,
      },
    });
    expect(result.status).toBe('indexed');
    if (result.status !== 'indexed') return;
    expect(result.standard).toBe('721');
    // Deployed after three empty blocks, so block 4 — found by search, not told.
    expect(result.deployBlock).toBe(4);
    expect(result.lastIndexedBlock).toBe(Number(bound));
    expect(result.rowsInserted).toBe(2);
  }, 180_000);

  it('put the two solo mints in separate blocks, and the cluster in one', () => {
    // The premise the ordering assertion below rests on. If these collapsed into one
    // block, "solo minters in block order" would be resolved by log_index instead and
    // the test would be checking something else without saying so.
    expect(soloBlock1).toBeLessThan(soloBlock2);
    expect(soloBlock2).toBeLessThan(clusterBlock);
    const perBlock = db.prepare(`
      SELECT block_number AS b, COUNT(*) AS n FROM transfers GROUP BY block_number
    `).all() as Array<{ b: number; n: number }>;
    expect(perBlock).toEqual([
      { b: Number(soloBlock1), n: 1 },
      { b: Number(soloBlock2), n: 1 },
    ]);
  });

  it('indexed only up to the bound, leaving the cluster untouched', () => {
    expect(countByKind(db, CHAIN_ID, contract))
      .toEqual({ mint: 2, buy: 0, transfer: 0, burn: 0, unclassified: 0 });
    const beyond = db.prepare(
      'SELECT COUNT(*) AS n FROM transfers WHERE block_number >= ?',
    ).get(Number(clusterBlock)) as { n: number };
    expect(beyond.n).toBe(0);
  });

  it('resumes unbounded from the watermark and picks up the cluster', async () => {
    const result = await backfill(db, {
      clock, jobId: 'e2e-2', ports,
      options: {
        chainId: CHAIN_ID, contract, level: 'full', costs: COSTS, staleLockMs: 60_000,
      },
    });
    expect(result.status).toBe('indexed');
    if (result.status !== 'indexed') return;
    // Started where the bounded run stopped, not at the deploy block.
    expect(result.fromBlock).toBe(Number(soloBlock2 + 3n));
    expect(result.toBlock).toBe(Number(head - 1n));
    expect(result.rowsInserted).toBe(CLUSTER);
    expect(countByKind(db, CHAIN_ID, contract).mint).toBe(2 + CLUSTER);
  }, 180_000);

  it('returns firstMinters in the order the chain MINED, ties included', () => {
    const rows = firstMinters(db, { chainId: CHAIN_ID, contract, limit: 50 });
    // Two solo minters first, in block order, then the cluster by mined log_index.
    const expected = [
      chain.accounts[1]!.toLowerCase(),
      chain.accounts[2]!.toLowerCase(),
      ...clusterMinedSenders,
    ];
    expect(rows.map((r) => r.minter)).toEqual(expected);
    expect(rows).toHaveLength(2 + CLUSTER);
  });

  it('minted to itself throughout, so mintedToOthers is false for every wallet', () => {
    const rows = firstMinters(db, { chainId: CHAIN_ID, contract, limit: 50 });
    for (const row of rows) {
      expect(row.mintedToOthers).toBe(false);
      expect(row.minter).toBe(row.firstRecipient);
    }
  });

  it('agrees with the recipient view, which is the same set here', () => {
    const minters = firstMinters(db, { chainId: CHAIN_ID, contract, limit: 50 });
    const recipients = firstRecipients(db, { chainId: CHAIN_ID, contract, limit: 50 });
    expect(recipients.map((r) => r.recipient)).toEqual(minters.map((r) => r.minter));
  });

  it('is a no-op when run again with nothing new to index', async () => {
    const result = await backfill(db, {
      clock, jobId: 'e2e-3', ports,
      options: {
        chainId: CHAIN_ID, contract, level: 'full', costs: COSTS, staleLockMs: 60_000,
      },
    });
    expect(result.status).toBe('up_to_date');
  }, 180_000);

  it('left the lock released', () => {
    const row = db.prepare('SELECT locked_by AS l FROM collections').get() as { l: string | null };
    expect(row.l).toBeNull();
  });
});
