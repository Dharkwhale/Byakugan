import { describe, expect, it } from 'vitest';
import {
  isConflict, isUnauthorized, isUnchangedEdit, retryAfterSeconds,
} from '../../src/telegram/failures.js';

/**
 * Fixtures copied from MEASURED output, not from documentation.
 *
 * `docs/superpowers/notes/2026-10-02-grammy-behaviour.md` holds the probe results these are
 * taken from — including that `parameters` comes back as `{}` rather than `undefined` on a
 * non-429, which is why `parameters?.retry_after` is safe to read on any error.
 *
 * `GrammyError` is reconstructed rather than imported and thrown, because grammY's
 * constructor takes an `ApiError` plus a method and payload, and the classifier only reads
 * the four fields below. Shaping the fixture is honest here precisely because the shape was
 * measured; before the probe ran, these were documentation-shaped and the notes said so.
 */
function apiError(a: {
  code: number;
  description: string;
  parameters?: Record<string, number>;
  method?: string;
}) {
  return Object.assign(
    new Error(`Call to '${a.method ?? 'editMessageText'}' failed! (${a.code}: ${a.description})`),
    {
      name: 'GrammyError',
      error_code: a.code,
      description: a.description,
      parameters: a.parameters ?? {},
      method: a.method ?? 'editMessageText',
      ok: false as const,
    },
  );
}

/** The exact description Telegram returned, verbatim from the probe. */
const UNCHANGED_EDIT = 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message';
/** The exact description Telegram returned to the DISPLACED poller, verbatim. */
const CONFLICT = 'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running';

describe('isUnchangedEdit', () => {
  it('recognises the measured unchanged-edit rejection', () => {
    expect(isUnchangedEdit(apiError({ code: 400, description: UNCHANGED_EDIT }))).toBe(true);
  });

  it('does not treat other 400s as unchanged edits', () => {
    for (const description of [
      'Bad Request: message to edit not found',
      'Bad Request: chat not found',
      'Bad Request: message can\'t be edited',
    ]) {
      expect(isUnchangedEdit(apiError({ code: 400, description }))).toBe(false);
    }
  });

  it('requires the code as well as the text', () => {
    // A 500 whose body happened to echo the phrase is not this condition.
    expect(isUnchangedEdit(apiError({ code: 500, description: UNCHANGED_EDIT }))).toBe(false);
  });

  it('is false for anything that is not a Bot API error', () => {
    expect(isUnchangedEdit(new Error('socket hang up'))).toBe(false);
    expect(isUnchangedEdit(undefined)).toBe(false);
    expect(isUnchangedEdit(null)).toBe(false);
    expect(isUnchangedEdit('a string')).toBe(false);
    expect(isUnchangedEdit({ error_code: 400 })).toBe(false);          // no description
    expect(isUnchangedEdit({ description: UNCHANGED_EDIT })).toBe(false); // no code
  });
});

describe('retryAfterSeconds', () => {
  it('reads the typed parameter', () => {
    expect(retryAfterSeconds(apiError({
      code: 429, description: 'Too Many Requests: retry after 7', parameters: { retry_after: 7 },
    }))).toBe(7);
  });

  it('falls back to the description when the typed field is absent', () => {
    // `retry_after` is optional on ResponseParameters, and returning undefined for a 429
    // would turn a rate limit into an un-waited retry.
    expect(retryAfterSeconds(apiError({
      code: 429, description: 'Too Many Requests: retry after 12', parameters: {},
    }))).toBe(12);
  });

  it('is undefined for a 429 that names no wait at all', () => {
    expect(retryAfterSeconds(apiError({ code: 429, description: 'Too Many Requests' })))
      .toBeUndefined();
  });

  it('is undefined for every other code, even one mentioning a wait', () => {
    expect(retryAfterSeconds(apiError({ code: 400, description: 'retry after 5' })))
      .toBeUndefined();
    expect(retryAfterSeconds(apiError({ code: 400, description: UNCHANGED_EDIT })))
      .toBeUndefined();
  });

  it('reads parameters safely when they come back as an empty object', () => {
    // Measured: a non-429 GrammyError carries `parameters: {}`, not undefined.
    expect(retryAfterSeconds(apiError({ code: 400, description: UNCHANGED_EDIT, parameters: {} })))
      .toBeUndefined();
  });

  it('is undefined for a non-API error', () => {
    expect(retryAfterSeconds(new Error('nope'))).toBeUndefined();
  });
});

describe('isConflict and isUnauthorized', () => {
  it('recognises the displacement conflict', () => {
    expect(isConflict(apiError({ code: 409, description: CONFLICT, method: 'getUpdates' })))
      .toBe(true);
  });

  it('recognises a bad token', () => {
    expect(isUnauthorized(apiError({ code: 401, description: 'Unauthorized' }))).toBe(true);
  });

  it('keeps the four classes distinct', () => {
    const conflict = apiError({ code: 409, description: CONFLICT, method: 'getUpdates' });
    expect(isUnauthorized(conflict)).toBe(false);
    expect(isUnchangedEdit(conflict)).toBe(false);
    expect(retryAfterSeconds(conflict)).toBeUndefined();

    const unchanged = apiError({ code: 400, description: UNCHANGED_EDIT });
    expect(isConflict(unchanged)).toBe(false);
    expect(isUnauthorized(unchanged)).toBe(false);
  });

  it('is false for non-API errors', () => {
    expect(isConflict(new Error('x'))).toBe(false);
    expect(isUnauthorized(new Error('x'))).toBe(false);
  });
});
