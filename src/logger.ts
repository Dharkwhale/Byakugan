import { Writable } from 'node:stream';
import pino, { type Logger } from 'pino';
import { deriveSecretTokens, scrubSecrets } from './secrets.js';

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

  // pino has no channel for a destination-stream write error — it never
  // reads the callback we hand `target.write()` below, so a failure there
  // would otherwise vanish. Report the first one as a process warning
  // instead (scrubbed: the failure reason can itself embed a secret, e.g. a
  // viem error carrying the request URL). Gated on `hasWarned` so a
  // persistently failing target cannot spam.
  let hasWarned = false;
  function reportWriteFailure(err: unknown): void {
    if (hasWarned) return;
    hasWarned = true;
    const message = err instanceof Error ? err.message : String(err);
    process.emitWarning(
      `byakugan logger: write to log destination failed: ${scrubSecrets(message, tokens)}`,
    );
  }

  // Node auto-emits 'error' on whichever stream's own write callback
  // receives an error; with no listener, that crashes the whole process —
  // worse than the dropped line this fix is meant to prevent. stdout/stderr
  // already tolerate EPIPE without this, and the synchronous-throw catch
  // below covers their other escape path, so leave them alone. For any
  // other stream, attach at most one no-op listener: unconditionally
  // attaching would leak a new listener on every `createLogger` call against
  // a stream shared across calls (a real risk for a process-global-like
  // stream), and could silence errors unrelated to this logger.
  if (
    target !== process.stdout &&
    target !== process.stderr &&
    target.listenerCount?.('error') === 0
  ) {
    target.on('error', () => {});
  }

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
