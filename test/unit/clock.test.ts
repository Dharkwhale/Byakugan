import { describe, expect, it } from 'vitest';
import { manualClock, systemClock } from '../../src/clock.js';

describe('systemClock', () => {
  it('returns epoch milliseconds', () => {
    const before = Date.now();
    const now = systemClock.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(Number.isInteger(now)).toBe(true);
  });
});

describe('manualClock', () => {
  it('starts at the given time and does not move on its own', () => {
    const clock = manualClock(1_000);
    expect(clock.now()).toBe(1_000);
    expect(clock.now()).toBe(1_000);
  });

  it('advances by an explicit amount', () => {
    const clock = manualClock(1_000);
    clock.advance(500);
    expect(clock.now()).toBe(1_500);
  });

  it('can be set to an absolute time', () => {
    const clock = manualClock(1_000);
    clock.set(9_999);
    expect(clock.now()).toBe(9_999);
  });

  it('defaults to 0 so tests are reproducible without passing a start', () => {
    expect(manualClock().now()).toBe(0);
  });
});
