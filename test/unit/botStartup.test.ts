import { describe, expect, it } from 'vitest';
import {
  classifyStartupFailure, requireBotConfig,
  GRAMMY_DEFAULT_LONG_POLL_SECONDS, GRAMMY_DEFAULT_REQUEST_TIMEOUT_SECONDS,
  REQUEST_TIMEOUT_SECONDS,
} from '../../src/bot/app.js';
import { EXIT } from '../../src/report.js';
import { ConfigError } from '../../src/errors.js';
import type { Config } from '../../src/config.js';

const base: Config = {
  chains: new Map(), defaultChainId: 1, dbPath: ':memory:',
  etherscanApiKey: undefined, computeUnitsPerSecond: 300, secrets: [],
  telegramBotToken: undefined, telegramAllowedUserIds: [],
};

describe('requireBotConfig', () => {
  it('returns the token and a set of ids', () => {
    expect(requireBotConfig({
      ...base, telegramBotToken: 'tok', telegramAllowedUserIds: [1, 2],
    })).toEqual({ token: 'tok', allowedUserIds: new Set([1, 2]) });
  });

  it('throws when the token is missing', () => {
    expect(() => requireBotConfig({ ...base, telegramAllowedUserIds: [1] }))
      .toThrow(ConfigError);
  });

  it('throws on an EMPTY allowlist rather than starting', () => {
    // The two ways to get this wrong are a bot that drops everything (useless) and one
    // that treats empty as allow-all (catastrophic). Neither should be reachable by
    // leaving a variable unset.
    expect(() => requireBotConfig({ ...base, telegramBotToken: 'tok' }))
      .toThrow(/TELEGRAM_ALLOWED_USER_IDS/);
  });
});

describe('classifyStartupFailure', () => {
  const api = (code: number, description: string) =>
    Object.assign(new Error(description), { error_code: code, description });

  it('maps a 409 to BUSY and says this instance was DISPLACED', () => {
    // MEASURED, and the opposite of what was first assumed. Telegram terminates the
    // request already in flight — "terminated by other getUpdates request" — so the 409
    // goes to the INCUMBENT, not the newcomer. A process seeing this has been displaced
    // and cannot poll at all.
    const result = classifyStartupFailure(
      api(409, 'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running'),
    );
    expect(result?.exitCode).toBe(EXIT.BUSY);
    expect(result?.message).toMatch(/taken over/i);
    // Names the likely cause, so the operator looks for the old process rather than
    // treating it as a transient failure.
    expect(result?.message).toMatch(/older process still running/i);
    // Says what it costs: the displaced process's in-flight jobs are gone.
    expect(result?.message).toMatch(/orphaned/i);
    expect(result?.message).toContain(String(process.pid));
    // It must NOT tell the operator to restart this one, which would just displace the
    // other instance in turn and trade places forever.
    expect(result?.message).toMatch(/flip-flop|trade places|find and stop/i);
    expect(result?.message).not.toMatch(/retry/i);
  });

  it('maps a 401 to USAGE', () => {
    expect(classifyStartupFailure(api(401, 'Unauthorized'))?.exitCode).toBe(EXIT.USAGE);
  });

  it('is undefined for anything else, so it is not swallowed', () => {
    expect(classifyStartupFailure(new Error('network down'))).toBeUndefined();
  });
});

describe('the request timeout', () => {
  /*
   * A CONFIGURATION assertion, deliberately, and this is the exception the rule allows.
   * The behaviour — a request aborting after N seconds — can only be observed by waiting
   * N seconds, and this project does not sleep in tests. What carries the meaning here is
   * not that the option is set but the RELATIONSHIP between three numbers, and that is
   * assertable: too low and long polling is killed mid-poll, too high and a stalled
   * progress edit holds a finished job's final message for minutes.
   */
  it('clears the long poll and undercuts grammY default', () => {
    expect(REQUEST_TIMEOUT_SECONDS).toBeGreaterThan(GRAMMY_DEFAULT_LONG_POLL_SECONDS);
    expect(REQUEST_TIMEOUT_SECONDS).toBeLessThan(GRAMMY_DEFAULT_REQUEST_TIMEOUT_SECONDS);
  });
});
