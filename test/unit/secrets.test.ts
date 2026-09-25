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

  // Total stringify: a hostile toString() must not crash the caller — this
  // runs inside the probe script's catch block, where the thrown value's
  // shape is never trustworthy.
  it('does not throw for a value whose toString throws', () => {
    const hostile = { toString() { throw new Error('nope'); } };
    expect(() => scrubUnknown(hostile, [])).not.toThrow();
  });
});

// Critical 1: a secret containing a JSON-escapable character (quote,
// backslash, control char) is not the same byte sequence once pino's JSON
// serializer has escaped it. The escaped form must be a token in its own
// right, or the secret survives serialization in the clear.
describe('deriveSecretTokens — JSON-escaped form', () => {
  it('includes the JSON-escaped form of a secret containing a quote', () => {
    const quoted = 'ab"cdef1234567890';
    const tokens = deriveSecretTokens([quoted]);
    expect(tokens).toContain(JSON.stringify(quoted).slice(1, -1));
  });
});

describe('scrubSecrets — JSON-escaped form', () => {
  it('scrubs a secret as it would appear after JSON serialization', () => {
    const quoted = 'ab"cdef1234567890';
    const tokens = deriveSecretTokens([quoted]);
    const serialized = JSON.stringify({ note: `key ${quoted} here` });
    const out = scrubSecrets(serialized, tokens);
    expect(out).not.toContain('cdef1234567890');
  });
});

// Critical 2: Infura's documented basic-auth form, https://:KEY@host/v3/ID —
// url.username/url.password are a distinct source of secret material from
// the path segment, and no fallback pattern previously covered them.
describe('deriveSecretTokens — basic-auth credentials', () => {
  it('includes the basic-auth password as a token', () => {
    const password = 'PROJSECRET1234567890abcd';
    const tokens = deriveSecretTokens([
      `https://:${password}@mainnet.infura.io/v3/ID1234567890123456`,
    ]);
    expect(tokens).toContain(password);
  });
});

describe('scrubSecrets — basic-auth credentials', () => {
  it('redacts a known Infura-style basic-auth password', () => {
    const password = 'PROJSECRET1234567890abcd';
    const url = `https://:${password}@mainnet.infura.io/v3/ID1234567890123456`;
    const tokens = deriveSecretTokens([url]);
    expect(scrubSecrets(`GET ${url} failed`, tokens)).not.toContain(password);
  });

  it('redacts an unknown basic-auth password via the fallback pattern', () => {
    const out = scrubSecrets(
      'https://:unknownpass1234567890@mainnet.infura.io/v3/abc',
      [],
    );
    expect(out).not.toContain('unknownpass1234567890');
  });
});

// Important 3: the path-key fallback must stay narrow. This project's own
// logs are full of doc URLs and contract addresses; the pattern must not
// treat either as a secret.
describe('fallback path-key pattern — narrowed to avoid over-matching', () => {
  it('leaves a docs URL slug after /v2/ untouched', () => {
    const prose = 'see https://docs.example.com/v2/getting-started-with-indexers';
    expect(scrubSecrets(prose, [])).toBe(prose);
  });

  it('leaves a lowercase 0x-prefixed contract address after /v2/ untouched', () => {
    const prose = 'contract at /v2/0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
    expect(scrubSecrets(prose, [])).toBe(prose);
  });

  it('still redacts a mixed-case alphanumeric key after /v2/', () => {
    const unknownKey = 'zZyYxXwW1122334455667788990011223';
    const out = scrubSecrets(`https://base-mainnet.g.alchemy.com/v2/${unknownKey}`, []);
    expect(out).not.toContain(unknownKey);
  });

  it('also covers /v1/ and /v3/ prefixes', () => {
    const unknownKey = 'zZyYxXwW1122334455667788990011223';
    expect(scrubSecrets(`https://api.example.com/v1/${unknownKey}`, [])).not.toContain(unknownKey);
    expect(scrubSecrets(`https://api.example.com/v3/${unknownKey}`, [])).not.toContain(unknownKey);
  });
});

// Important 4: the query-param fallback must only fire on credential-shaped
// names. This project logs `tokenId` on essentially every line.
describe('fallback query-param pattern — credential names only', () => {
  it('does not redact tokenId, a field this project logs constantly', () => {
    const prose = 'tokenId=123456789012345678';
    expect(scrubSecrets(prose, [])).toBe(prose);
  });

  it('does not redact a bare key= param', () => {
    const prose = 'key=abcdefghij1234567890';
    expect(scrubSecrets(prose, [])).toBe(prose);
  });

  it('still redacts credential-shaped query param names', () => {
    const unknownKey = 'QRSTUV1234567890abcdef';
    expect(scrubSecrets(`?dkey=${unknownKey}`, [])).not.toContain(unknownKey);
    expect(scrubSecrets(`?auth_token=${unknownKey}`, [])).not.toContain(unknownKey);
    expect(scrubSecrets(`?secret=${unknownKey}`, [])).not.toContain(unknownKey);
  });
});

// Minor (a): overlapping tokens must not leave a fragment of either behind.
describe('scrubSecrets — overlapping tokens', () => {
  it('fully redacts two secrets that share overlapping characters, leaving no fragment', () => {
    const secretA = 'AAAAAAAABBBBBBBB'; // 16 chars
    const secretB = 'BBBBBBBBCCCCCCCC'; // 16 chars, shares 'BBBBBBBB' with secretA
    const text = `prefix ${secretA.slice(0, 8)}${secretB} suffix`;
    const out = scrubSecrets(text, [secretA, secretB]);
    expect(out).not.toContain('AAAAAAAA');
    expect(out).not.toContain('BBBBBBBB');
    expect(out).not.toContain('CCCCCCCC');
  });
});

// Minor (b): the lowered minimum still yields a token for a short key.
describe('deriveSecretTokens — lowered minimum token length', () => {
  it('tokenizes an 8-character bare key', () => {
    const shortKey = 'AbC12345';
    expect(deriveSecretTokens([shortKey])).toContain(shortKey);
  });
});

// Minor (c): matching is case-insensitive.
describe('scrubSecrets — case sensitivity', () => {
  it('redacts a case-folded secret', () => {
    const tokens = deriveSecretTokens([KEY]);
    const folded = KEY.toLowerCase();
    expect(scrubSecrets(`calling with ${folded} now`, tokens)).not.toContain(folded);
  });
});
