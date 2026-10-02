import { describe, expect, it, vi } from 'vitest';
import {
  MESSAGE_BUDGET, respond, sanitizeOnChainText,
} from '../../src/bot/render.js';
import type { Replier } from '../../src/bot/replier.js';

function fakeReplier() {
  const reply = vi.fn(async (_t: string) => ({ messageId: 1 }));
  const edit = vi.fn(async (_id: number, _t: string) => undefined);
  const sendDocument = vi.fn(async (_a: { filename: string; contents: string; caption: string }) => undefined);
  return { replier: { reply, edit, sendDocument } as Replier, reply, edit, sendDocument };
}

describe('sanitizeOnChainText', () => {
  // name() is attacker-controlled. Dropping parse_mode handles Markdown; none of these
  // involve Markdown at all.
  it('strips newlines, which would forge message structure', () => {
    expect(sanitizeOnChainText('Cool\nCollection\r\nFake: 999')).toBe('Cool Collection Fake: 999');
  });

  it('strips control characters', () => {
    expect(sanitizeOnChainText('A\u0000B\u0007C\u001bD')).toBe('ABCD');
  });

  // Escapes, not literals: a bidi control pasted into source is invisible and easily lost.
  it('strips bidi overrides, which can make text read as something else', () => {
    expect(sanitizeOnChainText('abc‮def‬')).toBe('abcdef');
    expect(sanitizeOnChainText('⁦x⁩')).toBe('x');
  });

  it('collapses whitespace runs', () => {
    expect(sanitizeOnChainText('a     b\t\tc')).toBe('a b c');
  });

  it('truncates a long name rather than letting it eat the message budget', () => {
    const out = sanitizeOnChainText('x'.repeat(2000));
    expect(out.length).toBeLessThanOrEqual(65);
    expect(out.endsWith('…')).toBe(true);
  });

  it('renders an absent name as a placeholder, not as "undefined"', () => {
    expect(sanitizeOnChainText(null)).toBe('(unnamed)');
    expect(sanitizeOnChainText('')).toBe('(unnamed)');
  });
});

describe('respond', () => {
  const small = {
    title: 'First minters', headers: ['wallet', 'minted'],
    rows: [['0xaaa', '3'], ['0xbbb', '1']], filename: 'firstminters-1-0xaaa-123.csv',
  };

  it('sends a message when the output fits', async () => {
    const { replier, reply, sendDocument } = fakeReplier();
    await respond(replier, small);
    expect(reply).toHaveBeenCalledOnce();
    expect(sendDocument).not.toHaveBeenCalled();
    expect(reply.mock.calls[0]![0]).toContain('First minters');
  });

  it('sends a CSV document once the output exceeds the budget', async () => {
    const { replier, reply, sendDocument } = fakeReplier();
    const rows = Array.from({ length: 500 }, (_, i) => [`0x${String(i).padStart(40, '0')}`, '1']);
    await respond(replier, { ...small, rows });
    expect(sendDocument).toHaveBeenCalledOnce();
    expect(reply).not.toHaveBeenCalled();
    const doc = sendDocument.mock.calls[0]![0];
    expect(doc.contents.split('\n')[0]).toBe('wallet,minted');
    expect(doc.contents.split('\n')).toHaveLength(501);
    expect(doc.caption).toContain('500');
  });

  it('switches on the rendered LENGTH, not on a row count', async () => {
    // One rule for every command, and the real limit is characters.
    const { replier, sendDocument } = fakeReplier();
    await respond(replier, { ...small, rows: [['x'.repeat(MESSAGE_BUDGET + 1), '1']] });
    expect(sendDocument).toHaveBeenCalledOnce();
  });

  it('quotes a CSV field containing a comma or a quote', async () => {
    const { replier, sendDocument } = fakeReplier();
    const rows = Array.from({ length: 400 }, () => ['a,b', 'he said "hi"']);
    await respond(replier, { ...small, rows });
    expect(sendDocument.mock.calls[0]![0].contents).toContain('"a,b"');
    expect(sendDocument.mock.calls[0]![0].contents).toContain('"he said ""hi"""');
  });
});
