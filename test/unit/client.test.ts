import { afterEach, describe, expect, it } from 'vitest';
import { getChainClient, resetChainClients } from '../../src/chain/client.js';
import { ConfigError } from '../../src/errors.js';
import type { ChainConfig, Config } from '../../src/config.js';

const chain = (chainId: number, name: string): ChainConfig => ({
  chainId, name, rpcUrl: `https://${name}.example/v2/key`,
  initialChunk: 2000, maxChunk: 10000, requestsPerSecond: 5,
  confirmations: 12, blockFetchThreshold: 3,
  archiveProbe: { address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', block: 1 },
});

const configWith = (...ids: Array<[number, string]>): Config => ({
  chains: new Map(ids.map(([id, name]) => [id, chain(id, name)])),
  defaultChainId: ids[0]?.[0],
  dbPath: ':memory:',
  etherscanApiKey: undefined,
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
  // A slow mainnet backfill must not throttle Base.
  it('does not let one chain drain another chain\'s bucket', async () => {
    const config = configWith([1, 'eth'], [8453, 'base']);
    const eth = getChainClient(1, config);
    const base = getChainClient(8453, config);

    expect(eth.limit).not.toBe(base.limit);

    // Drain mainnet's bucket entirely (capacity is requestsPerSecond = 5).
    const started: string[] = [];
    for (let i = 0; i < 5; i++) await eth.limit(async () => { started.push('eth'); });

    // Base must still run immediately. If the buckets were shared this would
    // block on mainnet's exhausted tokens.
    const before = Date.now();
    await base.limit(async () => { started.push('base'); });
    expect(Date.now() - before).toBeLessThan(50);
    expect(started.filter((s) => s === 'base')).toHaveLength(1);
  });

  it('gives each chain a limiter sized from its own requestsPerSecond', () => {
    const config = configWith([1, 'eth'], [8453, 'base']);
    expect(getChainClient(1, config).limit).not.toBe(getChainClient(8453, config).limit);
  });
});
