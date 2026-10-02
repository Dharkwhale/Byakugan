import { describe, expect, it, vi } from 'vitest';
import {
  MESSAGE_BUDGET, renderTable, respond, sanitizeOnChainText, toCsv,
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
    expect(sanitizeOnChainText('abc\u202edef\u202c')).toBe('abcdef');
    expect(sanitizeOnChainText('\u2066x\u2069')).toBe('x');
  });

  it('collapses whitespace runs', () => {
    expect(sanitizeOnChainText('a     b\t\tc')).toBe('a b c');
  });

  it('truncates a long name rather than letting it eat the message budget', () => {
    const out = sanitizeOnChainText('x'.repeat(2000));
    expect(out.length).toBeLessThanOrEqual(65);
    expect(out.endsWith('…')).toBe(true);
  });

  it('does not split a surrogate pair at the truncation boundary', () => {
    // 63 x's, then an emoji whose high surrogate sits at UTF-16 index 63.
    const out = sanitizeOnChainText('x'.repeat(63) + '\u{1f600}yyy');
    expect(out).not.toMatch(/[�-�]/);
    expect(out).toBe('x'.repeat(63) + '\u{1f600}…');
    // And past the cut: 64 x's then an emoji, which must be dropped whole.
    const out2 = sanitizeOnChainText('x'.repeat(64) + '\u{1f600}');
    expect(out2).not.toMatch(/[�-�]/);
  });

  it('turns an all-invisible name into the placeholder', () => {
    expect(sanitizeOnChainText('\u200b\u200c\u200d\u2060')).toBe('(unnamed)');
  });

  it('strips LRM, RLM and ALM, which can still reorder text', () => {
    expect(sanitizeOnChainText('foo\u200e bar')).toBe('foo bar');
    expect(sanitizeOnChainText('a\u200fb\u061cc')).toBe('abc');
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
  it('neutralises a spreadsheet formula in a field', () => {
    const csv = toCsv({
      headers: ['name'],
      rows: [['=HYPERLINK("http://evil","x")'], ['+1'], ['@SUM(A1)'], ['-2+3'], ['plain']],
    });
    const fields = csv.split('\n').slice(1);
    expect(fields[0]).toBe('"\'=HYPERLINK(""http://evil"",""x"")"');
    for (const f of fields) expect(f).not.toMatch(/^"?[=+\-@\t\r]/);
    expect(fields[4]).toBe('plain');
  });

  it('throws on a ragged row instead of rendering a blank cell', () => {
    expect(() => renderTable({ title: 't', headers: ['a', 'b'], rows: [['1', '2'], ['only']] }))
      .toThrow(/row 1 has 1 cells, expected 2/);
  });
});
