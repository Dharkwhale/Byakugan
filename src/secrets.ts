/** Minimum length for a path segment, query value, or bare key to be treated as a secret. */
const MIN_TOKEN_LENGTH = 8;

const REDACTED = '[REDACTED]';

/**
 * A segment after `/v1|v2|v3/` only counts as a key if it looks like one —
 * mixed-case alphanumeric with a digit — and is not a hex address or hash
 * (`0x...`). Without this guard the pattern also fires on ordinary doc-URL
 * slugs (`/v2/getting-started-with-indexers`) and on the contract addresses
 * this project logs constantly (`/v2/0xc02aaa39...`), which would make the
 * indexer's own output useless.
 */
function looksLikeKey(segment: string): boolean {
  if (segment.startsWith('0x')) return false; // contract address or hash
  return /[0-9]/.test(segment) && /[a-z]/.test(segment) && /[A-Z]/.test(segment);
}

function redactPathKey(text: string): string {
  return text.replace(
    /(\/v[123]\/)([A-Za-z0-9_-]{24,})/g,
    (whole: string, prefix: string, segment: string) =>
      looksLikeKey(segment) ? `${prefix}${REDACTED}` : whole,
  );
}

/**
 * Only credential-shaped query param names. Deliberately excludes bare `key`
 * and bare `token` — this project logs `tokenId` constantly, and a bare
 * `token=` rule would redact it on every line. Shared with
 * `deriveSecretTokens`'s query-value harvesting, so both use one definition
 * of "looks like a credential param name".
 */
const CREDENTIAL_PARAM_NAME_ALTERNATION =
  'api[-_]?key|apikey|dkey|access[-_]?token|auth[-_]?token|secret';
const CREDENTIAL_PARAM_NAME_RE = new RegExp(`^(?:${CREDENTIAL_PARAM_NAME_ALTERNATION})$`, 'i');

function redactQueryKey(text: string): string {
  return text.replace(
    new RegExp(`((?:${CREDENTIAL_PARAM_NAME_ALTERNATION})=)[A-Za-z0-9_.-]{8,}`, 'gi'),
    `$1${REDACTED}`,
  );
}

/** Infura-style basic-auth credentials: https://:SECRET@host/... */
function redactBasicAuth(text: string): string {
  return text.replace(/(\/\/[^/\s:@]*:)[^/\s@]+(@)/g, `$1${REDACTED}$2`);
}

/**
 * Patterns for secrets no token knows about — a URL built at runtime, or a
 * chain configured after the logger was constructed. Each only fires inside a
 * URL-ish context (a versioned path segment, a credential-named query param,
 * or basic-auth userinfo), so ordinary prose and contract addresses are left
 * alone.
 */
const FALLBACK_PASSES: Array<(text: string) => string> = [
  redactPathKey,
  redactQueryKey,
  redactBasicAuth,
];

/**
 * Expands raw secrets into every form they might appear in.
 *
 * A secret stored as a full URL will not match a log line carrying only its
 * key segment, its basic-auth userinfo, the same URL percent-encoded
 * (`encodeURIComponent` leaves the alphanumeric key intact while encoding the
 * separators around it), or the same value JSON-escaped by pino's serializer
 * (a quote, backslash, or control character in the raw secret is not the same
 * byte sequence once JSON.stringify has run). So every one of those forms
 * becomes a token in its own right.
 *
 * Returned longest-first for readability when inspected directly; this is a
 * courtesy, not a dependency — `scrubSecrets` finds and merges match ranges
 * per token independently of input order (see its own comment).
 */
export function deriveSecretTokens(rawSecrets: string[]): string[] {
  const tokens = new Set<string>();

  for (const raw of rawSecrets) {
    const secret = raw?.trim();
    if (!secret) continue;
    tokens.add(secret);

    let url: URL | undefined;
    try {
      url = new URL(secret);
    } catch {
      url = undefined;
    }

    if (url) {
      for (const segment of url.pathname.split('/')) {
        if (segment.length >= MIN_TOKEN_LENGTH) tokens.add(segment);
      }
      // Only harvest a query value when its param name looks credential-shaped.
      // Config.secrets holds operator-supplied RPC URLs; a benign param like
      // `?network=arbitrum-one` is not a secret, and turning it into a
      // project-wide redaction token would quietly corrupt every log line
      // that mentions that network.
      for (const [paramName, value] of url.searchParams) {
        if (value.length >= MIN_TOKEN_LENGTH && CREDENTIAL_PARAM_NAME_RE.test(paramName)) {
          tokens.add(value);
        }
      }
      // Infura-style basic auth: https://:SECRET@host/... or https://user:SECRET@host/...
      if (url.username) tokens.add(url.username);
      if (url.password) tokens.add(url.password);
    }
  }

  // Derived forms, added after the loop so they apply to every token found above.
  for (const token of [...tokens]) {
    const encoded = encodeURIComponent(token);
    if (encoded !== token) tokens.add(encoded);

    const jsonEscaped = JSON.stringify(token).slice(1, -1);
    if (jsonEscaped !== token) tokens.add(jsonEscaped);
  }

  return [...tokens].sort((a, b) => b.length - a.length);
}

