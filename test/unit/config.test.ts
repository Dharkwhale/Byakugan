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

describe('Telegram configuration', () => {
  const env = {
    RPC_URL_1: 'https://eth.example/v2/abcdefghijklmnop',
    DEFAULT_CHAIN_ID: '1',
  };

  it('parses the token and the allowlist', () => {
    const cfg = loadConfig({
      ...env,
      TELEGRAM_BOT_TOKEN: '123456:AAbbccddeeffgghh',
      TELEGRAM_ALLOWED_USER_IDS: '111, 222 ,333',
    }, CHAINS);
    expect(cfg.telegramBotToken).toBe('123456:AAbbccddeeffgghh');
    expect(cfg.telegramAllowedUserIds).toEqual([111, 222, 333]);
  });

  it('puts the BOT TOKEN in secrets, so the output scrubber covers it', () => {
    // grammY builds every request URL as api.telegram.org/bot<TOKEN>/… and those URLs
    // appear in error dumps. That is the same shape that put an Alchemy key into a
    // transcript and cost a rotation; the stream scrub only covers the token once it is
    // in `secrets`.
    const cfg = loadConfig({ ...env, TELEGRAM_BOT_TOKEN: '123456:AAbbccddeeffgghh' }, CHAINS);
    expect(cfg.secrets).toContain('123456:AAbbccddeeffgghh');
  });

  it('tolerates both fields being absent, because the CLI needs neither', () => {
    const cfg = loadConfig(env, CHAINS);
    expect(cfg.telegramBotToken).toBeUndefined();
    expect(cfg.telegramAllowedUserIds).toEqual([]);
  });

  it('rejects an allowlist entry that is not a numeric user id', () => {
    expect(() => loadConfig(
      { ...env, TELEGRAM_ALLOWED_USER_IDS: '111,@alice' }, CHAINS,
    )).toThrow(/TELEGRAM_ALLOWED_USER_IDS/);
  });

  it('ignores stray commas and whitespace rather than producing NaN ids', () => {
    const cfg = loadConfig(
      { ...env, TELEGRAM_ALLOWED_USER_IDS: ' 111 , , 222, ' }, CHAINS,
    );
    expect(cfg.telegramAllowedUserIds).toEqual([111, 222]);
  });
});
