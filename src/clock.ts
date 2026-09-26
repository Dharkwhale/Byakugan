/**
 * A source of epoch milliseconds.
 *
 * Everything that records or compares a timestamp takes one of these, so the
 * lock lifecycle can be tested by setting the time rather than sleeping. Note
 * that nothing in this project uses SQLite's own `datetime()`/`unixepoch()`:
 * two clocks that can disagree is exactly the bug this avoids.
 */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

export interface ManualClock extends Clock {
  advance(ms: number): void;
  set(ms: number): void;
}

/** A clock that only moves when a test moves it. */
export function manualClock(startMs = 0): ManualClock {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms) => { current += ms; },
    set: (ms) => { current = ms; },
  };
}
