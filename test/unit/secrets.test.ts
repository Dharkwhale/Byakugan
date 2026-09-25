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

  // "v2" (2 chars) is far below MIN_TOKEN_LENGTH (8) and doesn't actually
  // probe the lowered constant. A 7-character structural segment is the
  // realistic near-miss: one character short of the minimum, and a name
  // ("mainnet") this project's own RPC URLs plausibly contain.
  it('does not harvest a 7-character structural path segment just under the minimum', () => {
    const tokens = deriveSecretTokens(['https://mainnet.example.com/v2/api']);
    expect(tokens).not.toContain('mainnet');
  });

  it('ignores empty and whitespace-only secrets', () => {
    expect(deriveSecretTokens(['', '   '])).toEqual([]);
  });
});

describe('scrubSecrets — token order does not matter', () => {
  // deriveSecretTokens returns tokens longest-first as a courtesy, but
  // scrubSecrets must not depend on that: it finds each token's occurrences
  // independently and only merges afterward. Passing tokens in the WRONG
  // order (shortest first) is the behavioural version of the old "ordering"
  // test, which only checked deriveSecretTokens's own output and would pass
  // even if scrubSecrets silently required sorted input.
  it('fully redacts a secret even when a token that could fragment it is passed first', () => {
    const shortToken = KEY.slice(0, 8); // a prefix of KEY, shorter than KEY itself
    const out = scrubSecrets(`calling with ${KEY} now`, [shortToken, KEY]);
    expect(out).not.toContain(KEY);
    expect(out).not.toContain(KEY.slice(8)); // no fragment of the non-shared remainder
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

// Important 4 / round-3: the query-param fallback and query-value harvesting
// now share ONE table (CREDENTIAL_QUERY_PARAMS in src/secrets.ts) so they
// can't drift the way they did before — the fallback used to redact
// ?x-api-key=/?api_secret= that harvesting never turned into tokens, and
// bare ?token=/?password= were harvested by neither. Bare `token`/`secret`/
// `password` are safe to include because this is a param-NAME match
// requiring an exact `name=` — it does not match `tokenId=` or `token_id=`,
// which this project logs constantly.
describe('fallback query-param pattern — credential names only', () => {
  it('does not redact tokenId, a field this project logs constantly', () => {
    const prose = 'tokenId=123456789012345678';
    expect(scrubSecrets(prose, [])).toBe(prose);
  });

  it('does not redact token_id either', () => {
    const prose = 'token_id=123456789012345678';
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

  // Round-3: broadened coverage, previously missing or inconsistent between
  // harvesting and the fallback.
  it('redacts x-api-key and api_secret in the fallback', () => {
    const unknownKey = 'QRSTUV1234567890abcdef';
    expect(scrubSecrets(`?x-api-key=${unknownKey}`, [])).not.toContain(unknownKey);
    expect(scrubSecrets(`?api_secret=${unknownKey}`, [])).not.toContain(unknownKey);
  });

  it('redacts bare token=, password=, passwd=, and pwd= in the fallback', () => {
    const unknownKey = 'QRSTUV1234567890abcdef';
    expect(scrubSecrets(`?token=${unknownKey}`, [])).not.toContain(unknownKey);
    expect(scrubSecrets(`?password=${unknownKey}`, [])).not.toContain(unknownKey);
    expect(scrubSecrets(`?passwd=${unknownKey}`, [])).not.toContain(unknownKey);
    expect(scrubSecrets(`?pwd=${unknownKey}`, [])).not.toContain(unknownKey);
  });

  it('harvests x-api-key, api_secret, bare token=, and password= as tokens too', () => {
    const value = 'HARVESTVALUE1234567890';
    for (const paramName of ['x-api-key', 'api_secret', 'token', 'password']) {
      const tokens = deriveSecretTokens([`https://rpc.example.com/v2/abcd1234?${paramName}=${value}`]);
      expect(tokens).toContain(value);
    }
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

// Minor (c) — case-insensitivity — was tested here with a single hand-picked
// example. Removed in round 3: the property test below (see "hostile
// Unicode filler") exercises case-folding as one of its randomized variants
// across hundreds of iterations and generic filler contexts, which strictly
// subsumes this specific example.

// Critical (new): findTokenRanges must never compute match indices on a
// case-folded copy of the text. toLowerCase() changes the length of U+0130
// İ (it becomes "i" + U+0307, two UTF-16 code units instead of one), which
// skews every index after an İ relative to the original string — leaking a
// prefix of whatever secret follows and eating unrelated trailing text
// instead. On-chain metadata (collection/token names) is attacker-supplied,
// so this is reachable by anyone who can mint a token whose name contains İ.
describe('scrubSecrets — İ (U+0130) index skew', () => {
  const skewKey = 'aBcDeF0123456789KEYTAIL';

  it.each([1, 4, 16])('does not leak the key when %i İ character(s) precede it', (n) => {
    const tokens = deriveSecretTokens([skewKey]);
    const prefix = 'İ'.repeat(n);
    const text = `${prefix} url=${skewKey}trailing-text-here`;
    const out = scrubSecrets(text, tokens);
    expect(out).not.toContain(skewKey);
    // Check every prefix of the key, not just the whole key: a whole-key
    // check passes even while e.g. the first 16 of 23 characters leak.
    for (let len = 4; len <= skewKey.length; len += 4) {
      expect(out).not.toContain(skewKey.slice(0, len));
    }
  });

  it('leaves ordinary Turkish text unchanged when no secret is present', () => {
    const turkish = "İstanbul için İzmir'den İnternet üzerinden istek gönderildi";
    expect(scrubSecrets(turkish, [])).toBe(turkish);
  });
});

// Important (new): Config.secrets holds operator-supplied RPC URLs. A
// benign query param on one of them (e.g. ?network=arbitrum-one) must not
// become a project-wide redaction token just because it happens to be long
// enough — only a credential-shaped param name should cause harvesting.
describe('deriveSecretTokens — query-value harvesting restricted to credential-named params', () => {
  it('does not harvest a non-credential query value', () => {
    const tokens = deriveSecretTokens([
      'https://rpc.example.com/v2/aBcD1234?network=arbitrum-one',
    ]);
    expect(tokens).not.toContain('arbitrum-one');
  });

  it('still harvests a credential-named query value', () => {
    const value = 'CREDVALUE1234567890';
    const tokens = deriveSecretTokens([`https://rpc.example.com/v2/api?apikey=${value}`]);
    expect(tokens).toContain(value);
  });
});

// Important (new): three rounds of hand-picked adversarial inputs is the
// wrong instrument — that is exactly where the İ bug hid. A deterministic
// (seeded, not Math.random()) property test sprays a hostile Unicode
// alphabet around a spliced secret and checks the general invariant instead
// of one fixture at a time. Any failure reproduces exactly, because the
// PRNG is seeded.
describe('scrubSecrets — property test across hostile Unicode filler', () => {
  // mulberry32: small, deterministic, seeded PRNG. Not cryptographic — only
  // needs to be reproducible and reasonably well distributed.
  function mulberry32(seed: number): () => number {
    let s = seed;
    return () => {
      s |= 0;
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // BMP look-alikes/length-changers under case-folding, combining marks,
  // astral surrogate pairs (emoji + a mathematical-alphanumeric character),
  // RTL control marks, and plain ASCII — the categories the finding named.
  // Written as explicit \u escapes (rather than the literal glyphs) so the
  // combining marks and RTL controls stay legible in source instead of
  // silently attaching to whatever character precedes them in the editor.
  const ATOMS = [
    'İ', 'ß', 'ſ', 'K', // U+0130, U+00DF, U+017F, U+212A (Kelvin sign)
    '̀', '́', '̈', 'ͯ', // combining marks
    '😀', '🔥', '\u{1D400}', '\u{1D49C}', // astral surrogate pairs
    '‏', '‮', // RTL mark, RTL override
    'a', 'b', 'Z', '9', ' ', '-', '_', '.', // plain ASCII
  ];

  function randomFiller(rand: () => number, length: number): string {
    let out = '';
    for (let i = 0; i < length; i++) {
      out += ATOMS[Math.floor(rand() * ATOMS.length)];
    }
    return out;
  }

  // Two fixtures: one plain (for the raw/case-folded/percent-encoded
  // variants — it contains '/', '+', '=' so percent-encoding actually
  // transforms it, not a no-op), one containing a quote (for the
  // JSON-escaped variant — a secret with no escapable character would make
  // that branch a no-op and decorative, the same mistake flagged earlier).
  const PLAIN_SECRET = 'zQ7mPk2R/t9Lw+4Vb1=';
  const QUOTED_SECRET = 'zQ7"Pk2Rt9Lw4Vb1c2';

  function pickVariant(rand: () => number): { tokens: string[]; spliced: string } {
    const roll = rand();
    if (roll < 0.34) {
      return { tokens: deriveSecretTokens([PLAIN_SECRET]), spliced: PLAIN_SECRET };
    }
    if (roll < 0.67) {
      return {
        tokens: deriveSecretTokens([PLAIN_SECRET]),
        spliced: PLAIN_SECRET.toLowerCase(),
      };
    }
    if (roll < 0.84) {
      return {
        tokens: deriveSecretTokens([PLAIN_SECRET]),
        spliced: encodeURIComponent(PLAIN_SECRET),
      };
    }
    return {
      tokens: deriveSecretTokens([QUOTED_SECRET]),
      spliced: JSON.stringify(QUOTED_SECRET).slice(1, -1),
    };
  }

  // Threshold and filler size are load-bearing, not arbitrary: the İ-leak
  // length equals the number of İ characters preceding the secret, and with
  // too few filler atoms the probability of a run long enough to clear a
  // higher threshold collapses. A round-2 version of this test asserted
  // len >= 4 with a filler cap of 12 atoms (only ~1/22 of them İ) — measured
  // afterward, against a deliberately reconstructed pre-fix
  // (toLowerCase-based) implementation, at 0 failures out of 300, because
  // the maximum İ run across all 300 seeded iterations never reached 4. The
  // same generator at len >= 1 caught the same reconstructed bug 65/300
  // times. len >= 1 with a 40-atom filler cap and 500 iterations was
  // measured (against the current, fixed implementation) to produce zero
  // false positives before adopting it here.
  it('leaves no 1+ character prefix of the spliced secret in the output, across hundreds of randomized hostile-Unicode splices', () => {
    const SEED = 0xc0ffee;
    const ITERATIONS = 500;
    const FILLER_MAX = 40;
    const rand = mulberry32(SEED);

    for (let i = 0; i < ITERATIONS; i++) {
      const before = randomFiller(rand, Math.floor(rand() * FILLER_MAX));
      const after = randomFiller(rand, Math.floor(rand() * FILLER_MAX));
      const { tokens, spliced } = pickVariant(rand);

      const text = `${before}${spliced}${after}`;
      const out = scrubSecrets(text, tokens);

      for (let len = 1; len <= spliced.length; len++) {
        const prefix = spliced.slice(0, len);
        if (out.includes(prefix)) {
          throw new Error(
            `iteration ${i} (seed 0x${SEED.toString(16)}) leaked a ${len}-character ` +
              `prefix of the spliced secret. before.length=${before.length}, ` +
              `after.length=${after.length}, spliced=${JSON.stringify(spliced)}`,
          );
        }
      }
    }
  });
});
