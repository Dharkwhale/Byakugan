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

  // A write failure is reported through the callback path below, which is
  // the correct channel (it also drives backpressure). Node additionally
  // auto-emits 'error' on whichever stream's own write callback received the
  // error — on `target` itself, independent of anything we do — and on
  // `scrubbing` once we forward that error into its own callback. Neither
  // emission has a listener otherwise, and an unlistened 'error' event
  // crashes the process; that would turn a single failed write (or an EPIPE
  // on a closed stdout) into a process-ending exception, which is worse than
  // the silent drop this fix replaces. Swallow both here — the callback path
  // is the real signal.
  target.on('error', () => {});

  const scrubbing = new Writable({
    write(chunk, _enc, cb) {
      let line: string;
      try {
        line = scrubSecrets(String(chunk), tokens);
      } catch (err) {
        cb(err as Error);
        return;
      }
      try {
        // Deferring `cb` until the underlying write's callback fires gives
        // real backpressure (a slow/stalled target no longer looks ready),
        // and surfaces a write error instead of silently dropping the line.
        target.write(line, (err) => cb(err ?? null));
      } catch (err) {
        // A synchronous throw (e.g. EPIPE on a closed stdout) must not
        // escape into business code via log.info()/log.error().
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
