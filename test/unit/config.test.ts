import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { ConfigError } from '../../src/errors.js';

const CHAINS = {
  '1': {
    name: 'ethereum', initialChunk: 2000, maxChunk: 10000,
    requestsPerSecond: 25, confirmations: 12, blockFetchThreshold: 3,
    archiveProbe: { address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', block: 4719569 },
  },
  '8453': {
    name: 'base', initialChunk: 5000, maxChunk: 20000,
    requestsPerSecond: 25, confirmations: 30, blockFetchThreshold: 3,
    archiveProbe: { address: '0x4200000000000000000000000000000000000006', block: 100000 },
  },
};

describe('loadConfig', () => {
  it('discovers every RPC_URL_<chainId> key', () => {
    const cfg = loadConfig(
      { RPC_URL_1: 'https://a.example/k', RPC_URL_8453: 'https://b.example/k', DB_PATH: './x.db' },
      CHAINS,
    );
    expect([...cfg.chains.keys()].sort((a, b) => a - b)).toEqual([1, 8453]);
    expect(cfg.chains.get(1)?.rpcUrl).toBe('https://a.example/k');
    expect(cfg.chains.get(8453)?.confirmations).toBe(30);
  });

  it('throws when no RPC_URL_<chainId> is set', () => {
    expect(() => loadConfig({ DB_PATH: './x.db' }, CHAINS)).toThrow(ConfigError);
  });

  it('throws on a malformed RPC URL', () => {
    expect(() => loadConfig({ RPC_URL_1: 'not-a-url', DB_PATH: './x.db' }, CHAINS))
      .toThrow(ConfigError);
  });

  it('ignores an RPC_URL for a chain absent from chains.json', () => {
    const cfg = loadConfig(
      { RPC_URL_1: 'https://a.example/k', RPC_URL_999: 'https://c.example/k', DB_PATH: './x.db' },
      CHAINS,
    );
    expect(cfg.chains.has(999)).toBe(false);
  });

  it('still scrubs an RPC_URL for a chain absent from chains.json', () => {
    const cfg = loadConfig(
      {
        RPC_URL_1: 'https://a.example/k',
        RPC_URL_999: 'https://c.example/UNKNOWNCHAINKEY',
        DB_PATH: './x.db',
      },
      CHAINS,
    );
    expect(cfg.chains.has(999)).toBe(false);
    expect(cfg.secrets).toContain('https://c.example/UNKNOWNCHAINKEY');
  });

  it('leaves a chain in chains.json without an env var unavailable, not an error', () => {
    const cfg = loadConfig({ RPC_URL_1: 'https://a.example/k', DB_PATH: './x.db' }, CHAINS);
    expect(cfg.chains.has(8453)).toBe(false);
  });

  it('collects every secret for log scrubbing', () => {
    const cfg = loadConfig(
      { RPC_URL_1: 'https://a.example/SECRETKEY', ETHERSCAN_API_KEY: 'ESKEY', DB_PATH: './x.db' },
      CHAINS,
    );
    expect(cfg.secrets).toContain('https://a.example/SECRETKEY');
    expect(cfg.secrets).toContain('ESKEY');
  });

  // Scope bar: this project must never hold a private key.
  it('has no private-key field in the schema', () => {
    const cfg = loadConfig(
      { RPC_URL_1: 'https://a.example/k', PRIVATE_KEY: '0xdeadbeef', DB_PATH: './x.db' },
      CHAINS,
    );
    expect(JSON.stringify(cfg)).not.toContain('0xdeadbeef');
    expect(Object.keys(cfg)).not.toContain('privateKey');
  });
});
