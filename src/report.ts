/**
 * Turning any thrown value into something worth printing, plus the exit-code table.
 *
 * LIVES IN src/, NOT src/cli/, because the Telegram bot needs the same mapping and a
 * second one would drift. An earlier design split it — prose here, exit codes left in
 * src/cli/ — and that was wrong: the bot's startup path needs EXIT too, so the split
 * would have had the bot importing from src/cli/, which is the layering smell the
 * split existed to remove. Exit codes are not CLI-specific; both front ends are
 * processes that exit. The bot ignores `exitCode` in replies and uses it on startup.
 */
import { BaseError, HttpRequestError, TimeoutError } from 'viem';
import {
  ByakuganError, ClassifyError, CollectionLockedError, ConfigError, DecodeError,
  DeployBlockUnavailableError, EnrichmentLevelError, MigrationError, RangeExhaustedError,
  TxEnrichmentError, UnsupportedStandardError, UsageError,
} from './errors.js';

/**
 * Exit codes, grouped so a wrapping script can act on the CATEGORY without knowing
 * every error class.
 *
 * The distinction that matters, and the reason these are not all `1`: a script needs
 * to tell "you typed a bad address" from "the RPC is down". The first should stop and
 * be reported to whoever typed it; the second should be retried later. Collapsing
 * them into one non-zero code forces the wrapper to parse message text, which then
 * breaks the next time a message is reworded.
 *
 * Codes stay below 64 and avoid 126–128 and 130+, which shells and signals claim.
 */
