import { describe, expect, it, vi } from 'vitest';
import { enrichTxs, selectNeeded, type TxSource } from '../../src/chain/tx.js';
import type { FetchCosts } from '../../src/chain/fetchStrategy.js';
import { TxEnrichmentError } from '../../src/errors.js';
import { classify } from '../../src/indexer/classify.js';
import { ZERO_ADDRESS, type Address, type DecodedTransfer, type Hash, type TxInfo } from '../../src/types.js';

const SENDER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address;
const BUYER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Address;
const hash = (n: number) => `0x${String(n).padStart(64, '0')}` as Hash;

/** Costs are injected everywhere; the real prices are still pending measurement. */
const COSTS: FetchCosts = { perBlock: 20, perTx: 15 };

function transfer(over: Partial<DecodedTransfer> = {}): DecodedTransfer {
  return {
    tokenId: 1n, amount: 1n, from: ZERO_ADDRESS, to: BUYER,
    txHash: hash(1), blockNumber: 100n, logIndex: 0, batchIndex: 0, ...over,
  };
}

function makeSource(over: Partial<TxSource> = {}) {
  const getTransaction = vi.fn(async (h: Hash) => ({ from: SENDER, value: 5n }));
  const getBlockWithTransactions = vi.fn(async (blockNumber: bigint) =>
    // Every block pretends to hold four transactions, only some of them wanted.
    [1, 2, 3, 4].map((i) => ({
      hash: hash(Number(blockNumber) * 10 + i),
      from: SENDER,
      value: BigInt(i),
    })),
  );
  return {
    source: { getTransaction, getBlockWithTransactions, ...over } as TxSource,
    getTransaction,
    getBlockWithTransactions,
  };
}

describe('selectNeeded', () => {
  const mint = transfer({ from: ZERO_ADDRESS, txHash: hash(1) });
  const sale = transfer({ from: SENDER, txHash: hash(2) });
  const burn = transfer({ from: SENDER, to: ZERO_ADDRESS, txHash: hash(3) });

  it('fetches nothing at logs_only', () => {
    expect(selectNeeded([mint, sale, burn], 'logs_only')).toEqual([]);
  });

  it('fetches the MINT transactions at mints_only, not zero of them', () => {
    // The correction that matters: tx_from on a mint is the acting wallet, so
    // mints_only cannot be a no-op fetch or firstMinters loses its whole point.
    expect(selectNeeded([mint, sale, burn], 'mints_only'))
      .toEqual([{ txHash: hash(1), blockNumber: 100n }]);
  });

  it('fetches everything at full, including the mints', () => {
    expect(selectNeeded([mint, sale, burn], 'full').map((n) => n.txHash))
      .toEqual([hash(1), hash(2), hash(3)]);
  });

  it('deduplicates a batch log sharing one transaction', () => {
    // An ERC-1155 TransferBatch is one transaction carrying many transfers; an
    // airdrop is one transaction carrying hundreds of mints. Both must cost ONE
    // fetch — this is the cheap case, and charging per transfer would invert that.
    const batch = [0, 1, 2, 3, 4].map((i) =>
      transfer({ from: ZERO_ADDRESS, txHash: hash(7), batchIndex: i }));
    expect(selectNeeded(batch, 'full')).toEqual([{ txHash: hash(7), blockNumber: 100n }]);
  });

  it('deduplicates an airdrop of many mints in one transaction', () => {
    const airdrop = Array.from({ length: 200 }, (_, i) =>
      transfer({ from: ZERO_ADDRESS, txHash: hash(9), logIndex: i }));
    expect(selectNeeded(airdrop, 'mints_only')).toHaveLength(1);
  });

  it('keeps the block a transaction was seen in', () => {
    expect(selectNeeded([transfer({ blockNumber: 4242n })], 'full'))
      .toEqual([{ txHash: hash(1), blockNumber: 4242n }]);
  });
});

