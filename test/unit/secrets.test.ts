import { describe, expect, it } from 'vitest';
import { deriveSecretTokens, scrubSecrets, scrubUnknown } from '../../src/secrets.js';

const KEY = 'aBcD1234efGh5678ijKl9012mnOp3456';
const RPC_URL = `https://eth-mainnet.g.alchemy.com/v2/${KEY}`;
const ES_KEY = 'ESKEY9876543210ABCDEF';

describe('deriveSecretTokens', () => {
  it('includes the raw secret', () => {
    expect(deriveSecretTokens([RPC_URL])).toContain(RPC_URL);
  });

  it('extracts the key segment from the URL path', () => {
    expect(deriveSecretTokens([RPC_URL])).toContain(KEY);
  });

  it('includes the percent-encoded raw secret', () => {
    expect(deriveSecretTokens([RPC_URL])).toContain(encodeURIComponent(RPC_URL));
  });

  it('extracts a query-parameter value', () => {
    const tokens = deriveSecretTokens([`https://api.example.com/v2/api?apikey=${ES_KEY}`]);
    expect(tokens).toContain(ES_KEY);
  });

  it('keeps a bare non-URL secret', () => {
    expect(deriveSecretTokens([ES_KEY])).toContain(ES_KEY);
  });

  // Redacting "v2" or "eth-mainnet" would mangle every log line in the project.
  it('does not treat short or structural path segments as secrets', () => {
    const tokens = deriveSecretTokens([RPC_URL]);
    expect(tokens).not.toContain('v2');
    expect(tokens).not.toContain('eth-mainnet.g.alchemy.com');
  });

  it('ignores empty and whitespace-only secrets', () => {
    expect(deriveSecretTokens(['', '   '])).toEqual([]);
  });

  it('orders tokens longest first so a short token cannot fragment a longer one', () => {
    const tokens = deriveSecretTokens([RPC_URL]);
    const lengths = tokens.map((t) => t.length);
    expect([...lengths].sort((a, b) => b - a)).toEqual(lengths);
  });
});

describe('scrubSecrets', () => {
  const tokens = deriveSecretTokens([RPC_URL, ES_KEY]);

  it('removes a bare key', () => {
    expect(scrubSecrets(`calling with ${KEY} now`, tokens)).not.toContain(KEY);
  });

  it('removes a full URL', () => {
    const out = scrubSecrets(`GET ${RPC_URL} failed`, tokens);
    expect(out).not.toContain(KEY);
    expect(out).toContain('GET');
    expect(out).toContain('failed');
  });

  it('removes the percent-encoded form', () => {
    expect(scrubSecrets(encodeURIComponent(RPC_URL), tokens)).not.toContain(KEY);
  });

  it('removes every occurrence, not just the first', () => {
    expect(scrubSecrets(`${KEY} and ${KEY} and ${KEY}`, tokens)).not.toContain(KEY);
  });

  // The fallback: this key was never in Config.secrets.
  it('redacts an Alchemy-shaped key that no token knows about', () => {
    const unknownKey = 'zZyYxXwW1122334455667788990011223';
    const out = scrubSecrets(`https://base-mainnet.g.alchemy.com/v2/${unknownKey}`, tokens);
    expect(out).not.toContain(unknownKey);
  });

  it('redacts an apikey query value that no token knows about', () => {
    const unknownKey = 'QRSTUV1234567890abcdef';
    const out = scrubSecrets(`https://api.etherscan.io/v2/api?apikey=${unknownKey}&x=1`, tokens);
    expect(out).not.toContain(unknownKey);
  });

  it('leaves ordinary prose untouched', () => {
    const prose = 'indexed 1200 transfers for chain 8453 in 4.2s';
    expect(scrubSecrets(prose, tokens)).toBe(prose);
  });

  it('is a no-op with no tokens and no fallback match', () => {
    expect(scrubSecrets('plain text', [])).toBe('plain text');
  });
});

describe('scrubUnknown', () => {
  const tokens = deriveSecretTokens([RPC_URL]);

  it('scrubs an Error message', () => {
    expect(scrubUnknown(new Error(`boom ${KEY}`), tokens)).not.toContain(KEY);
  });

  it('scrubs a non-Error value without throwing', () => {
    expect(scrubUnknown(KEY, tokens)).not.toContain(KEY);
    expect(scrubUnknown(null, tokens)).toBe('null');
  });
});
