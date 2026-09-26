import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

/**
 * A lock-owner identity, unique per RUN.
 *
 * Deliberately not derived from the collection, the process name, or a bare pid:
 * pids are reused, so a restarted process could steal or release its own
 * predecessor's lock by accident. The hostname and pid are there to make a held
 * lock diagnosable from logs; the uuid is what guarantees uniqueness.
 */
export function newJobId(): string {
  return `${hostname()}:${process.pid}:${randomUUID()}`;
}