describe('enrichTxs strategy selection', () => {
  it('returns an empty map for nothing needed, without calling the source', async () => {
    const { source, getTransaction, getBlockWithTransactions } = makeSource();
    expect((await enrichTxs({ source, needed: [], costs: COSTS })).size).toBe(0);
    expect(getTransaction).not.toHaveBeenCalled();
    expect(getBlockWithTransactions).not.toHaveBeenCalled();
  });

  it('fetches per transaction when the window is sparse', async () => {
    // 3 txs across 3 blocks: 1.0 tx/block, below the 1.33 break-even.
    const { source, getTransaction, getBlockWithTransactions } = makeSource();
    const out = await enrichTxs({
      source, costs: COSTS,
      needed: [
        { txHash: hash(11), blockNumber: 1n },
        { txHash: hash(21), blockNumber: 2n },
        { txHash: hash(31), blockNumber: 3n },
      ],
    });
    expect(out.size).toBe(3);
    expect(getTransaction).toHaveBeenCalledTimes(3);
    expect(getBlockWithTransactions).not.toHaveBeenCalled();
  });

  it('fetches whole blocks when the window is dense', async () => {
    // 3 txs in ONE block: 3.0 tx/block, above the break-even.
    const { source, getTransaction, getBlockWithTransactions } = makeSource();
    const out = await enrichTxs({
      source, costs: COSTS,
      needed: [
        { txHash: hash(11), blockNumber: 1n },
        { txHash: hash(12), blockNumber: 1n },
        { txHash: hash(13), blockNumber: 1n },
      ],
    });
    expect(out.size).toBe(3);
    expect(getBlockWithTransactions).toHaveBeenCalledTimes(1);
    expect(getTransaction).not.toHaveBeenCalled();
  });

  it('picks per-tx for an airdrop, however many transfers it carried', async () => {
    // The intuition-inverting case: 200 mints, ONE transaction. Block-fetch would
    // pay for a whole block to read one transaction out of it.
    const { source, getTransaction, getBlockWithTransactions } = makeSource();
    const airdrop = Array.from({ length: 200 }, (_, i) =>
      transfer({ from: ZERO_ADDRESS, txHash: hash(11), logIndex: i, blockNumber: 1n }));
    await enrichTxs({ source, costs: COSTS, needed: selectNeeded(airdrop, 'mints_only') });
    expect(getTransaction).toHaveBeenCalledTimes(1);
    expect(getBlockWithTransactions).not.toHaveBeenCalled();
  });

  it('measures density AFTER the database pre-check, not before', async () => {
    // Five of six needed transactions are already stored. What remains is one
    // transaction in one block, which is sparse — so counting the known ones would
    // have chosen block-fetch and paid for a block to read a single transaction.
    const { source, getTransaction, getBlockWithTransactions } = makeSource();
    const known = new Map<string, TxInfo>(
      [12, 13, 14, 15, 16].map((i) => [hash(i), { from: BUYER, value: 1n }]),
    );
    const out = await enrichTxs({
      source, costs: COSTS, known,
      needed: [11, 12, 13, 14, 15, 16].map((i) => ({ txHash: hash(i), blockNumber: 1n })),
    });
    expect(getTransaction).toHaveBeenCalledTimes(1);
    expect(getBlockWithTransactions).not.toHaveBeenCalled();
    expect(out.size).toBe(6);
    expect(out.get(hash(12))).toEqual({ from: BUYER, value: 1n });
  });

  it('deduplicates repeated hashes before deciding and before fetching', async () => {
    const { source, getTransaction } = makeSource();
    await enrichTxs({
      source, costs: COSTS,
      needed: Array.from({ length: 50 }, () => ({ txHash: hash(11), blockNumber: 1n })),
    });
    expect(getTransaction).toHaveBeenCalledTimes(1);
  });

  it('fetches nothing at all when every needed transaction is known', async () => {
    const { source, getTransaction, getBlockWithTransactions } = makeSource();
    const out = await enrichTxs({
      source, costs: COSTS,
      known: new Map([[hash(11), { from: BUYER, value: 9n }]]),
      needed: [{ txHash: hash(11), blockNumber: 1n }],
    });
    expect(getTransaction).not.toHaveBeenCalled();
    expect(getBlockWithTransactions).not.toHaveBeenCalled();
    expect(out.get(hash(11))).toEqual({ from: BUYER, value: 9n });
  });
});

