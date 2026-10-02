import { describe, expect, it, vi } from 'vitest';
import type { Context } from 'grammy';
import { makeReplier } from '../../src/bot/replier.js';
import { deriveSecretTokens } from '../../src/secrets.js';
import { writeDropLog, writeHandlerError } from '../../src/bot/app.js';

/**
 * An obviously FAKE credential. Never a real one, and never read from .env.
 */
// A plain string that NO generic URL/key pattern would catch, so these tests prove the
// configured tokens are applied rather than a fallback pass that scrubs on its own.
const FAKE_KEY = 'zz-fake-secret-ZXCV0987654321';
const FAKE_URL = `see ${FAKE_KEY} here`;
const tokens = deriveSecretTokens([FAKE_KEY]);

function fakeCtx() {
  const sendMessage = vi.fn(async (_c: number, _t: string) => ({ message_id: 1 }));
  const editMessageText = vi.fn(async (_c: number, _m: number, _t: string) => true);
  const sendDocument = vi.fn(async (_c: number, _f: unknown, _o: { caption?: string }) => true);
  const ctx = { chat: { id: 5 }, api: { sendMessage, editMessageText, sendDocument } };
  return { ctx: ctx as unknown as Context, sendMessage, editMessageText, sendDocument };
}

describe('makeReplier scrubs every outbound string', () => {
  it('reply', async () => {
    const { ctx, sendMessage } = fakeCtx();
    await makeReplier(ctx, tokens).reply(`failed: GET ${FAKE_URL} returned 429`);
    const sent = String(sendMessage.mock.calls[0]?.[1]);
    expect(sent).not.toContain(FAKE_KEY);
    expect(sent).toContain('failed: GET');
    expect(sent).toContain('returned 429');
  });

  it('edit', async () => {
    const { ctx, editMessageText } = fakeCtx();
    await makeReplier(ctx, tokens).edit(9, `progress ${FAKE_URL}`);
    const sent = String(editMessageText.mock.calls[0]?.[2]);
    expect(sent).not.toContain(FAKE_KEY);
    expect(sent).toContain('progress');
  });

  it('document caption, contents AND filename', async () => {
    const { ctx, sendDocument } = fakeCtx();
    await makeReplier(ctx, tokens).sendDocument({
      filename: `${FAKE_KEY}.csv`, contents: `wallet,rpc\n0xabc,${FAKE_URL}\n`,
      caption: `from ${FAKE_URL}`,
    });
    const call = sendDocument.mock.calls[0];
    const file = call?.[1] as { fileData: Buffer; filename: string };
    const contents = file.fileData.toString('utf8');
    expect(contents).not.toContain(FAKE_KEY);
    expect(contents).toContain('wallet,rpc');
    expect(call?.[2].caption).not.toContain(FAKE_KEY);
    expect(call?.[2].caption).toContain('from');
    expect(file.filename).not.toContain(FAKE_KEY);
  });

  it('passes ordinary text through untouched', async () => {
    const { ctx, sendMessage } = fakeCtx();
    await makeReplier(ctx, tokens).reply('Indexed 0xabc on chain 1');
    expect(sendMessage.mock.calls[0]?.[1]).toBe('Indexed 0xabc on chain 1');
  });
});

describe('main logging callbacks write what they are given', () => {
  /** Runs `fn` and returns everything it wrote to stderr (read BEFORE restoring: restore clears calls). */
  function stderrOf(fn: () => void): string {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
    try {
      fn();
      return spy.mock.calls.map((c) => String(c[0])).join('');
    } finally {
      spy.mockRestore();
    }
  }

  it('writeDropLog puts the drop message on stderr, newline-terminated', () => {
    const out = stderrOf(() => writeDropLog('dropped an update from unauthorized user 999'));
    expect(out).toBe('dropped an update from unauthorized user 999\n');
  });

  it('writeHandlerError puts the failure on stderr, naming what failed', () => {
    const out = stderrOf(() => writeHandlerError(new Error('handler blew up: reason-xyz')));
    expect(out).toContain('reason-xyz');
  });
});
