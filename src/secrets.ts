/** Minimum length for a path segment or query value to be treated as a key. */
const MIN_TOKEN_LENGTH = 16;

const REDACTED = '[REDACTED]';

/**
 * Patterns for secrets no token knows about — a URL built at runtime, or a
 * chain configured after the logger was constructed. Deliberately narrow: each
 * only fires inside a URL-ish context, so ordinary prose is never touched.
 */
const FALLBACK_PATTERNS: Array<[RegExp, string]> = [
  [/(\/v[23]\/)[A-Za-z0-9_-]{16,}/g, `$1${REDACTED}`],
  [/((?:api[-_]?key|apikey|access[-_]?token)=)[A-Za-z0-9_.-]{8,}/gi, `$1${REDACTED}`],
];

/**
 * Expands raw secrets into every form they might appear in.
 *
 * A secret stored as a full URL will not match a log line carrying only its key
 * segment, or the same URL percent-encoded — `encodeURIComponent` leaves the
 * alphanumeric key intact while encoding the separators around it. So the key
 * itself becomes a token in its own right.
 *
 * Sorted longest-first: replacing a short token first could consume part of a
 * longer one and leave the remainder in the output.
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
        if (value.length >= 8) tokens.add(value);
      }
    }
  }

  // Encoded forms, added after the loop so encoding is applied to every token.
  for (const token of [...tokens]) {
    const encoded = encodeURIComponent(token);
    if (encoded !== token) tokens.add(encoded);
  }

  return [...tokens].sort((a, b) => b.length - a.length);
}

export function scrubSecrets(value: string, tokens: string[]): string {
  let out = value;
  for (const token of tokens) {
    if (!token) continue;
    out = out.split(token).join(REDACTED);
  }
  for (const [pattern, replacement] of FALLBACK_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

export function scrubUnknown(value: unknown, tokens: string[]): string {
  const text = value instanceof Error ? (value.stack ?? value.message) : String(value);
  return scrubSecrets(text, tokens);
}
