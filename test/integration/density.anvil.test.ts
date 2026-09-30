/**
 * Deterministic density fixture, on a local anvil chain.
 *
 * WHAT THIS EXISTS TO SETTLE. `chooseFetchStrategy` compares per-transaction
 * against whole-block enrichment, and the comparison turns on transactions per
 * block. The two extremes are more than an order of magnitude apart and only one of
 * them can be produced by a contract:
 *
 *   CLUSTERED   N separate wallets each sending their own mint into ONE block.
 *               N transactions, 1 block. No contract can cause this — it is a
 *               property of transaction bundling — so `anvil --no-mining` produces
 *               it by construction instead.
 *   AIRDROP     one wallet calling mintManyTo with N recipients. N mints, but ONE
 *               transaction in ONE block. Worth pinning because it inverts an
 *               intuition: the big mint is the CHEAP case for enrichment.
 *
 * Both are exercised, so the break-even is tested on both sides rather than only
 * near the line — where the sparse real-world measurement (1.04 tx/block) already
 * sits, and where the decision is decided by price rather than by shape.
 *
 * The resulting default is therefore a SYNTHETIC UPPER BOUND, deliberately: it does
 * not encode whichever collection happened to be minting the week it was measured.
 *
 * Skips with a reason when Foundry is absent. See test/helpers/anvil.ts.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import {
  anvilAvailability, call, deploy, readArtifact, startAnvil, type AnvilChain,
} from '../helpers/anvil.js';
import {
  breakEvenTxsPerBlock, chooseFetchStrategy, measureDensity, type FetchCosts,
} from '../../src/chain/fetchStrategy.js';
import { decodeLogs } from '../../src/indexer/decode.js';
import { classify } from '../../src/indexer/classify.js';
import { ZERO_ADDRESS } from '../../src/types.js';

const availability = anvilAvailability();
if (!availability.ok) {
  // process.stderr.write, NOT console.warn. Measured: vitest discards console
  // output from a file whose every test is skipped, so console.warn here printed
  // nothing whatsoever and the skip was completely silent — which is close to a
  // deleted test. Raw stderr survives it.
  process.stderr.write(`\n[density.anvil] SKIPPED — ${availability.reason}\n\n`);
}

/**
 * Wallets for the clustered extreme. 20 gives 20 tx/block, which clears any
 * plausible break-even by a wide margin — the point is to be unambiguously on the
 * block-fetch side, not to be realistic about drop sizes.
 */
const WALLETS = 20;

/** Illustrative prices. The REAL ones are pending a dashboard measurement, so every
 * assertion here states the costs it used; none of them reads config. */
const COSTS: FetchCosts = { perBlock: 20, perTx: 15 };

