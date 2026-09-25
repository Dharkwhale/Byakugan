/**
 * Classifies an archive-probe failure so callers can tell "this node does not
 * serve state at this block" (a real verdict) apart from "the request itself
 * failed" (a timeout, rate limit, or network blip — retry, don't conclude).
 */
export type ProbeOutcome = 'state_unavailable' | 'transient';

const STATE_UNAVAILABLE_PATTERNS = [
  /missing trie node/i,
  /state not available/i,
  /state is not available/i,
  /requested resource not found/i,
  /header not found/i,
  /no state available/i,
];

/** Pulls every message string out of an error and its `cause` chain. */
function collectMessages(err: unknown, seen = new Set<unknown>()): string[] {
  if (err === null || typeof err !== 'object') {
    return typeof err === 'string' ? [err] : [];
  }
  if (seen.has(err)) return [];
  seen.add(err);

  const messages: string[] = [];
  if ('message' in err && typeof (err as { message?: unknown }).message === 'string') {
    messages.push((err as { message: string }).message);
  }
  if ('cause' in err) {
    messages.push(...collectMessages((err as { cause?: unknown }).cause, seen));
  }
  return messages;
}

export function classifyProbeError(err: unknown): ProbeOutcome {
  const messages = collectMessages(err);
  const isStateUnavailable = messages.some((message) =>
    STATE_UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(message)),
  );
  return isStateUnavailable ? 'state_unavailable' : 'transient';
}
