import { describe, expect, it, vi } from 'vitest';
import { allowOnly } from '../../src/bot/auth.js';

describe('allowOnly', () => {
  const ids = new Set([111, 222]);

  it('passes an allowed user through', async () => {
    const next = vi.fn(async () => undefined);
    await allowOnly(ids)({ from: { id: 111 } }, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('drops an unauthorized user SILENTLY — no reply of any kind', async () => {
    // The requirement is silence, not a polite refusal. Any response, including an
    // error, confirms the bot exists to whoever found its username.
    const next = vi.fn(async () => undefined);
    const api = { sendMessage: vi.fn(), editMessageText: vi.fn(), sendDocument: vi.fn() };
    await allowOnly(ids)({ from: { id: 999 }, api } as never, next);
    expect(next).not.toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(api.editMessageText).not.toHaveBeenCalled();
    expect(api.sendDocument).not.toHaveBeenCalled();
  });

  it('drops an update with no sender at all', async () => {
    const next = vi.fn(async () => undefined);
    await allowOnly(ids)({}, next);
    expect(next).not.toHaveBeenCalled();
  });

  it('logs the rejected id, so attempts are visible to the owner', async () => {
    // A Telegram user id is not a secret, and the owner should be able to see that
    // someone found the bot.
    const log = vi.fn();
    await allowOnly(ids, log)({ from: { id: 999 } }, vi.fn(async () => undefined));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('999'));
  });

  it('refuses to construct with an empty allowlist', async () => {
    expect(() => allowOnly(new Set())).toThrow(/empty/i);
  });
});
