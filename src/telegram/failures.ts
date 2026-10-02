/**
 * Classifies Telegram Bot API failures.
 *
 * EVERY SHAPE HERE WAS MEASURED, not recalled. See
 * `docs/superpowers/notes/2026-10-02-grammy-behaviour.md` for grammY's error surface read
 * out of its source, and for the live-probe output each predicate below is written against.
 * This project has lost rounds to assumed mechanisms — viem's 10s default timeout, the
 * compute-unit ceiling, vitest discarding `console.*` from a fully-skipped file, a dry-run
 * reading `maxChunk` instead of the measured cap — so the notes are the authority and this
 * file follows them rather than the reverse.
 *
 * `GrammyError` is matched structurally rather than with `instanceof`. Two reasons: a
 * caller may hand us an error that crossed a module boundary, and the fields these
 * predicates read are the whole contract — `error_code`, `description` and `parameters`
 * are typed readonly properties on `GrammyError`, so a value carrying them is as good as
 * the class for this purpose, while `instanceof` would make the classifier brittle to a
 * duplicated grammY install.
 */
interface ApiErrorShape {
  error_code: number;
  description: string;
  parameters?: { retry_after?: number };
}

function asApiError(err: unknown): ApiErrorShape | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const candidate = err as Partial<ApiErrorShape>;
  if (typeof candidate.error_code !== 'number') return undefined;
  // ARGUED, NOT TESTED — the description check. Mutation-tested and the mutant SURVIVED
  // (14 passed, 0 failed), because every consumer below happens to tolerate a missing
  // description: `/pattern/.test(undefined)` stringifies to "undefined" and simply fails to
  // match. It is kept because that tolerance is accidental rather than designed — the
  // declared type says `description: string`, and without this the type would be a lie that
  // the next consumer, written to trust it, could act on. No test can distinguish it today.
  if (typeof candidate.description !== 'string') return undefined;
  return candidate as ApiErrorShape;
}

/**
 * Editing a message to the text it already holds is an ERROR, not a no-op.
 *
 * Measured, verbatim:
 *   400 — "Bad Request: message is not modified: specified new message content and reply
 *          markup are exactly the same as a current content and reply markup of the message"
 *
 * MATCHED ON DESCRIPTION TEXT, deliberately rather than lazily: 400 covers many unrelated
 * conditions and there is no code that means only this. The dependence is on someone else's
 * wording, so it is worth being explicit about which way it fails — if Telegram rewords the
 * message this returns false, the editor stops skipping identical renders, and progress
 * edits begin failing visibly. Noisy rather than silent is the right direction for a guess
 * about another system's prose.
 *
 * The code is checked as well as the text so that a 500 whose body happened to echo the
 * phrase is not mistaken for this condition.
 */
export function isUnchangedEdit(err: unknown): boolean {
  const api = asApiError(err);
  return api?.error_code === 400 && /message is not modified/i.test(api.description);
}

/**
 * How long Telegram asked us to wait, when it asked.
 *
 * A budget entirely separate from Alchemy's compute units: a bot can be well inside its RPC
 * allowance and still be rate-limited for editing one message too often.
 *
 * `parameters.retry_after` is a typed optional field on `ResponseParameters`, so the typed
 * path is tried first. The description fallback exists because the field is OPTIONAL — not
 * because the typed path is unreliable — and returning `undefined` for a 429 that named its
 * wait in prose would turn a rate limit into an un-waited retry.
 */
export function retryAfterSeconds(err: unknown): number | undefined {
  const api = asApiError(err);
  if (api?.error_code !== 429) return undefined;
  const typed = api.parameters?.retry_after;
  if (typeof typed === 'number' && Number.isFinite(typed)) return typed;
  const parsed = /retry after (\d+)/i.exec(api.description);
  return parsed?.[1] === undefined ? undefined : Number(parsed[1]);
}

/**
 * Another instance has DISPLACED this one.
 *
 * Measured, and the opposite of the obvious reading: two concurrent `getUpdates` and the
 * SECOND succeeds while the FIRST is rejected with "terminated by other getUpdates
 * request". Telegram does not refuse a newcomer — it kills the request already in flight
 * and serves the new one.
 *
 * So a process seeing this has lost its poll, not failed to acquire one. It cannot continue,
 * which is why the bot exits on it; and restarting it would displace the other instance in
 * turn, which is why the message says so.
 */
export function isConflict(err: unknown): boolean {
  return asApiError(err)?.error_code === 409;
}

/** The token is wrong, or has been revoked. */
export function isUnauthorized(err: unknown): boolean {
  return asApiError(err)?.error_code === 401;
}
