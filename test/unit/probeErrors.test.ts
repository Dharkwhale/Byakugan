import { describe, expect, it } from 'vitest';
import { classifyProbeError } from '../../src/chain/probeErrors.js';

const STATE_UNAVAILABLE_MESSAGES = [
  'missing trie node abc123',
  'state not available for block 100',
  'state is not available for block 100',
  'Requested resource not found',
  'header not found',
  'no state available for block 100',
];

describe('classifyProbeError', () => {
  it.each(STATE_UNAVAILABLE_MESSAGES)('classifies "%s" as state_unavailable', (message) => {
    expect(classifyProbeError(new Error(message))).toBe('state_unavailable');
  });

  it('is case-insensitive', () => {
    expect(classifyProbeError(new Error('MISSING TRIE NODE'))).toBe('state_unavailable');
  });

  it('classifies a timeout as transient', () => {
    expect(classifyProbeError(new Error('The operation was aborted due to timeout'))).toBe(
      'transient',
    );
  });

  it('classifies ECONNRESET as transient', () => {
    expect(classifyProbeError(new Error('read ECONNRESET'))).toBe('transient');
  });

  it('classifies an HTTP 429 as transient', () => {
    expect(classifyProbeError(new Error('HTTP request failed with status 429'))).toBe(
      'transient',
    );
  });

  it('walks a nested cause chain to find a state-unavailable message', () => {
    const inner = new Error('missing trie node deep in the cause chain');
    const outer = new Error('request failed', { cause: inner });
    expect(classifyProbeError(outer)).toBe('state_unavailable');
  });

  it('returns transient for null without throwing', () => {
    expect(() => classifyProbeError(null)).not.toThrow();
    expect(classifyProbeError(null)).toBe('transient');
  });

  it('returns transient for a plain string without throwing', () => {
    expect(() => classifyProbeError('boom')).not.toThrow();
    expect(classifyProbeError('boom')).toBe('transient');
  });
});
