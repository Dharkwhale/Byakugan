import { Writable } from 'node:stream';
import pino, { type Logger } from 'pino';
import { deriveSecretTokens, scrubSecrets } from './secrets.js';

/**
 * Tracks which destination-stream objects already have our no-op 'error'
 * listener attached, across every call — `createScrubbingStream` (and, via
 * it, `createLogger`) may be called more than once against the same shared
 * stream, e.g. `process.stdout` across multiple `createLogger` calls.
 *
 * Keyed on the object itself, not on `target.listenerCount('error')`:
 * listener count can't tell "already guarded by us" apart from "already has
 * an unrelated listener" or "has none and never will" — observed count 1 on
 * `process.stdout` at startup under `tsx`, which would make a count-based
 * guard skip attaching entirely and leave stdout unprotected.
 */
const guardedTargets = new WeakSet<object>();

/**
 * Attaches a no-op 'error' listener to `target`, at most once ever, so a
 * broken destination cannot crash the process. This is unconditional,
 * INCLUDING `process.stdout`/`process.stderr`: contrary to an earlier
 * assumption in this module, stdio does NOT tolerate EPIPE by default —
 * piping the default destination into a consumer that closes early (e.g.
 * `npm run index | head`) reproduces an unhandled `'error'` on stdout that
 * kills the process mid-run, even though the same failure was already
 * reported once through the write callback in `createScrubbingStream`
 * below. Suppressing that crash is the correct behavior for a CLI: the
 * operator-facing signal is the one-time process warning, not a fatal
 * exception the operator never asked for.
 */
function guardTarget(target: NodeJS.WritableStream): void {
  if (typeof (target as { on?: unknown }).on !== 'function') return;
  if (guardedTargets.has(target)) return;
  guardedTargets.add(target);
  target.on('error', () => {});
}

/**
 * Wraps `target` in a Writable that scrubs every chunk before writing it
 * through, and never lets a failure anywhere in that path — a scrub that
 * throws, a target write that fails asynchronously, or a target write that
 * throws synchronously — escape into the caller (pino, and beyond it,
 * business code calling `log.info()`/`log.error()`).
 *
 * This is the least verifiable part of the module by inspection alone: both
 * the round-2 EPIPE regression and the write-failure double-throw fixed
 * here landed in exactly this plumbing. It is exported and tested directly
 * rather than only indirectly through `createLogger`.
 */
export function createScrubbingStream(
  target: NodeJS.WritableStream,
  tokens: string[],
): Writable {
  let hasWarned = false;

  function reportWriteFailure(err: unknown): void {
    if (hasWarned) return;
    hasWarned = true;
    try {
      const message = err instanceof Error ? err.message : String(err);
      const detail = scrubSecrets(message, tokens);
      process.emitWarning(`byakugan logger: write to log destination failed: ${detail}`);
    } catch {
      // Scrubbing the failure message can itself throw (e.g. a pathological
      // token). This function exists specifically to keep failures out of
      // business code, so that must never propagate from here — fall back
      // to a fixed, content-free message instead of retrying anything that
      // could fail again.
      process.emitWarning(
        'byakugan logger: write to log destination failed (details withheld)',
      );
    }
  }

  guardTarget(target);

  const scrubbing = new Writable({
    write(chunk, _enc, cb) {
      let line: string;
      try {
        line = scrubSecrets(String(chunk), tokens);
      } catch (err) {
        reportWriteFailure(err);
        cb(err as Error);
        return;
      }
      try {
        // Serializes this stream's writes to the target's pace, and lets a
        // synchronous throw (e.g. EPIPE on a closed stdout) be caught below
        // instead of escaping into business code via log.info()/log.error().
        // This is NOT full backpressure: pino never reads write()'s boolean
        // return, so a persistently slow (not failing) target still buffers
        // inside this wrapper rather than blocking the caller. A write
        // failure is not silently dropped — see `reportWriteFailure` above.
        target.write(line, (err) => {
          if (err) reportWriteFailure(err);
          cb(err ?? null);
        });
      } catch (err) {
        reportWriteFailure(err);
        cb(err as Error);
      }
    },
  });
  scrubbing.on('error', () => {});

  return scrubbing;
}

/**
 * A pino logger whose every serialized line is scrubbed.
 *
 * The scrub sits on the stream rather than in `redact` paths, because a secret
 * can arrive inside an error message, a stack trace, a cause several levels
 * down, an array element, or an object key name — none of which a path can
 * name. The stream is the one place they all pass through.
 *
 * IMPORTANT: this only works because pino serializes in this process. If a
 * `transport` (e.g. pino-pretty) is ever wired in, pino moves serialization
 * to a worker thread and this stream never sees the line at all — the scrub
 * would be silently bypassed. Serialization must stay in-process, or the
 * scrub must move with it.
 */
export function createLogger(
  rawSecrets: string[],
  stream?: NodeJS.WritableStream,
): Logger {
  const tokens = deriveSecretTokens(rawSecrets);
  const target = stream ?? process.stdout;
  const scrubbing = createScrubbingStream(target, tokens);

  return pino(
    {
      level: process.env.LOG_LEVEL ?? 'info',
      base: undefined,
      // The default err serializer stops at the top-level error.
      serializers: { err: pino.stdSerializers.errWithCause },
    },
    scrubbing,
  );
}