describe.skipIf(!availability.ok)('density fixture on anvil', () => {
  let chain: AnvilChain;
  let erc721: Address;
  let abi721: ReturnType<typeof readArtifact>['abi'];
  let deployer: Address;

  beforeAll(async () => {
    const artifact = readArtifact('FixtureERC721');
    abi721 = artifact.abi;
    chain = await startAnvil({ accounts: WALLETS + 4 });
    deployer = chain.accounts[0]!;
    erc721 = await deploy(chain, { from: deployer, bytecode: artifact.bytecode });
  }, 120_000);

  afterAll(() => { chain?.stop(); });

  /** Every Transfer log in one block, decoded. */
  async function decodedLogsIn(blockNumber: bigint) {
    const logs = (await chain.rpc('eth_getLogs', [{
      fromBlock: `0x${blockNumber.toString(16)}`,
      toBlock: `0x${blockNumber.toString(16)}`,
      address: erc721,
    }])) as Array<{ topics: string[]; data: string; transactionHash: string;
                    blockNumber: string; logIndex: string }>;
    return decodeLogs(
      logs.map((l) => ({
        topics: l.topics as `0x${string}`[],
        data: l.data as `0x${string}`,
        transactionHash: l.transactionHash as `0x${string}`,
        blockNumber: BigInt(l.blockNumber),
        logIndex: Number(l.logIndex),
      })),
      '721',
    );
  }

  async function headNumber(): Promise<bigint> {
    return BigInt((await chain.rpc('eth_blockNumber')) as string);
  }

  it('reports the pinned Foundry version it is running against', () => {
    // Recorded in the output so a density result can be traced to a toolchain.
    expect(availability.ok && availability.version).toContain('anvil');
  });

  describe('the CLUSTERED extreme: N wallets, one block', () => {
    let rows: Array<{ txHash: string; blockNumber: number }>;
    // Captured, not re-read from the head: later suites mine further blocks, and a
    // test that asked for "the current head" would drift onto one of theirs.
    let clusterBlock: bigint;

    beforeAll(async () => {
      // Each wallet sends its OWN mint. None is mined yet, so they all queue.
      for (let i = 0; i < WALLETS; i++) {
        const wallet = chain.accounts[i + 1]!;
        await chain.send({
          from: wallet, to: erc721, data: call(abi721, 'mint', [wallet]),
        });
      }
      await chain.mine();
      clusterBlock = await headNumber();
      const decoded = await decodedLogsIn(clusterBlock);
      rows = decoded.map((d) => ({ txHash: d.txHash, blockNumber: Number(d.blockNumber) }));
    }, 120_000);

    it('lands all N transactions in exactly one block', () => {
      const density = measureDensity(rows);
      expect(density.uniqueTxs).toBe(WALLETS);
      expect(density.uniqueBlocks).toBe(1);
      expect(density.txsPerBlock).toBe(WALLETS);
    });

    it('used N DISTINCT senders, not one wallet sending N times', async () => {
      // Added after a mutation check: swapping the N wallets for a single wallet
      // sending N queued transactions left every other assertion here passing. The
      // clustering comes from --no-mining, not from who sent what, so "N wallets"
      // was decoration in the test's name until this assertion made it real.
      //
      // It is worth making real rather than renaming away: distinct senders are what
      // the enrichment paths disagree about. block-fetch reads every `from` out of
      // one block response and per-tx reads one per call, so a fault that collapsed
      // senders together would be invisible against a block of identical ones.
      const block = (await chain.rpc('eth_getBlockByNumber', [
        `0x${clusterBlock.toString(16)}`, true,
      ])) as { transactions: Array<{ from: Address; hash: string }> };
      const senders = new Set(block.transactions.map((t) => t.from.toLowerCase()));
      expect(block.transactions).toHaveLength(WALLETS);
      expect(senders.size).toBe(WALLETS);
    });

    it('is far above the break-even, not merely past it', () => {
      // 20 tx/block against a break-even of 1.33. If this ever drifts toward the
      // line the fixture has stopped testing the extreme it was built for.
      expect(measureDensity(rows).txsPerBlock).toBeGreaterThan(
        breakEvenTxsPerBlock(COSTS) * 10,
      );
    });

    it('chooses block-fetch, at a large saving', () => {
      const { uniqueTxs, uniqueBlocks } = measureDensity(rows);
      expect(chooseFetchStrategy({ uniqueTxs, uniqueBlocks, costs: COSTS }))
        .toBe('block-fetch');
      // 1 block * 20 CU against 20 txs * 15 CU.
      expect(uniqueBlocks * COSTS.perBlock).toBe(20);
      expect(uniqueTxs * COSTS.perTx).toBe(300);
    });

    it('decodes every mint, so the density is measured over real rows', () => {
      expect(rows).toHaveLength(WALLETS);
    });
  });

  describe('the AIRDROP extreme: one transaction, N mints', () => {
    let rows: Array<{ txHash: string; blockNumber: number }>;

    beforeAll(async () => {
      const recipients = Array.from({ length: WALLETS }, (_, i) => chain.accounts[i + 1]!);
      await chain.send({
        from: deployer, to: erc721, data: call(abi721, 'mintManyTo', [recipients]),
      });
      await chain.mine();
      const decoded = await decodedLogsIn(await headNumber());
      rows = decoded.map((d) => ({ txHash: d.txHash, blockNumber: Number(d.blockNumber) }));
    }, 120_000);

    it('produces N mints from a single transaction', () => {
      expect(rows).toHaveLength(WALLETS);
      expect(new Set(rows.map((r) => r.txHash)).size).toBe(1);
    });

    it('measures as 1.0 tx/block however many transfers it carried', () => {
      expect(measureDensity(rows)).toEqual({
        uniqueTxs: 1, uniqueBlocks: 1, txsPerBlock: 1,
      });
    });

    it('chooses per-tx — the big mint is the CHEAP case', () => {
      const { uniqueTxs, uniqueBlocks } = measureDensity(rows);
      expect(chooseFetchStrategy({ uniqueTxs, uniqueBlocks, costs: COSTS })).toBe('per-tx');
      // One fetch serves all 20 transfers: 15 CU, against 20 CU to pull the block.
      expect(uniqueTxs * COSTS.perTx).toBe(15);
    });
  });

  describe('the kind matrix, with answers known in advance', () => {
    /**
     * Expectations are written from the SPEC, not read back from the chain: each
     * call below is chosen because of which classifier branch it must reach, and the
     * expected kind is stated before the fixture runs.
     */
    it('produces mint, buy, transfer and burn from real logs', async () => {
      const owner = chain.accounts[1]!;
      const buyer = chain.accounts[2]!;

      // A token to move around. mint -> tokenId is whatever nextTokenId is; capture it.
      await chain.send({ from: owner, to: erc721, data: call(abi721, 'mint', [owner]) });
      await chain.mine();
      const minted = (await decodedLogsIn(await headNumber()))[0]!;
      expect(minted.from).toBe(ZERO_ADDRESS);
      expect(classify({ from: minted.from, to: minted.to }, { from: owner, value: 0n }))
        .toBe('mint');

      // buy(): payable, and tx.from is the recipient -> the buy branch.
      await chain.send({
        from: buyer, to: erc721, value: 10n ** 15n,
        data: call(abi721, 'buy', [minted.tokenId]),
      });
      await chain.mine();
      const bought = (await decodedLogsIn(await headNumber()))[0]!;
      expect(bought.to).toBe(buyer.toLowerCase());
      expect(classify({ from: bought.from, to: bought.to }, { from: buyer, value: 10n ** 15n }))
        .toBe('buy');

      // transferFrom(): no value -> transfer, even though it is a real movement.
      await chain.send({
        from: buyer, to: erc721,
        data: call(abi721, 'transferFrom', [buyer, owner, minted.tokenId]),
      });
      await chain.mine();
      const moved = (await decodedLogsIn(await headNumber()))[0]!;
      expect(classify({ from: moved.from, to: moved.to }, { from: buyer, value: 0n }))
        .toBe('transfer');

      // burn(): to the zero address.
      await chain.send({
        from: owner, to: erc721, data: call(abi721, 'burn', [minted.tokenId]),
      });
      await chain.mine();
      const burned = (await decodedLogsIn(await headNumber()))[0]!;
      expect(burned.to).toBe(ZERO_ADDRESS);
      expect(classify({ from: burned.from, to: burned.to }, { from: owner, value: 0n }))
        .toBe('burn');
    }, 120_000);

    it('reports a mint sent by one wallet to another as such', async () => {
      // The acting-wallet case, on real chain data: tx.from is the deployer, the
      // recipient is someone else, and that difference is the bot signal.
      const recipient = chain.accounts[3]!;
      await chain.send({
        from: deployer, to: erc721, data: call(abi721, 'mint', [recipient]),
      });
      await chain.mine();
      const log = (await decodedLogsIn(await headNumber()))[0]!;
      expect(log.to).toBe(recipient.toLowerCase());
      expect(log.to).not.toBe(deployer.toLowerCase());
      expect(classify({ from: log.from, to: log.to }, { from: deployer, value: 0n }))
        .toBe('mint');
    }, 120_000);
  });
});
