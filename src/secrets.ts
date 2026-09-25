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
 * `token=` rule would redact it on every line.
 */
function redactQueryKey(text: string): string {
  return text.replace(
    /((?:api[-_]?key|apikey|dkey|access[-_]?token|auth[-_]?token|secret)=)[A-Za-z0-9_.-]{8,}/gi,
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
 * Sorted longest-first: replacing a short token first could consume part of a
 * longer one and leave the remainder in the output. `scrubSecrets` re-sorts
 * on its own input too, so this ordering is a courtesy, not a dependency.
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
      for (const value of url.searchParams.values()) {
        if (value.length >= MIN_TOKEN_LENGTH) tokens.add(value);
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

/**
 * Finds every occurrence of every token, case-insensitively, allowing
 * occurrences to overlap each other. Overlap matters: two configured secrets
 * that happen to share a run of characters can both occur in the same
 * stretch of text (e.g. adjacent path segments), and each occurrence must be
 * found independently of whether another token's match already claimed part
 * of that span.
 */
function findTokenRanges(text: string, tokens: string[]): Range[] {
  const ranges: Range[] = [];
  const lower = text.toLowerCase();

  for (const token of tokens) {
    if (!token) continue;
    const needle = token.toLowerCase();
    let from = 0;
    while (from <= lower.length - needle.length) {
      const idx = lower.indexOf(needle, from);
      if (idx === -1) break;
      ranges.push({ start: idx, end: idx + needle.length });
      from = idx + 1;
    }
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
  const usable = [...tokens].filter((t) => t.length > 0).sort((a, b) => b.length - a.length);

  let out = value;
  if (usable.length > 0) {
    const ranges = mergeRanges(findTokenRanges(out, usable));
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
