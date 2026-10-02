import { afterEach, describe, expect, it } from 'vitest';
import { getChainClient, resetChainClients } from '../../src/chain/client.js';
import { ConfigError } from '../../src/errors.js';
import type { ChainConfig, Config } from '../../src/config.js';

const chain = (chainId: number, name: string): ChainConfig => ({
  chainId, name, rpcUrl: `https://${name}.example/v2/key`,
  initialChunk: 2000, maxChunk: 10000, confirmations: 12,
  archiveProbe: { address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', block: 1 },
});

const configWith = (...ids: Array<[number, string]>): Config => ({
  chains: new Map(ids.map(([id, name]) => [id, chain(id, name)])),
  defaultChainId: ids[0]?.[0],
  dbPath: ':memory:',
  etherscanApiKey: undefined,
  computeUnitsPerSecond: 300,
  secrets: ids.map(([, name]) => `https://${name}.example/v2/key`),
});

afterEach(() => resetChainClients());

describe('getChainClient — memoization', () => {
  it('returns the identical object for the same chain id', () => {
    const config = configWith([1, 'eth']);
    expect(getChainClient(1, config)).toBe(getChainClient(1, config));
  });

  it('returns the identical client and limiter, not just an equal wrapper', () => {
    const config = configWith([1, 'eth']);
    const a = getChainClient(1, config);
    const b = getChainClient(1, config);
    expect(a.client).toBe(b.client);
    expect(a.limit).toBe(b.limit);
  });

  it('returns different objects for different chains', () => {
    const config = configWith([1, 'eth'], [8453, 'base']);
    expect(getChainClient(1, config)).not.toBe(getChainClient(8453, config));
  });

  it('forgets everything after resetChainClients', () => {
    const config = configWith([1, 'eth']);
    const first = getChainClient(1, config);
    resetChainClients();
    expect(getChainClient(1, config)).not.toBe(first);
  });
});

describe('getChainClient — failures are not memoized', () => {
  it('throws ConfigError for an unconfigured chain', () => {
    expect(() => getChainClient(999, configWith([1, 'eth']))).toThrow(ConfigError);
  });

  it('names the missing env var so the error is actionable', () => {
    expect(() => getChainClient(999, configWith([1, 'eth']))).toThrow(/RPC_URL_999/);
  });

  // Caching the failure would turn a transient misconfiguration into a
  // permanent one for the life of the process.
  it('succeeds on a later call once the chain is configured', () => {
    expect(() => getChainClient(999, configWith([1, 'eth']))).toThrow(ConfigError);
    const fixed = configWith([1, 'eth'], [999, 'newchain']);
    expect(() => getChainClient(999, fixed)).not.toThrow();
    expect(getChainClient(999, fixed).chainId).toBe(999);
  });

  it('still throws every time while the chain stays unconfigured', () => {
    const config = configWith([1, 'eth']);
    expect(() => getChainClient(999, config)).toThrow(ConfigError);
    expect(() => getChainClient(999, config)).toThrow(ConfigError);
  });
});

describe('getChainClient — one bucket per chain', () => {
  // PREMISE REVISED — the original assumption predated the compute-unit
  // finding. "A slow mainnet backfill must not throttle Base" is no longer
  // literally true and cannot be: Alchemy's CU/s ceiling is ACCOUNT-WIDE, so
  // chains running concurrently draw on one shared budget. A mainnet backfill
  // saturating that budget necessarily slows Base. Measured cause: getLogs is
  // 60 CU and the documented free-tier ceiling is 300 CU/s, so a
  // request-counting bucket at 25/s draws 1,500 CU/s and 429s — which is what
  // happened.
  //
  // What survives, and what this file still pins: per-chain buckets for
  // FAIRNESS, so no chain monopolises ordering or pacing. The account-level CU
  // budget they draw from is the separate mechanism that stops them
  // collectively breaching a ceiling none of them can see alone.
  //
  // Behavioural independence of two buckets (one draining, one untouched) is
  // already pinned with an injected clock in rateLimit.test.ts ("gives two
  // limiters separate token pools" — no wall clock involved there). This test
  // does not need to re-prove that property; it only needs to prove the
  // WIRING — that getChainClient hands each chain its own limiter instance
  /**
   * REVERSED, deliberately, and this is the second time this test's premise has changed.
   *
   * It first asserted that each chain got its own bucket so a slow mainnet backfill could
   * not throttle Base. Then the comment was corrected, because the compute-unit ceiling
   * is ACCOUNT-WIDE and that goal is not achievable — concurrent chains draw on one
   * budget. Now the assertions match: the limiter is SHARED, because per-chain buckets
   * could only have divided a budget they did not control while letting their sum exceed
   * it, which is the failure mode that earns a 429.
   *
   * Timing is not asserted here. `getChainClient` builds its limiter with the real
   * systemClock and has no clock parameter, so a timing assertion would be a wall-clock
   * read in a suite that injects time everywhere else. The spend arithmetic is pinned in
   * rateLimit.test.ts against an injected clock; this pins the WIRING.
   */
  it('shares ONE limiter across chains, because the budget is account-wide', () => {
    const config = configWith([1, 'eth'], [8453, 'base']);
    expect(getChainClient(1, config).limit).toBe(getChainClient(8453, config).limit);
  });

  it('still runs work submitted through either chain handle', async () => {
    const config = configWith([1, 'eth'], [8453, 'base']);
    const eth = getChainClient(1, config);
    const base = getChainClient(8453, config);
    const ran: string[] = [];
    // Cheap costs, so the shared bucket is not exhausted and this does not become a
    // wall-clock wait.
    await eth.limit(async () => { ran.push('eth'); }, 1);
    await base.limit(async () => { ran.push('base'); }, 1);
    expect(ran).toEqual(['eth', 'base']);
  });

  it('builds a fresh shared limiter after a reset, so a changed ceiling takes effect', () => {
    const first = getChainClient(1, configWith([1, 'eth'])).limit;
    resetChainClients();
    expect(getChainClient(1, configWith([1, 'eth'])).limit).not.toBe(first);
  });

});
