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
 */
export function createLogger(
  rawSecrets: string[],
  stream?: NodeJS.WritableStream,
): Logger {
  const tokens = deriveSecretTokens(rawSecrets);
  const target = stream ?? process.stdout;

  const scrubbing = new Writable({
    write(chunk, _enc, cb) {
      target.write(scrubSecrets(String(chunk), tokens));
      cb();
    },
  });

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
