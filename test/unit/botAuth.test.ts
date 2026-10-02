import { describe, expect, it, vi } from 'vitest';
import { allowOnly } from '../../src/bot/auth.js';

/**
 * A context whose every property other than `from` is a recorder. Any property READ
 * (ctx.reply, ctx.api, ctx.api.sendPhoto, ...) and any CALL is logged in `touched`, and
 * the recorder is itself callable and nestable, so a mutant reaching for an API method
 * nobody thought to list still gets recorded.
 *
 * This replaces an enumerated fake (`sendMessage`, `editMessageText`, `sendDocument`),
 * which a drop branch calling `ctx.api.sendPhoto` inside a try/catch walked straight past.
 * Silence is the one property this middleware exists for, so it is pinned structurally:
 * the assertion is "nothing was touched", not "these three things were not called".
 */
function recordingCtx(from?: { id: number }) {
  const touched: string[] = [];
  const recorder = (path: string): unknown =>
    new Proxy(function () {}, {
      get(_t, key) {
        const name = `${path}.${String(key)}`;
        touched.push(name);
        return recorder(name);
      },
      apply() {
        touched.push(`${path}()`);
        return Promise.resolve(undefined);
      },
    });
  const ctx = new Proxy(from ? { from } : {}, {
    get(target, key, receiver) {
      if (key === 'from') return Reflect.get(target, key, receiver);
      const name = `ctx.${String(key)}`;
      touched.push(name);
      return recorder(name);
    },
  });
  return { ctx, touched };
}

describe('allowOnly', () => {
  const ids = new Set([111, 222]);

  it('passes every allowlisted user through, not just the first', async () => {
    // Both ids are tested: a gate comparing against one hardcoded or first-only id
    // would lock out the owner's other accounts with a green suite.
    for (const id of ids) {
      const next = vi.fn(async () => undefined);
      await allowOnly(ids)({ from: { id } }, next);
      expect(next).toHaveBeenCalledOnce();
    }
  });

  it('does not log for an authorized user', async () => {
    // The owner's log should list only rejections; logging allowed traffic as
    // "dropped ... unauthorized" would bury the real attempts.
    const log = vi.fn();
    await allowOnly(ids, log)({ from: { id: 222 } }, vi.fn(async () => undefined));
    expect(log).not.toHaveBeenCalled();
  });

  it('drops an unauthorized user SILENTLY — no reply of any kind', async () => {
    // The requirement is silence, not a polite refusal. Any response, including an
    // error, confirms the bot exists to whoever found its username.
    const next = vi.fn(async () => undefined);
    const { ctx, touched } = recordingCtx({ id: 999 });
    await allowOnly(ids)(ctx, next);
    expect(next).not.toHaveBeenCalled();
    expect(touched).toEqual([]);
  });

  it('drops an update with no sender at all, also silently', async () => {
    const next = vi.fn(async () => undefined);
    const { ctx, touched } = recordingCtx();
    await allowOnly(ids)(ctx, next);
    expect(next).not.toHaveBeenCalled();
    expect(touched).toEqual([]);
  });

  it('the recorder is not vacuous: it sees an unlisted method read and call', () => {
    // Guards the guard. If the Proxy stopped recording, the two silence tests would
    // pass against any drop branch.
    const { ctx, touched } = recordingCtx({ id: 1 });
    void (ctx as unknown as { api: { sendPhoto: () => unknown } }).api.sendPhoto();
    expect(touched).toEqual(['ctx.api', 'ctx.api.sendPhoto', 'ctx.api.sendPhoto()']);
  });

  it('logs the rejected id, so attempts are visible to the owner', async () => {
    // A Telegram user id is not a secret, and the owner should be able to see that
    // someone found the bot.
    const log = vi.fn();
    await allowOnly(ids, log)({ from: { id: 999 } }, vi.fn(async () => undefined));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('999'));
  });

  it('logs a sender-less drop as such', async () => {
    const log = vi.fn();
    await allowOnly(ids, log)({}, vi.fn(async () => undefined));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('(no sender)'));
  });

  it('refuses to construct with an empty allowlist', async () => {
    expect(() => allowOnly(new Set())).toThrow(/empty/i);
  });
});
