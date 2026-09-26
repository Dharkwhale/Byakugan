import { describe, expect, it } from 'vitest';
import { hostname } from 'node:os';
import { newJobId } from '../../src/jobId.js';

describe('newJobId', () => {
  it('is unique per call', () => {
    expect(newJobId()).not.toBe(newJobId());
  });

  it('stays unique across many calls', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newJobId()));
    expect(ids.size).toBe(1000);
  });

  // hostname and pid are for reading logs; the uuid is what makes it unique.
  it('carries the hostname and pid for diagnosability', () => {
    const id = newJobId();
    expect(id).toContain(hostname());
    expect(id).toContain(String(process.pid));
  });

  // A bare pid or process name would let a restarted process steal or release
  // its own predecessor's lock.
  it('ends in a uuid, so it is per-run rather than per-process', () => {
    const segments = newJobId().split(':');
    expect(segments.length).toBeGreaterThanOrEqual(3);
    expect(segments.at(-1)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});
