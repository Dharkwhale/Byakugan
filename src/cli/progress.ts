import type { Clock } from '../clock.js';

export interface ProgressEvent {
  chunkIndex: number;
  fromBlock: bigint;
  toBlock: bigint;
  inserted: number;
}

export interface ProgressReporter {
  /** Called once per chunk. Prints only when the interval has elapsed. */
  onChunk(event: ProgressEvent): void;
  /** Always prints, whatever the interval — the final tally is never dropped. */
  finish(a: { chunks: number; rows: number; lastIndexedBlock: number }): void;
}

/**
 * Rate-limited progress output for a long backfill.
 *
 * WHY RATE-LIMITED: at the measured 10-block cap a million-block span is 100,000
 * chunks. One line each is 100,000 lines of scrollback that nobody reads and that
 * buries any warning printed among them. Time-based rather than every-Nth-chunk,
 * because chunk size varies as the adaptive range shrinks and grows, so every-Nth
 * would speed up and slow down for reasons unrelated to how fast the work is going.
 *
 * TWO EVENTS ALWAYS PRINT, whatever the interval: the first chunk, so the operator
 * sees that work has started rather than staring at nothing for a minute, and
 * `finish`, so the run always ends with a tally. A progress reporter that can swallow
 * the last line is worse than none — it leaves the operator unsure whether the run
 * completed.
 *
 * Time comes from the injected `Clock`, like everywhere else in this project, so the
 * tests assert the throttle by advancing a number rather than by sleeping.
 *
 * WRITES VIA THE INJECTED SINK, which the CLI points at `process.stdout` — already
 * wrapped by `outputScrubbing.ts`. Nothing here formats an RPC URL, but a block range
 * printed beside an error message is exactly the kind of output that grows a secret
 * later, and the guard costs nothing.
 */
export function createProgressReporter(a: {
  clock: Clock;
  write: (line: string) => void;
  /** Minimum gap between printed chunk lines. */
  intervalMs?: number;
  contract: string;
  chainId: number;
  /** The bound being worked towards, for a percentage. */
  fromBlock: bigint;
  toBlock: bigint;
}): ProgressReporter {
  const intervalMs = a.intervalMs ?? 2_000;
  const span = a.toBlock - a.fromBlock + 1n;
  let lastPrintMs: number | null = null;
  let rowsSoFar = 0;

  return {
    onChunk(event) {
      rowsSoFar += event.inserted;
      const now = a.clock.now();
      const isFirst = lastPrintMs === null;
      if (!isFirst && now - lastPrintMs! < intervalMs) return;
      lastPrintMs = now;

      // Integer percentage from bigints — no float conversion, because a span can
      // exceed Number.MAX_SAFE_INTEGER on a long-lived chain.
      const done = event.toBlock - a.fromBlock + 1n;
      const percent = span > 0n ? (done * 100n) / span : 100n;
      a.write(
        `  chunk ${event.chunkIndex + 1}  blocks ${event.fromBlock}-${event.toBlock}` +
        `  (${percent}%)  rows ${rowsSoFar}\n`,
      );
    },

    finish(summary) {
      a.write(
        `done  chain ${a.chainId}  ${a.contract}\n` +
        `  chunks ${summary.chunks}  rows ${summary.rows}` +
        `  indexed through block ${summary.lastIndexedBlock}\n`,
      );
    },
  };
}