export const EXIT = {
  /** Finished the work asked of it. */
  OK: 0,
  /**
   * Something this code did not anticipate. A bug, not a condition — an error that
   * reached the top level without a mapping is reported as such rather than being
   * guessed into one of the categories below, because a wrong category is worse than
   * an honest "unknown": it would send a wrapper into a retry loop over a defect.
   */
  INTERNAL: 1,
  /**
   * The request was wrong and a human has to change it: a malformed address, an
   * unconfigured chain, a contract that is not an NFT, a level that conflicts with
   * what is already indexed. Retrying unchanged cannot help.
   */
  USAGE: 2,
  /**
   * The chain or provider could not serve what was asked, through no fault of the
   * request: RPC failures, an archive that will not serve old state, a range the
   * provider refuses at any size, a reorg under the confirmations depth. Retrying
   * later is the right response.
   */
  UNAVAILABLE: 3,
  /** Another job holds the collection's lock and it is not yet stale. Retry later. */
  BUSY: 4,
  /**
   * The local database is in a state this build will not touch — most often a
   * migration whose checksum no longer matches. Needs operator attention, not a
   * retry, and is kept apart from USAGE because nothing about the command was wrong.
   */
  LOCAL_STATE: 5,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export interface Reported {
  exitCode: ExitCode;
  /** One line naming what went wrong, in the category's terms. */
  headline: string;
  /** The error's own message, which carries the specifics and the fix. */
  detail: string;
  /** What the operator should do next, when the category implies one. */
  hint?: string;
}

/**
 * Turns any thrown value into something worth printing and an exit code.
 *
 * WHY THIS EXISTS AT ALL: an unhandled error prints a stack trace, and a stack trace
 * is both unreadable to whoever ran the command and a leak risk — viem's error dumps
 * carry the request URL, and that URL carries an API key. A key reached a transcript
 * that way once in this project and had to be rotated. The stream scrub in
 * `outputScrubbing.ts` is the guarantee; mapping errors to messages is what makes the
 * output useful rather than merely safe.
 *
 * Each class listed here was given a distinct type precisely so this mapping could
 * exist. A `ByakuganError` subclass that is not handled falls through to a generic
 * `ByakuganError` branch rather than to INTERNAL, because it is still a condition
 * this code raised deliberately — but its absence from the specific list is why the
 * test asserts every exported class is mapped.
 */
export function describeError(err: unknown): Reported {
  // Order matters: subclasses before the ByakuganError catch-all.
  if (err instanceof UsageError) {
    return {
      exitCode: EXIT.USAGE,
      headline: 'The command could not be understood',
      detail: err.message,
      hint: 'Run with --help for the options and the enrichment levels.',
    };
  }
  if (err instanceof ConfigError) {
    return {
      exitCode: EXIT.USAGE,
      headline: 'Configuration is incomplete or invalid',
      detail: err.message,
      hint: 'Set the missing environment variable and add the chain to config/chains.json.',
    };
  }
  if (err instanceof UnsupportedStandardError) {
    return {
      exitCode: EXIT.USAGE,
      headline: 'That contract is not a supported NFT collection',
      detail: err.message,
      hint: 'Byakugan indexes ERC-721 and ERC-1155. Check the address is the ' +
        'collection itself and not a marketplace, a token, or a proxy that does not ' +
        'answer ERC-165.',
    };
  }
  if (err instanceof EnrichmentLevelError) {
    return {
      exitCode: EXIT.USAGE,
      headline: 'Enrichment level conflicts with what is already indexed',
      detail: err.message,
      hint: 'Either rerun with the level this collection was indexed at, or upgrade ' +
        'it explicitly first. Nothing was written, so neither option loses work.',
    };
  }
  if (err instanceof CollectionLockedError) {
    return {
      exitCode: EXIT.BUSY,
      headline: 'Another job is indexing this collection',
      detail: err.message,
      hint: 'Wait for it to finish, or for its lock to go stale if it died.',
    };
  }
  if (err instanceof DeployBlockUnavailableError) {
    return {
      exitCode: EXIT.UNAVAILABLE,
      headline: 'Could not establish the deploy block',
      detail: err.message,
      hint: 'This usually means the provider will not serve state that far back. ' +
        'Pass --deploy-block to supply it directly, or use an archive-capable endpoint.',
    };
  }
  if (err instanceof RangeExhaustedError) {
    return {
      exitCode: EXIT.UNAVAILABLE,
      headline: 'The provider refused every block range that was tried',
      detail: err.message,
      hint: 'Not a range that can be narrowed further — the endpoint is rejecting ' +
        'the request itself. Check the endpoint and its plan limits.',
    };
  }
  if (err instanceof TxEnrichmentError) {
    return {
      exitCode: EXIT.UNAVAILABLE,
      headline: 'Transaction data did not match the logs it came from',
      detail: err.message,
      hint: 'Most often a reorg below the configured confirmations depth. Rerun; the ' +
        'watermark did not move, so nothing was half-written.',
    };
  }
  if (err instanceof MigrationError) {
    return {
      exitCode: EXIT.LOCAL_STATE,
      headline: 'The database schema is not in a state this build will use',
      detail: err.message,
      hint: 'Applied migrations are immutable. Restore the migration file, or start ' +
        'from a fresh database — do not edit an applied migration.',
    };
  }
  if (err instanceof DecodeError || err instanceof ClassifyError) {
    // Reached only if an upstream invariant broke. Genuinely a defect: these two
    // assert things the pipeline is supposed to guarantee before calling them.
    return {
      exitCode: EXIT.INTERNAL,
      headline: 'An internal invariant was violated while processing chain data',
      detail: err.message,
      hint: 'This is a bug rather than a condition. Please report it with the message above.',
    };
  }
  if (err instanceof ByakuganError) {
    return {
      exitCode: EXIT.INTERNAL,
      headline: `Unhandled ${err.name}`,
      detail: err.message,
      hint: 'This error type has no CLI mapping yet, which is itself a defect.',
    };
  }
  if (isTransportFailure(err)) {
    return {
      exitCode: EXIT.UNAVAILABLE,
      headline: 'Could not reach the RPC endpoint',
      detail: err instanceof Error ? firstLine(err.message) : String(err),
      hint: 'The request never got an answer. Check the endpoint is up and the URL is ' +
        'right, then retry — nothing was indexed.',
    };
  }
  return {
    exitCode: EXIT.INTERNAL,
    headline: 'Unexpected failure',
    detail: err instanceof Error ? firstLine(err.message) : String(err),
    hint: 'Rerun with --verbose for a stack trace.',
  };
}

/**
 * Whether a thrown value is the endpoint failing to answer, rather than answering
 * something we disliked.
 *
 * THIS IS THE DISTINCTION THE EXIT CODES EXIST FOR, and it was missing until a
 * process-level test caught it: a viem transport error is not a `ByakuganError`, so it
 * fell through to INTERNAL and a wrapping script would have treated "the RPC is down"
 * as a defect in this program — stopping instead of retrying.
 *
 * Checked through `walk()` because viem nests the real cause: the outer error is a
 * generic request failure and the `HttpRequestError` or `TimeoutError` is underneath
 * it. The same reason `isExecutionFailure` in chain/standard.ts walks the chain.
 * Non-viem failures (a bare `fetch` rejection, a refused socket) are matched by their
 * node error codes, since they arrive with no viem wrapper at all.
 */
function isTransportFailure(err: unknown): boolean {
  if (err instanceof BaseError) {
    const walked = err.walk((e) => e instanceof HttpRequestError || e instanceof TimeoutError);
    if (walked) return true;
  }
  for (let e: unknown = err, depth = 0; e instanceof Error && depth < 10; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && NETWORK_CODES.has(code)) return true;
    if (/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|socket hang up/i
      .test(e.message)) return true;
    e = e.cause;
  }
  return false;
}

const NETWORK_CODES = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT',
]);

/**
 * First line only.
 *
 * viem's messages are multi-paragraph dumps that include a `URL:` line, and that URL
 * carries an API key. The stream scrub redacts it either way — that is the guarantee —
 * but printing forty lines of transport internals to report "the endpoint is down"
 * buries the one sentence the operator needs.
 */
function firstLine(message: string): string {
  const line = message.split('\n').find((l) => l.trim().length > 0);
  return (line ?? message).trim();
}

/**
 * The printable form. Deliberately NOT a stack trace unless asked for.
 *
 * Every line goes through `process.stderr`, which `outputScrubbing.ts` has wrapped,
 * so a secret appearing inside any error message is redacted on the way out. That is
 * the mechanism, and it is why this function is free to print `detail` verbatim
 * instead of trying to sanitise per call site — which is the approach that failed
 * before.
 */
export function formatError(reported: Reported, a: { verbose?: boolean; err?: unknown } = {}): string {
  const lines = [`error: ${reported.headline}`, '', `  ${reported.detail}`];
  if (reported.hint) lines.push('', `  hint: ${reported.hint}`);
  if (a.verbose && a.err instanceof Error && a.err.stack) {
    lines.push('', a.err.stack);
  }
  lines.push('');
  return lines.join('\n');
}