describe('enrichTxs result shape', () => {
  it('returns exactly the requested hashes, discarding the rest of a block', async () => {
    // Block-fetch gets four transactions back; only two were asked for. Returning
    // the extras would let a caller quietly depend on them.
    const { source } = makeSource();
    const out = await enrichTxs({
      source, costs: COSTS,
      needed: [
        { txHash: hash(11), blockNumber: 1n },
        { txHash: hash(12), blockNumber: 1n },
        { txHash: hash(13), blockNumber: 1n },
      ],
    });
    expect([...out.keys()].sort()).toEqual([hash(11), hash(12), hash(13)].sort());
  });

  it('LOWERCASES the sender, which classify depends on', async () => {
    // classify asserts lowercase and throws rather than normalising, precisely so
    // that an omission here surfaces. This is the boundary that guard refers to.
    const checksummed = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa' as Address;
    const { source } = makeSource({
      getTransaction: async () => ({ from: checksummed, value: 5n }),
    });
    const out = await enrichTxs({
      source, costs: COSTS, needed: [{ txHash: hash(11), blockNumber: 1n }],
    });
    expect(out.get(hash(11))?.from).toBe(checksummed.toLowerCase());
    // And the result is actually usable by classify, which is the point.
    expect(() => classify(
      { from: SENDER, to: checksummed.toLowerCase() as Address },
      out.get(hash(11))!,
    )).not.toThrow();
  });

  it('lowercases senders arriving via block-fetch too', async () => {
    const checksummed = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa' as Address;
    const { source } = makeSource({
      getBlockWithTransactions: async () => [
        { hash: hash(11), from: checksummed, value: 1n },
        { hash: hash(12), from: checksummed, value: 2n },
        { hash: hash(13), from: checksummed, value: 3n },
      ],
    });
    const out = await enrichTxs({
      source, costs: COSTS,
      needed: [11, 12, 13].map((i) => ({ txHash: hash(i), blockNumber: 1n })),
    });
    for (const info of out.values()) expect(info.from).toBe(checksummed.toLowerCase());
  });

  it('preserves a value above Number.MAX_SAFE_INTEGER exactly', async () => {
    const huge = 2n ** 200n + 7n;
    const { source } = makeSource({ getTransaction: async () => ({ from: SENDER, value: huge }) });
    const out = await enrichTxs({
      source, costs: COSTS, needed: [{ txHash: hash(11), blockNumber: 1n }],
    });
    expect(out.get(hash(11))?.value).toBe(huge);
  });
});

describe('enrichTxs failure modes', () => {
  it('throws, naming the transaction, when a block omits it', async () => {
    // A transaction decoded from a log must be in its own block. Missing means the
    // chain moved under us. Omitting it silently would leave the row unenriched
    // under an index about to be recorded complete.
    const { source } = makeSource({
      getBlockWithTransactions: async () => [{ hash: hash(99), from: SENDER, value: 1n }],
    });
    await expect(enrichTxs({
      source, costs: COSTS,
      needed: [11, 12, 13].map((i) => ({ txHash: hash(i), blockNumber: 1n })),
    })).rejects.toThrow(TxEnrichmentError);
  });

  it('names the reorg as the likely cause rather than a transient failure', async () => {
    const { source } = makeSource({
      getBlockWithTransactions: async () => [],
    });
    await expect(enrichTxs({
      source, costs: COSTS,
      needed: [11, 12, 13].map((i) => ({ txHash: hash(i), blockNumber: 1n })),
    })).rejects.toThrow(/reorg below the confirmations depth/);
  });

  it('rejects a stringified value instead of letting it read as unpaid', async () => {
    const { source } = makeSource({
      getTransaction: async () => ({ from: SENDER, value: '5' as unknown as bigint }),
    });
    await expect(enrichTxs({
      source, costs: COSTS, needed: [{ txHash: hash(11), blockNumber: 1n }],
    })).rejects.toThrow(/non-bigint value/);
  });

  it('rejects a missing value', async () => {
    const { source } = makeSource({
      getTransaction: async () => ({ from: SENDER, value: undefined as unknown as bigint }),
    });
    await expect(enrichTxs({
      source, costs: COSTS, needed: [{ txHash: hash(11), blockNumber: 1n }],
    })).rejects.toThrow(/non-bigint value/);
  });

  it('rejects a sender that is not an address', async () => {
    const { source } = makeSource({
      getTransaction: async () => ({ from: undefined as unknown as Address, value: 1n }),
    });
    await expect(enrichTxs({
      source, costs: COSTS, needed: [{ txHash: hash(11), blockNumber: 1n }],
    })).rejects.toThrow(/not an address/);
  });

  it('rejects absent cost figures rather than making a path look free', async () => {
    const { source } = makeSource();
    await expect(enrichTxs({
      source,
      costs: { perBlock: 0, perTx: 15 },
      needed: [{ txHash: hash(11), blockNumber: 1n }],
    })).rejects.toThrow(/positive finite/);
  });
});
