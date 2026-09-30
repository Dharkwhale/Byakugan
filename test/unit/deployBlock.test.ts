import { describe, expect, it, vi } from 'vitest';
import {
  binarySearchDeployBlock, fetchCreationBlockFromExplorer, probeArchive,
  resolveDeployBlock, validateDeployBlock,
} from '../../src/chain/deployBlock.js';
import { DeployBlockUnavailableError } from '../../src/errors.js';
import type { Address } from '../../src/types.js';

const ADDRESS = '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d' as Address;
const KEY = 'TESTKEY1234567890ABCDEF';
const PROBE = { address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' as Address, block: 4719569 };

/** An archive node: code exists at and after `deployedAt`. */
const archiveNode = (deployedAt: bigint) =>
  async ({ blockNumber }: { blockNumber: bigint }) =>
    (blockNumber >= deployedAt ? '0xdeadbeef' : '0x');

/**
 * A target node that also serves the archive probe contract at its historical
 * block. Fixture correction: the brief's `archiveNode(12287507n)` returns empty
 * at the probe block (4719569 < 12287507), which makes the archive guard read
 * the node as pruned and the binary-search tests unreachable.
 */
const withProbe = (node: (a: { address: Address; blockNumber: bigint }) => Promise<string>) =>
  async (a: { address: Address; blockNumber: bigint }) =>
    (a.address === PROBE.address && a.blockNumber === BigInt(PROBE.block) ? '0xdeadbeef' : node(a));

/** A pruned node: only recent state is served, older calls come back empty. */
const prunedNode = (horizon: bigint) =>
  async ({ blockNumber }: { blockNumber: bigint }) =>
    (blockNumber >= horizon ? '0xdeadbeef' : '0x');

/** Measured Arbitrum pre-Nitro shape: the call THROWS rather than returning empty. */
const stateUnavailable = async () => { throw new Error('Requested resource not found.'); };
const transientFailure = async () => { throw new Error('The request took too long to respond.'); };

const explorerOk = (block: number) => async () =>
  new Response(JSON.stringify({ status: '1', message: 'OK', result: [{ blockNumber: String(block) }] }));
/** Measured: failures arrive as HTTP 200 with the reason in the body. */
const explorerNotOk = (reason: string) => async () =>
  new Response(JSON.stringify({ status: '0', message: 'NOTOK', result: reason }), { status: 200 });

describe('validateDeployBlock', () => {
  it('is valid when code exists at the block and not before it', async () => {
    expect(await validateDeployBlock(archiveNode(100n), ADDRESS, 100n)).toBe('valid');
  });

  it('is invalid when there is no code at the block', async () => {
    expect(await validateDeployBlock(archiveNode(200n), ADDRESS, 100n)).toBe('invalid');
  });

  it('is invalid when code already exists at block-1', async () => {
    expect(await validateDeployBlock(archiveNode(50n), ADDRESS, 100n)).toBe('invalid');
  });

  it('is valid at block 0, where there is no previous block to check', async () => {
    expect(await validateDeployBlock(archiveNode(0n), ADDRESS, 0n)).toBe('valid');
  });

  // The measured Arbitrum pre-Nitro case. "Cannot check" must not read as "wrong".
  it('is unvalidatable when the provider cannot serve state for the block', async () => {
    expect(await validateDeployBlock(stateUnavailable, ADDRESS, 55n)).toBe('unvalidatable');
  });

  it('is unvalidatable when only the block-1 call cannot be served', async () => {
    const getCode = async ({ blockNumber }: { blockNumber: bigint }) => {
      if (blockNumber === 99n) throw new Error('missing trie node');
      return '0xdeadbeef';
    };
    expect(await validateDeployBlock(getCode, ADDRESS, 100n)).toBe('unvalidatable');
  });

  it('rethrows a transient failure rather than calling it unvalidatable', async () => {
    await expect(validateDeployBlock(transientFailure, ADDRESS, 100n)).rejects.toThrow(/too long/);
  });
});

describe('binarySearchDeployBlock', () => {
  it('finds the exact deploy block', async () => {
    expect(await binarySearchDeployBlock(archiveNode(12287507n), ADDRESS, 21000000n)).toBe(12287507n);
  });

  it('finds a deploy at block zero', async () => {
    expect(await binarySearchDeployBlock(archiveNode(0n), ADDRESS, 1000n)).toBe(0n);
  });

  it('finds a deploy at the head itself', async () => {
    expect(await binarySearchDeployBlock(archiveNode(1000n), ADDRESS, 1000n)).toBe(1000n);
  });

  it('errors when there is no code at safeHead', async () => {
    await expect(binarySearchDeployBlock(archiveNode(5000n), ADDRESS, 1000n))
      .rejects.toThrow(DeployBlockUnavailableError);
  });

  // Measured: two real Base collections resolved in 26 and 25 calls.
  it('uses a logarithmic number of calls', async () => {
    const getCode = vi.fn(archiveNode(12287507n));
    await binarySearchDeployBlock(getCode, ADDRESS, 21000000n);
    expect(getCode.mock.calls.length).toBeLessThan(40);
  });
});

describe('probeArchive', () => {
  it('passes when the probe contract has code at its historical block', async () => {
    expect(await probeArchive(archiveNode(4000000n), PROBE)).toBe(true);
  });

  it('fails on a pruned node', async () => {
    expect(await probeArchive(prunedNode(20000000n), PROBE)).toBe(false);
  });
});

describe('probeArchive — retry policy', () => {
  const noSleep = async () => undefined;
  // Mutation-verified: no-retry mutant fails the first two; retry-everything fails the third.
  it('retries a transient failure and returns true once it succeeds', async () => {
    let calls = 0;
    const getCode = vi.fn(async () => { if (++calls < 3) throw new Error('timeout'); return '0xdeadbeef'; });
    expect(await probeArchive(getCode, PROBE, { attempts: 3, sleep: noSleep })).toBe(true);
    expect(getCode).toHaveBeenCalledTimes(3);
  });

  it('gives up on a persistent transient failure after exactly attempts calls', async () => {
    const getCode = vi.fn(transientFailure);
    await expect(probeArchive(getCode, PROBE, { attempts: 3, sleep: noSleep })).rejects.toThrow(/too long/);
    expect(getCode).toHaveBeenCalledTimes(3);
  });

  it('does not retry state_unavailable: one call, verdict false', async () => {
    const getCode = vi.fn(stateUnavailable);
    expect(await probeArchive(getCode, PROBE, { attempts: 3, sleep: noSleep })).toBe(false);
    expect(getCode).toHaveBeenCalledTimes(1);
  });
});

describe('fetchCreationBlockFromExplorer', () => {
  it('returns the block from a successful response', async () => {
    const r = await fetchCreationBlockFromExplorer({
      chainId: 1, address: ADDRESS, apiKey: KEY, fetchFn: explorerOk(12287507) as unknown as typeof fetch,
    });
    expect(r).toEqual({ ok: true, block: 12287507 });
  });

  // Measured: HTTP 200 with the failure in the body. Checking response.ok is useless.
  it('rejects a refusal body (HTTP 200, status 0, no blockNumber)', async () => {
    const r = await fetchCreationBlockFromExplorer({
      chainId: 1, address: ADDRESS, apiKey: KEY,
      fetchFn: explorerNotOk('Missing/Invalid API Key') as unknown as typeof fetch,
    });
    expect(r.ok).toBe(false);
  });

  // Pins status parsing itself: the blockNumber guard cannot save this one.
  // Mutation-verified (mutant C: trust response.ok).
  it('rejects status 0 even when the body carries a valid blockNumber', async () => {
    const sneaky = async () => new Response(JSON.stringify(
      { status: '0', message: 'NOTOK', result: [{ blockNumber: '12287507' }] }), { status: 200 });
    const r = await fetchCreationBlockFromExplorer({
      chainId: 1, address: ADDRESS, apiKey: KEY, fetchFn: sneaky as unknown as typeof fetch,
    });
    expect(r.ok).toBe(false);
  });

  it('does not blank the reason when the api key is empty', async () => {
    const r = await fetchCreationBlockFromExplorer({
      chainId: 1, address: ADDRESS, apiKey: '',
      fetchFn: explorerNotOk('Missing/Invalid API Key') as unknown as typeof fetch,
    });
    expect(r).toEqual({ ok: false, reason: 'explorer refused: Missing/Invalid API Key' });
  });

  it('carries the provider reason so the warning is actionable', async () => {
    const r = await fetchCreationBlockFromExplorer({
      chainId: 8453, address: ADDRESS, apiKey: KEY,
      fetchFn: explorerNotOk('Free API access is not supported for this chain.') as unknown as typeof fetch,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not supported for this chain/);
  });

  it('fails when the response has no usable blockNumber', async () => {
    const noBlock = async () =>
      new Response(JSON.stringify({ status: '1', result: [{ txHash: '0xabc' }] }));
    const r = await fetchCreationBlockFromExplorer({
      chainId: 1, address: ADDRESS, apiKey: KEY, fetchFn: noBlock as unknown as typeof fetch,
    });
    expect(r.ok).toBe(false);
  });

  it('fails without throwing when the request itself errors', async () => {
    const boom = async () => { throw new Error('ECONNRESET'); };
    const r = await fetchCreationBlockFromExplorer({
      chainId: 1, address: ADDRESS, apiKey: KEY, fetchFn: boom as unknown as typeof fetch,
    });
    expect(r.ok).toBe(false);
  });

  // The URL carries the API key. It must never reach a reason string.
  it('never leaks the api key into the failure reason', async () => {
    const boom = async () => { throw new Error('connect failed to https://api.etherscan.io/v2/api?apikey=SUPERSECRET'); };
    const r = await fetchCreationBlockFromExplorer({
      chainId: 1, address: ADDRESS, apiKey: 'SUPERSECRET', fetchFn: boom as unknown as typeof fetch,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).not.toContain('SUPERSECRET');
  });

  it('routes the call through the injected limiter', async () => {
    let calls = 0;
    const limit = async <T>(fn: () => Promise<T>): Promise<T> => { calls++; return fn(); };
    await fetchCreationBlockFromExplorer({
      chainId: 1, address: ADDRESS, apiKey: KEY,
      fetchFn: explorerOk(1) as unknown as typeof fetch, limit,
    });
    expect(calls).toBe(1);
  });
});

describe('resolveDeployBlock — precedence, each source failing in turn', () => {
  const base = {
    getCode: withProbe(archiveNode(12287507n)),
    chainId: 1,
    address: ADDRESS,
    safeHead: 21000000n,
    archiveProbe: PROBE,
  };

  it('prefers a validated override and makes no chain call beyond validation', async () => {
    const r = await resolveDeployBlock({ ...base, override: 12287507 });
    expect(r).toEqual({ block: 12287507, source: 'override', validated: true });
  });

  // An override is an explicit human claim and the likeliest place for a typo.
  it('throws when an override fails validation, rather than falling through', async () => {
    await expect(resolveDeployBlock({ ...base, override: 999 }))
      .rejects.toThrow(DeployBlockUnavailableError);
  });

  it('says the override was rejected and why', async () => {
    await expect(resolveDeployBlock({ ...base, override: 999 }))
      .rejects.toThrow(/override|--deploy-block/i);
  });

  it('accepts an unvalidatable override, recording it as unvalidated', async () => {
    const r = await resolveDeployBlock({ ...base, getCode: stateUnavailable, override: 55 });
    expect(r).toEqual({ block: 55, source: 'override', validated: false });
  });

  it('uses the explorer when there is no override', async () => {
    const r = await resolveDeployBlock({
      ...base, etherscanApiKey: KEY, fetchFn: explorerOk(12287507) as unknown as typeof fetch,
    });
    expect(r).toEqual({ block: 12287507, source: 'explorer', validated: true });
  });

  it('accepts an unvalidatable explorer answer as unvalidated — the Arbitrum pre-Nitro case', async () => {
    const r = await resolveDeployBlock({
      ...base, getCode: stateUnavailable, etherscanApiKey: KEY,
      fetchFn: explorerOk(55) as unknown as typeof fetch,
    });
    expect(r).toEqual({ block: 55, source: 'explorer', validated: false });
  });

  // Unlike an override, an explorer answer that fails validation is not a human
  // claim — warn and try the next source.
  it('warns and falls through when the explorer answer fails validation', async () => {
    const onWarn = vi.fn();
    const r = await resolveDeployBlock({
      ...base, etherscanApiKey: KEY, fetchFn: explorerOk(999) as unknown as typeof fetch, onWarn,
    });
    expect(r).toEqual({ block: 12287507, source: 'binary_search', validated: true });
    expect(onWarn).toHaveBeenCalled();
  });

  it('warns and falls through when the explorer itself fails', async () => {
    const onWarn = vi.fn();
    const r = await resolveDeployBlock({
      ...base, etherscanApiKey: KEY,
      fetchFn: explorerNotOk('Free API access is not supported for this chain.') as unknown as typeof fetch,
      onWarn,
    });
    expect(r.source).toBe('binary_search');
    expect(onWarn.mock.calls.flat().join(' ')).toMatch(/not supported for this chain/);
  });

  it('skips the explorer entirely when no api key is configured', async () => {
    const fetchFn = vi.fn(explorerOk(1) as unknown as typeof fetch);
    const r = await resolveDeployBlock({ ...base, fetchFn });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(r.source).toBe('binary_search');
  });

  it('binary searches when the archive probe passes', async () => {
    expect(await resolveDeployBlock(base)).toEqual({
      block: 12287507, source: 'binary_search', validated: true,
    });
  });

  it('refuses to binary search against a pruned node', async () => {
    await expect(resolveDeployBlock({ ...base, getCode: prunedNode(20000000n) }))
      .rejects.toThrow(DeployBlockUnavailableError);
  });

  // All four sources unavailable.
  it('names both escape hatches when nothing can resolve the block', async () => {
    const onWarn = vi.fn();
    const attempt = resolveDeployBlock({
      ...base, getCode: prunedNode(20000000n), etherscanApiKey: KEY,
      fetchFn: explorerNotOk('Max rate limit reached') as unknown as typeof fetch, onWarn,
    });
    await expect(attempt).rejects.toThrow(DeployBlockUnavailableError);
    await expect(attempt).rejects.toThrow(/--deploy-block/);
    await expect(attempt).rejects.toThrow(/ETHERSCAN_API_KEY/);
  });

  it('records which source won, for every source', async () => {
    const o = await resolveDeployBlock({ ...base, override: 12287507 });
    const e = await resolveDeployBlock({
      ...base, etherscanApiKey: KEY, fetchFn: explorerOk(12287507) as unknown as typeof fetch });
    const b = await resolveDeployBlock(base);
    expect([o.source, e.source, b.source]).toEqual(['override', 'explorer', 'binary_search']);
  });
});

describe('resolveDeployBlock — binary-search result is validated too', () => {
  // A load-balanced provider answering inconsistently: block 99 reads empty
  // during the search, then has code when validation reads it again.
  // Mutation-verified (mutant D): skipping the post-search validation makes
  // this test fail.
  it('throws when the found block fails validation', async () => {
    const seen = new Map<bigint, number>();
    const getCode = async ({ address, blockNumber }: { address: Address; blockNumber: bigint }) => {
      if (address === PROBE.address) return '0xdeadbeef'; // archive guard passes
      const n = (seen.get(blockNumber) ?? 0) + 1;
      seen.set(blockNumber, n);
      if (blockNumber === 99n) return n === 1 ? '0x' : '0xdeadbeef';
      return blockNumber >= 100n ? '0xdeadbeef' : '0x';
    };
    await expect(resolveDeployBlock({
      getCode, chainId: 1, address: ADDRESS, safeHead: 1000n, archiveProbe: PROBE,
    })).rejects.toThrow(DeployBlockUnavailableError);
  });
});
