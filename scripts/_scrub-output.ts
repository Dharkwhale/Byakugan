/**
 * Output-boundary secret scrubbing for every script and throwaway probe.
 *
 * IMPORT THIS FIRST, before anything that could print. Importing it is enough —
 * installation happens as an import side effect, deliberately, so that "did I
 * remember to call it?" is not a question anyone has to answer.
 *
 * WHY IT INTERCEPTS THE STREAMS rather than offering a `scrub()` to call at each
 * print site: this exists because per-call-site scrubbing was tried and failed.
 * A probe hit HTTP 429, the unhandled viem error printed its own dump including
 * the request URL, and an API key reached a transcript in plain text and had to
 * be rotated. The probe did scrub — in its happy path only. `src/logger.ts`
 * already learned this lesson for the product: scrub where every byte must pass,
 * not where a developer remembers to ask. This is the same fix for the tooling.
 *
 * Covered here: `console.*` (which routes through the streams), any direct
 * `process.stdout.write`/`process.stderr.write`, an uncaught exception, and an
 * unhandled promise rejection.
 */
import { loadConfig } from '../src/config.js';
import { deriveSecretTokens, scrubSecrets } from '../src/secrets.js';

/**
 * Env vars whose VALUES are credentials. Matched broadly on purpose: a probe
 * that reads `process.env.RPC_URL_84532` directly — before that chain is even in
 * chains.json, so `config.secrets` would not carry it — must still be covered.
 * Missing a secret here is the failure mode; over-collecting is harmless.
 */
const SECRET_ENV_PATTERN = /RPC_URL|API_KEY|APIKEY|TOKEN|SECRET|PASSWORD|PRIVATE|MNEMONIC|SEED/i;

/** Shorter than this cannot be a credential, and redacting it would mangle prose. */
const MIN_SECRET_LENGTH = 8;

function collectTokens(): string[] {
  const raw: string[] = [];

  // Anything config knows about (RPC URLs, the explorer key).
  try {
    raw.push(...loadConfig().secrets);
  } catch {
    // Config may be invalid or absent — that must not stop the guard installing.
  }

  // Plus every credential-shaped env var, so a probe reading process.env
  // directly is covered even when config does not know about that chain.
  for (const [name, value] of Object.entries(process.env)) {
    if (!value || value.length < MIN_SECRET_LENGTH) continue;
    if (SECRET_ENV_PATTERN.test(name)) raw.push(value);
  }

  return deriveSecretTokens(raw);
}

let installed = false;

export function installOutputScrubbing(): void {
  if (installed) return;
  installed = true;

  const tokens = collectTokens();
  const scrub = (s: string): string => (tokens.length > 0 ? scrubSecrets(s, tokens) : s);

  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write.bind(stream);
    // The signature is overloaded; this wrapper preserves both arities.
    stream.write = ((
      chunk: unknown,
      encoding?: unknown,
      callback?: unknown,
    ): boolean => {
      const text = typeof chunk === 'string' ? chunk : String(chunk);
      return (original as (c: unknown, e?: unknown, cb?: unknown) => boolean)(
        scrub(text),
        encoding,
        callback,
      );
    }) as typeof stream.write;
  }

  // An uncaught error prints via Node's own handler, which does NOT go through
  // the stream wrapper in every case — so intercept it and print scrubbed.
  process.on('uncaughtException', (err: unknown) => {
    process.stderr.write(`uncaughtException: ${scrub(describe(err))}\n`);
    process.exitCode = 1;
  });

  process.on('unhandledRejection', (reason: unknown) => {
    process.stderr.write(`unhandledRejection: ${scrub(describe(reason))}\n`);
    process.exitCode = 1;
  });
}

/** Total stringification — a throwing `toString` must not defeat the guard. */
function describe(value: unknown): string {
  try {
    if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
    return String(value);
  } catch {
    return '[unserializable]';
  }
}

installOutputScrubbing();
