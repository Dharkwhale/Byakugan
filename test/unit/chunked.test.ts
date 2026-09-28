import { describe, expect, it } from 'vitest';
import { chunked } from '../../src/db/chunked.js';

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

describe('chunked', () => {
  it('returns nothing for an empty list', () => {
    expect(chunked([])).toEqual([]);
  });

  it('returns one group for a single item', () => {
    expect(chunked([1])).toEqual([[1]]);
  });

  it('returns one group at exactly the default size', () => {
    expect(chunked(range(500))).toHaveLength(1);
  });

  it('splits one past the default size', () => {
    const groups = chunked(range(501));
    expect(groups).toHaveLength(2);
    expect(groups[1]).toHaveLength(1);
  });

  it('splits 1000 into two full groups', () => {
    expect(chunked(range(1000)).map((g) => g.length)).toEqual([500, 500]);
  });

  it('honours an explicit size', () => {
    expect(chunked(range(5), 2).map((g) => g.length)).toEqual([2, 2, 1]);
  });

  // Counts cannot catch an off-by-one in chunk assembly: a group that starts or
  // ends one element early still has a plausible length. These assert the
  // CONTENTS round-trip, which is what actually breaks.
  it.each([0, 1, 2, 499, 500, 501, 999, 1000, 1001])(
    'reassembles exactly the original list for length %i',
    (n) => {
      const input = range(n);
      expect(chunked(input).flat()).toEqual(input);
    },
  );

  it('puts the boundary elements in the right groups', () => {
    const groups = chunked(range(1001));
    expect(groups[0]?.[0]).toBe(0);
    expect(groups[0]?.at(-1)).toBe(499);   // last of the first chunk
    expect(groups[1]?.[0]).toBe(500);      // first of the second chunk
    expect(groups[1]?.at(-1)).toBe(999);
    expect(groups[2]).toEqual([1000]);
  });

  it('never emits an empty group', () => {
    for (const n of [1, 500, 501, 1000, 1001]) {
      expect(chunked(range(n)).every((g) => g.length > 0)).toBe(true);
    }
  });

  it('rejects a size below 1 rather than looping forever', () => {
    expect(() => chunked([1, 2], 0)).toThrow();
  });
});
