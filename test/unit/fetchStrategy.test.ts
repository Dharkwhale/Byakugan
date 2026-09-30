import { describe, expect, it } from 'vitest';
import {
  breakEvenTxsPerBlock, chooseFetchStrategy, measureDensity, type FetchCosts,
} from '../../src/chain/fetchStrategy.js';

/**
 * Costs are INJECTED in every test, never imported from config.
 *
 * The real compute-unit prices are still pending a dashboard measurement, and a
 * test that hard-coded a guess would start passing for the wrong reason the moment
 * the real numbers landed — it would pin the guess rather than the rule. What is
 * being tested here is the break-even arithmetic, which holds at any price.
 */
const evenCosts: FetchCosts = { perBlock: 20, perTx: 20 };
const dearerBlock: FetchCosts = { perBlock: 20, perTx: 15 };

describe('breakEvenTxsPerBlock', () => {
  it('is the cost ratio', () => {
    expect(breakEvenTxsPerBlock({ perBlock: 20, perTx: 15 })).toBeCloseTo(1.3333, 4);
    expect(breakEvenTxsPerBlock(evenCosts)).toBe(1);
  });

  it('rejects a zero or missing price rather than making a path look free', () => {
    expect(() => breakEvenTxsPerBlock({ perBlock: 0, perTx: 15 })).toThrow(/positive finite/);
    expect(() => breakEvenTxsPerBlock({ perBlock: 20, perTx: 0 })).toThrow(/positive finite/);
    expect(() => breakEvenTxsPerBlock(
      { perBlock: 20, perTx: undefined as unknown as number },
    )).toThrow(/positive finite/);
  });
});

describe('chooseFetchStrategy at the two measured extremes', () => {
  it('picks per-tx for the sparse case measured on Base (1.04 tx/block)', () => {
    // 10,573 unique txs over 10,209 unique blocks. Block-fetch needs
    // perBlock/perTx below 1.04 to win, which any realistic pricing misses.
    expect(chooseFetchStrategy({
      uniqueTxs: 10573, uniqueBlocks: 10209, costs: dearerBlock,
    })).toBe('per-tx');
  });

  it('flips on the same sparse data if the two prices are EQUAL', () => {
    // Pinned because it is the whole reason the decision is computed rather than
    // fixed: at 20/20 the break-even is 1.0, the measured 1.04 clears it, and
    // block-fetch wins that collection by 3.4% (204,180 CU against 211,460).
    // A 4% margin is also why the dashboard figures matter — the sparse case sits
    // near enough to the line that the price, not the shape, decides it.
    expect(chooseFetchStrategy({
      uniqueTxs: 10573, uniqueBlocks: 10209, costs: evenCosts,
    })).toBe('block-fetch');
  });

  it('picks block-fetch for a clustered drop (many txs per block)', () => {
    // 200 separate wallets minting into 4 blocks: 50 tx/block.
    expect(chooseFetchStrategy({
      uniqueTxs: 200, uniqueBlocks: 4, costs: dearerBlock,
    })).toBe('block-fetch');
  });

  it('picks per-tx for an airdrop, which is one tx however many transfers', () => {
    // mintManyTo([...200 addresses]) is ONE transaction in ONE block. The
    // intuition that a big mint favours block-fetch is exactly backwards here.
    expect(chooseFetchStrategy({
      uniqueTxs: 1, uniqueBlocks: 1, costs: dearerBlock,
    })).toBe('per-tx');
  });
});

describe('chooseFetchStrategy around the break-even', () => {
  it('gives an exact tie to per-tx', () => {
    // 2 blocks * 20 = 40 == 2 txs * 20. Equal cost, so the latency tiebreak wins.
    expect(chooseFetchStrategy({ uniqueTxs: 2, uniqueBlocks: 2, costs: evenCosts }))
      .toBe('per-tx');
  });

  it('switches on the first block-fetch win, not before', () => {
    // perBlock/perTx = 20/15 = 1.333, so 4 txs in 3 blocks still loses
    // (3*20=60 vs 4*15=60, a tie) and 5 in 3 wins (60 vs 75).
    expect(chooseFetchStrategy({ uniqueTxs: 4, uniqueBlocks: 3, costs: dearerBlock }))
      .toBe('per-tx');
    expect(chooseFetchStrategy({ uniqueTxs: 5, uniqueBlocks: 3, costs: dearerBlock }))
      .toBe('block-fetch');
  });

  it('decides by integer products, so a ratio that is inexact in binary is safe', () => {
    // 0.1-style rounding cannot flip these: the comparison never divides.
    expect(chooseFetchStrategy({
      uniqueTxs: 3, uniqueBlocks: 10, costs: { perBlock: 3, perTx: 10 },
    })).toBe('per-tx');
  });

  it('treats an empty window as per-tx, which costs nothing', () => {
    expect(chooseFetchStrategy({ uniqueTxs: 0, uniqueBlocks: 0, costs: dearerBlock }))
      .toBe('per-tx');
    expect(chooseFetchStrategy({ uniqueTxs: 0, uniqueBlocks: 5, costs: dearerBlock }))
      .toBe('per-tx');
  });

  it('rejects nonsense counts rather than choosing on them', () => {
    expect(() => chooseFetchStrategy({ uniqueTxs: -1, uniqueBlocks: 1, costs: evenCosts }))
      .toThrow(/non-negative integer/);
    expect(() => chooseFetchStrategy({ uniqueTxs: 1.5, uniqueBlocks: 1, costs: evenCosts }))
      .toThrow(/non-negative integer/);
    expect(() => chooseFetchStrategy({ uniqueTxs: 1, uniqueBlocks: -2, costs: evenCosts }))
      .toThrow(/non-negative integer/);
  });
});

describe('measureDensity', () => {
  it('counts unique transactions and blocks, not rows', () => {
    // One batch log: three rows, one tx, one block.
    expect(measureDensity([
      { txHash: '0xa', blockNumber: 10 },
      { txHash: '0xa', blockNumber: 10 },
      { txHash: '0xa', blockNumber: 10 },
    ])).toEqual({ uniqueTxs: 1, uniqueBlocks: 1, txsPerBlock: 1 });
  });

  it('measures the clustered shape', () => {
    expect(measureDensity([
      { txHash: '0xa', blockNumber: 7 },
      { txHash: '0xb', blockNumber: 7 },
      { txHash: '0xc', blockNumber: 7 },
      { txHash: '0xd', blockNumber: 8 },
    ])).toEqual({ uniqueTxs: 4, uniqueBlocks: 2, txsPerBlock: 2 });
  });

  it('treats a bigint block number as the same block as its number form', () => {
    // Block numbers arrive as bigint from viem and as number from SQLite; the two
    // must not count as two blocks or the density doubles.
    expect(measureDensity([
      { txHash: '0xa', blockNumber: 10n },
      { txHash: '0xb', blockNumber: 10 },
    ])).toEqual({ uniqueTxs: 2, uniqueBlocks: 1, txsPerBlock: 2 });
  });

  it('reports zero density for no rows without dividing by zero', () => {
    expect(measureDensity([])).toEqual({ uniqueTxs: 0, uniqueBlocks: 0, txsPerBlock: 0 });
  });
});
