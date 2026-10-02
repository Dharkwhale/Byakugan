import type { Clock } from '../clock.js';
import type { Reported } from '../report.js';
import { isUnchangedEdit, retryAfterSeconds } from '../telegram/failures.js';
import type { Replier } from './replier.js';

export interface JobProgress {
  onChunk(a: { fromBlock: bigint; toBlock: bigint; rows: number; source: string }): Promise<void>;
  finish(text: string): Promise<void>;
  fail(reported: Reported, nextCommand?: string): Promise<void>;
}

/** Longest `retry_after` a final edit will wait out, in seconds. */
const MAX_FINAL_RETRY_WAIT_S = 30;

/**
 * One message, edited as the job runs.
 *
 * Telegram allows roughly one message per second per chat and counts edits, so a chunk
 * is not a tick: at the measured 10-block getLogs cap a large backfill is tens of
 * thousands of chunks, and editing per chunk would be rate-limited within seconds.
 *
 * Three behaviours here are Telegram's, not choices:
 *   - An edit whose text is UNCHANGED is an error, not a no-op, so identical renders are
 *     skipped before they are sent.
 *   - A 429 carries `retry_after`, on a budget separate from Alchemy's. The edit is
 *     DROPPED rather than queued: a stale progress line has no value, and queueing turns
 *     one rate-limit into a backlog that outlives the job.
 *   - `finish` and `fail` bypass the throttle and retry once. A reporter that can swallow
 *     its last line leaves the user unable to tell a finished job from a hung one.
 *
 * The rendered progress text deliberately carries NO timestamp or elapsed counter. Anything
 * that changes on every tick makes every render differ from the last, so the
 * unchanged-text skip could never fire; it would be dead code that still looked like a
 * guard. The text changes only when the job's numbers do.
 *
 * `sleep` is injectable so the final-edit retry can be tested without waiting out a real
 * `retry_after`.
 */
export function createJobProgress(a: {
  replier: Replier;
  messageId: number;
  clock: Clock;
  intervalMs?: number;
  header: string;
  sleep?: (ms: number) => Promise<void>;
}): JobProgress {
  const intervalMs = a.intervalMs ?? 4_000;
  const sleep = a.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastSentAt: number | null = null;
  let lastText: string | null = null;
  let mutedUntil = 0;
  let finished = false;
  // The send currently on the wire, or null. Settles when the send settles and never rejects.
  let inFlight: Promise<void> | null = null;

  const send = async (text: string): Promise<void> => {
    if (text === lastText) return;         // unchanged edits throw; skip before sending
    try {
      await a.replier.edit(a.messageId, text);
      lastText = text;
      lastSentAt = a.clock.now();
    } catch (err) {
      if (isUnchangedEdit(err)) { lastText = text; return; }
      const wait = retryAfterSeconds(err);
      if (wait !== undefined) { mutedUntil = a.clock.now() + wait * 1_000; return; }
      throw err;                            // a transport failure is not ours to hide
    }
  };

  /**
   * Sends past the throttle and the mute, retrying ONCE after `retry_after` (capped at
   * MAX_FINAL_RETRY_WAIT_S seconds).
   *
   * Once, not repeatedly: the point is that the last line lands, and a job that cannot post
   * its result after two attempts has a problem that more attempts will not fix. The second
   * attempt's failure is not caught, so it propagates to the caller.
   */
  const forceSend = async (text: string): Promise<void> => {
    try {
      await a.replier.edit(a.messageId, text);
      return;
    } catch (err) {
      if (isUnchangedEdit(err)) return;
      const wait = retryAfterSeconds(err);
      if (wait === undefined) throw err;
      await sleep(Math.min(wait, MAX_FINAL_RETRY_WAIT_S) * 1_000);
      await a.replier.edit(a.messageId, text);
    }
  };

  return {
    async onChunk({ fromBlock, toBlock, rows, source }) {
      // The final message is the result. A tick arriving after finish/fail is dropped here;
      // a tick already in flight is awaited by finish/fail before they write the result.
      // A tick arriving while another is in flight is dropped too, so two ticks never race
      // and a stale progress line is never queued behind a slow edit.
      if (finished) return;
      if (inFlight !== null) return;
      const now = a.clock.now();
      if (now < mutedUntil) return;
      if (lastSentAt !== null && now - lastSentAt < intervalMs) return;
      let release!: () => void;
      inFlight = new Promise<void>((r) => { release = r; });
      try {
        await send(
          `${a.header}\n` +
          `  via ${source}\n` +
          `  blocks ${fromBlock}-${toBlock}\n` +
          `  rows ${rows}`,
        );
      } finally {
        inFlight = null;
        release();
      }
    },

    async finish(text) {
      finished = true;
      await inFlight;   // let a tick already on the wire land first, so the result is written last
      await forceSend(text);
    },

    async fail(reported, nextCommand) {
      finished = true;
      await inFlight;
      const lines = [a.header, '', `failed: ${reported.headline}`, '', `  ${reported.detail}`];
      if (reported.hint) lines.push('', `  ${reported.hint}`);
      if (nextCommand) lines.push('', `  next: ${nextCommand}`);
      await forceSend(lines.join('\n'));
    },
  };
}