interface Range {
  start: number;
  end: number;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Finds every occurrence of a single token, case-insensitively, allowing
 * occurrences to overlap each other (see the stepping note below — a
 * self-overlapping token, and two different tokens overlapping each other in
 * the source text, both need this).
 *
 * Matches against the ORIGINAL string, never a case-folded copy. Computing
 * indices on `text.toLowerCase()` and then slicing the original is unsound:
 * `toLowerCase()` changes the length of some BMP characters — U+0130 `İ`
 * becomes two UTF-16 code units, `i` + U+0307 — so every index computed on
 * the folded copy is skewed relative to the original once an İ has appeared
 * before it. That skew silently redacts the wrong span: a prefix of the real
 * secret survives and unrelated trailing text gets eaten instead, and each
 * additional İ widens the leak by one more character. A case-insensitive
 * regex run directly on the original string has no such skew, because it
 * never produces a second copy with different offsets.
 *
 * Latent cost note: this is superlinear in the number of tokens when tokens
 * are highly self-similar (each token's own `from = index + 1` stepping
 * rescans overlapping tokens' territory) — measured at ~1.5s for 30
 * near-duplicate tokens over ~100KB of text. Real provider keys are
 * independently random, not self-similar, so this is a latent characteristic
 * rather than a practical concern for this project's actual secrets.
 */
function findTokenRanges(text: string, token: string): Range[] {
  const ranges: Range[] = [];
  const re = new RegExp(escapeRegExp(token), 'gi');
  let from = 0;
  for (;;) {
    re.lastIndex = from;
    const match = re.exec(text);
    if (!match) break;
    ranges.push({ start: match.index, end: match.index + match[0].length });
    // Step by one, not by match length: stepping by length would miss a
    // self-overlapping occurrence of the same token.
    from = match.index + 1;
  }
  return ranges;
}

/** Merges overlapping or touching ranges so each redacted span is covered once. */
function mergeRanges(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: Range[] = [];

  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }

  return merged;
}

/**
 * Redacts every occurrence of every token in one coherent pass, via merged
 * match ranges rather than sequential per-token `split`/`join`.
 *
 * Sequential replacement — even longest-first — still fails when two tokens
 * physically overlap in the source text (e.g. two configured secrets that
 * share a run of characters, adjacent in a log line): replacing the first
 * match consumes characters the second token's match needed, so the second
 * token's non-shared remainder is left exposed. Computing all match ranges
 * up front (allowing overlaps) and merging them before doing any replacement
 * closes that gap: the merged span is redacted as a whole, so no fragment of
 * either token can survive.
 */
export function scrubSecrets(value: string, tokens: string[]): string {
  // Order does not matter: each token's occurrences are found independently
  // (against the original string) and only merged afterward, so an unsorted
  // token list is handled exactly the same as a sorted one.
  const usable = tokens.filter((t) => t.length > 0);

  let out = value;
  if (usable.length > 0) {
    const allRanges: Range[] = [];
    for (const token of usable) {
      allRanges.push(...findTokenRanges(out, token));
    }
    const ranges = mergeRanges(allRanges);
    if (ranges.length > 0) {
      let result = '';
      let cursor = 0;
      for (const range of ranges) {
        result += out.slice(cursor, range.start) + REDACTED;
        cursor = range.end;
      }
      result += out.slice(cursor);
      out = result;
    }
  }

  for (const pass of FALLBACK_PASSES) {
    out = pass(out);
  }

  return out;
}

export function scrubUnknown(value: unknown, tokens: string[]): string {
  let text: string;
  try {
    text = value instanceof Error ? (value.stack ?? value.message) : String(value);
  } catch {
    // A hostile or exotic value (e.g. an object whose toString throws) must
    // never crash the caller just because scrubbing tried to look at it.
    text = '[unserializable]';
  }
  return scrubSecrets(text, tokens);
}
